import json
import subprocess
import sys

import pytest
from test_e0 import ANALYSIS, B0, snapshot
from test_report import report, save

import live_eligibility as live

HASH = "a" * 64


@pytest.fixture
def archives(tmp_path):
    root = tmp_path / "runs"
    declaration = tmp_path / "cohorts.json"
    foundation = {"model": "p/m", "experiment": None, "runs": ["f2", "f1"]}
    cohorts = {
        k: {"model": "p/" + name, "runs": [f"{name}{i}" for i in (3, 1, 2)]}
        for k, name in (("M-M", "m"), ("M-L", "l"))
    }
    save(declaration, {"foundation": foundation, "cohorts": cohorts})
    for group in (foundation, *cohorts.values()):
        for run in group["runs"]:
            snapshot(
                root,
                run,
                B0,
                fixture=False,
                model=group["model"],
                experiment=group.get("experiment", "E0"),
                feature_id=live.PRIMARY,
                baseline_hash=HASH,
                repo={"url": "minibank", "commit": "source"},
            )
    # Public QA receipt for one control, trusted local evaluate-only for the other.
    (root / "summary").mkdir()
    save(
        root / "summary/f1-quality.json",
        {
            "run_id": "f1",
            "final_commit": "snap",
            "review_rounds": 1,
            "manifest_sha256": report.sha256(root / "f1/manifest.json"),
            "tests": {k: {"passed": 3, "observed": 3} for k in ("public", "hidden")},
            "signed_quality": {
                "passed": True,
                "artifact_sha256": {"assessment.json": HASH},
            },
        },
    )
    assessment = tmp_path / "assessment.json"
    save(
        assessment,
        {
            "version": 1,
            "reviewer": "Independent evaluator",
            "request_sha256": "b" * 64,
            "final_commit": "snap",
            "semantic": [{"requirement": "R", "verdict": "pass"}],
            "links": [],
        },
    )
    digest = report.sha256(assessment)
    folder = root / "f2/evaluation/assessments" / digest
    folder.mkdir(parents=True)
    assessment.rename(folder / "assessment.json")
    save(
        folder / "decision.json",
        {
            "final_commit": "snap",
            "usage_scope": "independent-post-pipeline",
            "assessment_sha256": digest,
        },
    )
    update(root / "f2/manifest.json", assessment_sha256=digest)
    return root, declaration


def update(path, **fields):
    save(path, {**report.read_json(path), **fields})


def invoke(root, declaration, baseline=HASH):
    return subprocess.run(
        [
            sys.executable,
            str(ANALYSIS / "live_eligibility.py"),
            "--runs",
            str(root),
            "--cohorts",
            str(declaration),
            "--baseline-hash",
            baseline,
        ],
        capture_output=True,
        text=True,
    )


def test_gate_freezes_verified_runs_deterministically(archives):
    root, declaration = archives
    # A measured E0 slot can have a negative quality result.
    update(root / "m1/manifest.json", accepted=False, status="failed")
    first = invoke(root, declaration)
    assert first.returncode == 0, first.stderr
    assert first.stdout == invoke(root, declaration).stdout
    result = json.loads(first.stdout)
    assert result["eligible"] and result["baseline_hash"] == HASH
    assert result["declaration_sha256"] == report.sha256(declaration)
    f1, f2 = result["foundation"]["runs"]
    assert f1["id"] == "f1" and "qa_receipt_sha256" in f1
    assert f2["id"] == "f2" and "qa_decision_sha256" in f2
    assert [r["id"] for r in result["cohorts"]["M-M"]["runs"]] == ["m1", "m2", "m3"]


@pytest.mark.parametrize(
    "issue",
    [
        "receipt-missing",
        "receipt-fails",
        "unsigned-run-claim",
        "receipt-drift",
        "declared-assessment-missing",
        "reported-defect",
        "assessment-drift",
        "foundation-slot",
        "incomplete-meter",
        "dry-run",
        "wrong-b0",
        "different-requirements",
        "secondary-feature",
    ],
)
def test_gate_refuses_without_printing_a_freeze(archives, issue):
    root, declaration = archives
    receipt = root / "summary/f1-quality.json"
    if issue == "receipt-missing":
        receipt.unlink()
    elif issue == "receipt-fails":
        update(receipt, signed_quality={"passed": False})
    elif issue == "unsigned-run-claim":
        update(root / "f2/manifest.json", assessment_sha256=None)
    elif issue == "receipt-drift":
        update(receipt, final_commit="other")
    elif issue == "declared-assessment-missing":
        verdict = report.read_json(receipt)["signed_quality"]
        update(
            receipt,
            signed_quality={**verdict, "files": {"assessment.json": "missing.json"}},
        )
    elif issue == "reported-defect":
        update(receipt, public_contract_defects=["Incorrect transfer limit"])
    elif issue == "assessment-drift":
        next((root / "f2/evaluation/assessments").glob("*/assessment.json")).write_text(
            "{}"
        )
    elif issue == "foundation-slot":
        update(root / "f2/manifest.json", pair_id="f1")
    elif issue == "incomplete-meter":
        (root / "l3/calls.jsonl").write_text("")
    elif issue == "dry-run":
        update(root / "m1/manifest.json", dry_run=True)
    elif issue == "wrong-b0":
        for manifest in root.glob("l*/manifest.json"):
            update(manifest, baseline_hash="d" * 64)
    elif issue == "different-requirements":
        for manifest in root.glob("l*/manifest.json"):
            update(manifest, requirements_hash="other")
    elif issue == "secondary-feature":
        for manifest in root.glob("*/manifest.json"):
            update(manifest, feature_id="export-history-csv")
    completed = invoke(root, declaration)
    assert completed.returncode != 0
    assert completed.stderr and not completed.stdout
