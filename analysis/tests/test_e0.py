import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from test_report import make_arm, report, save

ANALYSIS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ANALYSIS))
import e0  # noqa: E402


def snapshot(
    root, run_id, stages, *, fixture=True, experiment="E0", model=None, **overrides
):
    path = make_arm(root, run_id, "base", sum(stages.values()), dry=fixture)
    manifest_file = path / "manifest.json"
    manifest = report.read_json(manifest_file)
    manifest.update(
        pair_id=run_id,
        experiment=experiment,
        purpose="replay" if fixture else "feature",
        mode="baseline",
        pipeline_complete=True,
        finished_at="2026-11-21T10:00:00Z",
        model=model or ("mock/replay" if fixture else "p/m"),
        provider="mock" if fixture else "p",
        accepted=not fixture,
    )
    manifest.update(overrides)
    save(manifest_file, manifest)
    call_path = path / "calls.jsonl"
    template = report.read_json(call_path)
    import json

    rows = []
    for stage, rpt in stages.items():
        row = dict(
            template,
            stage=stage,
            event_key=stage,
            t_in=rpt // 2,
            t_cache_read=rpt - rpt // 2,
            provider_id=manifest["provider"],
            model=manifest["model"],
        )
        rows.append(json.dumps(row))
    call_path.write_text("\n".join(rows) + "\n")
    meter_file = path / "meter.json"
    meter = report.read_json(meter_file)
    meter.update(
        call_count=len(rows),
        by_stage={
            stage: {"call_count": 1, "rpt": rpt} for stage, rpt in stages.items()
        },
        sha256={"calls.jsonl": report.sha256(call_path)},
    )
    save(meter_file, meter)
    return path


B0 = {"spec": 25, "apply": 60, "review": 12, "verify": 3}


def test_fixture_report_recomputes_and_is_byte_reproducible(tmp_path):
    root, out = tmp_path / "runs", tmp_path / "report"
    snapshot(root, "a", B0)
    snapshot(root, "b", dict(B0, apply=80))
    snapshot(
        root,
        "c",
        {
            "propose": 4,
            "specs": 11,
            "design": 8,
            "tasks": 2,
            **{k: v for k, v in dict(B0, apply=100).items() if k != "spec"},
        },
    )
    snapshot(root, "not-declared", B0)
    snapshot(root, "small", B0, experiment="E0-s")
    cohort_file = tmp_path / "cohorts.json"
    save(
        cohort_file,
        {
            "cohorts": {
                "M-M": {"model": "mock/replay", "runs": ["c", "b", "a"]},
                "M-S": {"model": "mock/replay", "runs": ["small"]},
            }
        },
    )
    cli = [
        sys.executable,
        str(ANALYSIS / "e0.py"),
        "--fixture",
        "--runs",
        str(root),
        "--out",
        str(out),
        "--cohorts",
        str(cohort_file),
    ]
    subprocess.run(cli, check=True)
    md = out / "e0.md"
    svg = out / "e0.svg"
    first = (md.read_bytes(), svg.read_bytes())
    subprocess.run(cli, check=True)
    assert first == (md.read_bytes(), svg.read_bytes())
    contents = md.read_text()
    assert "**Синтетическая фикстура." in contents
    assert "Полный замер у 3 из 3 заявленных попыток." in contents
    assert "Полный замер у 1 из 1 заявленных попыток. Минимум по ТЗ 2" in contents
    assert "Полный замер у 0 из 0 заявленных попыток. Минимум по ТЗ 3" in contents
    assert (
        "Медиана RPT 120, диапазон 100–140, IQR 110–130 (ширина 20), выборочный CV 16.7%"
        in contents
    )
    assert "| Реализация | 240 | 66.7% | 66.7% | Наибольшая доля |" in contents
    assert "| S1–S4 · спецификация | 75 | 20.8%" in contents
    assert "| Проверка | 9 | 2.5% | 2.5% | Ниже 5% |" in contents
    assert "MDE при 3" in contents
    assert "N и MDE ждёт минимального объёма" in contents
    assert "not-declared" not in contents
    assert "[140](../runs/c/calls.jsonl)" in contents
    circles = ET.parse(svg).findall(".//{http://www.w3.org/2000/svg}circle")
    assert len(circles) == 4

    # Archive mode must reject fixture inputs, even under a declared real model.
    real = snapshot(root, "declared-fixture", B0, model="p/m")
    a = e0.inspect_archive(root, real.name, "E0", "p/m", False)
    assert not a.usable and "Тип запуска" in a.reason


def test_planning_sensitivity():
    n, mde = e0.paired_plan(cv=0.2, rho=0, n=10)
    assert n == 13
    assert mde == pytest.approx(0.222396, abs=0.00001)
    for rho, expected_n in [(-0.25, 16), (0.5, 7), (0.75, 4)]:
        assert e0.paired_plan(cv=0.2, rho=rho, n=10)[0] == expected_n
    assert e0.coefficient_of_variation([3]) is None
    assert e0.coefficient_of_variation([3, 3]) == 0


def test_diagnostic_attempts_are_visible_but_do_not_break_comparable_subset(tmp_path):
    rejected = snapshot(
        tmp_path, "qa-rejected", B0, fixture=False, accepted=False, status="failed"
    )
    pilot = snapshot(tmp_path, "pilot", B0, fixture=False, experiment=None)
    interrupted = snapshot(
        tmp_path, "interrupted", B0, fixture=False, pipeline_complete=False
    )
    valid = snapshot(tmp_path, "valid", B0, fixture=False)
    smoke = snapshot(tmp_path, "smoke", B0, fixture=False, purpose="go-smoke")
    runs = e0.inspect_cohort(
        tmp_path,
        "E0",
        "p/m",
        [p.name for p in (rejected, pilot, interrupted, valid, smoke)],
        False,
    )
    by_id = {run.attempt.path.name: run for run in runs}
    assert {key for key, run in by_id.items() if run.usable} == {"valid", "qa-rejected"}
    assert e0.full_acceptance(by_id["valid"].attempt)
    assert not e0.full_acceptance(by_id["qa-rejected"].attempt)
    assert "Серия" in by_id["pilot"].reason
    assert by_id["interrupted"].attempt.rpt == 100
    assert "не завершился" in by_id["interrupted"].reason
    assert "Тип запуска" in by_id["smoke"].reason


def test_cohort_excludes_version_drift_and_duplicate_complete_slots(tmp_path):
    snapshot(tmp_path, "valid", B0)
    snapshot(tmp_path, "drift", B0, baseline_hash="changed")
    snapshot(tmp_path, "duplicate", B0, pair_id="valid")
    for conflict in ("drift", "duplicate"):
        runs = e0.inspect_cohort(
            tmp_path, "E0", "mock/replay", ["valid", conflict], True
        )
        assert len(runs) == 2
        assert all(not r.usable and "повторяется слот" in r.reason for r in runs)


def test_tampered_ledger_and_archived_links_are_rejected(tmp_path):
    root = tmp_path / "runs"
    tampered = snapshot(root, "tampered", B0)
    meter_path = tampered / "meter.json"
    meter = report.read_json(meter_path)
    meter.update(rpt=101)
    save(meter_path, meter)
    unsafe = snapshot(root, "unsafe", B0)
    shadow = unsafe / "raw" / "events.jsonl"
    outside = tmp_path / "private.jsonl"
    shadow.rename(outside)
    shadow.symlink_to(outside)
    traversal = snapshot(root, "traversal", B0)
    meter_path = traversal / "meter.json"
    meter = report.read_json(meter_path)
    meter["raw_sha256"]["raw/../../.env"] = "irrelevant"
    save(meter_path, meter)
    runs = e0.inspect_cohort(
        root,
        "E0",
        "mock/replay",
        ["tampered", "unsafe", "traversal", "missing"],
        True,
    )
    assert all(not r.usable and r.attempt.rpt is None and r.reason for r in runs)
    assert all(".env" not in r.reason and "private.jsonl" not in r.reason for r in runs)


def test_selection_and_output_cannot_escape_archive_paths(tmp_path):
    declaration = tmp_path / "cohorts.json"
    for ids in (["../unrelated"], ["dup", "dup"], [".env"]):
        save(declaration, {"cohorts": {"M-M": {"model": "mock/replay", "runs": ids}}})
        with pytest.raises(ValueError):
            e0.load_cohorts(declaration, True)
    root = tmp_path / "runs"
    root.mkdir()
    with pytest.raises(ValueError, match="вне архива"):
        e0.analyze(root, {}, root / "report", True)
    report = tmp_path / "output"
    report.mkdir()
    (report / "e0.svg").symlink_to(tmp_path / "unrelated.svg")
    with pytest.raises(ValueError, match="символьной"):
        e0.analyze(root, {}, report, True)
