import assert from "node:assert/strict";
import { test } from "node:test";
import { fail, lineReader, negotiate, ok, PeersError, provenanceHeader } from "../../src/protocol.ts";

test("negotiate picks the highest common version", () => {
	assert.equal(negotiate({ version: "1.0", minVersion: "1.0" }, { version: "1.0", minVersion: "1.0" }), "1.0");
	assert.equal(negotiate({ version: "1.3", minVersion: "1.0" }, { version: "1.1", minVersion: "1.0" }), "1.1");
	assert.equal(negotiate({ version: "2.1", minVersion: "1.4" }, { version: "1.9", minVersion: "1.0" }), "1.9");
});

test("negotiate returns undefined when ranges don't overlap", () => {
	assert.equal(negotiate({ version: "1.0", minVersion: "1.0" }, { version: "2.0", minVersion: "2.0" }), undefined);
	assert.equal(negotiate({ version: "2.3", minVersion: "2.0" }, { version: "1.9", minVersion: "1.0" }), undefined);
});

test("negotiate rejects malformed ranges as invalid_request", () => {
	assert.throws(() => negotiate({ version: "1.0", minVersion: "1.0" }, undefined as never), (e: unknown) => e instanceof PeersError && e.code === "invalid_request");
	assert.throws(() => negotiate({ version: "1.0", minVersion: "1.0" }, { version: "one", minVersion: "1.0" }), PeersError);
});

test("lineReader reassembles records split across chunks and reports bad lines", () => {
	const records: unknown[] = [];
	const bad: string[] = [];
	const feed = lineReader((r) => records.push(r), (l) => bad.push(l));
	feed('{"a":1}\n{"b"');
	feed(':2}\n\nnot json\n{"c":3}');
	assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
	assert.deepEqual(bad, ["not json"]);
	feed("\n");
	assert.deepEqual(records, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("fail marks only transient errors as retryable", () => {
	const req = { id: "r1", type: "prompt" };
	assert.equal(fail(req, "agent_unavailable", "x").retryable, true);
	assert.equal(fail(req, "approval_timeout", "x").retryable, true);
	assert.equal(fail(req, "denied", "x").retryable, false);
	assert.deepEqual(fail(req, "hop_limit", "too far"), {
		type: "response",
		id: "r1",
		command: "prompt",
		success: false,
		error: "too far",
		errorCode: "hop_limit",
		retryable: false,
		data: undefined,
	});
	assert.deepEqual(ok({ id: "r2", type: "get_state" }, { idle: true }), { type: "response", id: "r2", command: "get_state", success: true, data: { idle: true } });
});

test("provenanceHeader names the sender and the hop count", () => {
	assert.equal(provenanceHeader({ id: "abc", label: "pi1", host: "box" }, 2), '[from pi-peers peer "pi1" (abc)@box, hop 2/3]');
});
