"""Recompute paired measurements from local run archives."""

import argparse
import hashlib
import html
import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from math import comb
from pathlib import Path
from statistics import median
from urllib.parse import quote

TOKENS = ("t_in", "t_cache_read", "t_cache_write", "t_out", "t_reasoning")
CONTROLS = (
    "feature_id",
    "repo",
    "provider",
    "model",
    "params",
    "versions",
    "requirements_hash",
    "test_oracle_hash",
    "baseline_hash",
    "config_hash",
    "expected_hash",
    "profile",
)
QUALITY = ("Cov_req", "Cov_scn", "Cov_task", "Cov_expected", "Green", "Cons")
CHECKS = ("validate", "consistency", "trace", "full_suite", "review", "semantic")
ATTEMPT_COLUMNS = (
    "Запуск",
    "Тип",
    "Плечо",
    "Модель",
    "RPT",
    "Стоимость / списание Go",
    "Стоимость по прайсу Go, $",
    "Расход квоты Go",
    "Состояние",
)
STAGE_NAMES = {
    "propose": "Предложение",
    "spec": "Спецификация",
    "specs": "Требования",
    "design": "Проектирование",
    "tasks": "Задачи",
    "apply": "Реализация",
    "review": "Ревью",
    "fix": "Исправления",
    "verify": "Проверка",
    "other": "Прочее",
}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


@dataclass
class Attempt:
    path: Path
    manifest: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)
    stages: Counter = field(default_factory=Counter)
    tokens: Counter = field(default_factory=Counter)
    model_calls: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    qa_receipt: dict = field(default_factory=dict)
    qa_receipt_error: str | None = None
    meter_ok: bool = False
    quality_ok: bool = False
    cost: float | None = None
    list_cost: float | None = None
    allowance: float | None = None

    @property
    def rpt(self):
        return sum(self.stages.values()) if self.meter_ok else None

    @property
    def live(self):
        return self.manifest.get("dry_run") is False

    @property
    def technical(self):
        return (
            self.manifest.get("kind") == "meter-smoke"
            or self.manifest.get("purpose") == "go-smoke"
        )

    @property
    def archived_baseline(self):
        m = self.manifest
        return (
            self.live
            and not self.technical
            and m.get("mode") == "baseline"
            and m.get("status") in {"complete", "failed", "interrupted"}
        )

    @property
    def billing_values(self):
        return [
            value if value is not None else "—"
            for value in (self.cost, self.list_cost, self.allowance)
        ]

    @property
    def accepted(self):
        return (
            self.live
            and not self.technical
            and self.rpt is not None
            and self.quality_ok
            and not self.errors
        )

    @property
    def qa_receipt_path(self):
        return self.path.parent / "summary" / f"{self.path.name}-quality.json"

    @property
    def process_diagnostic_path(self):
        return (
            self.path.parent / "summary" / f"{self.path.name}-process-diagnostic.json"
        )


def inspect_usage(a):
    m = a.manifest
    summary = read_json(a.path / "meter.json")
    raw_digests = summary.get("raw_sha256", {})
    if not raw_digests and a.live:
        raise ValueError("нет отпечатков первичных данных")
    for relative, expected in raw_digests.items():
        source = (a.path / relative).resolve()
        if (
            not source.is_relative_to((a.path / "raw").resolve())
            or sha256(source) != expected
        ):
            raise ValueError("изменились первичные данные: " + relative)
    calls_file = a.path / "calls.jsonl"
    if summary.get("sha256", {}).get("calls.jsonl") != sha256(calls_file):
        raise ValueError("отпечаток calls.jsonl расходится с meter.json")
    if summary.get("run_id") != m["run_id"] or summary.get("dry_run") != m["dry_run"]:
        raise ValueError("расход и манифест описывают разные запуски")
    if not summary.get("complete"):
        raise ValueError("учёт неполон: " + ", ".join(summary.get("issues", [])))
    keys = set()
    with calls_file.open(encoding="utf-8") as source:
        for line in source:
            call = json.loads(line)
            key = call["event_key"]
            if call["run_id"] != m["run_id"] or call["branch"] != m["branch"]:
                raise ValueError("строка calls.jsonl относится к другому плечу")
            if key in keys or call.get("usage_status") != "known":
                raise ValueError("повтор или неизвестный расход: " + key)
            keys.add(key)
            if (
                call.get("provider_id") != m["provider"]
                or call.get("model") != m["model"]
            ):
                raise ValueError("модель или провайдер расходится с манифестом")
            if not all(type(call[k]) is int and call[k] >= 0 for k in TOKENS):
                raise ValueError("некорректная компонента usage")
            source_ref = call["raw_ref"].split("#")[0]
            source_path = (a.path / source_ref).resolve()
            if (
                not source_path.is_relative_to(a.path.resolve())
                or not source_path.is_file()
            ):
                raise ValueError("нет первичного события: " + source_ref)
            total = sum(call[k] for k in TOKENS)
            a.tokens.update({k: call[k] for k in TOKENS})
            a.stages[call["stage"]] += total
            a.model_calls.append((total, call["stage"], call["raw_ref"]))
    if (
        not keys
        or len(keys) != summary.get("call_count")
        or sum(a.stages.values()) != summary["rpt"]
    ):
        raise ValueError("число вызовов или RPT расходится с meter.json")
    stages = {k: v["rpt"] for k, v in summary["by_stage"].items() if v["call_count"]}
    if stages != dict(a.stages):
        raise ValueError("итоги стадий расходятся с meter.json")
    crosscheck = a.path / "reconciliation.json"
    if crosscheck.exists():
        evidence = read_json(crosscheck)
        if evidence.get("matched") is False or evidence.get("fields_match") is False:
            raise ValueError(
                "первичный источник расходится с нормализованной разбивкой"
            )
    billing = summary.get("opencode_billing") or {}
    a.list_cost = billing.get("list_cost")
    a.allowance = billing.get("allowance")
    a.cost = summary.get("cost")
    a.meter_ok = True


def inspect_quality(a):
    gates = read_json(a.path / "quality" / "gates.json")
    trace = read_json(a.path / "quality" / "trace.json")
    m = a.manifest
    if not m.get("final_commit") or not all(
        x.get("final_commit") == m["final_commit"] for x in [gates, trace]
    ):
        raise ValueError("привязка QA к финальному коммиту отсутствует")
    a.metrics = gates["metrics"]
    checks = gates["checks"]
    hidden = gates["suites"]["hidden"]
    if not trace.get("rows") or not all(a.metrics.get(k) == 1 for k in QUALITY):
        raise ValueError("неполное покрытие или непройденные обязательные проверки")
    if not (gates.get("ok") and all(checks.get(k, {}).get("ok") for k in CHECKS)):
        raise ValueError("есть открытые замечания QA")
    if not hidden["total"] or hidden["skipped"] or not 0 <= a.metrics["Q_hidden"] <= 1:
        raise ValueError("отсутствует полный результат закрытой приёмки")
    if not 1 <= a.metrics["R"] <= 5:
        raise ValueError("не подтверждено обязательное ревью")
    if m.get("accepted") is not True:
        raise ValueError("итоговая приёмка запуска не подтверждена")
    a.quality_ok = True


def inspect_qa_receipt(a):
    if not a.qa_receipt_path.is_file():
        return
    receipt = read_json(a.qa_receipt_path)
    if (
        receipt["run_id"] != a.manifest["run_id"]
        or receipt["final_commit"] != a.manifest.get("final_commit")
        or receipt["manifest_sha256"] != sha256(a.path / "manifest.json")
    ):
        raise ValueError("сводка независимой приёмки расходится с манифестом")
    if type(receipt["signed_quality"]["passed"]) is not bool:
        raise ValueError("сводка независимой приёмки не содержит решения")
    for kind in ("public", "hidden"):
        totals = receipt["tests"][kind]
        if not 0 <= totals["passed"] <= totals["observed"]:
            raise ValueError("некорректные итоги независимой приёмки")
    if not 0 <= receipt["review_rounds"] <= 5:
        raise ValueError("некорректное число раундов независимой приёмки")
    a.qa_receipt = receipt


def inspect_run(path):
    a = Attempt(path)
    try:
        a.manifest = read_json(path / "manifest.json")
        if a.manifest["run_id"] != path.name:
            raise ValueError("имя каталога расходится с run_id")
    except (OSError, KeyError, ValueError, TypeError) as exc:
        a.errors.append(str(exc))
        return a
    if a.manifest.get("status") == "running":
        a.errors.append("выполняется")
        return a
    checks = [inspect_usage]
    if a.live and not a.technical and a.manifest.get("pipeline_complete") is not False:
        checks.append(inspect_quality)
        try:
            inspect_qa_receipt(a)
        except (OSError, KeyError, ValueError, TypeError):
            a.qa_receipt_error = (
                "Открытая сводка независимой приёмки не прошла проверку."
            )
    for check in checks:
        try:
            check(a)
        except (OSError, KeyError, ValueError, TypeError, AttributeError) as exc:
            a.errors.append(str(exc).replace(str(path) + "/", ""))
    if a.manifest.get("status") != "complete":
        a.errors.append("статус: " + str(a.manifest.get("status")))
    return a


def compare_arms(arms):
    if sorted(a.manifest.get("branch", "") for a in arms) != ["base", "opt"]:
        return None, "нужно по одному плечу base и opt"
    base, opt = sorted(arms, key=lambda a: a.manifest["branch"])
    if not all(a.accepted for a in [base, opt]):
        return None, "нет полного замера и приёмки обоих плеч"
    for key in CONTROLS:
        if base.manifest.get(key) is None or base.manifest[key] != opt.manifest.get(
            key
        ):
            return None, "различается или отсутствует контроль: " + key
    images = [a.manifest.get("isolation", {}).get("image") for a in (base, opt)]
    if not images[0] or images[0] != images[1]:
        return None, "различаются образы стенда"
    if any(base.manifest["flags"].values()):
        return None, "в baseline включена оптимизация"
    if not base.rpt:
        return None, "нулевой знаменатель RPT"
    return (base, opt), ""


def collect(root):
    # Harness uses subdirectories for series reservations in addition to run directories.
    attempts = [inspect_run(p.parent) for p in sorted(root.glob("*/manifest.json"))]
    for path in sorted(root.glob("*/calls.jsonl")):
        if not (path.parent / "manifest.json").is_file():
            attempts.append(inspect_run(path.parent))
    pairs = defaultdict(list)
    for a in attempts:
        if a.live and not a.technical and a.manifest.get("pair_id"):
            pairs[a.manifest["pair_id"]].append(a)
    return attempts, {key: compare_arms(arms) for key, arms in sorted(pairs.items())}


def esc_md(value):
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("|", r"\|")
        .replace("\n", " ")
    )


def ref(out, path):
    return quote(os.path.relpath(path, out), safe="/.")


def table(headings, rows):
    values = [headings, ["---"] * len(headings), *rows]
    return "\n".join("| " + " | ".join(map(str, row)) + " |" for row in values)


def sign_p(ratios):
    n = sum(r != 1 for r in ratios)
    wins = sum(r < 1 for r in ratios)
    return sum(comb(n, i) for i in range(wins, n + 1)) / (2**n)


def kind_of(a):
    if a.manifest.get("purpose") == "go-smoke":
        return "проверка OpenCode Go · " + ("модель" if a.live else "mock")
    if a.manifest.get("kind") == "meter-smoke":
        return "проверка счётчика · " + ("модель" if a.live else "mock")
    if a.live:
        return "модель"
    return "репетиция" if a.manifest.get("dry_run") is True else "неизвестно"


def series_quality_issues(members):
    by_arm = defaultdict(list)
    for a in members:
        by_arm[a.manifest.get("branch")].append(a)
    if not all(by_arm.get(k) for k in ("base", "opt")):
        return ["отсутствует плечо base или opt"]
    base, opt = by_arm["base"], by_arm["opt"]
    issues = []
    if any(a.manifest.get("status") in ("running", "interrupted") for a in members):
        issues.append("есть незавершённые попытки")
    if sum(a.accepted for a in opt) / len(opt) < sum(a.accepted for a in base) / len(
        base
    ):
        issues.append("P_success уменьшилась")
    if any(
        not a.metrics or a.metrics.get("Q_hidden") is None or a.metrics.get("R") is None
        for a in members
    ):
        issues.append("неполные данные закрытых тестов или ревью")
    else:
        b_hidden = [a.metrics["Q_hidden"] for a in base]
        o_hidden = [a.metrics["Q_hidden"] for a in opt]
        if median(o_hidden) < median(b_hidden) or (
            1 in b_hidden and median(o_hidden) != 1
        ):
            issues.append("снизилась медиана закрытой приёмки")
        if median(a.metrics["R"] for a in opt) > median(a.metrics["R"] for a in base):
            issues.append("выросла медиана раундов ревью")
    if any(not a.quality_ok for a in opt):
        issues.append("неполное подтверждение покрытия и согласованности")
    return issues


def summarize_series(attempts):
    series = defaultdict(list)
    for a in attempts:
        m = a.manifest
        if a.live and not a.technical and m.get("series_id"):
            series[m["series_id"]].append(a)
    result = []
    for name, members in sorted(series.items()):
        result.append("## Серия " + esc_md(name))
        rows = []
        by_arm = defaultdict(list)
        for a in members:
            by_arm[a.manifest.get("branch")].append(a)
        for branch, arms in sorted(by_arm.items()):
            accepted = sum(a.accepted for a in arms)
            measured = [a.rpt for a in arms if a.rpt is not None]
            rows.append(
                [
                    esc_md(branch),
                    len(arms),
                    accepted,
                    f"{accepted / len(arms):.1%}",
                    sum(measured) if len(measured) == len(arms) else "неполный учёт",
                    f"{sum(measured) / accepted:.1f}"
                    if accepted and len(measured) == len(arms)
                    else "—",
                ]
            )
        result.append(
            table(
                [
                    "Плечо",
                    "Попыток",
                    "Принято",
                    "P_success",
                    "RPT всех попыток",
                    "RPT на принятую фичу",
                ],
                rows,
            )
        )
        if not all(by_arm.get(k) for k in ("base", "opt")):
            continue
        issues = series_quality_issues(members)
        result.append(
            "Сравнение качества по §4.3: "
            + (
                ", ".join(issues)
                if issues
                else "пороги соблюдены на собранных попытках"
            )
            + "."
        )
    return result


def elapsed_seconds(interval):
    start, end = interval.get("started_at"), interval.get("finished_at")
    if not isinstance(start, str) or not isinstance(end, str):
        return None
    try:
        duration = (
            datetime.fromisoformat(end) - datetime.fromisoformat(start)
        ).total_seconds()
    except (TypeError, ValueError):
        return None
    return duration if duration >= 0 else None


def baseline_stage_usage(a):
    stage_calls = Counter(stage for _, stage, _ in a.model_calls)
    durations = defaultdict(list)
    for interval in a.manifest.get("stages", []):
        durations[interval["stage"]].append(elapsed_seconds(interval))
    stage_order = {stage: i for i, stage in enumerate(STAGE_NAMES)}
    stages = sorted(
        a.stages, key=lambda stage: (stage_order.get(stage, len(stage_order)), stage)
    )
    for stage in stages:
        times = durations[stage]
        seconds = f"{sum(times):.1f}" if times and None not in times else "—"
        yield stage, stage_calls[stage], a.stages[stage], seconds


def report_baseline(a, out):
    m = a.manifest
    qa = a.qa_receipt
    signed_quality = qa.get("signed_quality", {})
    parts = [f"### Живой B0 · {esc_md(a.path.name)}"]
    if m.get("pipeline_complete") is False:
        parts.append(
            "Конвейер остановился до итоговой приёмки. Метрики качества отсутствуют."
        )
        diagnostic = a.process_diagnostic_path
        if diagnostic.is_file():
            parts.append(f"[Диагностика остановки конвейера]({ref(out, diagnostic)})")
    elapsed = elapsed_seconds(m)
    if elapsed is not None:
        parts.append(f"Длительность прогона по манифесту — {elapsed:.1f} с.")
    if a.meter_ok:
        parts.extend(
            [
                f"RPT **{a.rpt}**, модельных вызовов **{len(a.model_calls)}**.",
                table(
                    ["Стадия", "Вызовы", "RPT", "Доля RPT", "Длительность, с"],
                    [
                        [
                            esc_md(STAGE_NAMES.get(stage, stage)),
                            calls,
                            rpt,
                            f"{rpt / a.rpt:.1%}" if a.rpt else "—",
                            seconds,
                        ]
                        for stage, calls, rpt, seconds in baseline_stage_usage(a)
                    ],
                ),
            ]
        )
    gates = m.get("gates") or {}
    suites = gates.get("suites", {})
    metrics = gates.get("metrics", {})
    quality_rows = []
    if suites:
        public, hidden = (suites.get(kind, {}) for kind in ("public", "hidden"))
        automated_status = (
            "до независимой оценки" if qa else "ожидают независимой оценки"
        )
        if m.get("assessment_sha256"):
            automated_status = (
                "приёмка подтверждена" if m["accepted"] else "приёмка отклонена"
            )
        quality_rows.append(
            [
                "Автоматические гейты · " + automated_status,
                f"{public.get('passed', '—')}/{public.get('total', '—')}",
                f"{hidden.get('passed', '—')}/{hidden.get('total', '—')}",
                metrics.get("R", "—"),
            ]
        )
    if qa:
        verdict = "снимок принят" if signed_quality["passed"] else "снимок отклонён"
        quality_rows.append(
            [
                "Независимая подписанная приёмка · " + verdict,
                *[
                    f"{qa['tests'][kind]['passed']}/{qa['tests'][kind]['observed']}"
                    for kind in ("public", "hidden")
                ],
                qa["review_rounds"],
            ]
        )
    if quality_rows:
        parts.append(
            table(
                ["Оценка", "Публичные тесты", "Закрытые тесты", "Раунды ревью"],
                quality_rows,
            )
        )
    if qa:
        checks = ", ".join(
            esc_md(check) for check in signed_quality.get("failed_checks", [])
        )
        if checks:
            parts.append(f"Гейты, отклонившие итоговый снимок — {checks}.")
        parts.extend(esc_md(defect) for defect in qa.get("public_contract_defects", []))
        frozen = qa.get("frozen_public_replay")
        if frozen:
            parts.append(
                f"Независимый повтор замороженной регрессии подтвердил "
                f"{frozen['original_inventory_passed']}/{frozen['original_inventory_total']} исходных тестов. "
                f"Расширенный отбор включил новые тесты и дал {frozen['passed']}/{frozen['total']}."
            )
        parts.append(
            f"[Открытая сводка независимой приёмки]({ref(out, a.qa_receipt_path)})"
        )
        frozen_replay = a.qa_receipt_path.with_name(f"{a.path.name}-frozen-replay.json")
        if frozen_replay.is_file():
            parts.append(
                f"[Отдельная перепроверка замороженной регрессии]({ref(out, frozen_replay)})"
            )
    if a.qa_receipt_error:
        parts.append(a.qa_receipt_error)
    files = (
        "manifest.json",
        "meter.json",
        "stages.csv",
        "calls.jsonl",
        "raw/relay.jsonl",
    )
    parts.append(
        " · ".join(
            f"[{p}]({ref(out, a.path / p)})" for p in files if (a.path / p).is_file()
        )
    )
    return parts


def report_parts(attempts, pairs, out):
    valid = [(name, *arms) for name, (arms, _) in pairs.items() if arms]
    parts = [
        "# Frugal SDD · результаты",
        "Отчёт пересчитан из сохранённых событий вызовов и итогов приёмки.",
    ]
    if not valid:
        parts.append(
            "**Экономия пока не установлена. В архиве нет полной сопоставимой A/B-пары с проверенным расходом и качеством.**"
        )
    rows = []
    for a in attempts:
        m = a.manifest
        mid = esc_md(a.path.name)
        link = f"[{mid}]({ref(out, a.path / 'manifest.json')})" if m else mid
        kind = kind_of(a)
        details = "; ".join(a.errors) if a.errors else "проверен"
        rows.append(
            [
                link,
                kind,
                esc_md(m.get("branch", "—")),
                esc_md(m.get("model", "—")),
                a.rpt if a.rpt is not None else "—",
                *a.billing_values,
                esc_md(details),
            ]
        )
    parts.extend(
        [
            "## Все попытки",
            table(ATTEMPT_COLUMNS, rows) if rows else "Архив пока пуст.",
        ]
    )
    for a in attempts:
        if a.technical and a.meter_ok:
            parts.append(f"### Проверка счётчика · {esc_md(a.path.name)}")
            parts.append(
                table(
                    [
                        "Вход без кэша",
                        "Чтение кэша",
                        "Запись кэша",
                        "Выход",
                        "Reasoning",
                        "RPT",
                    ],
                    [[*[a.tokens[k] for k in TOKENS], a.rpt]],
                )
            )
            files = [
                "calls.jsonl",
                "meter.json",
                "raw/events.jsonl",
                "raw/opencode.db",
                "raw/relay.jsonl",
                "reconciliation.json",
            ]
            parts.append(
                " · ".join(
                    f"[{p}]({ref(out, a.path / p)})"
                    for p in files
                    if (a.path / p).is_file()
                )
            )
    parts.extend(summarize_series(attempts))
    for a in attempts:
        if a.archived_baseline:
            parts.extend(report_baseline(a, out))
    groups = defaultdict(list)
    for label, base, opt in valid:
        name = esc_md(label)
        ratio = opt.rpt / base.rpt
        parts += [
            f"## Пара {name}",
            f"RPT {base.rpt} → {opt.rpt}. Экономия этой пары **{100 * (1 - ratio):.2f}%**.",
            table(
                ["Стадия", "Base", "Opt", "Вклад, п. п."],
                [
                    [
                        esc_md(STAGE_NAMES.get(s, s)),
                        base.stages[s],
                        opt.stages[s],
                        f"{100 * (base.stages[s] - opt.stages[s]) / base.rpt:.2f}",
                    ]
                    for s in sorted(set(base.stages) | set(opt.stages))
                ],
            ),
            table(
                ["Компонента", "Base", "Opt"],
                [[k, base.tokens[k], opt.tokens[k]] for k in TOKENS],
            ),
            table(
                ["Качество", "Base", "Opt"],
                [
                    [k, base.metrics[k], opt.metrics[k]]
                    for k in (*QUALITY, "Q_hidden", "R")
                ],
            ),
        ]
        for arm in (base, opt):
            links = [
                f"[{p}]({ref(out, arm.path / p)})"
                for p in (
                    "calls.jsonl",
                    "meter.json",
                    "quality/trace.json",
                    "quality/gates.json",
                )
            ]
            parts.append(esc_md(arm.manifest["branch"]) + " · " + " · ".join(links))
        group_key = json.dumps(
            [
                base.manifest.get("experiment"),
                *[base.manifest.get(k) for k in CONTROLS],
                opt.manifest["flags"],
            ],
            sort_keys=True,
        )
        groups[group_key].append((base, opt))
    for grouped in groups.values():
        base, opt = zip(*grouped)
        ratios = [o.rpt / b.rpt for b, o in grouped]
        parts.extend(
            [
                f"## {esc_md(base[0].manifest['model'])} · {esc_md(base[0].manifest['feature_id'])}",
                f"Полных пар {len(grouped)}. Разность относительно медианы base составляет {100 * (1 - median(a.rpt for a in opt) / median(a.rpt for a in base)):.2f}%.",
                "Парные отношения opt/base: "
                + ", ".join(f"{r:.4f}" for r in ratios)
                + f". Односторонний знаковый критерий p = {sign_p(ratios):.4f}.",
                "Эти данные описывают полные пары. Для принятия конфигурации требуется сравнение успешности всех попыток серии и условий §4.3.",
            ]
        )
    for name, (_, reason) in pairs.items():
        if reason:
            parts.append(f"Пара {esc_md(name)}: {esc_md(reason)}.")
    return parts


def write_report(root, out):
    if not root.is_dir():
        raise ValueError(f"каталог прогонов отсутствует: {root}")
    attempts, pairs = collect(root)
    parts = report_parts(attempts, pairs, out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "REPORT.md").write_text("\n\n".join(parts) + "\n", encoding="utf-8")
    write_dashboard(attempts, pairs, out)


def esc_html(value):
    return html.escape(str(value), quote=True)


def dashboard_link(out, path, label):
    return f'<a href="{esc_html(ref(out, path))}">{esc_html(label)}</a>'


def dashboard_baseline(a, out):
    manifest = a.manifest
    heading = f"<h3>{esc_html(a.path.name)}</h3>"
    sources = [(a.path / "manifest.json", "Манифест")]
    if manifest.get("pipeline_complete") is False:
        quality = (
            "Конвейер остановился до итоговой приёмки. Метрики качества отсутствуют."
        )
        sources.append((a.process_diagnostic_path, "Диагностика остановки"))
    elif a.qa_receipt:
        qa = a.qa_receipt
        verdict = (
            "снимок принят" if qa["signed_quality"]["passed"] else "снимок отклонён"
        )
        public, hidden = (qa["tests"][kind] for kind in ("public", "hidden"))
        quality = (
            f"Независимая приёмка · {verdict}. "
            f"Публичные тесты {public['passed']}/{public['observed']}, "
            f"закрытые тесты {hidden['passed']}/{hidden['observed']}, "
            f"раунды ревью {qa['review_rounds']}."
        )
        sources.append((a.qa_receipt_path, "Открытая сводка приёмки"))
    elif a.qa_receipt_error:
        quality = a.qa_receipt_error
    elif a.quality_ok:
        quality = "Приёмка подтверждена гейтами."
    else:
        quality = "Итоговая приёмка не подтверждена."

    spend = "<p>Полный расход не подтверждён.</p>"
    if a.meter_ok:
        sources.extend(
            (a.path / name, label)
            for name, label in (
                ("meter.json", "Учёт расхода"),
                ("stages.csv", "Сводка по стадиям"),
                ("calls.jsonl", "Нормализованные вызовы"),
            )
        )
        elapsed = elapsed_seconds(manifest)
        elapsed_label = f" · {elapsed:.1f} с" if elapsed is not None else ""
        rows = []
        for stage, calls, rpt, seconds in baseline_stage_usage(a):
            share = f"{rpt / a.rpt:.1%}" if a.rpt else "—"
            label = esc_html(STAGE_NAMES.get(stage, stage))
            rows.append(
                f'<tr><th scope="row">{label}</th><td>{calls}</td><td>{rpt}</td>'
                f'<td><meter max="{max(a.rpt, 1)}" value="{rpt}" aria-hidden="true"></meter> '
                f"{share}</td><td>{seconds}</td></tr>"
            )
        spend = (
            f"<p><strong>{a.rpt} RPT</strong> · Вызовы модели {len(a.model_calls)}{elapsed_label}</p>"
            '<div class="table-scroll"><table aria-label="Расход по стадиям"><thead><tr>'
            '<th scope="col">Стадия</th><th scope="col">Вызовы</th><th scope="col">RPT</th>'
            '<th scope="col">Доля RPT прогона</th><th scope="col">Время, с</th>'
            f"</tr></thead><tbody>{''.join(rows)}</tbody></table></div>"
        )
    links = " · ".join(
        dashboard_link(out, path, label) for path, label in sources if path.is_file()
    )
    return (
        f'<article class="baseline-run">{heading}<p>{esc_html(quality)}</p>'
        f"{spend}<p>{links}</p></article>"
    )


def write_dashboard(attempts, pairs, out):
    e = esc_html

    rows = []
    for a in attempts:
        link = e(ref(out, a.path / "manifest.json"))
        status = "проверен"
        if a.manifest.get("status") == "running":
            status = "выполняется"
        elif a.archived_baseline and a.manifest.get("pipeline_complete") is False:
            status = "конвейер остановлен"
        elif a.errors:
            status = "проверка не пройдена" if a.meter_ok else "учёт не подтверждён"
        if a.qa_receipt:
            receipt = e(ref(out, a.qa_receipt_path))
            verdict = (
                "снимок принят"
                if a.qa_receipt["signed_quality"]["passed"]
                else "снимок отклонён"
            )
            status = (
                f'<a href="{receipt}">Независимая приёмка · {verdict}</a><br>{status}'
            )
        cells = [
            f'<a href="{link}">{e(a.path.name)}</a>',
            e(kind_of(a)),
            e(a.manifest.get("branch", "—")),
            e(a.manifest.get("model", "—")),
            str(a.rpt) if a.rpt is not None else "—",
            *[e(value) for value in a.billing_values],
            status,
        ]
        rows.append("<tr>" + "".join(f"<td>{v}</td>" for v in cells) + "</tr>")
    cards = []
    for label, (arms, _) in pairs.items():
        if arms:
            b, o = arms
            cards.append(
                f"<h2>{e(label)}</h2><p>RPT {b.rpt} → {o.rpt} · экономия {100 * (1 - o.rpt / b.rpt):.2f}%</p>"
            )
            peak = max(b.rpt, o.rpt)
            for stage in sorted(set(b.stages) | set(o.stages)):
                cards.append(
                    f"<p>{e(STAGE_NAMES.get(stage, stage))} · base {b.stages[stage]} / opt {o.stages[stage]}<br>"
                    f'<meter max="{peak}" value="{b.stages[stage]}"></meter> <meter max="{peak}" value="{o.stages[stage]}"></meter></p>'
                )
    headline = "Сопоставимые пары" if cards else "Экономия пока не установлена"
    baselines = "".join(
        dashboard_baseline(a, out) for a in attempts if a.archived_baseline
    )
    baseline_section = (
        '<section aria-labelledby="baseline-title"><h2 id="baseline-title">Архив замеров B0</h2>'
        "<p>Расход базового конвейера. Экономию показывает сравнение сопоставимых пар.</p>"
        f"{baselines}</section>"
        if baselines
        else ""
    )
    page = f"""<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Frugal SDD · результаты</title><style>
body{{max-width:1100px;margin:4rem auto;padding:0 1.5rem;font:16px/1.5 system-ui;color:#17312a;background:#f9fbf8}}
h1,h2{{line-height:1.2}} a{{color:#126347}} table{{border-collapse:collapse;width:100%}}
th,td{{text-align:left;padding:.6rem;border-bottom:1px solid #b9cbbf;vertical-align:top;overflow-wrap:anywhere}}
section,.table-scroll{{overflow:auto}} meter{{width:40%;max-width:22rem}}
.baseline-run{{padding:1rem 1.25rem;margin:1rem 0;border:1px solid #b9cbbf;border-radius:.5rem}}
.baseline-run h3{{margin-top:0;overflow-wrap:anywhere}} .baseline-run p:last-child{{margin-bottom:0}}
.baseline-run meter{{width:6rem;vertical-align:middle}}</style><main><h1>Frugal SDD</h1>
<h2>{headline}</h2>{"".join(cards)}<p><a href="REPORT.md">Отчёт с расчётами и источниками</a></p>
{baseline_section}
<h2>Все попытки</h2><section><table><thead><tr>{"".join(f"<th>{h}</th>" for h in ATTEMPT_COLUMNS)}
</tr></thead><tbody>{"".join(rows)}</tbody></table></section></main></html>"""
    (out / "dashboard.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Пересчитать локальный отчёт Frugal")
    parser.add_argument("runs", type=Path)
    parser.add_argument("--out", type=Path, default=Path("report"))
    args = parser.parse_args()
    try:
        write_report(args.runs, args.out)
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + "\n")
