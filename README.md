# pi-peers

Let your [pi](https://pi.dev) coding agents find each other and talk, on one machine or across machines over SSH. There's no registry, no daemon and no open port.

```
You: pi1
This host:
- pi2 (idle)
Host wsl2:
- wsl2/pi3 (idle)
Incoming messages: ask before delivering · always allow: none · always deny: none · may steer: none
```

> **Status: 0.1.0, experimental.** It's built for **one user's own agents**. Every peer message is a possible prompt injection, so read [Security](#security) before you allow anything without asking.

## Install

```bash
pi install git:github.com/rcconsult/pi-peers
```

After the npm release, `pi install npm:pi-peers` will also work. Then run `/reload` in your running agents, or restart them.

Requirements:
- pi 1.1 or later.
- Node ≥ 22.18 wherever the `pi-peers` CLI runs. That's only needed on the remote hosts.

## Quick start: same machine

1. **Name your sessions:** start pi with `pi -n pi1` and `pi -n pi2`, or run `/name pi1` inside pi. The status bar then shows `pi-peers: pi1 (you)`.
2. **See who's there:** run `/peers`, or ask an agent to list its peers.
3. **Ask one agent to talk to another,** for example: *"Ask pi2 to review src/protocol.ts and wait for its answer."*

The receiving agent asks you before acting on a peer message, unless you've allowed that peer.

### What the agents get

| | Name | What it does |
|---|---|---|
| Tool | `peers_list` | Lists peers on this host and on configured SSH hosts. |
| Tool | `peers_send` | Sends `prompt`, `follow_up` or `steer` to a peer. With `wait=true`, it returns the peer's answer when its run finishes. |
| Tool | `peers_read` | Reads a peer's state or its last answer. |
| Tool | `peers_ask_owner` | Puts a question or decision to you, the human at that agent's terminal, and waits for your answer. |
| Command | `/peers` | Shows peers and the incoming-message policy. |
| Command | `/peers policy ask\|allow\|deny` | Sets the default for incoming messages. |
| Command | `/peers allow\|deny\|steer\|forget <name>` | Sets per-peer exceptions. `steer` lets a peer interrupt a running turn. |
| Command | `/peers guard ask\|block\|off`, `/peers guard scope peer\|all` | Sets the owner gate for risky actions (see [Security](#security)). |

**Addressing:** an agent ID, its session name, or its label (the folder name when there's no session name). An exact match wins over a case-insensitive one. An ambiguous name is refused, never guessed. On SSH hosts, use `<host>/<name>`, for example `wsl2/pi3`.

**Running a team of agents** (one lead steering several workers, with approvals turned off): see the [collaboration guide](docs/collaboration-guide.md) for setup, task templates, and rules to paste into each agent's `AGENTS.md`.

**Stable addresses:** an agent's ID is pi's session ID, so it survives `/reload`, `/resume` and `pi -c`. A plain `pi` start is a new session, so give it a name again.

## Across machines

Each host lists its own agents. SSH carries the connection, and your `~/.ssh/config` does the addressing. List the hosts in `~/.pi-peers/hosts`, one SSH alias per line:

```
# <ssh alias> [--reverse] [command that runs the pi-peers CLI there; default: pi-peers]
devbox
wsl2  --reverse  /home/me/.nvm/versions/node/v25.0.0/bin/node /home/me/pi-peers/src/cli.ts
```

- **On each remote host:** install the extension in pi there, and make the CLI available, either with `npm i -g pi-peers` or by naming the command in the hosts file. SSH logins must work without a prompt (keys or an agent), because pi-peers runs `ssh` with `BatchMode=yes`.
- **`--reverse`:** use it when that host can't SSH back to you, for example a laptop behind NAT, or Windows with no SSH server. Each of your agents keeps one SSH session open to that host. The host's agents then see yours as local peers, listed as *"Reached through \<your host\>'s reverse link"*, and messages travel back over that same session.
- **WSL:** WSL distros and Windows each keep their own `~/.pi-peers`; never share one between them. Reach WSL from Windows as an SSH host. `ssh` may land in a different distro from `wsl.exe`, so test against the one your alias actually reaches.

## Security

- **Trust boundary: one user.**
  - On a machine, only your user can reach an agent: owner-only folders, a 256-bit token per agent, and a constant-time token check.
  - Across machines, SSH does the authentication. pi-peers adds no login of its own and opens no port.
- **Peers act with your permissions.** An agent that accepts a message can read, edit and run anything you can. The sender label (`[from pi-peers peer "pi1" … hop 1/3]`) tells you where a message came from, but **it is not proof**: any process running as you can claim any name.
- **The owner gate (on by default)** works even when messages are delivered without asking (`allow`). While a peer's task is running, risky tool calls stop and ask you at that agent's terminal first. That covers pushing, deleting recursively, publishing, installing, `ssh`, credential files, and writes outside the working folder. A denied or unanswered call is blocked, and the agent is told to report `NEEDS OWNER`. pi itself runs tool calls without asking, so this gate is what stands between a peer's request and your machine. It is pattern-based: a safety net, not a sandbox.
- **Keep `ask` unless you're sure.** `ask` shows a dialog with the message before delivering it. If it goes unanswered for 120 s, the message is refused, and an agent with no UI refuses outright. `allow` delivers without asking.
- **Loops are capped:** a chain of peer messages stops at 3 hops.
- **Tokens stay out of listings:** `pi-peers list` (also over SSH) and `get_state` never include them.
- **The token is an access check, not an identity.** Anything running as you can read the discovery files, connect, and claim to be any peer. pi-peers keeps out *other* users and other machines; it can't protect you from your own compromised processes.
- **On Windows:** the agent's named pipe is read-only for other accounts, so they can't send it anything. Token files inherit your profile's private permissions. Administrators and SYSTEM keep full access, as they do to everything.
- **`~/.pi-peers/hosts` is configuration that gets run.** Its remote commands are executed on those hosts over SSH, so protect it like your `~/.ssh/config`.

## How it works

- **Discovery:** each agent writes one file to `~/.pi-peers/agents/` (or `$PI_PEERS_HOME/agents/`), and listens on a named pipe (Windows) or a Unix socket (elsewhere). Listing peers means reading that folder and checking that each agent is alive.
- **Wire format:** newline-delimited JSON, with records shaped like pi's own RPC commands. The schema is [schema/pi-peers-1.0.json](schema/pi-peers-1.0.json), and its versioning rules keep minor versions backward compatible.
- **Design rationale:** [docs/adr/0001](docs/adr/0001-pi-agent-discovery-and-remote-control.md) records the decisions and the alternatives that were rejected.

## Development

```bash
npm install
npm run typecheck     # tsc, also enforces the erasable-syntax-only rule
npm test              # unit + schema-compatibility tests
npm run test:e2e      # real pi agents; uses pi from ~/.pi/agent, or set PI_CLI
npm run gen:types     # regenerate src/schema.gen.ts after changing the schema
npm run build         # compile the CLI to dist/ (the extension ships as TypeScript)
```

The SSH end-to-end tests run only when these are set:

| Variable | Meaning |
|---|---|
| `PI_PEERS_E2E_SSH_HOST` | SSH alias of the remote host |
| `PI_PEERS_E2E_REMOTE_REPO` | This repo's path on that host |
| `PI_PEERS_E2E_REMOTE_PI_CLI` | pi's `cli.js` on that host |
| `PI_PEERS_E2E_REMOTE_NODE` | Node ≥ 22.18 on that host (default `node`) |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
