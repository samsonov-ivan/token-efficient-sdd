"""Reconcile public local OpenCode pilot runs from HTTP bytes and native events."""

import argparse
import hashlib
import json
import re
from pathlib import Path


def read(path):
    return json.loads(path.read_bytes())


def count(value):
    if type(value) is not int or value < 0:
        raise ValueError("invalid token count")
    return value


def provider_tokens(raw, content_type):
    text = raw.decode()
    if "event-stream" in content_type or text.lstrip().startswith("data:"):
        data = [
            line[5:].strip() for line in text.splitlines() if line.startswith("data:")
        ]
        if not data or data[-1] != "[DONE]":
            raise ValueError("truncated SSE response")
        events = [json.loads(s) for s in data[:-1]]
        if any("error" in event for event in events):
            raise ValueError("server error event")
        rows = [e["usage"] for e in events if e.get("usage") is not None]
        if not rows or any(row != rows[-1] for row in rows):
            raise ValueError("missing or conflicting server usage")
        usage = rows[-1]
    else:
        usage = json.loads(text)["usage"]
    prompt = count(usage["prompt_tokens"])
    output = count(usage["completion_tokens"])
    if count(usage["total_tokens"]) != prompt + output:
        raise ValueError("server total differs from input plus output")
    return prompt, output


def native_steps(path):
    steps, seen = [], set()
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event["type"] != "step_finish":
            continue
        part = event["part"]
        key = (event["sessionID"], part["id"])
        if key in seen:
            raise ValueError("duplicate native step")
        seen.add(key)
        tokens = part["tokens"]
        prompt = sum(
            map(
                count,
                (tokens["input"], tokens["cache"]["read"], tokens["cache"]["write"]),
            )
        )
        output = count(tokens["output"]) + count(tokens["reasoning"])
        if (
            tokens.get("total") is not None
            and count(tokens["total"]) != prompt + output
        ):
            raise ValueError("native total differs from components")
        steps.append((key[0], prompt, output))
    return steps


def audit_task(folder):
    calls = folder / "calls"
    records, issues = [], []
    stems = sorted({p.name.split(".")[0] for p in calls.iterdir() if p.is_file()})
    if stems != [f"{i:04d}" for i in range(1, len(stems) + 1)] or not stems:
        issues.append("missing or nonconsecutive HTTP attempts")
    for stem in stems:
        if not re.fullmatch(r"[0-9]{4}", stem):
            continue
        try:
            meta = read(calls / f"{stem}.meta.json")
            request = (calls / f"{stem}.request.json").read_bytes()
            response = (calls / f"{stem}.response").read_bytes()
            for blob, key in [
                (request, "request_sha256"),
                (response, "response_sha256"),
            ]:
                if hashlib.sha256(blob).hexdigest() != meta[key]:
                    raise ValueError(f"{key} mismatch")
            if meta["status"] != 200:
                raise ValueError(f"HTTP {meta['status']}")
            if not meta.get("complete") or meta.get("issues"):
                raise ValueError("incomplete transport record")
            records.append(provider_tokens(response, meta.get("content_type", "")))
        except (OSError, KeyError, TypeError, ValueError) as exc:
            issues.append(f"{stem}: {exc}")
    steps = native_steps(folder / "native.jsonl")
    if records != [(prompt, output) for _, prompt, output in steps]:
        issues.append("provider/native token sequences differ")
    prompt = sum(n for n, _ in records)
    output = sum(n for _, n in records)
    return {
        "http_attempts": len(stems),
        "measured_calls": len(records),
        "native_steps": len(steps),
        "input": prompt,
        "output": output,
        "known_total": prompt + output,
        "session_ids": sorted({sid for sid, _, _ in steps}),
        "issues": issues,
    }


def audit_run(root):
    out = {}
    prompts = {}
    results = read(root / "run.json")
    for arm in ("shared", "fresh"):
        tasks = [audit_task(root / arm / f"task-{i}") for i in (1, 2)]
        checks_ok = []
        for i, task in enumerate(tasks, 1):
            directory = root / arm / f"task-{i}"
            prompt = (directory / "prompt.txt").read_bytes()
            result = read(directory / "result.json")
            if result["prompt_sha256"] != hashlib.sha256(prompt).hexdigest():
                raise ValueError("recorded task prompt hash differs from the archive")
            if prompts.setdefault(i, prompt) != prompt:
                raise ValueError("task prompt differs between arms")
            if result != results["results"][arm][i - 1]:
                raise ValueError("run summary differs from task result")
            checks = result.get("checks") or {}
            groups = ("api", "task1") if i == 1 else ("api", "task1", "task2")
            required = [checks.get(group, {}) for group in groups]
            checks_ok.append(
                result.get("code") == 0
                and all(
                    c.get("total", 0) > 0 and c.get("total") == c.get("passed")
                    for c in required
                )
            )
            if not task["issues"] and result["provider_rpt"] != task["known_total"]:
                raise ValueError("task RPT differs from raw server responses")
        left, right = (t["session_ids"] for t in tasks)
        correct_sids = len(left) == len(right) == 1 and (left == right) == (
            arm == "shared"
        )
        complete = correct_sids and not any(t["issues"] for t in tasks)
        out[arm] = {
            "tasks": tasks,
            "session_control": correct_sids,
            "complete_usage": complete,
            "public_checks_passed": all(checks_ok),
            "total": sum(t["known_total"] for t in tasks) if complete else None,
        }
    return out


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("runs", type=Path, nargs="+")
    results = {str(path): audit_run(path) for path in cli.parse_args().runs}
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return (
        0
        if all(
            arm["complete_usage"] for run in results.values() for arm in run.values()
        )
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
