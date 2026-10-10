// Generates src/schema.gen.ts from the current schema version. Run: npm run gen:types
import * as fs from "node:fs";
import { compile } from "json-schema-to-typescript";

const SCHEMA = "schema/pi-peers-1.0.json";
const OUT = "src/schema.gen.ts";

const schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
const ts = await compile(schema, "PiPeers", {
	bannerComment: `// Generated from ${SCHEMA} by scripts/gen-types.ts. Do not edit; change the schema and rerun npm run gen:types.`,
	unreachableDefinitions: true,
	additionalProperties: false,
	style: { useTabs: true, printWidth: 120 },
});
fs.writeFileSync(OUT, ts);
console.log(`wrote ${OUT}`);
