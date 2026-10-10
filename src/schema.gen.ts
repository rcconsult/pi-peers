// Generated from schema/pi-peers-1.0.json by scripts/gen-types.ts. Do not edit; change the schema and rerun npm run gen:types.

/**
 * MAJOR.MINOR
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "Version".
 */
export type Version = string;
/**
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "ErrorCode".
 */
export type ErrorCode =
	| "hello_required"
	| "auth_failed"
	| "incompatible_version"
	| "invalid_request"
	| "unsupported_command"
	| "denied"
	| "approval_timeout"
	| "no_ui"
	| "steer_not_allowed"
	| "hop_limit"
	| "ambiguous_target"
	| "agent_not_found"
	| "agent_unavailable"
	| "connection_lost"
	| "ssh_failed"
	| "internal_error";
/**
 * Any record a client sends.
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "Request".
 */
export type Request = Hello | GetState | GetLastAssistantText | Delivery;
/**
 * Reverse-link control records on the stdio of `ssh <host> pi-peers expose`.
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "LinkFrame".
 */
export type LinkFrame =
	| {
			op: "expose";
			agent: ExposedAgent;
	  }
	| {
			op: "update";
			agent: ExposedAgent;
	  }
	| {
			op: "ready";
	  }
	| {
			op: "open" | "close";
			ch: number;
	  }
	| {
			op: "rec";
			ch: number;
			rec: {};
	  };

/**
 * pi-peers remote-control schema, version 1.0. Wire records are newline-delimited JSON. Minor versions only add optional fields, commands, events, error codes and enum values; receivers ignore what they don't know. See docs/adr/0001-pi-agent-discovery-and-remote-control.md.
 */
export interface PiPeers {
	[k: string]: unknown;
}
/**
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "VersionRange".
 */
export interface VersionRange {
	/**
	 * Highest version supported
	 */
	version: string;
	/**
	 * Lowest version still supported
	 */
	minVersion: string;
}
/**
 * Who is speaking. Shown to the receiving model in the provenance header.
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "Peer".
 */
export interface Peer {
	id: string;
	label: string;
	host: string;
}
/**
 * First record on every connection. Frozen across versions: it may only gain optional fields.
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "Hello".
 */
export interface Hello {
	id: string;
	type: "hello";
	protocol: VersionRange;
	/**
	 * From the agent's discovery file. Omitted by remote clients; the bridge adds it.
	 */
	token?: string;
	from?: Peer;
}
/**
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "GetState".
 */
export interface GetState {
	id: string;
	type: "get_state";
}
/**
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "GetLastAssistantText".
 */
export interface GetLastAssistantText {
	id: string;
	type: "get_last_assistant_text";
}
/**
 * prompt, follow_up or steer: a message injected into the receiving agent.
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "Delivery".
 */
export interface Delivery {
	/**
	 * Also the dedupe key: a repeated id within 10 minutes returns the original response.
	 */
	id: string;
	type: "prompt" | "follow_up" | "steer";
	message: string;
	/**
	 * Peer messages in this chain so far, this one included. Refused above 3.
	 */
	hops?: number;
	/**
	 * The sender waits for the answer (peers_send wait=true); shapes the reply hint.
	 */
	awaitsReply?: boolean;
}
/**
 * Reply to one request, matched by id. Extends pi's RPC response shape with errorCode and retryable.
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "Response".
 */
export interface Response {
	type: "response";
	id: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	errorCode?: ErrorCode;
	retryable?: boolean;
}
/**
 * Discovery file $PI_PEERS_HOME/agents/<id>.json. Readable only by the user.
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "AgentEntry".
 */
export interface AgentEntry {
	schemaVersion: Version;
	protocol: VersionRange;
	/**
	 * pi's session id, so it survives /reload and /resume; -<pid> appended for a second process on the same session.
	 */
	id: string;
	/**
	 * The user-supplied pi session name.
	 */
	sessionName?: string;
	piSessionId?: string;
	/**
	 * sessionName, else the cwd base name, else id.
	 */
	label: string;
	host: string;
	/**
	 * process.platform of the writer. Entries from another runtime are skipped, never pruned.
	 */
	runtime?: string;
	/**
	 * Set by a reverse link: the host where the agent really runs.
	 */
	via?: string;
	/**
	 * The real agent's runtime, for reverse-link entries.
	 */
	remoteRuntime?: string;
	pid: number;
	cwd: string;
	/**
	 * Named pipe on Windows, Unix socket elsewhere.
	 */
	endpoint: string;
	/**
	 * Secret. Never printed by list, never sent over SSH by list.
	 */
	token: string;
	piVersion?: string;
	startedAt: string;
}
/**
 * get_state data, and each row of `pi-peers list --json`: an AgentEntry without its token, plus live status.
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "AgentState".
 */
export interface AgentState {
	schemaVersion?: Version;
	protocol?: VersionRange;
	id: string;
	sessionName?: string;
	piSessionId?: string;
	label: string;
	host: string;
	runtime?: string;
	via?: string;
	remoteRuntime?: string;
	pid?: number;
	cwd: string;
	endpoint?: string;
	piVersion?: string;
	startedAt?: string;
	idle?: boolean;
	/**
	 * Completed agent runs; a waiting sender compares it before and after.
	 */
	settled?: number;
	/**
	 * list only: idle, busy, or an error code.
	 */
	status?: string;
}
/**
 * What a reverse link publishes about an agent on the far host.
 *
 * This interface was referenced by `PiPeers`'s JSON-Schema
 * via the `definition` "ExposedAgent".
 */
export interface ExposedAgent {
	schemaVersion: Version;
	protocol: VersionRange;
	id: string;
	sessionName?: string;
	piSessionId?: string;
	label: string;
	host: string;
	runtime?: string;
	cwd: string;
}
