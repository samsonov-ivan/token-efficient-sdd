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


def test_missing_or_duplicate_arm_and_ties(tmp_path):
    make_arm(tmp_path, "first", "base", 80)
    assert report.collect(tmp_path)[1]["pair"][0] is None
    make_arm(tmp_path, "second", "base", 80)
    make_arm(tmp_path, "last", "opt", 70)
    assert report.collect(tmp_path)[1]["pair"][0] is None
    assert report.sign_p([0.8, 0.9, 0.9, 1]) == 0.125
    assert report.sign_p([1]) == 1
