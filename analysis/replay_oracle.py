"""Run post-pipeline acceptance controls on an isolated checkout of a given SHA."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def digest_tree(directory: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(
        p for p in directory.rglob("*") if p.is_file() and "__pycache__" not in p.parts
    ):
        digest.update(str(path.relative_to(directory)).encode() + b"\0")
        digest.update(path.read_bytes() + b"\0")
    return digest.hexdigest()


def suite(checkout: Path, output: Path, target: str, python: str) -> dict:
    output.mkdir()
    junit = output / "junit.xml"
    cmd = [
        python,
        "-m",
        "pytest",
        "-q",
        "-o",
        "addopts=",
        "--strict-markers",
        "-p",
        "no:cacheprovider",
        f"--junitxml={junit}",
        target,
    ]
    env = {
        k: v for k, v in os.environ.items() if not k.startswith(("PYTHON", "PYTEST"))
    }
    env.update(PYTHONDONTWRITEBYTECODE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
    started = time.monotonic()
    with (output / "pytest.log").open("wb") as log:
        run = subprocess.run(
            cmd, cwd=checkout, env=env, stdout=log, stderr=subprocess.STDOUT
        )
    cases = []
    if junit.is_file():
        for item in ET.parse(junit).iter("testcase"):
            state = next(
                (
                    status
                    for status in ("failure", "error", "skipped")
                    if item.find(status) is not None
                ),
                "passed",
            )
            cases.append(
                dict(id=f"{item.get('classname')}::{item.get('name')}", status=state)
            )
    counts = {
        state: sum(c["status"] == state for c in cases)
        for state in ("failure", "error", "skipped", "passed")
    }
    return {
        "exit": run.returncode,
        "elapsed_s": round(time.monotonic() - started, 3),
        "counts": counts,
        "cases": sorted(cases, key=lambda c: c["id"]),
        "log": f"{output.name}/pytest.log",
        "junit": f"{output.name}/junit.xml",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo", required=True, type=Path, help="standalone trusted QA repository"
    )
    parser.add_argument(
        "--rev", required=True, help="commit of the base, reference or mutation"
    )
    parser.add_argument("--feature", required=True)
    parser.add_argument("--expect", required=True, choices=["red", "green", "mutant"])
    parser.add_argument(
        "--out", required=True, type=Path, help="new, dedicated evidence directory"
    )
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="interpreter with the stand dependencies",
    )
    args = parser.parse_args()
    feature_root = ROOT / "bench/features"
    feature = (feature_root / args.feature).resolve()
    if feature.parent != feature_root or not (feature / "hidden_tests").is_dir():
        parser.error("unknown feature")
    oracle = feature / "hidden_tests"
    repo = args.repo.resolve()
    sha = git(
        "rev-parse", "--verify", "--end-of-options", args.rev + "^{commit}", cwd=repo
    )
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    result = dict(
        feature=feature.name,
        revision=sha,
        oracle_sha256=digest_tree(oracle),
        expected=args.expect,
    )
    with tempfile.TemporaryDirectory(prefix="frugal-qa-") as temp:
        clone = Path(temp) / "checkout"
        git("init", "--quiet", str(clone))
        git("fetch", "--quiet", "--depth=1", str(repo), sha, cwd=clone)
        git("checkout", "--quiet", "--detach", "FETCH_HEAD", cwd=clone)
        result["regression"] = suite(clone, out / "regression", "tests", args.python)
        shutil.copytree(
            oracle,
            clone / "qa_acceptance",
            ignore=shutil.ignore_patterns("__pycache__"),
        )
        result["acceptance"] = suite(
            clone, out / "acceptance", "qa_acceptance", args.python
        )
    acceptance = result["acceptance"]
    counts = acceptance["counts"]
    total = len(acceptance["cases"])
    valid = (
        result["regression"]["exit"] == 0
        and result["regression"]["counts"]["passed"]
        == len(result["regression"]["cases"])
        > 0
        and 15 <= total <= 30
        and counts["error"] + counts["skipped"] == 0
        and len({case["id"] for case in acceptance["cases"]}) == total
    )
    if args.expect == "green":
        valid = valid and acceptance["exit"] == 0 and counts["passed"] == total
    elif args.expect == "red":
        valid = valid and acceptance["exit"] == 1 and counts["failure"] == total
    else:
        valid = valid and acceptance["exit"] == 1 and counts["failure"] >= 1
    result["verified"] = valid
    (out / "result.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n"
    )
    print(
        f"{args.feature} {sha[:12]} {args.expect} {counts} verified={valid} evidence={out}"
    )
    return int(not valid)


if __name__ == "__main__":
    raise SystemExit(main())
