# ADR 0001: Pi agent discovery and remote control

- **Status:** Proposed
- **Date:** 2026-10-10
- **Scope:** Phase 1 covers agents on the same host. Phase 2 covers agents across hosts over SSH.
- **Background:** [pi-extension-research.md](../pi-extension-research.md)
- **Name:** `pi-peers`, decided 2026-10-10.
  - npm: `pi-peers`, because `pies` and `pi-peer` were already taken.
  - GitHub: `rcconsult/pi-peers`.
  - The name is used everywhere: tools `peers_*`, the `/peers` command, `~/.pi-peers`, and `PI_PEERS_HOME`.

## Context

We want running pi agents, and a human controller, to find each other and exchange messages. We want to do this without building a registry service that agents must register with.

Facts from the installed pi 1.1.0 that constrain the design:

- Pi has no built-in way for agents to find or message each other. Its docs and examples cover a single agent: extensions, RPC mode for a child process, and the SDK. The `pi.events` bus only reaches extensions inside the same process.
- **RPC mode** (`pi --mode rpc`) is controlled through a child process's stdin and stdout, so it can only drive a pi that the controller itself starts. It cannot attach to an interactive pi that's already running.
- **Extensions** run inside every pi process and can:
  - inject input with `pi.sendUserMessage()`. While the agent is busy, this needs a `deliverAs` of `steer` or `followUp`; `ctx.isIdle()` reports the state.
  - register tools and slash commands.
  - start sockets from `session_start` and close them in `session_shutdown`.
- Extensions run with the user's full OS permissions and can see credentials. Every inbound message is therefore a possible prompt-injection and lateral-movement path.
- The current host runs Windows 11, Node 24.21 and OpenSSH 10.5. Other hosts may run Linux.

The trust boundary is a **single user**: one person's agents talking to each other, possibly across that person's machines.

## Decision drivers

1. No registry service and no daemon to keep running.
2. No network listener on a TCP port, even on localhost.
3. The OS decides who may connect on one host; SSH decides across hosts.
4. The same wire protocol is used locally, over SSH, and towards RPC-mode children.
5. Works on Windows and on Linux/macOS.
6. A peer message can never make an agent act without a clear policy.

## Decision

Build two components, both in TypeScript:

- **`pi-peers` extension**, loaded into every pi from `~/.pi/agent/extensions/`. It makes the agent reachable and gives it tools to reach its peers.
- **`pi-peers` CLI**, a small Node script used by humans, by the extension, and by SSH on the remote side. Its commands are `list`, `send`, `attach` and `bridge`.

### Phase 1: same host

#### Endpoint

On `session_start`, each agent opens a local IPC endpoint. There is no TCP.

| OS | Endpoint |
|---|---|
| Windows | Named pipe `\\.\pipe\pi-peers-<user>-<agentId>` |
| Linux/macOS | Unix domain socket `~/.pi-peers/run/<agentId>.sock`, in a directory with mode `0700` |

Node's `net.createServer().listen(path)` supports both. The endpoint closes in an idempotent `session_shutdown` handler.

#### Discovery

Discovery uses a well-known rendezvous directory, `~/.pi-peers/agents/`, which only the user can access. Each live agent writes one file there, `<agentId>.json`:

```json
{
  "schemaVersion": "1.0",
  "protocol": { "version": "1.0", "minVersion": "1.0" },
  "id": "01J…",
  "sessionName": "Refactor auth module",
  "piSessionId": "k1l2m3n4…",
  "label": "Refactor auth module",
  "pid": 12345,
  "cwd": "C:\\git\\utils\\pi-peers",
  "endpoint": "\\\\.\\pipe\\pi-peers-alice-01J…",
  "token": "<random 256-bit>",
  "piVersion": "1.1.0",
  "startedAt": "2026-10-10T12:00:00Z"
}
```

- **Listing peers:** read the directory, then check each entry is alive (the PID exists and a connect probe succeeds).
- **Stale entries:** whoever lists the directory deletes entries that fail the check. There is no heartbeat process.

#### Session name

The user-supplied pi session name is the main human-facing handle for an agent.

- **Where it comes from:** pi's own session name. The user sets it with `/name <name>`, `pi --name` / `-n`, or `set_session_name` in RPC mode; an extension can set it with `pi.setSessionName()`. pi-peers never invents or stores its own name for an agent.
- **Reading it:** the extension calls `pi.getSessionName()` on `session_start`. Resuming or switching sessions fires `session_start` again, which may bring a different name and pi session ID.
- **Keeping it current:**
  - The extension subscribes to `pi.on("session_info_changed")`, which fires when the user renames or clears the name.
  - It then rewrites the discovery file atomically: write a temporary file, then rename it over the old one.
  - Peers with an active `subscribe` connection receive the event.
- **Fields:**
  - `sessionName`: the user's name exactly as typed. Absent when not set.
  - `label`: what UIs display. It is `sessionName` if set, otherwise the base name of `cwd`, otherwise `id`.
  - `piSessionId`: lets a user match an agent to `/session` and `/resume` output.
- **Addressing a peer:** peers are addressed by `id`, then by `sessionName`, then by `label`.
  - `id`: an exact match.
  - `sessionName`: an exact match first, then a case-insensitive match if exactly one agent matches.
  - `label`: same matching rules as `sessionName`.
  - Names may contain spaces, so tools and the CLI take them as one quoted argument (`pi-peers send "Refactor auth module" …`).
- **Agent ID:** the agent `id` is pi's session ID, so an address stays valid across `/reload`, `/resume` and `pi -c`. A plain `pi` start is a new session, which means a new ID and no name, so use `-n` or `/name`. A second live process on the same session gets `-<pid>` appended.
- **Duplicates:** two agents may share a session name. An ambiguous address is rejected, and the error lists the matching `id`s and `cwd`s. pi-peers never picks one at random.
- **Session names are not secret.** They appear in `pi-peers list` output, also over SSH, and in the provenance header of messages an agent sends. Don't put secrets in session names.
- **Location:** the directory sits outside `~/.pi/agent/` on purpose, so `pi update` and pi's managed install never touch it. `PI_PEERS_HOME` overrides the location.

#### Authentication

- The endpoint is reachable only by the same user: through the `0700` directory on POSIX, and through an explicit owner-only DACL on the Windows named pipe.
- In addition, the first record on every connection must be a `hello` that carries the token from the discovery file. Anyone who can read that file is the same user.
- The token covers the case where the pipe's DACL turns out to be wider than intended. It costs almost nothing.

#### Protocol

The protocol is newline-delimited JSON.

- **Command vocabulary:** a subset of pi's own RPC command vocabulary:
  - records look like `{"id":"…","type":"…"}`, and replies come back as `response` records with the same `id`.
  - there is one extra command, `hello`, which carries the token and negotiates the protocol version (see [Versioning and compatibility](#versioning-and-compatibility)).
  - one client library can then drive attached agents and RPC-mode children.
- **Commands in v1:**
  - `hello`, `get_state`, `get_last_assistant_text`, `get_messages`
  - `prompt`, `follow_up`, `steer`, `abort`
- **Events:** clients can ask to receive the agent's session events (`subscribe`). These use pi's JSON event shapes.

#### Agent-facing surface

| Kind | Name | Purpose |
|---|---|---|
| Tool | `peers_list` | List peers (id, session name or label, cwd, idle or busy) |
| Tool | `peers_send` | Send a `prompt` or `follow_up` to a peer; optionally wait for its reply |
| Tool | `peers_read` | Read a peer's last assistant text or state |
| Command | `/peers` | Show peers and the inbound policy; change the policy |

#### Inbound policy (safety)

- **Labelling:** each peer message is injected with a provenance header, for example `[from pi-peers peer "<label>" (<id>)@<host>]`, so the receiving model can tell it apart from the user.
- **Policy:**
  - `ask` (default): `ctx.ui.confirm()` before injecting.
  - `allow`: inject without asking. Allowed per peer name or per host.
  - `deny`: refuse.
- **Delivery timing:**
  - idle agent: injected straight away.
  - busy agent: queued as `followUp`.
  - `steer`: only when the peer is allowed to steer.
- **Loop guard:** every message carries a hop count, and the extension refuses messages with more than 3 hops. This stops two agents from feeding each other forever.

### Versioning and compatibility

pi-peers is built around one **versioned remote-control schema**. Every record on the wire and the discovery file are defined by it.

#### Schema

- **Source of truth:** a JSON Schema in the repo, `schema/pi-peers-<MAJOR>.<MINOR>.json`. Every released version stays in the repo.
- **Code:** TypeScript types are generated from the schema into `src/schema.gen.ts` (`npm run gen:types`), never hand-written separately.
- **Validation:**
  - At runtime, the code checks the fields it relies on (string `id` and `type`, the version range, a non-empty `message`) and returns `invalid_request` when they're wrong. It deliberately has no JSON Schema validator at runtime, so the CLI and the extension need no dependencies on remote hosts.
  - Full validation against the schema runs in the test suite (`test/unit/schema.test.ts`), for the fixtures and for the records the code produces.
- **Version format:** `MAJOR.MINOR`. A change that doesn't alter the schema (for example a documentation fix) doesn't change the version.

#### Rules

| Change | Allowed in a minor version? |
|---|---|
| Add an optional field, command, event type, error code or enum value | ✅ |
| Remove or rename a field, command or event | ❌ needs a major version |
| Change a field's type or meaning, make an optional field required, change a default | ❌ needs a major version |

Every minor version **must** be backward compatible. For this to hold, receivers follow these rules in every version:

- Ignore unknown fields.
- Ignore unknown event types.
- Treat an unknown enum value as "unknown". For an unknown `errorCode`, fall back to the error's `retryable` flag and `error` text.
- Answer an unknown command with `unsupported_command`. This happens when a newer client talks to an older agent.

A **major** version may break compatibility, but only by declaring a **minimum version**: the oldest version that implementations of the new major still speak. The minimum is recorded in that major's schema and release notes.

#### Negotiation

1. **Ranges:** each side advertises the range it supports, `{version, minVersion}`.
2. **Agreed version:** in `hello`, the agent picks the lower of the two `version`s.
3. **Rejection:** the agent refuses the connection with `incompatible_version` when the agreed version is below either side's `minVersion`. The error includes both ranges.
4. **Scope:** the agreed version is fixed for the whole connection, and every later record uses its shapes.
5. **Frozen `hello`:** the `hello` record and its response are frozen across all versions, and may only gain optional fields. Any client, bridge and agent can therefore always negotiate, or at least report clearly that they can't.
6. **Early warning:** the discovery file publishes the agent's range, so `pi-peers list` can mark incompatible peers before anyone connects.

#### Component versions

- **One package:** the extension and the CLI ship as one package with its own semver. Its version is separate from the protocol version.
- **Ranges:** `pi-peers --version` and the discovery file report which protocol range the package speaks.
- **pi compatibility:** the package declares the pi versions it supports through `peerDependencies` on `@earendil-works/pi-coding-agent`.
- **Compatibility tests:** the test suite keeps sample records for every released minor version under `test/fixtures/<version>/`, one file per `$def`. Every new build must accept them, and must still produce records an older peer accepts.

### Errors and failure modes

Error responses extend pi's RPC shape, `{type:"response", id, command, success:false, error:"<text>"}`, with two optional fields, `errorCode` and `retryable`. Plain pi RPC clients therefore still parse them.

As in pi, `success` refers to **acceptance**. A message waiting for approval gets its response only once the decision is made or the approval times out. Failures after acceptance arrive as events.

| `errorCode` | When | Retry |
|---|---|---|
| `hello_required` | The first record wasn't `hello` | No; the connection closes |
| `auth_failed` | The token is missing or wrong | No; the connection closes |
| `incompatible_version` | No common protocol version | No |
| `invalid_request` | The record fails schema validation | No |
| `unsupported_command` | The command is unknown at the agreed version | No |
| `denied` | Policy is `deny`, or the user declined in `ask` | No |
| `approval_timeout` | `ask` went unanswered for 120 s (configurable) | Yes, by explicit choice |
| `no_ui` | Policy is `ask` but the agent has no UI (`ctx.hasUI` is false, e.g. `-p` or `--mode json`), so the message is treated as denied | No |
| `steer_not_allowed` | `steer` from a peer that isn't allowed to steer | No; send `follow_up` instead |
| `hop_limit` | The message would exceed 3 hops | No |
| `ambiguous_target` | The address matches more than one agent; the error lists their `id`s and `cwd`s | No; use an `id` |
| `agent_not_found` | No live agent matches the address | No |
| `agent_unavailable` | The discovery entry exists but the connection fails; the entry is pruned | Yes |
| `connection_lost` | The connection dropped mid-request (reported on the client side) | Reads: yes. Sends: only with the same request `id`, see below |
| `ssh_failed` | The SSH connection or login to the host failed, or the remote `pi-peers` is missing | Yes |
| `internal_error` | A bug or unexpected exception in pi-peers | No |

**Delivery guarantees**

- **Sends:** `prompt`, `follow_up` and `steer` are delivered **at most once**.
- **Deduplication:** the agent remembers request `id`s for 10 minutes. A repeated `id` returns the original response instead of being injected again.
- **Retrying a send:** safe only by resending with the **same** `id`. pi-peers never retries sends automatically.
- **Reads:** may be retried freely.

**Timeouts**

All defaults below can be changed in configuration.

| Stage | Default |
|---|---|
| Connect | 5 s |
| `hello` | 5 s |
| Approval | 120 s |
| A sender waiting for a response | approval timeout + 10 s |

**Stale entries:** a discovery entry whose PID is dead or whose endpoint refuses connections is deleted by whoever finds it. That client then reports `agent_unavailable` or `agent_not_found`, and never silently falls back to another agent.

### Phase 2: across hosts over SSH

There's still no registry. SSH provides transport, authentication and host addressing, and the remote side reuses the Phase 1 machinery.

- **Hosts:** the hosts to search are listed in `~/.pi-peers/hosts`, one SSH alias from `~/.ssh/config` per line. SSH settings (user, key, jump host) stay in the SSH config.
  - An alias may be followed by the remote command that runs the CLI. The default is `pi-peers`. Example:

    ```
    wsl2  /home/alice/.nvm/versions/node/v25.0.0/bin/node /home/alice/git/utils/pi-peers/src/cli.ts
    ```

  - The remote command is needed while the CLI isn't installed on the remote `PATH`, or when the remote's default `node` is too old.
- **Discovery:** `ssh <host> pi-peers list --json`. This reads the remote rendezvous directory and returns the live agents. The token is never included.
- **Connection:** `ssh <host> pi-peers bridge <id|sessionName>`. The remote `pi-peers` connects to its local pipe or socket, then copies bytes between SSH's stdin/stdout and the endpoint. The local side treats the SSH child's stdio exactly like a local endpoint.
  - The only record the bridge reads is the client's first one, which must be `hello`. The client can't know the remote token, so the bridge adds it and forwards the record.
  - Version negotiation therefore happens end to end, between the client and the agent.
  - The bridge depends only on the frozen `hello` shape, so any bridge version works with any protocol version.
- **Addressing:** `<host>/<id|sessionName>`, for example `devbox/"Refactor auth module"`. The same matching and ambiguity rules apply on the remote host. A bare name means "this host".
- **Authentication:** SSH keys or the SSH agent. The remote `pi-peers` runs as the same user, so the single-user trust boundary still holds. No port is opened on any host.
- **Remote requirements:**
  - Node ≥ 22.18. The CLI runs as TypeScript through Node's type stripping. Ubuntu 24.04's packaged Node 18 is too old.
  - The `pi-peers` CLI, either on `PATH` or named in the hosts file.
  - The `pi-peers` extension in that host's pi.
- **Several runtimes on one machine:** WSL distros and Windows each keep their own `~/.pi-peers`. They must not share one, because PIDs in another namespace look dead and would get pruned. As a safeguard, every discovery entry records `runtime` (`process.platform`), and an entry from another runtime is skipped, never pruned. WSL is reached as an SSH host like any other.

### Reverse links: reaching back when SSH works in only one direction

SSH often works in only one direction. A laptop can reach a server or WSL, but nothing can SSH back to the laptop. To keep parity without an SSH server on the laptop, the side that *can* connect also carries traffic the other way.

- **Opting in:** a hosts-file entry is marked `--reverse`, for example `wsl2 --reverse <remote command>`.
- **The link:** every local agent keeps one long-lived `ssh <alias> pi-peers expose` open to each reverse host. It is opened on `session_start` and closed on `session_shutdown`, so there's still no daemon. If the link drops, it is retried with backoff (1 s up to 60 s).
- **The far end:** `expose` publishes the agent there as a local agent, with its own endpoint, its own token, and `via: <host>`. Agents on that host address it by its normal name, for example `pi1`, with the usual ID / session name / label rules.
- **Framing:** each connection to that endpoint becomes a numbered channel over the one SSH session, using NDJSON control records:
  - far → here: `{ch, op:"open"}`, `{ch, op:"rec", rec}`, `{ch, op:"close"}`
  - here → far: `{ch, op:"rec", rec}`, `{ch, op:"close"}`, `{op:"update", agent}` (sent on rename)
- **Authentication:**
  - Clients on the far host present the token from that host's discovery file, and `expose` checks it.
  - The agent treats reverse channels as already authenticated: by SSH, plus the far end's token check. It still requires `hello` for version negotiation.
  - The inbound policy, approval dialog and hop limit apply unchanged.
- **Liveness:** the far-end entry's PID is the `expose` process. When the agent exits, SSH closes, `expose` sees end-of-input, and it removes the entry.

### Reply hint

Each delivered message carries, under the provenance header, one line telling the receiving model how to answer:

- **When the sender waits for a reply** (`awaitsReply`, set by `peers_send wait=true`): "reply by answering normally, not with peers_send".
- **When the sender is reachable from here** (local, or through a reverse link): how to address it with `peers_send`.
- **Otherwise:** that it can't be messaged back from here, and that the sender can read the answer with `peers_read`.

This stops agents from probing paths that don't exist, such as trying `ssh` to the hostname in the header.

## Options considered

| Option | Verdict | Reason |
|---|---|---|
| Rendezvous directory + local IPC (chosen, Phase 1) | ✅ | No daemon; the OS controls access; no network exposure |
| Localhost TCP ports + token | ❌ | Any local process, including other users', can reach the port; Windows firewall prompts; port collisions |
| mDNS / UDP broadcast | ❌ | Exposes agents on the LAN; firewall friction; heavy for one host |
| Central registry service (HTTP) | ❌ | Exactly what we want to avoid: a daemon, its lifecycle, and its own auth |
| Build only on RPC mode | ❌ for discovery | Cannot attach to interactive agents. Still supported for children `pi-peers` starts itself, via the shared protocol |
| SSH stdio bridge, `ssh host pi-peers bridge` (chosen, Phase 2) | ✅ | Works the same for named pipes and Unix sockets; uses only plain `ssh` |
| SSH socket forwarding, `ssh -L local.sock:remote.sock` | ❌ | Not portable to Windows named pipes (unverified); leaves forwarded sockets to clean up |
| Tailscale, WireGuard or another overlay network | ❌ for now | Extra infrastructure; SSH is already there |

## Consequences

**Positive**
- Nothing to run or monitor beyond the pi processes themselves.
- Local access is controlled by the OS, cross-host access by SSH. pi-peers has no authentication system of its own to get wrong.
- One protocol everywhere, and close to pi's own RPC protocol, so it's familiar and easy to test against `pi --mode rpc`.

**Negative and risks**
- **Discovery cost:** cross-host discovery costs one SSH round trip per host. Without connection multiplexing this is slow. The Windows OpenSSH client doesn't support `ControlMaster` (believed true, still to verify), so the CLI should cache `list` results briefly.
- **Single user only:** sharing between users would need a different trust model and a new ADR.
- **Install everywhere:** the extension and the CLI must be installed on every host. Mixed versions are expected, and the versioning rules make them safe. The price is discipline: every schema change must be checked against the compatibility tests.
- **Injection risk remains:** a peer the user trusts can still carry injected content from wherever that peer read it. The `ask` default and the provenance labels reduce this but don't remove it.
- **Leftover files:** a crashed pi leaves a stale discovery file and, on POSIX, a socket file. They are removed lazily the next time anyone lists the directory.

## Implementation status (2026-10-10)

- **Phase 1:** implemented and tested by hand with two live agents on Windows. Headless tests pass on Windows and in WSL (Ubuntu 22.04 and 24.04).
- **Phase 2:** implemented: `src/cli.ts` (`list`, `bridge`), `src/hosts.ts`, and `<host>/<name>` addressing in the tools. Tested end to end from Windows to WSL2 Ubuntu 24.04 over `ssh wsl2`:
  - remote list, with no token in the output.
  - bridged `get_state` and `get_last_assistant_text`.
  - a bridged `prompt` going through the remote `ask` dialog.
  - `agent_not_found` for an unknown agent, and `ssh_failed` for an unreachable host.
- **Reverse links:** implemented and tested end to end: a WSL client reached a Windows agent through `expose`, the Windows approval dialog appeared, and its "no" came back as `denied`. A bad token gave `auth_failed`, and the WSL entry disappeared when the Windows agent exited.
- **Testing note:** `ssh wsl2` may land in a different distro from `wsl.exe` (the default distro). Test against the distro the SSH alias actually reaches.

## Still to verify before acceptance

- [x] Default and explicit DACLs on Node named pipes on Windows: can an owner-only pipe be created from Node, or do we rely on the token? **Answered** (2026-10-10, read through .NET `PipesAclExtensions`):
  - **Default DACL:** Node pipes get the Windows default: full control for the owner, SYSTEM and Administrators; **read only** for Everyone and Anonymous.
  - **What other accounts can do:** they can open the pipe for reading, but they can't write, so they can't send `hello` or any command, and the agent never writes to an unauthenticated connection.
  - **Token files:** they inherit the user profile's ACL (owner, SYSTEM, Administrators only).
  - **Conclusion:** cross-user access is blocked by the read-only pipe plus the private token. Node has no API for an owner-only DACL, and native code isn't worth it for this.
  - **Inherent exposure:** Administrators and SYSTEM keep full access, which no user-level software can prevent.
- [x] Can `ctx.ui.confirm()` be used from an inbound-message handler while the agent is streaming? **Yes** (2026-10-10).
  - **Terminal UI:** tested by hand with two live agents. The dialog appears at the bottom of the screen mid-run.
  - **RPC mode:** tested headless. The dialog arrives at the client as an `extension_ui_request`, and the client's answer is honoured.
- [ ] `sendUserMessage` behaviour in non-interactive modes (`-p`, `--mode json`): disable inbound messages there?
- [ ] Whether the Windows OpenSSH client supports `ControlMaster`. Only a performance concern now: reverse links keep one session open per host anyway.

## Open questions for the owner

1. Is the controller mainly **agents messaging agents**, or a **human console** (`pi-peers attach`) watching and driving agents? This changes whether event streaming is in v1.
2. Is the default inbound policy right: `ask` everywhere, or `allow` for agents on the same host?
3. Is the hosts list a pi-peers file, or should it be inferred from `~/.ssh/config` (for example, every `Host` with a `# pi-peers` marker)?
4. Phase 2 hosts: which operating systems? Is any Windows host an SSH server, which would need `pi-peers` on Windows OpenSSH server's `PATH`?
