# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**pi-peers**: lets pi coding agents discover and message each other. Phase 1 covers agents on the same host; Phase 2 (planned) works across hosts over SSH. pi is `@earendil-works/pi-coding-agent`, installed at `~/.pi/agent`.

- **Names:** npm package `pi-peers`; GitHub repo [rcconsult/pi-peers](https://github.com/rcconsult/pi-peers) (private until a LICENSE and README exist). The local folder is still `pies`.
- **Design:** [docs/adr/0001-pi-agent-discovery-and-remote-control.md](docs/adr/0001-pi-agent-discovery-and-remote-control.md) is the source of truth for the protocol, versioning rules, error codes and security policy. Change the ADR together with the code.
- **pi API background:** [docs/pi-extension-research.md](docs/pi-extension-research.md). The bundled pi docs under `~/.pi/agent/install/releases/<ver>/node_modules/@earendil-works/pi-coding-agent/docs/` are authoritative.

## Commands

```bash
npm install
npm run typecheck                                  # tsc --noEmit; erasableSyntaxOnly enforces the strip-types rule
npm test                                           # unit + schema-compatibility tests (test/unit)
node --test test/unit/discovery.test.ts            # a single test file
node --test --test-name-pattern="resolveAgent" "test/unit/*.test.ts"   # a single test by name
npm run test:e2e                                   # real headless pi agents; PI_CLI overrides pi's cli.js
npm run gen:types                                  # after editing schema/pi-peers-1.0.json
npm run build                                      # dist/ (CLI only)
```

The SSH e2e tests need `PI_PEERS_E2E_SSH_HOST`, `PI_PEERS_E2E_REMOTE_REPO`, `PI_PEERS_E2E_REMOTE_PI_CLI`, and optionally `PI_PEERS_E2E_REMOTE_NODE`. Machine-specific values belong in `CLAUDE.local.md`, which is untracked. From Git Bash, prefix with `MSYS_NO_PATHCONV=1`, otherwise `/tmp/…` and `/mnt/…` arguments get rewritten to Windows paths.

## Layout

The code is TypeScript. pi loads the extension through jiti, straight from `src/`, and the CLI runs on plain Node from `src/` in development. Only the npm package's CLI is compiled, into `dist/`, because Node won't strip types inside `node_modules`.

| Path | Role |
|---|---|
| `src/protocol.ts` | Version negotiation, error responses, NDJSON framing; re-exports the generated wire types |
| `src/discovery.ts` | Rendezvous directory `~/.pi-peers/agents/` (`PI_PEERS_HOME` overrides it), liveness pruning, resolving a peer by id, session name or label |
| `src/client.ts` | Client: `hello`, then request/response matched by `id`, over any duplex stream |
| `src/hosts.ts` | Phase 2: `$PI_PEERS_HOME/hosts`, remote `list`, `bridge` over `ssh <alias>`, and reverse links (`--reverse` → `expose`) |
| `src/cli.ts` | CLI run on each host: `list [--json]`, `bridge <address>`, `expose` (far end of a reverse link). Run it as `node src/cli.ts …` (Node ≥ 22.18) |
| `src/extension/index.ts` | The pi extension: pipe/socket server, tools `peers_list` / `peers_send` / `peers_read`, `/peers` command, inbound policy |
| `.pi/extensions/pi-peers.ts` | Dev shim that loads the extension into pi agents started in this repo. It requires project trust; run `/reload` after changes |

**How a message flows:**
1. An agent discovers peers by listing `~/.pi-peers/agents/*.json`.
2. It connects to the peer's endpoint: a named pipe on Windows, a Unix socket elsewhere.
3. It sends `hello` with the token from the peer's discovery file.
4. It sends `prompt` / `follow_up` / `steer`.
5. The receiving extension applies its policy (`ask` shows `ctx.ui.confirm`), then injects the message with `pi.sendUserMessage()`, prefixed by a provenance header.

## Constraints

- **Plain `node` compatibility:** keep the code runnable under Node's built-in TypeScript type stripping, so the CLI runs on plain `node` in development and over SSH. That means no parameter properties, enums or namespaces, and `.ts` extensions in relative imports.
- **Don't bundle host packages:** `@earendil-works/*` and `typebox` are supplied by pi. Import them, but never bundle them.
- **Don't start resources at load time:** never open sockets, timers or processes in the extension factory. Start them in `session_start` and stop them in `session_shutdown`.
- **Separate runtimes:** each runtime (Windows, each WSL distro) has its own `~/.pi-peers`; never share one between runtimes. Cross-runtime traffic goes over SSH, like remote hosts.
- **Verify, don't assume:** discovery tests that touch real agents should set `PI_PEERS_HOME` to a scratch directory, so the user's live agents and policy aren't disturbed.

## Status

- **Wire types:** `schema/pi-peers-1.0.json` is the source of truth. `src/schema.gen.ts` is generated from it, so never edit it by hand. Add a fixture under `test/fixtures/<version>/` for any new record shape.
- **Publishing:** not yet published to npm.

## Sensitive files

`.local/` holds sensitive files (credentials, keys, secrets) and is git-ignored. Never move its contents into tracked paths, and never reference its secrets in committed code or docs.
