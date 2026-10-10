// Schema compatibility (ADR 0001, "Compatibility tests"): sample records of every released
// version must keep validating, and what the code produces today must validate too.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fail, ok, PROTOCOL, SCHEMA_VERSION } from "../../src/protocol.ts";

const root = path.resolve(import.meta.dirname, "../..");
const schema = JSON.parse(fs.readFileSync(path.join(root, "schema/pi-peers-1.0.json"), "utf8"));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(schema);
const check = (def: string, value: unknown): string[] => {
	const validate = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
	assert.ok(validate, `no $def ${def}`);
	return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

const fixturesRoot = path.join(root, "test/fixtures");
for (const version of fs.readdirSync(fixturesRoot)) {
	for (const file of fs.readdirSync(path.join(fixturesRoot, version))) {
		const def = file.replace(/(-[a-z-]+)?\.json$/, "");
		test(`fixture ${version}/${file} validates as ${def}`, () => {
			const value = JSON.parse(fs.readFileSync(path.join(fixturesRoot, version, file), "utf8"));
			for (const v of Array.isArray(value) ? value : [value]) assert.deepEqual(check(def, v), []);
		});
	}
}

test("records the code produces validate", () => {
	assert.deepEqual(check("Response", ok({ id: "1", type: "get_state" }, { idle: true })), []);
	assert.deepEqual(check("Response", JSON.parse(JSON.stringify(fail({ id: "1", type: "prompt" }, "denied", "no")))), []);
	assert.deepEqual(check("VersionRange", PROTOCOL), []);
	assert.deepEqual(check("Version", SCHEMA_VERSION), []);
});

test("AgentState rejects a token, so list output can't leak one", () => {
	const leaked = JSON.parse(fs.readFileSync(path.join(fixturesRoot, "1.0/AgentState-via.json"), "utf8"));
	assert.notDeepEqual(check("AgentState", { ...leaked, token: "secret" }), []);
});

test("unknown error codes are rejected by 1.0, so adding one needs a minor version bump", () => {
	assert.notDeepEqual(check("ErrorCode", "brand_new_code"), []);
});
