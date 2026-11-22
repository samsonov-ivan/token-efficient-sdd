"""Verify reviewer signatures and the owner's attestation of the Ф0/E0 archive.

The owner attests that enrollment was fixed before the first run, all attempts
were recorded, and reference and negative quality controls passed.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import e0
from report import read_json, sha256

PRIMARY = "add-transfer-limits"
DIGEST = re.compile(r"[0-9a-f]{64}")
VERIFY = """
const {createHash, createPublicKey, verify} = require('node:crypto');
const {readFileSync} = require('node:fs');
const input = JSON.parse(readFileSync(0, 'utf8'));
const bytes = (name) => Buffer.from(input[name], 'base64');
const key = createPublicKey(bytes('key'));
if (key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, bytes('payload'), key, bytes('signature'))) process.exit(1);
if (input.request) {
  const {request_sha256, ...body} = JSON.parse(bytes('request'));
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  if (digest !== request_sha256) process.exit(1);
}
"""


class Ineligible(ValueError):
    pass


def trusted_key(variable, runs):
    path = Path(os.environ.get(variable, ""))
    if not path.is_absolute():
        raise Ineligible(f"Требуется абсолютный путь к доверенному ключу {variable}.")
    path = path.resolve(strict=True)
    if path.is_relative_to(runs.resolve()) or not path.is_file():
        raise Ineligible(f"Доверенный ключ {variable} должен находиться вне архива.")
    key = path.read_bytes()
    if not key.startswith(b"-----BEGIN PUBLIC KEY-----"):
        raise Ineligible(
            f"Требуется открытый ключ Ed25519 в формате PEM для {variable}."
        )
    return key


def verify_signature(key, payload, signature, *, request=None):
    fields = {"key": key, "payload": payload, "signature": signature}
    if request is not None:
        fields["request"] = request
    if len(signature) != 64:
        return False
    verified = subprocess.run(
        ["node", "-e", VERIFY],
        input=json.dumps({k: base64.b64encode(v).decode() for k, v in fields.items()}),
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return verified.returncode == 0


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check_assessment(data, expected, final_commit, request):
    assessment = json.loads(data)
    request_data = json.loads(request)
    reviewer = assessment.get("reviewer")
    request_hash = request_data.get("request_sha256", "")
    if (
        digest(data) != expected
        or assessment.get("version") != 1
        or not isinstance(reviewer, str)
        or not reviewer.strip()
        or request_data.get("version") != 1
        or request_data.get("final_commit") != final_commit
        or not DIGEST.fullmatch(request_hash)
        or assessment.get("request_sha256") != request_hash
        or not assessment.get("semantic")
        or any(row.get("verdict") != "pass" for row in assessment["semantic"])
        or not isinstance(assessment.get("links"), list)
        or assessment.get("final_commit") != final_commit
    ):
        raise Ineligible("Оценка независимого проверяющего расходится с архивом.")


def foundation_qa(a, reviewer_key):
    m = a.manifest
    if not e0.full_acceptance(a):
        raise Ineligible(f"{a.path.name}: не подтверждена полная приёмка Ф0.")
    expected = m.get("assessment_sha256")
    if not isinstance(expected, str) or not DIGEST.fullmatch(expected):
        raise Ineligible(f"{a.path.name}: требуется подписанная оценка Ф0.")
    dirname = f"evaluation/assessments/{expected}"
    assessment = e0.archive_file(a.path, f"{dirname}/assessment.json").read_bytes()
    signature = e0.archive_file(a.path, f"{dirname}/assessment.sig").read_bytes()
    request = e0.archive_file(a.path, "quality/evaluator-request.json").read_bytes()
    decision_bytes = e0.archive_file(a.path, f"{dirname}/decision.json").read_bytes()
    if not verify_signature(reviewer_key, assessment, signature, request=request):
        raise Ineligible(
            f"{a.path.name}: подпись проверяющего или хэш запроса неверны."
        )
    check_assessment(assessment, expected, m["final_commit"], request)
    decision = json.loads(decision_bytes)
    if (
        decision.get("final_commit") != m["final_commit"]
        or decision.get("assessment_sha256") != expected
        or decision.get("usage_scope") != "independent-post-pipeline"
    ):
        raise Ineligible(f"{a.path.name}: офлайн-решение QA расходится с архивом.")
    return {
        "assessment_sha256": expected,
        "assessment_signature_sha256": digest(signature),
        "qa_request_sha256": digest(request),
        "qa_decision_sha256": digest(decision_bytes),
        "qa_gates_sha256": sha256(e0.archive_file(a.path, "quality/gates.json")),
        "qa_trace_sha256": sha256(e0.archive_file(a.path, "quality/trace.json")),
    }


def admission_proof(runs, declaration, baseline_hash, reviewer_key):
    if not DIGEST.fullmatch(baseline_hash):
        raise Ineligible("Требуется SHA-256 замороженного B0.")
    declaration_hash = sha256(declaration)
    cohorts = e0.load_cohorts(declaration, fixture=False)
    if not {"M-M", "M-L"}.issubset(cohorts):
        raise Ineligible("Требуются обе когорты E0: M-M и M-L.")
    foundation = read_json(declaration).get("foundation")
    if not isinstance(foundation, dict) or "experiment" not in foundation:
        raise Ineligible("Требуется foundation с model, experiment и runs.")
    ids = foundation.get("runs")
    experiment = foundation["experiment"]
    if (
        foundation.get("model") != cohorts["M-M"]["model"]
        or not isinstance(ids, list)
        or len(ids) != 2
        or any(not isinstance(i, str) or not e0.RUN_ID.fullmatch(i) for i in ids)
        or len(set(ids)) != 2
        or (experiment is not None and not isinstance(experiment, str))
    ):
        raise Ineligible("Ф0 требует два разных прогона на объявленной модели M-M.")
    output = {
        "protocol": "frugal-live-admission-v1",
        "feature_id": PRIMARY,
        "declaration_sha256": declaration_hash,
        "baseline_hash": baseline_hash,
        "reviewer_key_sha256": digest(reviewer_key),
        "cohorts": {},
    }
    feature_inputs = None
    for label, group, exp, minimum in (
        ("foundation", foundation, experiment, 2),
        *((k, cohorts[k], *e0.COHORTS[k][:2]) for k in ("M-M", "M-L")),
    ):
        records = e0.inspect_cohort(runs, exp, group["model"], group["runs"], False)
        measured = [r.attempt for r in records if r.usable]
        if len(measured) < minimum:
            raise Ineligible(f"{label}: измерено {len(measured)}, требуется {minimum}.")
        evidence = []
        for a in measured:
            m = a.manifest
            if m["feature_id"] != PRIMARY or m["baseline_hash"] != baseline_hash:
                raise Ineligible(f"{a.path.name}: другая основная фича или B0.")
            inputs = (
                m["repo"],
                m["requirements_hash"],
                m["expected_hash"],
                m["test_oracle_hash"],
            )
            if feature_inputs is None:
                feature_inputs = inputs
            if inputs != feature_inputs:
                raise Ineligible(
                    f"{a.path.name}: расходятся репозиторий, требования, эталон или тестовый оракул."
                )
            item = {
                "id": a.path.name,
                "final_commit": m["final_commit"],
                "manifest_sha256": sha256(e0.archive_file(a.path, "manifest.json")),
                "meter_sha256": sha256(e0.archive_file(a.path, "meter.json")),
                "calls_sha256": sha256(e0.archive_file(a.path, "calls.jsonl")),
            }
            if label == "foundation":
                item.update(foundation_qa(a, reviewer_key))
            evidence.append(item)
        entry = {"model": group["model"], "experiment": exp, "runs": evidence}
        if label == "foundation":
            output[label] = entry
        else:
            output["cohorts"][label] = entry
    if declaration_hash != sha256(declaration):
        raise Ineligible("Декларация изменилась за время проверки.")
    return output


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--runs", required=True, type=Path)
    cli.add_argument("--cohorts", required=True, type=Path)
    cli.add_argument("--baseline-hash", required=True)
    cli.add_argument("--prepare-attestation", action="store_true")
    args = cli.parse_args()
    try:
        reviewer_key = trusted_key("FRUGAL_LIVE_REVIEWER_KEY", args.runs)
        owner_key = (
            None
            if args.prepare_attestation
            else trusted_key("FRUGAL_LIVE_OWNER_KEY", args.runs)
        )
        result = admission_proof(
            args.runs, args.cohorts, args.baseline_hash, reviewer_key
        )
        encoded = canonical_json(result) + "\n"
        if owner_key is None:
            sys.stdout.write(encoded)
            return 0
        signature = e0.archive_file(
            args.cohorts.parent, f"{args.cohorts.name}.sig"
        ).read_bytes()
        if not verify_signature(owner_key, encoded.encode(), signature):
            raise Ineligible("Подпись владельца не подтверждает архив Ф0/E0.")
    except Ineligible as exc:
        print(exc, file=sys.stderr)
        return 1
    except e0.ARCHIVE_ERRORS:
        print("Декларация или архив доказательств не прошли проверку.", file=sys.stderr)
        return 1
    print(canonical_json({"eligible": True, **result}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
