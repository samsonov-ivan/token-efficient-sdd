"""Condense the three oracle controls per feature into a portable, auditable summary."""

import argparse
import hashlib
import json
from pathlib import Path

SIZES = ("small", "medium", "large")
CONTROLS = ("red", "green", "mutant")


def read_control(directory: Path, size: str, control: str) -> tuple[dict, dict, set]:
    filename = directory / f"{size}-{control}" / "result.json"
    raw = filename.read_bytes()
    result = json.loads(raw)
    expected = "mutant" if control.startswith("mutant-") else control
    if result["expected"] != expected or result["verified"] is not True:
        raise ValueError(f"control failed: {filename}")
    compact = dict(
        acceptance=result["acceptance"]["counts"],
        regression=result["regression"]["counts"],
        revision=result["revision"],
        source=f"{directory.name}/{size}-{control}/result.json",
        result_sha256=hashlib.sha256(raw).hexdigest(),
    )
    ids = {case["id"] for case in result["acceptance"]["cases"]}
    return result, compact, ids


def summarize(directory: Path) -> dict:
    grouped = {}
    base = set()
    for size in SIZES:
        controls = {}
        oracle_hashes, features, collected = set(), set(), []
        controls_on_disk = [
            d.name.removeprefix(f"{size}-")
            for d in sorted(directory.glob(f"{size}-mutant-*"))
            if d.is_dir()
        ]
        for control in [*CONTROLS, *controls_on_disk]:
            result, compact, ids = read_control(directory, size, control)
            oracle_hashes.add(result["oracle_sha256"])
            features.add(result["feature"])
            collected.append(ids)
            controls[control] = compact
            if control == "red":
                base.add(result["revision"])
        if (
            len(features) != 1
            or len(oracle_hashes) != 1
            or any(c != collected[0] for c in collected)
        ):
            raise ValueError(f"{size} controls used different inputs")
        grouped[size] = dict(
            feature=features.pop(), oracle_sha256=oracle_hashes.pop(), controls=controls
        )
    if len(base) != 1:
        raise ValueError("features used different base revisions")
    return dict(kind="wp01-oracle-qa", base_commit=base.pop(), features=grouped)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    result = summarize(args.directory)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
