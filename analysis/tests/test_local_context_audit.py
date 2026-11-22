import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_context_audit import audit_task, provider_tokens  # noqa: E402


def test_server_usage_counts_cache_once_and_requires_complete_stream():
    usage = {
        "prompt_tokens": 9,
        "prompt_tokens_details": {"cached_tokens": 3},
        "completion_tokens": 2,
        "total_tokens": 11,
    }
    raw = b"data: " + json.dumps({"usage": usage}).encode() + b"\n\n"
    assert provider_tokens(raw + b"data: [DONE]\n\n", "text/event-stream") == (9, 2)
    with pytest.raises(ValueError, match="truncated"):
        provider_tokens(raw, "text/event-stream")


def test_native_input_must_match_http_even_when_combined_total_matches(tmp_path):
    calls = tmp_path / "calls"
    calls.mkdir()
    req = b"{}"
    resp = b'{"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}'
    meta = {
        "complete": True,
        "status": 200,
        "content_type": "application/json",
        "request_sha256": hashlib.sha256(req).hexdigest(),
        "response_sha256": hashlib.sha256(resp).hexdigest(),
    }
    (calls / "0001.meta.json").write_text(json.dumps(meta))
    (calls / "0001.request.json").write_bytes(req)
    (calls / "0001.response").write_bytes(resp)
    tokens = {
        "input": 7,
        "cache": {"read": 2, "write": 0},
        "output": 2,
        "reasoning": 0,
        "total": 11,
    }
    evt = {
        "type": "step_finish",
        "sessionID": "s",
        "part": {"id": "p", "tokens": tokens},
    }
    native = tmp_path / "native.jsonl"
    native.write_text(json.dumps(evt))
    assert not audit_task(tmp_path)["issues"]
    tokens.update(input=6, output=3)
    native.write_text(json.dumps(evt))
    assert "provider/native token sequences differ" in audit_task(tmp_path)["issues"]
    (calls / "0001.response").write_bytes(resp + b" ")
    assert audit_task(tmp_path)["known_total"] == 0
