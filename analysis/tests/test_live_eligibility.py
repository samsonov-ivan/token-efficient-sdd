import json
import shutil
import subprocess
import sys

import pytest
from test_e0 import ANALYSIS, B0, snapshot
from test_report import report, save

import live_eligibility as live

HASH = "a" * 64


def node(script, *args):
    subprocess.run(["node", "-e", script, *args], check=True, capture_output=True)


def keypair(tmp, name):
    public = tmp / f"{name}.pem"
    private = tmp / f"{name}.private.pem"
    node(
        """
        const {generateKeyPairSync} = require('node:crypto');
        const {writeFileSync} = require('node:fs');
        const {publicKey, privateKey} = generateKeyPairSync('ed25519');
        writeFileSync(process.argv[1], publicKey.export({format:'pem', type:'spki'}));
        writeFileSync(process.argv[2], privateKey.export({format:'pem', type:'pkcs8'}), {mode:0o600});
        """,
        public,
        private,
    )
    return public, private


def sign(private, payload, signature):
    node(
        """
        const {sign} = require('node:crypto');
        const {readFileSync, writeFileSync} = require('node:fs');
        const [key, payload, sig] = process.argv.slice(1);
        writeFileSync(sig, sign(null, readFileSync(payload), readFileSync(key)));
        """,
        private,
        payload,
        signature,
    )


@pytest.fixture(scope="module")
def signed_archives(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("signed-archives")
    root = tmp_path / "runs"
    declaration = tmp_path / "cohorts.json"
    _, owner_private = keypair(tmp_path, "owner")
    reviewer, reviewer_private = keypair(tmp_path, "reviewer")
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
    for run in foundation["runs"]:
        path = root / run
        request = {"version": 1, "final_commit": "snap", "candidates": [run]}
        request_hash = live.digest(json.dumps(request, separators=(",", ":")).encode())
        save(
            path / "quality/evaluator-request.json",
            {**request, "request_sha256": request_hash},
        )
        assessment = tmp_path / "assessment.json"
        save(
            assessment,
            {
                "version": 1,
                "reviewer": "Independent evaluator",
                "request_sha256": request_hash,
                "final_commit": "snap",
                "semantic": [{"requirement": "R", "verdict": "pass"}],
                "links": [],
            },
        )
        digest = report.sha256(assessment)
        folder = path / "evaluation/assessments" / digest
        folder.mkdir(parents=True)
        assessment.rename(folder / "assessment.json")
        sign(reviewer_private, folder / "assessment.json", folder / "assessment.sig")
        save(
            folder / "decision.json",
            {
                "final_commit": "snap",
                "usage_scope": "independent-post-pipeline",
                "assessment_sha256": digest,
            },
        )
        update(path / "manifest.json", assessment_sha256=digest)
    # A measured E0 slot can have a negative quality result.
    update(root / "m1/manifest.json", accepted=False, status="failed")
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("FRUGAL_LIVE_REVIEWER_KEY", str(reviewer))
        prepared = invoke(root, declaration, "--prepare-attestation")
    assert prepared.returncode == 0, prepared.stderr
    assert "eligible" not in json.loads(prepared.stdout)
    proof = tmp_path / "proof.json"
    proof.write_text(prepared.stdout)
    sign(owner_private, proof, declaration.with_suffix(".json.sig"))
    return tmp_path


@pytest.fixture
def archives(tmp_path, monkeypatch, signed_archives):
    shutil.copytree(signed_archives, tmp_path, dirs_exist_ok=True)
    monkeypatch.setenv("FRUGAL_LIVE_OWNER_KEY", str(tmp_path / "owner.pem"))
    monkeypatch.setenv("FRUGAL_LIVE_REVIEWER_KEY", str(tmp_path / "reviewer.pem"))
    return tmp_path / "runs", tmp_path / "cohorts.json"


def update(path, **fields):
    save(path, {**report.read_json(path), **fields})


def invoke(root, declaration, *flags):
    return subprocess.run(
        [
            sys.executable,
            str(ANALYSIS / "live_eligibility.py"),
            "--runs",
            str(root),
            "--cohorts",
            str(declaration),
            "--baseline-hash",
            HASH,
            *flags,
        ],
        capture_output=True,
        text=True,
    )


def test_gate_freezes_verified_runs_deterministically(archives):
    root, declaration = archives
    first = invoke(root, declaration)
    assert first.returncode == 0, first.stderr
    assert first.stdout == invoke(root, declaration).stdout
    result = json.loads(first.stdout)
    assert result["eligible"] and result["baseline_hash"] == HASH
    assert result["declaration_sha256"] == report.sha256(declaration)
    assert [r["id"] for r in result["foundation"]["runs"]] == ["f1", "f2"]
    assert result["foundation"]["runs"][0]["qa_gates_sha256"] == report.sha256(
        root / "f1/quality/gates.json"
    )
    assert [r["id"] for r in result["cohorts"]["M-M"]["runs"]] == ["m1", "m2", "m3"]


@pytest.mark.parametrize(
    "issue",
    [
        "missing-owner-trust",
        "wrong-owner-key",
        "missing-owner-signature",
        "archive-local-reviewer-key",
        "wrong-reviewer-key",
        "missing-reviewer-signature",
        "forged-reviewer-signature",
        "legacy-summary",
        "request-drift",
        "gates-drift",
        "trace-drift",
        "declaration-drift",
        "manifest-drift",
        "foundation-slot",
        "incomplete-meter",
        "dry-run",
        "wrong-b0",
        "requirements_hash",
        "expected_hash",
        "test_oracle_hash",
        "secondary-feature",
    ],
)
def test_gate_refuses_without_printing_a_freeze(archives, monkeypatch, issue):
    root, declaration = archives
    assessment = next((root / "f1/evaluation/assessments").glob("*/assessment.json"))
    signature = assessment.with_suffix(".sig")
    if issue == "missing-owner-trust":
        monkeypatch.delenv("FRUGAL_LIVE_OWNER_KEY")
    elif issue == "wrong-owner-key":
        monkeypatch.setenv("FRUGAL_LIVE_OWNER_KEY", str(root.parent / "reviewer.pem"))
    elif issue == "missing-owner-signature":
        declaration.with_suffix(".json.sig").unlink()
    elif issue == "archive-local-reviewer-key":
        key = root / "reviewer.pem"
        key.write_bytes((root.parent / "reviewer.pem").read_bytes())
        monkeypatch.setenv("FRUGAL_LIVE_REVIEWER_KEY", str(key))
    elif issue == "wrong-reviewer-key":
        monkeypatch.setenv("FRUGAL_LIVE_REVIEWER_KEY", str(root.parent / "owner.pem"))
    elif issue == "missing-reviewer-signature":
        signature.unlink()
    elif issue == "forged-reviewer-signature":
        sign(root.parent / "owner.private.pem", assessment, signature)
    elif issue == "legacy-summary":
        signature.unlink()
        (root / "summary").mkdir()
        save(
            root / "summary/f1-quality.json",
            {
                "run_id": "f1",
                "final_commit": "snap",
                "manifest_sha256": report.sha256(root / "f1/manifest.json"),
                "review_rounds": 1,
                "tests": {
                    k: {"passed": 3, "observed": 3} for k in ("public", "hidden")
                },
                "signed_quality": {
                    "passed": True,
                    "artifact_sha256": {"assessment.json": report.sha256(assessment)},
                },
            },
        )
    elif issue == "request-drift":
        update(root / "f1/quality/evaluator-request.json", candidates=["changed"])
    elif issue == "gates-drift":
        update(root / "f1/quality/gates.json", added="changed")
    elif issue == "trace-drift":
        update(root / "f1/quality/trace.json", added="changed")
    elif issue == "declaration-drift":
        update(declaration, added="changed")
    elif issue == "manifest-drift":
        update(root / "f1/manifest.json", added="changed")
    elif issue == "foundation-slot":
        update(root / "f2/manifest.json", pair_id="f1")
    elif issue == "incomplete-meter":
        (root / "l3/calls.jsonl").write_text("")
    elif issue == "dry-run":
        update(root / "m1/manifest.json", dry_run=True)
    elif issue == "wrong-b0":
        for manifest in root.glob("l*/manifest.json"):
            update(manifest, baseline_hash="d" * 64)
    elif issue in {"requirements_hash", "expected_hash", "test_oracle_hash"}:
        for manifest in root.glob("l*/manifest.json"):
            update(manifest, **{issue: "f" * 64})
    elif issue == "secondary-feature":
        for manifest in root.glob("*/manifest.json"):
            update(manifest, feature_id="export-history-csv")
    completed = invoke(root, declaration)
    assert completed.returncode != 0
    assert completed.stderr and not completed.stdout
