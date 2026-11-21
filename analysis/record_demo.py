# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==12.2.0"]
# ///
"""Record an offline replay of observed CLI output and verified Frugal run evidence."""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

import report

ROOT = Path(__file__).resolve().parents[1]
W, H, FPS = 1280, 720, 24
BG, FG, MUTE, TEAL = "#101c26", "#edf4f6", "#a5bdc8", "#7ae0bd"
CLI = Path("packages/cli/bin/frugal.js")


@dataclass
class Scene:
    title: str
    text: str
    rows: list[str]
    source: str
    seconds: int
    command: str = ""
    bars: tuple = ()


def run(args, **kwargs):
    return subprocess.run(
        args, cwd=ROOT, check=True, capture_output=True, text=True, **kwargs
    )


def jsonl(path):
    with path.open(encoding="utf-8") as file:
        return [json.loads(line) for line in file if line.strip()]


def source(attempt, name):
    return f"{attempt.path.name}/{name}"


def replay(attempt, workspace):
    """Keep stdout from a real CLI invocation; save its derived files outside the archive."""
    output = workspace / attempt.path.name
    command = [
        "node",
        str(CLI),
        "meter",
        os.path.relpath(attempt.path, ROOT),
        "--out",
        str(output),
    ]
    raw_stdout = run(command).stdout
    observed = json.loads(raw_stdout)
    archived = report.read_json(attempt.path / "meter.json")
    if (
        not observed["complete"]
        or observed != archived
        or observed["rpt"] != attempt.rpt
    ):
        raise ValueError(f"Пересчёт отличается от архива {attempt.path.name}")
    expr = "{run_id, complete, call_count, rpt, cost}"
    stdout = run(["jq", expr], input=raw_stdout).stdout.strip()
    # Show the portable output argument used for replay, not a machine-specific temporary path.
    display = (
        shlex.join(command[:-1])
        + ' "$TMP/'
        + attempt.path.name
        + '" | jq '
        + shlex.quote(expr)
    )
    return display, stdout


def read_cli(attempt, filename, expression):
    relative = os.path.relpath(attempt.path / filename, ROOT)
    cmd = ["jq", "-r", expression, relative]
    return shlex.join(cmd), run(cmd).stdout.strip().splitlines()


def selected_call(attempt):
    calls = jsonl(attempt.path / "calls.jsonl")
    return max(calls, key=lambda row: sum(row[k] for k in report.TOKENS))


def tokens(row):
    return sum(row[k] for k in report.TOKENS)


def raw_call_scene(arm, label):
    row = selected_call(arm)
    raw = row["raw_ref"]
    filename, locator = raw.split("#", 1)
    if filename.endswith(".jsonl") and locator.startswith("L"):
        n = int(locator[1:])
        command = ["sed", "-n", f"{n}p", os.path.relpath(arm.path / filename, ROOT)]
        observed = json.loads(run(command).stdout)
        part = observed.get("part")
        if part and part["tokens"] != row["raw"]:
            raise ValueError("Расход шага в stdout расходится с реестром вызовов")
        shell = shlex.join(command)
    else:
        shell = ""
    return Scene(
        f"Самый дорогой вызов · {label}",
        f"Стадия {row['stage']}. Полная запись доступна по указанному идентификатору.",
        [
            row["event_key"],
            json.dumps(row["raw"], ensure_ascii=False),
            f"RPT вызова   {tokens(row):,}",
            f"Сессия   {row['session_id']}",
        ],
        source(arm, raw),
        16,
        shell,
    )


def preview_scenes(attempt, workspace):
    rec = report.read_json(attempt.path / "reconciliation.json")
    if not (
        rec.get("matched")
        and attempt.meter_ok
        and attempt.manifest.get("dry_run") is True
    ):
        raise ValueError("Для репетиции нужен сверенный технический mock-прогон")
    command, output = replay(attempt, workspace)
    children = [
        c for c in jsonl(attempt.path / "calls.jsonl") if c["parent_session_id"]
    ]
    if not children or not rec.get("child_steps"):
        raise ValueError(
            "Для этого сценария нужен результат scripts/check-meter-children.mjs"
        )
    child = children[0]
    expr = 'select(.type == "step_finish") | [.part.id, .part.tokens.input, .part.tokens.output] | @tsv'
    view_command, view_rows = read_cli(attempt, "raw/events.jsonl", expr)
    return [
        Scene(
            "Куда попал вызов подагента?",
            "Реальный opencode исполнил task. Ответы вернул локальный mock-провайдер.",
            [
                f"opencode   {attempt.manifest['versions']['opencode']}",
                f"Модель   {attempt.manifest['model']}",
                f"Запуск   {attempt.path.name}",
            ],
            source(attempt, "manifest.json"),
            7,
        ),
        Scene(
            "В родительском stdout",
            "Каждая строка показывает завершённый шаг, его вход и выход.",
            view_rows,
            source(attempt, "raw/events.jsonl"),
            9,
            view_command,
        ),
        Scene(
            "Открываем дочернюю сессию",
            "Frugal нашёл отдельный шаг по связям session, message и part.",
            [
                f"Сессия    {child['session_id']}",
                f"Родитель  {child['parent_session_id']}",
                f"Стадия    {child['stage']}",
                f"RPT       {tokens(child)}",
            ],
            source(attempt, child["raw_ref"]),
            8,
        ),
        Scene(
            "Независимый пересчёт",
            "Команда прочитала архив и записала новый результат во временный каталог.",
            [output],
            source(attempt, "meter.json"),
            10,
            command,
        ),
        Scene(
            "Что подтвердилось",
            "Счётчик восстановил расход локального провайдера, включая дочерний вызов.",
            [
                f"HTTP-запросы   {rec['provider_requests']}",
                f"Шаги в stdout   {rec['cli_steps']}",
                f"Шаги дочерней сессии   {rec['child_steps']}",
                "Первоисточник   raw/observed-requests.jsonl",
            ],
            source(attempt, "reconciliation.json"),
            9,
            bars=(("Провайдер", rec["provider_rpt"]), ("Измеритель", rec["meter_rpt"])),
        ),
    ]


def prototype_pair(attempts, label):
    arms = [a for a in attempts if a.manifest.get("pair_id") == label and not a.live]
    arms.sort(key=lambda a: a.manifest.get("branch", ""))
    if [a.manifest.get("branch") for a in arms] != ["base", "opt"]:
        raise ValueError(f"Репетиция {label}: нужны каталоги обоих плеч")
    base, opt = arms
    for arm in arms:
        m = arm.manifest
        if not (
            m.get("dry_run") is True
            and m.get("accepted") is False
            and m.get("pipeline_complete") is True
            and arm.meter_ok
            and not arm.errors
            and (arm.path / "final.bundle").is_file()
        ):
            raise ValueError(f"Репетиция не завершена: {arm.path.name}")
    for key in ("feature_id", "repo", "requirements_hash", "model"):
        if not base.manifest.get(key) or base.manifest[key] != opt.manifest.get(key):
            raise ValueError(f"Входы репетиции расходятся: {key}")
    if not base.manifest["repo"].get("commit"):
        raise ValueError("В репетиции отсутствует исходный коммит")
    left, right = (a.manifest["isolation"] for a in arms)
    if not (
        left.get("root")
        and right.get("root")
        and left["root"] != right["root"]
        and left["engine"] == right["engine"]
        and left["image"] == right["image"]
    ):
        raise ValueError("Изоляция двух плеч репетиции не подтверждена")
    return base, opt


def compression_scenes(path):
    evidence = report.read_json(path)
    checks = evidence["checks"]
    if not (
        evidence["fixture"] == "synthetic-git-log"
        and evidence["endpoint"] == "loopback"
        and len(checks) == 2
        and {version.split(".")[0] for version in checks} == {"1", "2"}
    ):
        raise ValueError("Нужна локальная фикстура H-03 для обеих версий OpenCode")
    lengths, digests = [], []
    for version, check in sorted(checks.items()):
        base, opt = check["baseline"], check["compressed"]
        sha = base["sourceSha256"]
        if not (
            0 < opt["chars"] < base["chars"]
            and opt["recovered"] is True
            and re.fullmatch(r"[a-f0-9]{64}", sha)
            and sha == opt["sourceSha256"] == opt["archiveSha256"]
        ):
            raise ValueError(f"Фикстура H-03 не сверилась на OpenCode {version}")
        lengths.append(
            f"OpenCode {version}   {base['chars']} → {opt['chars']} символов"
        )
        digests.append(f"{version}   {sha}")
    evidence_path = (
        os.path.relpath(path, ROOT) if path.is_relative_to(ROOT) else path.name
    )
    return [
        Scene(
            "H-03 · сжатие вывода инструмента",
            "Настоящий OpenCode выполняет git log. Локальная фикстура измеряет текст, полученный в следующем запросе.",
            lengths + ["Вход проверки   публичный синтетический Git-журнал"],
            evidence_path,
            13,
            'node scripts/probe-compression.mjs "$TMP/compression.json"',
        ),
        Scene(
            "Полный журнал можно открыть",
            "Проверка подтверждает чтение архива инструментом OpenCode и совпадение SHA-256 с исходным выводом.",
            digests,
            evidence_path,
            12,
        ),
    ]


def archived_smoke_scene(path, workspace):
    attempt = report.inspect_run(path)
    if not (
        attempt.live and attempt.technical and attempt.meter_ok and not attempt.errors
    ):
        raise ValueError(f"Нужен проверенный живой smoke: {path.name}")
    meter = report.read_json(path / "meter.json")
    relay = meter.get("relay") or {}
    if not (
        meter["call_count"] == relay.get("requests_with_usage") == 1
        and relay["known_rpt"] == meter["rpt"]
        and relay["relative_discrepancy"] == 0
        and (path / "raw/relay.jsonl").is_file()
    ):
        raise ValueError(f"Нужна полная сверка одного запроса с relay: {path.name}")
    command, _ = replay(attempt, workspace)
    return Scene(
        "Архив · один живой запрос",
        "Сохранённый usage провайдера пересчитывается офлайн. Этот smoke проверяет счётчик.",
        [
            attempt.manifest["model"],
            f"RPT   {meter['rpt']}   Расхождение с relay   {relay['relative_discrepancy']:.0%}",
            f"Вход   {meter['t_in']}   Чтение кэша   {meter['t_cache_read']}   Выход   {meter['t_out']}",
        ],
        source(attempt, "raw/relay.jsonl"),
        15,
        command,
    )


def prototype_review_scene(attempt, workspace):
    rounds_file = "opt/review/rounds.json"
    verify_file = "opt/verify.json"
    rounds_path = attempt.path / rounds_file
    if not rounds_path.is_file():
        return None
    rounds = report.read_json(rounds_path)
    verify = report.read_json(attempt.path / verify_file)
    commit = attempt.manifest["final_commit"]
    if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", commit) or not rounds:
        raise ValueError("Нет итогового снимка ревью прототипа")
    git_repo = workspace / "prototype-snapshot.git"
    object_format = "sha256" if len(commit) == 64 else "sha1"
    run(
        [
            "git",
            "init",
            "--bare",
            "-q",
            f"--object-format={object_format}",
            str(git_repo),
        ]
    )
    git = ["git", "--git-dir", str(git_repo)]
    run([*git, "bundle", "unbundle", str(attempt.path / "final.bundle")])
    tree = run([*git, "rev-parse", "--verify", f"{commit}^{{tree}}"]).stdout.strip()
    final = rounds[-1]
    if not (
        final["final"] is True
        and final["scope"] == "full"
        and final["verdict"] == "approved"
        and verify["passed"] is True
        and final["tree"] == verify["tree"] == tree
    ):
        raise ValueError("Финальное ревью и проверка не сверились со снимком прототипа")
    rows = []
    for index, record in enumerate(rounds):
        scope, verdict = record["scope"], record["verdict"]
        if not (
            record["round"] == index + 1
            and scope in ("full", "delta")
            and verdict in ("changes_requested", "approved")
            and (
                scope == "full"
                or (
                    index > 0
                    and record.get("previousTree") == rounds[index - 1]["tree"]
                )
            )
        ):
            raise ValueError("Не сверилась последовательность ревью прототипа")
        label = "финальный full" if record["final"] else scope
        rows.append(f"Раунд {record['round']}   {label}   {verdict}")
    rows.append(f"verify   PASS   tree {tree[:12]}")
    return Scene(
        "Ревью и проверка снимка",
        "В открытой mock-фикстуре итоговое полное ревью и verify сверены с Git tree сохранённого результата.",
        rows,
        f"{source(attempt, rounds_file)} · {source(attempt, verify_file)}",
        14,
    )


def prototype_capsule_scene(attempt):
    if attempt.manifest["flags"].get("capsule") is not True:
        return None
    filename = "opt/inputs/apply-1.1.txt"
    lines = (attempt.path / filename).read_text(encoding="utf-8").splitlines()
    if not any(
        s["stage"] == "apply" and s.get("task") == "1.1"
        for s in attempt.manifest["stages"]
    ):
        raise ValueError("Капсула не соответствует стадии apply 1.1")
    patterns = (
        r"# Task 1\.1 · .+",
        r"### Requirement: REQ-REPLAY-01 Replay marker",
        r"#### Scenario: SCN-REPLAY-01\.1 Marker exists",
        r"The replay fixture SHALL persist `replay-marker\.txt`\.",
    )
    excerpts = [
        next((line for line in lines if re.fullmatch(p, line)), "") for p in patterns
    ]
    if not all(excerpts):
        raise ValueError(
            "Капсула открытой фикстуры не содержит задачу, требование и сценарий"
        )
    return Scene(
        "Капсула отдельной задачи",
        "В apply 1.1 передаётся контекст задачи с исходным текстом требования и ссылкой на полную спецификацию.",
        [line.lstrip("# ") for line in excerpts],
        source(attempt, filename),
        9,
    )


def prototype_scenes(attempts, label, h03_path, workspace, live_smoke=None):
    base, opt = prototype_pair(attempts, label)
    arms = (base, opt)
    base_command, base_output = replay(base, workspace)
    _, opt_output = replay(opt, workspace)
    outcomes = [json.loads(output) for output in (base_output, opt_output)]
    scenes = [
        Scene(
            "Frugal SDD · прототип",
            "Frugal оборачивает OpenSpec и OpenCode, сохраняет события стадий и считает сырые токены из usage.",
            [
                f"Фича   {base.manifest['feature_id']}",
                "Изолированная парная репетиция",
                "Нативная проверка сжатия H-03",
            ],
            source(base, "manifest.json"),
            10,
        ),
        Scene(
            "Парный dry-run",
            "Одинаковые исходный коммит, требования и модель-фикстура. У каждого плеча своя рабочая копия.",
            [
                f"Модель   {base.manifest['model']}",
                f"Исходный коммит   {base.manifest['repo']['commit'][:12]}",
                f"Изоляция   {base.manifest['isolation']['engine']}",
                *[
                    f"{a.manifest['branch']}   {Path(a.manifest['isolation']['root']).name}"
                    for a in arms
                ],
            ],
            " · ".join(source(a, "manifest.json") for a in arms),
            13,
        ),
        Scene(
            "Стадии и артефакты",
            "spec объединяет proposal, specs, design и tasks. После реализации репетиция проходит ревью и проверку.",
            [
                *[
                    f"{a.manifest['branch']}   "
                    + " → ".join(s["stage"] for s in a.manifest["stages"])
                    for a in arms
                ],
                "Сырые события   raw/events.jsonl",
                "Снимок результата   final.bundle",
            ],
            source(opt, "manifest.json"),
            10,
        ),
        Scene(
            "Учёт из сохранённых событий",
            "frugal meter заново пересчитал каждое плечо и сверил результат с архивом. В кадре синтетический usage.",
            [
                f"{a.manifest['branch']}   вызовов: {m['call_count']}   RPT: {m['rpt']}"
                for a, m in zip(arms, outcomes, strict=True)
            ],
            " · ".join(source(a, "meter.json") for a in arms),
            14,
            base_command,
        ),
    ]
    capsule = prototype_capsule_scene(opt)
    if capsule:
        scenes.append(capsule)
    review = prototype_review_scene(opt, workspace)
    if review:
        scenes.append(review)
    scenes.extend(compression_scenes(h03_path))
    if live_smoke:
        scenes.append(archived_smoke_scene(live_smoke, workspace))
    scenes.append(
        Scene(
            "Результат демонстрации",
            "Репетиция показывает конвейер и воспроизводимость учёта. H-03 показывает сокращение текста в локальной фикстуре.",
            [
                "Репетиция   dry_run=true, accepted=false",
                "Оценка экономии требует принятой живой A/B-пары.",
            ],
            "docs/VIDEO.md",
            10,
        )
    )
    return scenes


def good_pair(attempts, pairs, label):
    arms, reason = pairs.get(label, (None, "пара отсутствует"))
    if not arms:
        raise ValueError(f"Пара {label}: {reason}")
    base, opt = arms
    series = base.manifest.get("series_id")
    if not series or series != opt.manifest.get("series_id"):
        raise ValueError("Оба плеча должны входить в одну зарегистрированную серию")
    members = [
        a
        for a in attempts
        if a.live
        and a.manifest.get("kind") != "meter-smoke"
        and a.manifest.get("series_id") == series
    ]
    issues = report.series_quality_issues(members)
    if issues:
        raise ValueError("Качество серии по §4.3: " + ", ".join(issues))
    return base, opt, members


def final_scenes(attempts, pairs, label, workspace):
    base, opt, members = good_pair(attempts, pairs, label)
    total_a, total_b = base.rpt, opt.rpt
    savings = 100 * (1 - total_b / total_a)
    anchors = set(base.stages) | set(opt.stages)
    diffs = sorted(anchors, key=lambda s: (-abs(base.stages[s] - opt.stages[s]), s))
    stages = [
        f"{report.STAGE_NAMES.get(s, s):18} {base.stages[s]:>8,}  {opt.stages[s]:>8,}   {100 * (base.stages[s] - opt.stages[s]) / total_a:>+7.2f}"
        for s in diffs
    ]
    header = "Стадия                 Base       Opt    п. п."
    rows = report.read_json(opt.path / "quality/trace.json")["rows"]
    link = next((r for r in rows if r.get("verdict") == "pass"), None)
    if not link:
        raise ValueError("Нет зелёной цепочки по требованию")

    snapshot = workspace / "final-snapshot.git"
    bundle = opt.path / "final.bundle"
    if not bundle.is_file() or not re.fullmatch(
        r"[0-9a-f]{40,64}", link["final_commit"]
    ):
        raise ValueError("Для проверки строк исходного кода нужен final.bundle и SHA")
    run(["git", "clone", "--bare", "--quiet", str(bundle), str(snapshot)])
    git = ["git", "--git-dir", str(snapshot)]

    def evidence(ref):
        filename = ref["path"]
        line = ref["line"]
        lines = run(
            [*git, "show", f"{link['final_commit']}:{filename}"]
        ).stdout.splitlines()
        if (
            type(line) is not int
            or not 1 <= line <= len(lines)
            or ref["text"].strip() not in lines[line - 1].strip()
        ):
            raise ValueError(
                f"Ссылка матрицы расходится с final.bundle: {filename}:{line}"
            )
        return f"{filename}:{line}", lines[line - 1].strip()

    code_file, code_text = evidence(link["code_ref"])
    test_file, test_text = evidence(link["assertion"])

    pair_source = f"{base.path.name}  /  {opt.path.name}"
    scenes = [
        Scene(
            "Расход на принятую фичу",
            f"{base.manifest['feature_id']} · изменение RPT одной пары {savings:.2f}%.",
            [f"Модель   {base.manifest['model']}", f"Пара     {label}"],
            pair_source,
            16,
            bars=(("Base", total_a), ("Opt", total_b)),
        ),
        Scene(
            "Одинаковые входы",
            "Архив фиксирует настройки провайдера, исходный коммит и текст задания.",
            [
                f"Репозиторий   {base.manifest['repo']['url']}",
                f"Коммит   {base.manifest['repo']['commit']}",
                f"Требования SHA-256   {base.manifest['requirements_hash']}",
                f"OpenSpec   {base.manifest['versions']['openspec']}     opencode   {base.manifest['versions']['opencode']}",
            ],
            source(base, "manifest.json"),
            16,
        ),
        Scene(
            "Что изменили в opt",
            "В манифестах пары перечислены активные флаги и версия инструмента.",
            [
                "Base   все флаги выключены",
                "Opt   "
                + ", ".join(k for k, v in sorted(opt.manifest["flags"].items()) if v),
                f"Версия Frugal   {opt.manifest['versions']['frugal']}",
            ],
            source(opt, "manifest.json"),
            13,
        ),
    ]
    for arm, label_arm in [(base, "base"), (opt, "opt")]:
        cmd, out = replay(arm, workspace)
        scenes.append(
            Scene(
                f"Пересчёт плеча {label_arm}",
                "Временный вывод CLI побайтно согласован с контрольными отпечатками архива.",
                [out],
                source(arm, "meter.json"),
                15,
                cmd,
            )
        )
        scenes.append(raw_call_scene(arm, label_arm))
    files = run(
        [*git, "ls-tree", "-r", "--name-only", link["final_commit"]]
    ).stdout.splitlines()
    context_files = [
        p
        for p in files
        if re.search(r"(?:^|/)(?:capsules?|handoff)(?:/|[._-])", p, re.I)
        and p.endswith((".md", ".json", ".txt"))
    ]
    if context_files:
        name = sorted(context_files)[0]
        excerpt = run([*git, "show", f"{link['final_commit']}:{name}"]).stdout
        excerpt_rows = [r for r in excerpt.splitlines() if r.strip()][:3]
        if excerpt_rows:
            scenes.append(
                Scene(
                    "Сохранённый контекст задачи",
                    "Фрагмент исходного файла оптимизированного плеча. В архиве доступно полное содержимое.",
                    [
                        name,
                        *[
                            r[:160] + ("…" if len(r) > 160 else "")
                            for r in excerpt_rows
                        ],
                    ],
                    source(opt, "final.bundle"),
                    15,
                )
            )
    for i in range(0, len(stages), 5):
        scenes.append(
            Scene(
                "Вклад стадий",
                "Вклад в процентных пунктах рассчитан относительно RPT базового плеча.",
                [header, *stages[i : i + 5]],
                pair_source,
                15,
            )
        )
    scenes.append(
        Scene(
            "Кэш и выход модели",
            "RPT включает непересекающиеся компоненты usage. Денежная оценка записана отдельно.",
            [
                f"{k:18} {base.tokens[k]:>9,}   {opt.tokens[k]:>9,}"
                for k in report.TOKENS
            ]
            + [f"Стоимость из usage   {base.cost}   /   {opt.cost}"],
            pair_source,
            17,
        )
    )
    scenes.extend(
        [
            Scene(
                "Требование и сценарий",
                "Начинаем с одной строки принятой матрицы и прослеживаем её до конкретного теста.",
                [
                    f"Требование   {link['req_id']}",
                    f"Сценарий   {link['scenario_id']}",
                    f"Задача   {', '.join(map(str, link['task_ids']))}",
                    f"Спецификация   {link['spec_ref']}",
                    f"Design   {link['design_ref']}",
                ],
                source(opt, "quality/trace.json"),
                17,
            ),
            Scene(
                "Реализация требования",
                "Строка прочитана командой git show на финальном SHA из архива.",
                [code_file, code_text, f"Коммит   {link['final_commit']}"],
                source(opt, "final.bundle"),
                17,
            ),
            Scene(
                "Проверяемое утверждение",
                f"Тест {link['test_id']}",
                [
                    test_file,
                    test_text,
                    f"Вердикт   {link['verdict']}",
                    f"Результат   {link['run_result_ref']}",
                ],
                source(opt, "quality/trace.json"),
                17,
            ),
            Scene(
                "Приёмка обоих плеч",
                "Гейты сравнивают проверенные сценарии, задачи, регрессии и раунды ревью.",
                [
                    f"{key:16}  {base.metrics[key]}   /   {opt.metrics[key]}"
                    for key in (*report.QUALITY, "Q_hidden", "R")
                ],
                source(opt, "quality/gates.json"),
                16,
            ),
            Scene(
                "Успешность всех попыток",
                "В знаменатель входят все зарегистрированные попытки этой серии.",
                [
                    f"{branch}: принято {sum(a.accepted for a in selected)} из {len(selected)}"
                    for branch in ("base", "opt")
                    if (
                        selected := [
                            a for a in members if a.manifest["branch"] == branch
                        ]
                    )
                ]
                + [f"Серия   {base.manifest['series_id']}"],
                "REPORT.md · таблица серии",
                14,
            ),
        ]
    )
    eligible = [(name, arms) for name, (arms, _) in pairs.items() if arms]
    across = sorted(
        {
            (pair[0].manifest["model"], pair[0].manifest["repo"]["url"])
            for _, pair in eligible
        }
    )
    scenes.append(
        Scene(
            "Границы переноса",
            "В таблицу вошли модели и репозитории из полных сопоставимых пар.",
            [f"{model}  ·  {repo}" for model, repo in across[:4]],
            "REPORT.md · сопоставимые пары",
            15,
        )
    )
    scenes.append(
        Scene(
            "Результат этой пары",
            "Отчёт можно воспроизвести по исходным событиям и матрицам качества.",
            [
                f"RPT base     {total_a:,}",
                f"RPT opt      {total_b:,}",
                f"Экономия     {savings:.2f}%",
                f"Полные сопоставимые пары в архиве    {len(eligible)}",
            ],
            "REPORT.md  ·  dashboard.html",
            15,
        )
    )
    return scenes


@lru_cache
def font(size, mono=False):
    candidates = (
        [
            "/System/Library/Fonts/Menlo.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        ]
        if mono
        else [
            "/System/Library/Fonts/HelveticaNeue.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    )
    setting = os.environ.get("FRUGAL_FONT_MONO" if mono else "FRUGAL_FONT")
    for name in [setting, *candidates]:
        if name and Path(name).is_file():
            return ImageFont.truetype(name, size)
    raise ValueError(
        "Укажите пути к шрифтам с кириллицей в FRUGAL_FONT и FRUGAL_FONT_MONO"
    )


def wrap(value, face, width):
    lines = []
    for paragraph in str(value).expandtabs(3).splitlines():
        line = ""
        for c in paragraph:
            if face.getlength(line + c) > width:
                split = line.rfind(" ")
                if split > len(line) // 2:
                    lines.append(line[:split].rstrip())
                    line = line[split + 1 :]
                else:
                    lines.append(line.rstrip())
                    line = ""
            line += c
        if line.strip():
            lines.append(line.rstrip())
    return lines


def frame(scene, label, scene_no, total, progress):
    image = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(image)

    def text(x, y, s, f, color):
        draw.text((x, y), s, font=f, fill=color, stroke_width=0, anchor="lt")

    draw.rectangle((0, 0, W, 8), fill="#233d47")
    draw.rectangle((0, 0, round(W * progress), 8), fill=TEAL)
    text(60, 38, "FRUGAL  /  SDD", font(22, True), TEAL)
    text(355, 39, label, font(21), MUTE)
    count = f"{scene_no:02} / {total:02}"
    text(W - 60 - font(20, True).getlength(count), 40, count, font(20, True), MUTE)
    text(58, 98, scene.title, font(51), FG)
    for caption_size in range(27, 18, -1):
        caption = wrap(scene.text, font(caption_size), W - 120)
        if len(caption) <= 2:
            break
    else:
        raise ValueError(f"Подпись не помещается в кадр: {scene.title}")
    for i, line in enumerate(caption):
        text(60, 171 + 33 * i, line, font(caption_size), MUTE)
    start = 235
    if scene.command:
        cmd_font = font(17, True)
        cmd = wrap("$ " + scene.command, cmd_font, W - 160)
        # Keep the full invocation visible even for long run IDs.
        if len(cmd) > 4:
            raise ValueError("Команда не помещается в кадр; сократите путь к архиву")
        for i, line in enumerate(cmd):
            text(70, start + i * 23, line, cmd_font, TEAL)
        start += len(cmd) * 23 + 15
    if scene.bars:
        peak = max(v for _, v in scene.bars) or 1
        for i, (name, value) in enumerate(scene.bars):
            y = start + i * 46
            text(66, y + 5, name, font(21), MUTE)
            draw.rounded_rectangle((255, y + 5, 885, y + 27), radius=6, fill="#273b48")
            width = round(630 * value / peak)
            if width:
                draw.rounded_rectangle(
                    (255, y + 5, 255 + width, y + 27),
                    radius=6,
                    fill=(TEAL if i else "#7ea2c6"),
                )
            text(923, y + 2, format(value, ","), font(24, True), FG)
        start += len(scene.bars) * 46 + 12
    draw.rounded_rectangle((53, start, W - 53, 609), radius=12, fill="#192b38")
    available = 609 - start - 36
    for size in range(25, 16, -1):
        lines = [
            line for row in scene.rows for line in wrap(row, font(size, True), W - 156)
        ]
        if len(lines) * (size + 9) <= available:
            break
    else:
        raise ValueError(f"Содержимое сцены не помещается в кадр: {scene.title}")
    for i, line in enumerate(lines):
        text(77, start + 20 + i * (size + 9), line, font(size, True), FG)
    footer_font = font(18, True)
    foot = wrap(scene.source, footer_font, W - 120)
    if len(foot) > 2:
        raise ValueError(f"Ссылка на источник слишком длинная: {scene.source}")
    for i, line in enumerate(foot):
        text(60, 643 + i * 23, line, footer_font, "#a9c8c5")
    return image


def encode(scenes, label, dest, work):
    total_seconds = sum(s.seconds for s in scenes)
    playlist = work / "frames.ffconcat"
    lines = ["ffconcat version 1.0"]
    elapsed = 0
    for i, scene in enumerate(scenes):
        still = frame(scene, label, i + 1, len(scenes), (elapsed + 1) / total_seconds)
        # Advance the timeline while the viewer reads. Text appears in full from the first frame.
        for tick in range(scene.seconds):
            path = work / f"frame-{i:02}-{tick:02}.png"
            if tick:
                # Only the top strip changes between whole seconds.
                canvas = still.copy()
                ImageDraw.Draw(canvas).rectangle(
                    (0, 0, round(W * (elapsed + tick + 1) / total_seconds), 8),
                    fill=TEAL,
                )
            else:
                canvas = still
            canvas.save(path, compress_level=2)
            lines.extend([f"file '{path.name}'", "duration 1"])
        elapsed += scene.seconds
    lines.append(f"file '{path.name}'")
    playlist.write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = work / "video.mp4"
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "1",
            "-i",
            str(playlist),
            "-t",
            str(total_seconds),
            "-vf",
            f"fps={FPS},format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-threads",
            "2",
            "-movflags",
            "+faststart",
            str(result),
        ]
    )
    probe = json.loads(
        run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_streams",
                "-of",
                "json",
                str(result),
            ]
        ).stdout
    )["streams"][0]
    if (
        probe["codec_name"],
        probe["width"],
        probe["height"],
        probe["r_frame_rate"],
    ) != ("h264", W, H, f"{FPS}/1"):
        raise ValueError(
            "Кодек, размеры или частота кадров расходятся с параметрами записи"
        )
    if (
        abs(float(probe["duration"]) - total_seconds) > 1 / FPS
        or int(probe["nb_frames"]) != total_seconds * FPS
    ):
        raise ValueError("Длительность или количество кадров расходится со сценарием")
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-xerror",
            "-nostdin",
            "-i",
            str(result),
            "-f",
            "null",
            "-",
        ]
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Move a fully decoded file into place. The temporary directory can be on a different mount.
    with tempfile.NamedTemporaryFile(
        dir=dest.parent, suffix=".mp4", delete=False
    ) as temp:
        working_dest = Path(temp.name)
    try:
        shutil.copyfile(result, working_dest)
        os.replace(working_dest, dest)
    finally:
        working_dest.unlink(missing_ok=True)
    return {
        "path": str(dest),
        "seconds": total_seconds,
        "frames": int(probe["nb_frames"]),
        "fps": FPS,
        "resolution": [W, H],
        "codec": probe["codec_name"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runs", type=Path)
    kind = parser.add_mutually_exclusive_group(required=True)
    kind.add_argument("--preview", metavar="MOCK_CHILD_RUN")
    kind.add_argument("--pair", metavar="PAIR_ID")
    kind.add_argument("--prototype", metavar="MOCK_PAIR_ID")
    parser.add_argument("--h03", type=Path, metavar="FIXTURE_JSON")
    parser.add_argument("--live-smoke", type=Path, metavar="ARCHIVED_RUN_DIR")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if (args.h03 or args.live_smoke) and not args.prototype:
        parser.error("Параметры --h03 и --live-smoke применяются с --prototype")
    filename = "demo.mp4"
    if args.preview:
        filename = "preflight.mp4"
    elif args.prototype:
        filename = "prototype.mp4"
    dest = (args.out or ROOT / "report" / filename).resolve()
    if (args.preview or args.prototype) and dest.name.casefold() == "demo.mp4":
        parser.error("Имя demo.mp4 зарезервировано для принятой живой A/B-пары")
    try:
        attempts, pairs = report.collect(args.runs.resolve())
        with tempfile.TemporaryDirectory(prefix="frugal-video-") as folder:
            work = Path(folder)
            if args.preview:
                selected = next(
                    (
                        a
                        for a in attempts
                        if a.path.name == args.preview
                        and a.manifest.get("kind") == "meter-smoke"
                    ),
                    None,
                )
                if selected is None:
                    raise ValueError("Технический запуск отсутствует")
                scenes = preview_scenes(selected, work)
                live = [
                    a
                    for a in attempts
                    if a.live
                    and a.meter_ok
                    and not a.errors
                    and a.manifest.get("kind") == "meter-smoke"
                    and (a.path / "raw/provider-response.sse").is_file()
                ]
                if live:
                    arm = sorted(live, key=lambda a: a.path.name)[0]
                    cmd, out = replay(arm, work)
                    result = report.read_json(arm.path / "reconciliation.json")
                    if result.get("matched") and result.get("provider_rpt") == arm.rpt:
                        scenes.extend(
                            [
                                Scene(
                                    "Один ответ настоящей модели",
                                    f"{arm.manifest['model']} · отдельная проверка единственного запроса.",
                                    [out],
                                    source(arm, "meter.json"),
                                    10,
                                    cmd,
                                ),
                                Scene(
                                    "Сверка ответа провайдера",
                                    "Числа получены из одного технического шага. Для оценки экономии нужна полная A/B-пара.",
                                    [
                                        f"Вход   {arm.tokens['t_in']}",
                                        f"Выход   {arm.tokens['t_out']}",
                                        f"Расхождение   {result['relative_discrepancy']:.2%}",
                                    ],
                                    source(arm, "raw/provider-response.sse"),
                                    9,
                                    bars=(
                                        ("Провайдер", result["provider_rpt"]),
                                        ("Измеритель", arm.rpt),
                                    ),
                                ),
                            ]
                        )
                label = "Техническая репетиция  /  проверка учёта"
            elif args.prototype:
                h03 = args.h03 or ROOT / "bench/runs/summary/h03-native-loopback.json"
                scenes = prototype_scenes(
                    attempts,
                    args.prototype,
                    h03.resolve(),
                    work,
                    args.live_smoke.resolve() if args.live_smoke else None,
                )
                label = "Демонстрация прототипа  /  офлайн"
            else:
                scenes = final_scenes(attempts, pairs, args.pair, work)
                if not 240 <= sum(s.seconds for s in scenes) <= 360:
                    raise ValueError(
                        "Длительность финальной записи выходит за пределы 4–6 минут"
                    )
                label = "Офлайн-повтор  /  живая A/B-пара"
            result = encode(scenes, label, dest, work)
            print(json.dumps(result, ensure_ascii=False))
    except (
        KeyError,
        TypeError,
        ValueError,
        OSError,
        subprocess.CalledProcessError,
    ) as exc:
        parser.exit(1, str(exc) + "\n")


if __name__ == "__main__":
    main()
