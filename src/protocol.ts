// pi-peers wire protocol v1.0: newline-delimited JSON over a local pipe/socket.
// Record shapes come from schema/pi-peers-1.0.json via src/schema.gen.ts.
// See docs/adr/0001-pi-agent-discovery-and-remote-control.md.

import type { ErrorCode, Peer, Response, VersionRange } from "./schema.gen.ts";

export type { ErrorCode, Peer, Response, VersionRange };

export const PROTOCOL = { version: "1.0", minVersion: "1.0" } as const;
export const SCHEMA_VERSION = "1.0";
export const MAX_HOPS = 3;

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["approval_timeout", "agent_unavailable", "connection_lost", "ssh_failed"]);

/** An incoming record before its type-specific fields are checked. */
export interface Request {
	id: string;
	type: string;
	[key: string]: unknown;
}

export class PeersError extends Error {
	readonly code: ErrorCode;
	readonly data?: unknown;

	constructor(code: ErrorCode, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export function ok(req: Request, data?: unknown): Response {
	return { type: "response", id: req.id, command: req.type, success: true, data };
}

export function fail(req: Pick<Request, "id" | "type">, code: ErrorCode, message: string, data?: unknown): Response {
	return {
		type: "response",
		id: req.id,
		command: req.type,
		success: false,
		error: message,
		errorCode: code,
		retryable: RETRYABLE.has(code),
		data,
	};
}

function parseVersion(v: string): [number, number] {
	const m = typeof v === "string" ? v.match(/^(\d+)\.(\d+)$/) : null;
	if (!m) throw new PeersError("invalid_request", `bad version "${v}"`);
	return [Number(m[1]), Number(m[2])];
}

function cmp(a: string, b: string): number {
	const [am, an] = parseVersion(a);
	const [bm, bn] = parseVersion(b);
	return am - bm || an - bn;
}

/** Highest version both ranges support, or undefined when they don't overlap. */
export function negotiate(a: VersionRange, b: VersionRange): string | undefined {
	if (!b || typeof b !== "object") throw new PeersError("invalid_request", "missing version range");
	const agreed = cmp(a.version, b.version) <= 0 ? a.version : b.version;
	const floor = cmp(a.minVersion, b.minVersion) >= 0 ? a.minVersion : b.minVersion;
	return cmp(agreed, floor) >= 0 ? agreed : undefined;
}

/** Splits a byte stream into JSON records, one per line. */
export function lineReader(onRecord: (record: unknown) => void, onBad: (line: string) => void): (chunk: Buffer | string) => void {
	let buf = "";
	return (chunk) => {
		buf += chunk.toString();
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			try {
				onRecord(JSON.parse(line));
			} catch {
				onBad(line);
			}
		}
	};
}

export const encode = (record: unknown): string => `${JSON.stringify(record)}\n`;

export function provenanceHeader(from: Peer, hops: number): string {
	return `[from pi-peers peer "${from.label}" (${from.id})@${from.host}, hop ${hops}/${MAX_HOPS}]`;
}
