"""Summarize preregistered B0 cohorts from local E0/E0-s archives."""

import argparse
import json
import re
from collections import Counter
from dataclasses import dataclass
from math import ceil, sqrt
from pathlib import Path
from statistics import NormalDist, mean, median, quantiles, stdev

from report import (
    CONTROLS,
    STAGE_NAMES,
    Attempt,
    inspect_quality,
    inspect_usage,
    read_json,
    ref,
    table,
)

# Minimum and target sample sizes come from TZ §10.3.
COHORTS = {"M-M": ("E0", 3, 5), "M-L": ("E0", 3, 5), "M-S": ("E0-s", 2, 3)}
SPEC_STAGES = ("propose", "specs", "design", "tasks")
CANDIDATES = {
    "propose": "H-08, H-12, H-15, H-24, H-25",
    "spec": "H-12, H-24, H-25",
    "specs": "H-12, H-24, H-25",
    "design": "H-12, H-24, H-25",
    "tasks": "H-12, H-24, H-25",
    "apply": "H-01, H-02, H-03, H-08, H-10, H-11, H-22, H-24",
    "review": "H-04, H-05, H-06, H-16, H-101",
    "fix": "H-02, H-03, H-05, H-11, H-23, H-101, H-102",
    "verify": "H-03, H-04, H-18, H-24",
    "other": "—",
}
ALPHA = 0.05
POWER = 0.8
EFFECT = 0.20
CORRELATIONS = (-0.25, 0.0, 0.25, 0.50, 0.75)
RUN_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]*")
MODEL_ID = re.compile(r"[a-zA-Z0-9_.-]+/[a-zA-Z0-9_./:-]+")
RAW_FILE = re.compile(
    r"raw/(?:events\.jsonl|export\.json|opencode\.db(?:-wal)?|provider\.jsonl|"
    r"relay\.jsonl|events/[\w.-]+\.jsonl|exports/[\w.-]+\.json)"
)
ARCHIVE_ERRORS = (OSError, ValueError, KeyError, TypeError, AttributeError)


@dataclass
class Run:
    attempt: Attempt
    reason: str = ""
    usable: bool = False


def load_cohorts(path, fixture):
    declared = read_json(path)["cohorts"]
    if not isinstance(declared, dict) or set(declared) - COHORTS.keys():
        raise ValueError("Классы в cohorts должны быть M-M, M-L или M-S.")
    used_ids = set()
    used_models = set()
    for cohort in declared.values():
        model, runs = cohort["model"], cohort["runs"]
        if not MODEL_ID.fullmatch(model) or (
            not fixture and (model.startswith("mock/") or model in used_models)
        ):
            raise ValueError("Укажите отдельный provider/model для каждого класса.")
        if not isinstance(runs, list) or any(not RUN_ID.fullmatch(run) for run in runs):
            raise ValueError("Укажите список допустимых идентификаторов запусков.")
        for run in runs:
            if run in used_ids:
                raise ValueError("Каждый run ID указывается один раз.")
            used_ids.add(run)
        used_models.add(model)
    return declared


def archive_file(root, relative, *, optional=False):
    """Resolve a trusted archive path without following symlinks."""
    path = root
    for part in relative.split("/"):
        if part in ("", ".", "..") or part.startswith("."):
            raise ValueError("Недопустимый путь внутри архива.")
        path = path / part
        if path.is_symlink():
            raise ValueError("Символьная ссылка внутри архива.")
    if not path.is_file() and not (optional and not path.exists()):
        raise ValueError("Отсутствует регулярный файл архива.")
    return path


def check_usage_paths(path):
    meter = read_json(archive_file(path, "meter.json"))
    raw = meter.get("raw_sha256", {})
    for source in raw:
        if not RAW_FILE.fullmatch(source):
            raise ValueError("Недопустимый источник расхода.")
        archive_file(path, source)
    with archive_file(path, "calls.jsonl").open(encoding="utf-8") as calls:
        for line in calls:
            source = json.loads(line)["raw_ref"].split("#", 1)[0]
            if source not in raw:
                raise ValueError("Первичное событие отсутствует в хешах измерителя.")
    archive_file(path, "reconciliation.json", optional=True)


def run_issue(m, experiment, model, fixture):
    if m["experiment"] != experiment or m["model"] != model:
        return "Серия или модель расходится с декларацией."
    if m["dry_run"] is not fixture or m.get("purpose") != (
        "replay" if fixture else "feature"
    ):
        return "Тип запуска расходится с режимом анализа."
    if (
        m.get("branch") != "base"
        or m.get("mode") != "baseline"
        or any(value is not False for value in m["flags"].values())
    ):
        return "Требуется B0 со всеми выключенными флагами."
    return ""


def completion_issue(a, fixture):
    m = a.manifest
    if (
        m.get("pipeline_complete") is not True
        or m.get("status") not in ("complete", "failed")
        or not m.get("finished_at")
        or not m.get("final_commit")
    ):
        return "Конвейер не завершился."
    spec_complete = "spec" in a.stages or all(
        stage in a.stages for stage in SPEC_STAGES
    )
    if (
        not a.rpt
        or set(a.stages) - STAGE_NAMES.keys()
        or not spec_complete
        or not all(stage in a.stages for stage in ("apply", "review", "verify"))
    ):
        return "Нет положительного RPT или обязательных стадий в журнале."
    if (
        not isinstance(m.get("pair_id"), str)
        or not RUN_ID.fullmatch(m["pair_id"])
        or any(m.get(key) is None for key in CONTROLS)
        or (not fixture and not (m.get("isolation") or {}).get("image"))
    ):
        return "Отсутствуют закреплённые входы или идентификатор слота."
    return ""


def inspect_archive(root, run_id, experiment, model, fixture):
    path = root / run_id
    a = Attempt(path)
    try:
        if path.is_symlink():
            raise ValueError("Символьная ссылка вместо каталога запуска.")
        a.manifest = read_json(archive_file(path, "manifest.json"))
        if a.manifest["run_id"] != run_id:
            raise ValueError("Манифест относится к другому запуску.")
        issue = run_issue(a.manifest, experiment, model, fixture)
        if issue or a.technical:
            return Run(a, issue or "Технический прогон.")
        check_usage_paths(path)
        inspect_usage(a)
        issue = completion_issue(a, fixture)
        if issue:
            return Run(a, issue)
    except ARCHIVE_ERRORS:
        # Exception bodies may contain raw telemetry, credentials or absolute paths.
        return Run(
            a, "Архив отсутствует, содержит недопустимый путь или не сошёлся учёт."
        )
    if not fixture:
        try:
            for artifact in ("quality/gates.json", "quality/trace.json"):
                archive_file(path, artifact)
            inspect_quality(a)
        except ARCHIVE_ERRORS:
            # Quality disputes are visible but do not discard complete RPT observations.
            pass
    return Run(a, usable=True)


def inspect_cohort(root, experiment, model, run_ids, fixture):
    runs = [
        inspect_archive(root, run_id, experiment, model, fixture)
        for run_id in sorted(run_ids)
    ]
    complete = [run for run in runs if run.usable]
    if not complete:
        return runs
    slots = Counter(run.attempt.manifest["pair_id"] for run in complete)
    reference = complete[0].attempt.manifest
    mismatch = any(
        any(m.get(key) != reference.get(key) for key in (*CONTROLS, "flags"))
        or (m.get("isolation") or {}).get("image")
        != (reference.get("isolation") or {}).get("image")
        for m in (run.attempt.manifest for run in complete)
    )
    if mismatch or max(slots.values()) > 1:
        for run in complete:
            run.usable = False
            run.reason = (
                "В когорте различаются закреплённые входы или повторяется слот."
            )
    return runs


def stage_distribution(attempts):
    """Use a common S1–S4 bucket if any attempt has ambiguous attribution."""
    merged = any("spec" in a.stages for a in attempts)
    dropped = SPEC_STAGES if merged else ("spec",)
    by_run = []
    for a in attempts:
        tokens = a.stages.copy()
        if merged:
            tokens["spec"] += sum(tokens.pop(stage, 0) for stage in SPEC_STAGES)
        by_run.append(tokens)
    total = sum(a.rpt for a in attempts)
    rows = []
    for stage in STAGE_NAMES:
        if stage in dropped:
            continue
        amount = sum(tokens[stage] for tokens in by_run)
        per_run = median(tokens[stage] / a.rpt for tokens, a in zip(by_run, attempts))
        rows.append((stage, amount, amount / total, per_run))
    return sorted(rows, key=lambda row: (-row[2], row[0])), merged


def coefficient_of_variation(totals):
    return stdev(totals) / mean(totals) if len(totals) >= 2 else None


def paired_plan(cv, rho, n):
    """One-sided normal planning approximation with equal marginal absolute SD."""
    margin = NormalDist().inv_cdf(1 - ALPHA) + NormalDist().inv_cdf(POWER)
    spread = margin * cv * sqrt(2 * (1 - rho))
    return ceil((spread / EFFECT) ** 2), spread / sqrt(n)


def percent(value):
    return "—" if value is None else f"{value:.1%}"


def power_table(label, totals, cv, minimum):
    if cv is None or cv == 0 or len(totals) < minimum:
        return ["Оценка N и MDE ждёт минимального объёма серии и ненулевого разброса."]
    planned = (8, 10) if label == "M-L" else (3, 5)
    target = "E3" if label == "M-L" else "E4"
    rows = []
    for rho in CORRELATIONS:
        required, mde_min = paired_plan(cv, rho, planned[0])
        _, mde_target = paired_plan(cv, rho, planned[1])
        rows.append(
            (
                f"{rho:+.2f}",
                required,
                max(planned[0], required),
                percent(mde_min),
                percent(mde_target),
            )
        )
    return [
        f"Планирование {target} на той же модели",
        "",
        table(
            [
                "ρ пары",
                "Расчёт N",
                "N с минимумом ТЗ",
                f"MDE при {planned[0]}",
                f"MDE при {planned[1]}",
            ],
            rows,
        ),
    ]


def stage_name(stage):
    return "S1–S4 · спецификация" if stage == "spec" else STAGE_NAMES[stage]


def svg_plots(groups, fixture):
    """Plot one point per run and stage shares for each available cohort."""
    height = 72 + sum(
        52 + 22 * (len(attempts) + len(stages)) for _, attempts, stages in groups
    )
    title = (
        "Синтетическая фикстура · RPT" if fixture else "E0 · RPT по прогонам и стадиям"
    )
    body = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850 {height}" role="img">',
        f"<title>{title}</title>",
        f'<rect width="850" height="{height}" fill="#f4f7fa"/>',
        '<g font-family="system-ui, sans-serif" fill="#132437">',
        f'<text x="28" y="36" font-size="22">{title}</text>',
    ]
    y = 52
    for label, attempts, stages in groups:
        maximum = max((a.rpt for a in attempts), default=0)
        body.append(
            f'<text x="28" y="{y + 18}" font-size="15">{label} · N={len(attempts)}</text>'
        )
        if maximum:
            body.append(
                f'<text x="474" y="{y + 18}" font-size="12">Шкала точек 0–{maximum:,} RPT</text>'
            )
        y += 40
        for index, a in enumerate(attempts, start=1):
            x = 386 + 342 * a.rpt / maximum
            body.extend(
                [
                    f'<text x="28" y="{y + 4}" font-size="12">Прогон №{index}</text>',
                    f'<line x1="386" x2="728" y1="{y}" y2="{y}" stroke="#cad3df"/>',
                    f'<circle cx="{x:.2f}" cy="{y}" r="4.5" fill="#176d83"><title>{a.rpt} RPT</title></circle>',
                    f'<text x="746" y="{y + 4}" font-size="12">{a.rpt:,}</text>',
                ]
            )
            y += 22
        for stage, _, share, _ in stages:
            body.extend(
                [
                    f'<text x="28" y="{y + 4}" font-size="12">{stage_name(stage)}</text>',
                    f'<rect x="386" y="{y - 5}" width="342" height="10" fill="#e4ebf3"/>',
                    f'<rect x="386" y="{y - 5}" width="{342 * share:.2f}" height="10" fill="#176d83"/>',
                    f'<text x="746" y="{y + 4}" font-size="12">{percent(share)}</text>',
                ]
            )
            y += 22
        y += 12
    body.extend(["</g>", "</svg>"])
    return "\n".join(body) + "\n"


def full_acceptance(a):
    return (
        a.accepted
        and a.manifest.get("status") == "complete"
        and a.metrics.get("Q_hidden") == 1
    )


def attempt_table(runs, attempts, out, fixture):
    indices = {a.path.name: index for index, a in enumerate(attempts, start=1)}
    rows = []
    for run in runs:
        a = run.attempt
        run_id = a.path.name
        if run.reason:
            status = run.reason
        elif fixture:
            status = "Фикстура"
        else:
            status = (
                "Приёмка подтверждена"
                if full_acceptance(a)
                else "Полная приёмка не подтверждена"
            )
        link = (
            f"[{run_id}]({ref(out, a.path / 'manifest.json')})"
            if a.manifest
            else run_id
        )
        rpt = f"[{a.rpt}]({ref(out, a.path / 'calls.jsonl')})" if a.meter_ok else "—"
        rows.append((indices.get(run_id, "—"), link, rpt, status))
    return table(["№ на графике", "Запуск", "RPT", "Состояние"], rows)


def describe(attempts, stages, merged, label, minimum):
    totals = [a.rpt for a in attempts]
    cv = coefficient_of_variation(totals)
    iqr = "—"
    if len(totals) >= 2:
        q1, _, q3 = quantiles(totals, n=4, method="inclusive")
        iqr = f"{q1:g}–{q3:g} (ширина {q3 - q1:g})"
    lines = [
        f"RPT: медиана {median(totals):g}, диапазон {min(totals)}–{max(totals)}, "
        f"IQR {iqr}, выборочный CV {percent(cv)}.",
        "",
    ]
    if merged:
        lines += [
            "S1–S4 объединены во всех этих запусках для сопоставимой атрибуции.",
            "",
        ]
    rows = []
    largest = stages[0][2]
    for stage, tokens, share, median_share in stages:
        priority = (
            "Наибольшая доля"
            if share == largest
            else "Ниже 5%"
            if share < 0.05
            else "Кандидаты"
        )
        rows.append(
            (
                stage_name(stage),
                tokens,
                percent(share),
                percent(median_share),
                priority,
                CANDIDATES[stage],
            )
        )
    return lines + [
        table(
            [
                "Стадия",
                "RPT",
                "Доля суммы",
                "Медиана долей",
                "Сигнал §15.5",
                "Гипотезы",
            ],
            rows,
        ),
        "",
        *power_table(label, totals, cv, minimum),
        "",
    ]


def analyze(root, declared, out, fixture):
    if out.resolve().is_relative_to(root.resolve()):
        raise ValueError("Каталог отчёта должен находиться вне архива запусков.")
    out.mkdir(parents=True, exist_ok=True)
    if any((out / name).is_symlink() for name in ("e0.md", "e0.svg")):
        raise ValueError("Файл отчёта не может быть символьной ссылкой.")
    lines = [
        "# E0 и E0-s · калибровка B0",
        "",
        "**Синтетическая фикстура. Результаты проверяют только анализ.**"
        if fixture
        else "**Офлайн-анализ заявленных архивов. Решение по Ф1 фиксируется отдельно.**",
        "",
        "![RPT каждого включённого запуска и доли стадий](e0.svg)",
        "",
        "RPT складывается из пяти нормализованных компонент, включая чтение и запись кэша. "
        "Распределение строится по завершившим конвейер запускам с полным учётом. "
        "Исходы приёмки и неполные попытки показаны для всех заявленных запусков.",
        "",
    ]
    groups = []
    for label, (experiment, minimum, target) in COHORTS.items():
        cohort = declared.get(label)
        model = cohort["model"] if cohort else None
        runs = (
            inspect_cohort(root, experiment, model, cohort["runs"], fixture)
            if cohort
            else []
        )
        attempts = [run.attempt for run in runs if run.usable]
        stages, merged = stage_distribution(attempts) if attempts else ([], False)
        groups.append((label, attempts, stages))
        qa_count = sum(full_acceptance(a) for a in attempts)
        lines += [
            f"## {label} · {experiment}",
            "",
            f"Модель **{model}**." if model else "Модель не объявлена.",
            f"Полные замеры: {len(attempts)} из {len(runs)}. Минимум ТЗ: {minimum}, цель: {target}."
            + (
                f" Полная приёмка: {qa_count} из {len(attempts)}."
                if not fixture
                else ""
            ),
            "",
        ]
        if runs:
            lines += [attempt_table(runs, attempts, out, fixture), ""]
        if attempts:
            lines += describe(attempts, stages, merged, label, minimum)
    lines += [
        "## Интерпретация",
        "",
        "- Приоритеты ранжированы по доле суммарного RPT. Гипотезы ниже 5% на всех "
        "затрагиваемых стадиях стоит понизить. Доля измеряет масштаб стадии. "
        "Повторяемый расход и экономию конкретного флага проверяет абляция. "
        "H-09 относится к стоимости кэша.",
        "- CV = выборочное стандартное отклонение / среднее B0. Межквартильный интервал "
        "получен линейной интерполяцией между отсортированными наблюдениями.",
        "- План N использует одностороннее нормальное приближение, α=0,05, мощность 0,8, "
        "эффект 20% среднего B0. При равных абсолютных SD плеч разброс разности "
        "равен SD(B0) × √(2 × (1 − ρ)). E0 измеряет только B0, поэтому ρ и равенство SD "
        "остаются сценарными допущениями. При малом N приближение может завышать мощность. "
        "Окончательный бюджет и число пар утверждаются по ТЗ перед E3/E4.",
    ]
    (out / "e0.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "e0.svg").write_text(svg_plots(groups, fixture), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", required=True, type=Path)
    parser.add_argument("--cohorts", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--fixture", action="store_true")
    args = parser.parse_args()
    try:
        declared = load_cohorts(args.cohorts, args.fixture)
        analyze(args.runs, declared, args.out, args.fixture)
    except ARCHIVE_ERRORS:
        parser.exit(2, "Не удалось прочитать декларацию или записать отчёт E0.\n")


if __name__ == "__main__":
    main()
