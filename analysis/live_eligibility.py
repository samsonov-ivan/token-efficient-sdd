"""Verify archived Ф0 and E0 observations against the owner's preregistration.

The owner verifies enrollment was fixed before the first run, no attempts were
omitted, and reference/negative quality controls passed. The archives used here
do not establish those facts independently.
"""

import argparse
import json
import re
import sys
from pathlib import Path

import e0
from report import inspect_qa_receipt, read_json, sha256

PRIMARY = "add-transfer-limits"
DIGEST = re.compile(r"[0-9a-f]{64}")


class Ineligible(ValueError):
    pass


def check_assessment(path, expected, final_commit, request=None):
    data = read_json(path)
    reviewer = data.get("reviewer")
    if (
        sha256(path) != expected
        or data.get("version") != 1
        or not isinstance(reviewer, str)
        or not reviewer.strip()
        or not DIGEST.fullmatch(data.get("request_sha256", ""))
        or (request is not None and data["request_sha256"] != request)
        or not data.get("semantic")
        or any(row.get("verdict") != "pass" for row in data["semantic"])
        or not isinstance(data.get("links"), list)
        or data.get("final_commit") != final_commit
    ):
        raise Ineligible("Оценка независимого проверяющего расходится с архивом.")


def foundation_qa(a):
    m = a.manifest
    if not e0.full_acceptance(a):
        raise Ineligible(f"{a.path.name}: не подтверждена полная приёмка Ф0.")
    receipt = e0.archive_file(
        a.path.parent, f"summary/{a.path.name}-quality.json", optional=True
    )
    expected = m.get("assessment_sha256")
    if receipt.exists():
        inspect_qa_receipt(a)
        qa = a.qa_receipt
        verdict = qa["signed_quality"]
        digest = verdict.get("artifact_sha256", {}).get("assessment.json", "")
        if (
            verdict["passed"] is not True
            or verdict.get("failed_checks")
            or qa.get("accepted") is False
            or qa.get("review_bound_to_final") is False
            or qa.get("public_contract_defects")
            or any(
                key in a.metrics and value != a.metrics[key]
                for key, value in verdict.get("metrics", {}).items()
            )
            or qa["review_rounds"] < 1
            or any(
                qa["tests"][kind]["observed"] != qa["tests"][kind]["passed"]
                or qa["tests"][kind]["observed"] < 1
                or qa["tests"][kind].get("missing", 0) != 0
                for kind in ("public", "hidden")
            )
            or not DIGEST.fullmatch(digest)
            or (expected is not None and digest != expected)
        ):
            raise Ineligible(f"{a.path.name}: независимая сводка не подтверждает Ф0.")
        filename = verdict.get("files", {}).get("assessment.json")
        if filename is not None:
            if not isinstance(filename, str) or "/" in filename:
                raise Ineligible(f"{a.path.name}: неверный путь к оценке QA.")
            check_assessment(
                e0.archive_file(receipt.parent, filename),
                digest,
                m["final_commit"],
                qa.get("request_sha256"),
            )
        return {"assessment_sha256": digest, "qa_receipt_sha256": sha256(receipt)}
    if not isinstance(expected, str) or not DIGEST.fullmatch(expected):
        raise Ineligible(f"{a.path.name}: требуется решение независимого проверяющего.")
    dirname = f"evaluation/assessments/{expected}"
    assessment_file = e0.archive_file(a.path, f"{dirname}/assessment.json")
    decision_file = e0.archive_file(a.path, f"{dirname}/decision.json")
    check_assessment(assessment_file, expected, m["final_commit"])
    decision = read_json(decision_file)
    if (
        decision.get("final_commit") != m["final_commit"]
        or decision.get("assessment_sha256") != expected
        or decision.get("usage_scope") != "independent-post-pipeline"
    ):
        raise Ineligible(f"{a.path.name}: офлайн-решение QA расходится с архивом.")
    return {"assessment_sha256": expected, "qa_decision_sha256": sha256(decision_file)}


def eligibility(runs, declaration, baseline_hash):
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
        "eligible": True,
        "feature_id": PRIMARY,
        "declaration_sha256": declaration_hash,
        "baseline_hash": baseline_hash,
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
            inputs = (m["repo"], m["requirements_hash"])
            if feature_inputs is None:
                feature_inputs = inputs
            if inputs != feature_inputs:
                raise Ineligible(
                    f"{a.path.name}: расходится репозиторий или требование."
                )
            item = {
                "id": a.path.name,
                "final_commit": m["final_commit"],
                "manifest_sha256": sha256(a.path / "manifest.json"),
                "meter_sha256": sha256(a.path / "meter.json"),
            }
            if label == "foundation":
                item.update(foundation_qa(a))
            evidence.append(item)
        entry = {"model": group["model"], "experiment": exp, "runs": evidence}
        if label == "foundation":
            output[label] = entry
        else:
            output["cohorts"][label] = entry
    if declaration_hash != sha256(declaration):
        raise Ineligible("Декларация изменилась за время проверки.")
    return output


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--runs", required=True, type=Path)
    cli.add_argument("--cohorts", required=True, type=Path)
    cli.add_argument("--baseline-hash", required=True)
    args = cli.parse_args()
    try:
        result = eligibility(args.runs, args.cohorts, args.baseline_hash)
    except Ineligible as exc:
        print(exc, file=sys.stderr)
        return 1
    except e0.ARCHIVE_ERRORS:
        print("Декларация или архив доказательств не прошли проверку.", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
