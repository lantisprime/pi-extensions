// herdr-control: json envelope + error classification tests.
import assert from "node:assert/strict";
import { parseEnvelope, extractError, errorCodeIs } from "../lib/json.ts";
import { AGENT_LIST_JSON, ERR_BLOCKED, ERR_STALLED } from "./fixtures.ts";

const parsed = parseEnvelope(AGENT_LIST_JSON);
assert.equal(parsed.ok, true);
assert.equal(parsed.envelope.id, "cli:agent:list");
assert.ok(Array.isArray(parsed.envelope.result.agents));

assert.equal(parseEnvelope("").ok, false, "empty output rejected");
assert.equal(parseEnvelope("not json").ok, false, "non-JSON rejected");
assert.equal(parseEnvelope('{"noresult":1}').ok, false, "missing result rejected");
assert.equal(parseEnvelope('{"id":1,"result":{}}').ok, false, "non-string id rejected");

// error extraction shapes
const nested = extractError(ERR_BLOCKED, 1);
assert.equal(nested.code, "agent_blocked");
assert.match(nested.message, /blocked/);

const flat = extractError(JSON.stringify({ code: "timeout", message: "timed out" }), 1);
assert.equal(flat.code, "timeout");

const bareString = extractError(JSON.stringify({ error: "boom" }), 1);
assert.equal(bareString.code, null);
assert.equal(bareString.message, "boom");

const raw = extractError("plain stderr text", 1);
assert.equal(raw.code, null);
assert.equal(raw.message, "plain stderr text");

const empty = extractError("", 1);
assert.match(empty.message, /exited with code 1/);

// code classification, incl. substring fallback
assert.equal(errorCodeIs(nested, "agent_blocked"), true);
assert.equal(errorCodeIs(nested, "timeout"), false);
assert.equal(errorCodeIs({ code: null, message: "herdr returned agent_prompt_stalled (no change)" }, "agent_prompt_stalled"), true);
assert.equal(errorCodeIs(extractError(ERR_STALLED, 1), "agent_prompt_stalled"), true);

console.log("test-json: all tests passed");
