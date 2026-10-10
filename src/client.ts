// Client side of a pi-peers connection: hello, then request/response by id.
// The transport is any duplex stream: a local pipe/socket, or an SSH child's stdio.

import * as crypto from "node:crypto";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import type { AgentEntry } from "./discovery.ts";
import { encode, lineReader, PeersError, PROTOCOL, type Peer, type Response } from "./protocol.ts";

export const CONNECT_TIMEOUT_MS = 5_000;

export class PeersClient {
	private pending = new Map<string, { resolve: (r: Response) => void; timer: NodeJS.Timeout }>();
	private stream: Duplex;
	private onClose: () => void;
	/** Text of the transport's last failure, e.g. SSH stderr; used in connection_lost errors. */
	failure?: string;

	constructor(stream: Duplex, onClose: () => void = () => stream.end()) {
		this.stream = stream;
		this.onClose = onClose;
		stream.on(
			"data",
			lineReader(
				(rec) => {
					const r = rec as Response;
					if (r?.type !== "response") return;
					const p = this.pending.get(r.id);
					if (!p) return;
					clearTimeout(p.timer);
					this.pending.delete(r.id);
					p.resolve(r);
				},
				() => {},
			),
		);
		const lost = () => {
			for (const [id, p] of this.pending) {
				clearTimeout(p.timer);
				p.resolve({
					type: "response",
					id,
					command: "?",
					success: false,
					error: this.failure ? `connection lost: ${this.failure}` : "connection lost",
					errorCode: "connection_lost",
					retryable: true,
				});
			}
			this.pending.clear();
		};
		stream.on("close", lost);
		stream.on("end", lost);
		stream.on("error", lost);
	}

	/** Connect to an agent on this host through its pipe or socket. */
	static async connect(entry: AgentEntry, from: Peer): Promise<PeersClient> {
		const sock = await new Promise<net.Socket>((resolve, reject) => {
			const s = net.connect(entry.endpoint);
			s.setTimeout(CONNECT_TIMEOUT_MS, () => {
				s.destroy();
				reject(new PeersError("agent_unavailable", `connect to ${entry.label} timed out`));
			});
			s.once("connect", () => {
				s.setTimeout(0);
				resolve(s);
			});
			s.once("error", (e) => reject(new PeersError("agent_unavailable", `connect to ${entry.label} failed: ${e.message}`)));
		});
		const client = new PeersClient(sock);
		await client.hello(from, entry.token);
		return client;
	}

	/** Send hello; a bridge adds the token itself, so remote clients pass none. */
	async hello(from: Peer, token?: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Response> {
		const hello = await this.request("hello", { protocol: PROTOCOL, token, from }, timeoutMs);
		if (!hello.success) {
			this.close();
			const code = hello.errorCode === "connection_lost" && this.failure ? "ssh_failed" : (hello.errorCode ?? "internal_error");
			throw new PeersError(code, hello.error ?? "hello failed", hello.data);
		}
		return hello;
	}

	request(type: string, fields: Record<string, unknown> = {}, timeoutMs = 30_000, id: string = crypto.randomUUID()): Promise<Response> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({
					type: "response",
					id,
					command: type,
					success: false,
					error: `no response within ${timeoutMs} ms`,
					errorCode: "connection_lost",
					retryable: true,
				});
			}, timeoutMs);
			this.pending.set(id, { resolve, timer });
			this.stream.write(encode({ id, type, ...fields }));
		});
	}

	close(): void {
		this.onClose();
	}
}
