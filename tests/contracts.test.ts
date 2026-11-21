import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const ajv = new Ajv({ strict: true, allowUnionTypes: true });
function validator(name: string) {
  const file = new URL(`../schemas/${name}.schema.json`, import.meta.url);
  return ajv.compile(JSON.parse(readFileSync(file, "utf8")));
}

describe("v1 experiment contracts", () => {
  it("compiles each published schema", () => {
    for (const name of ["call", "manifest", "findings", "frugal"]) {
      expect(validator(name)).toBeTypeOf("function");
    }
  });

  it("distinguishes a measured zero from an unknown component", () => {
    const validate = validator("call");
    const call = {
      run_id: "fixture", branch: "base", model: "mock/replay",
      provider_id: "mock", model_id: "replay", stage: "review", task: null,
      review_iter: 1, session_id: "s", message_id: "m", parent_session_id: null,
      event_key: "p", request_id: null, attempt: 1, source_schema: "fixture",
      usage_status: "known", ts: null, raw_ref: "raw/events.jsonl#L1",
      raw: {}, cost: null, t_in: 23, t_cache_read: 0, t_cache_write: 0,
      t_out: 4, t_reasoning: 0,
    };
    expect(validate(call)).toBe(true);
    expect(validate({ ...call, t_in: null })).toBe(false);
    expect(validate({ ...call, usage_status: "unknown", t_in: null })).toBe(true);
    expect(validate({ ...call, t_out: -1 })).toBe(false);
  });
});
