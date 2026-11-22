import hashlib
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "frugal_report", Path(__file__).parents[1] / "report.py"
)
report = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = report
spec.loader.exec_module(report)


def save(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def make_arm(root, name, branch, total, dry=False):
    folder = root / name
    (folder / "raw").mkdir(parents=True)
    (folder / "quality").mkdir()
    m = {k: "same" for k in report.CONTROLS}
    m.update(
        run_id=name,
        branch=branch,
        flags={"capsule": branch == "opt"},
        provider="p",
        model="p/m",
        pair_id="pair",
        accepted=True,
        series_id="series",
        isolation={"image": "fixture-image"},
        dry_run=dry,
        status="complete",
        final_commit="snap",
        stages=[],
    )
    save(folder / "manifest.json", m)
    row = {k: 0 for k in report.TOKENS}
    row.update(
        t_in=total,
        event_key="step",
        run_id=name,
        branch=branch,
        provider_id="p",
        model="p/m",
        usage_status="known",
        raw_ref="raw/events.jsonl#L1",
        stage="spec",
    )
    (folder / "raw" / "events.jsonl").write_text('{"type":"fixture"}\n')
    calls = json.dumps(row) + "\n"
    (folder / "calls.jsonl").write_text(calls)
    save(
        folder / "meter.json",
        {
            "run_id": name,
            "dry_run": dry,
            "complete": True,
            "raw_sha256": {
                "raw/events.jsonl": report.sha256(folder / "raw" / "events.jsonl")
            },
            "sha256": {"calls.jsonl": hashlib.sha256(calls.encode()).hexdigest()},
            "rpt": total,
            "call_count": 1,
            "by_stage": {"spec": {"call_count": 1, "rpt": total}},
        },
    )
    metrics = dict.fromkeys(report.QUALITY, 1)
    metrics.update(Q_hidden=1, R=1)
    gates = {
        "ok": True,
        "final_commit": "snap",
        "metrics": metrics,
        "suites": {"hidden": {"total": 2, "skipped": 0}},
        "checks": {key: {"ok": True} for key in report.CHECKS},
    }
    save(folder / "quality" / "gates.json", gates)
    save(
        folder / "quality" / "trace.json",
        {"final_commit": "snap", "rows": [{"verdict": "pass"}]},
    )
    return folder


def test_recompute_and_exclude_replay(tmp_path):
    root = tmp_path / "runs"
    make_arm(root, "base", "base", 100)
    make_arm(root, "opt", "opt", 70)
    make_arm(root, "replay", "base", 1000, True)
    attempts, pairs = report.collect(root)
    assert len(attempts) == 3
    assert pairs["pair"][1] == ""
    out = tmp_path / "output"
    report.write_report(root, out)
    contents = (out / "REPORT.md").read_text()
    assert "30.00%" in contents
    assert "1000" in contents
    assert "30.00%" in (out / "dashboard.html").read_text()


def test_go_smoke_billing_is_visible_outside_pair_and_series(tmp_path):
    root = tmp_path / "runs"
    make_arm(root, "base", "base", 100)
    make_arm(root, "opt", "opt", 70)
    smoke = make_arm(root, "go-smoke", "base", 10)
    manifest_file = smoke / "manifest.json"
    manifest = report.read_json(manifest_file)
    manifest.update(purpose="go-smoke", accepted=False, series_id="go-control")
    save(manifest_file, manifest)
    (smoke / "quality" / "gates.json").unlink()
    meter_file = smoke / "meter.json"
    meter = report.read_json(meter_file)
    meter.update(cost=0, opencode_billing={"list_cost": 0.003, "allowance": 0.004})
    save(meter_file, meter)

    attempts, pairs = report.collect(root)
    checked = next(a for a in attempts if a.path == smoke)
    assert checked.rpt == 10
    assert checked.billing_values == [0, 0.003, 0.004]
    assert checked.errors == []
    assert not checked.accepted
    assert pairs["pair"][1] == ""

    out = tmp_path / "output"
    report.write_report(root, out)
    markdown = (out / "REPORT.md").read_text()
    dashboard = (out / "dashboard.html").read_text()
    assert "## Серия go-control" not in markdown
    assert "| 10 | 0 | 0.003 | 0.004 |" in markdown
    assert "<td>10</td><td>0</td><td>0.003</td><td>0.004</td>" in dashboard
    for contents in (markdown, dashboard):
        assert "проверка OpenCode Go · модель" in contents
        assert "Стоимость по прайсу Go, $" in contents
        assert "Расход квоты Go" in contents


def test_reject_tampering_mismatches_and_missing_raw(tmp_path):
    a = make_arm(tmp_path, "base", "base", 100)
    b = make_arm(tmp_path, "opt", "opt", 70)
    manifest = report.read_json(b / "manifest.json")
    manifest["requirements_hash"] = "changed"
    save(b / "manifest.json", manifest)
    assert "requirements_hash" in report.collect(tmp_path)[1]["pair"][1]
    (a / "raw" / "events.jsonl").unlink()
    assert report.inspect_run(a).rpt is None
    with (b / "calls.jsonl").open("a") as stream:
        stream.write("\n")
    assert "отпечаток" in report.inspect_run(b).errors[0]


def test_h03_pilot_preserves_meter_and_quality_outside_scoring(tmp_path):
    root = tmp_path / "runs"
    for branch, total in (("base", 100), ("opt", 70)):
        arm = make_arm(root, branch, branch, total)
        path = arm / "manifest.json"
        manifest = report.read_json(path)
        manifest.update(
            purpose="h03-pilot",
            mode="baseline" if branch == "base" else "optimized",
            series_id="exploratory",
        )
        save(path, manifest)

    attempts, pairs = report.collect(root)
    assert len(attempts) == 2 and all(a.meter_ok and a.quality_ok for a in attempts)
    assert not any(a.archived_baseline for a in attempts)
    assert pairs == {}
    assert report.summarize_series(attempts) == []
    assert report.compare_arms(attempts)[0] is None
    out = tmp_path / "output"
    report.write_report(root, out)
    for filename in ("REPORT.md", "dashboard.html"):
        contents = (out / filename).read_text()
        assert "пилот H-03 вне зачёта · модель" in contents
        assert "30.00%" not in contents


def test_missing_or_duplicate_arm_and_ties(tmp_path):
    make_arm(tmp_path, "first", "base", 80)
    assert report.collect(tmp_path)[1]["pair"][0] is None
    make_arm(tmp_path, "second", "base", 80)
    make_arm(tmp_path, "last", "opt", 70)
    assert report.collect(tmp_path)[1]["pair"][0] is None
    assert report.sign_p([0.8, 0.9, 0.9, 1]) == 0.125
    assert report.sign_p([1]) == 1


def test_live_baseline_shows_stage_spend_and_independent_quality(tmp_path):
    root = tmp_path / "runs"
    arm = make_arm(root, "live-base", "base", 100)
    manifest_file = arm / "manifest.json"
    manifest = report.read_json(manifest_file)
    manifest.update(
        mode="baseline",
        pipeline_complete=True,
        status="failed",
        accepted=False,
        started_at="2026-11-21T12:00:00Z",
        finished_at="2026-11-21T12:00:11Z",
        stages=[
            {
                "stage": "spec",
                "started_at": "2026-11-21T12:00:01Z",
                "finished_at": "2026-11-21T12:00:03Z",
            },
            {
                "stage": "spec",
                "started_at": "2026-11-21T12:00:09Z",
                "finished_at": "2026-11-21T12:00:10Z",
            },
        ],
        gates={
            "suites": {
                "public": {"passed": 126, "total": 126},
                "hidden": {"passed": 29, "total": 30},
            },
            "metrics": {"R": 1},
        },
    )
    save(manifest_file, manifest)
    out = tmp_path / "output"
    report.write_report(root, out)
    contents = (out / "REPORT.md").read_text()
    assert "Длительность прогона по манифесту — 11.0 с." in contents
    assert "| Спецификация | 1 | 100 | 100.0% | 3.0 |" in contents
    assert (
        "Автоматические гейты · ожидают независимой оценки | 126/126 | 29/30 | 1 |"
        in contents
    )

    receipt_folder = root / "summary"
    receipt_folder.mkdir()
    save(
        receipt_folder / "live-base-quality.json",
        {
            "run_id": "live-base",
            "final_commit": "snap",
            "manifest_sha256": report.sha256(manifest_file),
            "signed_quality": {"passed": False, "failed_checks": ["semantic"]},
            "tests": {
                "public": {"passed": 126, "observed": 126},
                "hidden": {"passed": 29, "observed": 30},
            },
            "review_rounds": 1,
            "public_contract_defects": ["SCN-LIM-05.3: incorrect pagination"],
            "frozen_public_replay": {
                "original_inventory_passed": 68,
                "original_inventory_total": 68,
                "passed": 68,
                "total": 70,
            },
        },
    )
    digest = "a" * 64
    compressed = {
        "chars": 60,
        "sourceSha256": digest,
        "archiveSha256": digest,
        "recovered": True,
    }
    save(
        receipt_folder / "h03-native-loopback.json",
        {
            "fixture": "synthetic-git-log",
            "endpoint": "loopback",
            "checks": {
                "1.0.0": {
                    "baseline": {"chars": 100, "sourceSha256": digest},
                    "compressed": compressed,
                },
                "2.0.0": {
                    "baseline": {"chars": 100, "sourceSha256": digest},
                    "compressed": {**compressed, "archiveSha256": "b" * 64},
                },
            },
        },
    )
    report.write_report(root, out)
    contents = (out / "REPORT.md").read_text()
    prototype, appendix = contents.split("## Приложение · все попытки", 1)
    assert "100 → 60 символов (−40.0%)" in prototype
    assert "Полный учёт у 1 из 1 архивных живых попыток B0" in prototype
    assert "1.0.0" in prototype and "2.0.0" not in prototype
    assert "29/30" in appendix
    assert "Экономия токенов на полной фиче пока не подтверждена" in prototype
    assert (
        "Автоматические гейты · до независимой оценки | 126/126 | 29/30 | 1 |"
        in contents
    )
    assert (
        "Независимая подписанная приёмка · снимок отклонён | 126/126 | 29/30 | 1 |"
        in contents
    )
    assert "SCN-LIM-05.3" in contents
    assert (
        "68/68 исходных тестов. Расширенный отбор включил новые тесты и дал 68/70."
        in contents
    )
    assert "../runs/summary/live-base-quality.json" in contents
    assert (
        '<a href="../runs/summary/live-base-quality.json">Независимая приёмка · снимок отклонён</a>'
        in (out / "dashboard.html").read_text()
    )
    dashboard = (out / "dashboard.html").read_text()
    assert "Архив замеров B0" in dashboard
    assert "Экономия пока не установлена" in dashboard
    assert "<strong>100 RPT</strong> · Вызовы модели 1 · 11.0 с" in dashboard
    assert (
        '<meter max="100" value="100" aria-hidden="true"></meter> 100.0%' in dashboard
    )
    assert "Публичные тесты 126/126, закрытые тесты 29/30, раунды ревью 1." in dashboard
    assert 'href="../runs/live-base/meter.json"' in dashboard
    assert 'href="../runs/live-base/calls.jsonl"' in dashboard
    assert "raw/" not in dashboard
    assert "SCN-LIM-05.3" not in dashboard

    manifest["final_commit"] = "replaced"
    save(manifest_file, manifest)
    report.write_report(root, out)
    contents = (out / "REPORT.md").read_text()
    assert "сводка независимой приёмки не прошла проверку" in contents
    assert "SCN-LIM-05.3" not in contents
    dashboard = (out / "dashboard.html").read_text()
    assert "сводка независимой приёмки не прошла проверку" in dashboard
    assert "live-base-quality.json" not in dashboard


def test_stopped_baseline_reports_spend_without_quality(tmp_path):
    root = tmp_path / "runs"
    arm = make_arm(root, "stopped", "base", 100)
    manifest = report.read_json(arm / "manifest.json")
    manifest.update(
        mode="baseline",
        status="failed",
        pipeline_complete=False,
        final_commit=None,
        feature_id="export-history-csv",
    )
    save(arm / "manifest.json", manifest)
    summary = root / "summary"
    summary.mkdir()
    save(summary / "stopped-process-diagnostic.json", {"reason": "fixture"})
    out = tmp_path / "output"
    report.write_report(root, out)
    contents = (out / "REPORT.md").read_text()
    assert "Живой B0 · stopped" in contents
    assert "Фича — export-history-csv." in contents
    assert "RPT **100**, модельных вызовов **1**" in contents
    assert (
        "Конвейер остановился до итоговой приёмки. Метрики качества отсутствуют."
        in contents
    )
    assert "Публичные тесты" not in contents
    assert "привязка QA" not in contents
    dashboard = (out / "dashboard.html").read_text()
    assert "<h3>stopped</h3>" in dashboard
    assert "<p>Фича — export-history-csv.</p>" in dashboard
    assert "<strong>100 RPT</strong>" in dashboard
    assert "Конвейер остановился до итоговой приёмки." in dashboard
    assert 'href="../runs/summary/stopped-process-diagnostic.json"' in dashboard
    assert "Публичные тесты" not in dashboard


def test_running_baseline_leaves_accounting_and_quality_pending(tmp_path):
    root = tmp_path / "runs"
    arm = make_arm(root, "active", "base", 100)
    manifest_file = arm / "manifest.json"
    manifest = report.read_json(manifest_file)
    manifest.update(mode="baseline", status="running", pipeline_complete=True)
    save(manifest_file, manifest)
    mock = make_arm(root, "mock", "base", 42, dry=True)
    smoke = make_arm(root, "smoke", "base", 7)
    for folder, fields in [(mock, {}), (smoke, {"purpose": "go-smoke"})]:
        path = folder / "manifest.json"
        contents = report.read_json(path)
        contents.update(mode="baseline", pipeline_complete=True, **fields)
        save(path, contents)

    checked = report.inspect_run(arm)
    assert checked.errors == ["выполняется"]
    assert checked.rpt is None
    assert not checked.accepted

    out = tmp_path / "output"
    report.write_report(root, out)
    contents = (out / "REPORT.md").read_text()
    assert "выполняется" in contents
    assert "Живой B0 · active" not in contents
    dashboard = (out / "dashboard.html").read_text()
    assert "выполняется" in dashboard
    assert "Архив замеров B0" not in dashboard
    assert "<meter" not in dashboard


def test_archived_baseline_dashboard_only_shows_verified_usage(tmp_path):
    root = tmp_path / "runs"
    name = 'run<fixture>"'
    arm = make_arm(root, name, "base", 100)
    manifest_file = arm / "manifest.json"
    manifest = report.read_json(manifest_file)
    manifest.update(mode="baseline", status="interrupted", pipeline_complete=False)
    save(manifest_file, manifest)
    calls_file = arm / "calls.jsonl"
    call = json.loads(calls_file.read_text())
    second_call = dict(call, event_key="second-step", stage="apply", t_in=300)
    calls_file.write_text(f"{json.dumps(call)}\n{json.dumps(second_call)}\n")
    meter_file = arm / "meter.json"
    meter = report.read_json(meter_file)
    meter["sha256"]["calls.jsonl"] = report.sha256(calls_file)
    meter.update(rpt=400, call_count=2)
    meter["by_stage"]["apply"] = {"call_count": 1, "rpt": 300}
    save(meter_file, meter)

    out = tmp_path / "output"
    report.write_report(root, out)
    dashboard = (out / "dashboard.html").read_text()
    assert "<h3>run&lt;fixture&gt;&quot;</h3>" in dashboard
    assert 'href="../runs/run%3Cfixture%3E%22/manifest.json"' in dashboard
    assert "<strong>400 RPT</strong> · Вызовы модели 2" in dashboard
    assert dashboard.index(
        '<meter max="400" value="100" aria-hidden="true"></meter> 25.0%'
    ) < dashboard.index(
        '<meter max="400" value="300" aria-hidden="true"></meter> 75.0%'
    )

    meter.update(complete=False, issues=["<testsuite>private-detail</testsuite>"])
    save(meter_file, meter)
    report.write_report(root, out)
    dashboard = (out / "dashboard.html").read_text()
    assert "Полный расход не подтверждён." in dashboard
    assert "private-detail" not in dashboard
    assert "<meter" not in dashboard
    assert "400 RPT" not in dashboard


def test_h03_live_probe_reports_both_signed_changes_outside_scored_pairs(tmp_path):
    root = tmp_path / "runs"
    summaries = root / "summary"
    summaries.mkdir(parents=True)
    digest = "a" * 64
    for label, scenario, recovery, after, calls in (
        ("newest", "newest-visible", False, 95, 2),
        ("recovery", "archive-recovery", True, 120, 3),
    ):
        source = {"source_sha256": digest, "commit": "abcdef0"}
        save(
            summaries / f"h03-go-{label}-20261122.json",
            {
                "kind": "h03-compression-technical-probe",
                "mode": "live-go",
                "complete": True,
                "scored_feature_pair": False,
                "inputs": {
                    "fixture": "synthetic-git-log",
                    "scenario": scenario,
                    "model": "opencode-go/example",
                    "variant": "max",
                },
                "baseline": {
                    **source,
                    "usage": {"rpt": 100, "call_count": 2, "balance_charge": 0},
                },
                "compressed": {
                    **source,
                    "archive_sha256": digest,
                    "archive_recovered_in_session": recovery,
                    "usage": {"rpt": after, "call_count": calls, "balance_charge": 0},
                },
            },
        )
    out = tmp_path / "output"
    report.write_report(root, out)
    for filename in ("REPORT.md", "dashboard.html"):
        contents = (out / filename).read_text(encoding="utf-8")
        assert "RPT 100 → 95 (-5, -5.00%), вызовы 2 → 2, списание $0" in contents
        assert "RPT 100 → 120 (+20, +20.00%), вызовы 2 → 3, списание $0" in contents
        assert contents.count("открытая фикстура вне зачёта") == 2
    assert "Экономия токенов на полной фиче пока не подтверждена" in (
        out / "REPORT.md"
    ).read_text(encoding="utf-8")


def test_h03_pilot_reports_only_metered_matched_finished_arms(tmp_path):
    root = tmp_path / "runs"
    for branch, total in (("base", 100), ("opt", 70)):
        folder = make_arm(root, branch, branch, total)
        path = folder / "manifest.json"
        manifest = report.read_json(path)
        manifest.update(
            purpose="h03-pilot",
            mode="baseline" if branch == "base" else "optimized",
            flags={"tool_output_compression": branch == "opt", "capsule": False},
            isolation={"image": "sha256:" + "a" * 64},
            metering={"plugin_sha256": "b" * 64},
            pipeline_complete=True,
            status="failed",
            accepted=False,
        )
        if branch == "base":
            manifest["gates"] = {
                "final_commit": manifest["final_commit"],
                "ok": False,
                "suites": {"public": {"passed": 10, "total": 10}},
            }
        save(path, manifest)
    (root / "summary").mkdir()
    save(
        root / "summary" / "opt-quality.json",
        {
            "run_id": "opt",
            "final_commit": "snap",
            "manifest_sha256": report.sha256(root / "opt" / "manifest.json"),
            "signed_quality": {"passed": False},
            "tests": {
                "public": {"passed": 8, "observed": 10},
                "hidden": {"passed": 2, "observed": 2},
            },
            "review_rounds": 1,
        },
    )
    out = tmp_path / "output"
    report.write_report(root, out)
    for filename in ("REPORT.md", "dashboard.html"):
        text = (out / filename).read_text(encoding="utf-8")
        assert "Живые пилоты H-03 вне зачёта" in text
        assert "100 → 70" in text and "-30.00%" in text and "1 → 1" in text
        assert "автоматические гейты не закрыты, публичные 10/10" in text
        assert "независимая оценка отрицательная, публичные 8/10, закрытые 2/2" in text
    assert report.collect(root)[1] == {}

    base, opt = report.collect(root)[0]
    for wrong in (
        {"pair_id": "different"},
        {"config_hash": "different"},
        {"isolation": {"image": "sha256:" + "c" * 64}},
        {"metering": {}},
        {"flags": {"tool_output_compression": True, "capsule": True}},
        {"pipeline_complete": False},
        {"dry_run": True},
    ):
        other = report.Attempt(opt.path, {**opt.manifest, **wrong}, meter_ok=True)
        assert list(report.pilot_pairs((base, other))) == []
    opt.meter_ok = False
    assert list(report.pilot_pairs((base, opt))) == []
