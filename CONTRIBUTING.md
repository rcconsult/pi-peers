# Contributing to pi-peers

Thanks for helping. pi-peers is small and young, so issues and pull requests both count.

## Before you start

- **Bugs and ideas:** open an issue first for anything bigger than a small fix, so we can agree on the approach before you write code.
- **Security problems:** please don't open a public issue. See [SECURITY.md](SECURITY.md).
- **Code of conduct:** everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node ≥ 22.18 and, for the end-to-end tests, [pi](https://pi.dev) 1.1 or later.

```bash
git clone https://github.com/rcconsult/pi-peers.git
cd pi-peers
npm install
npm run typecheck
npm test
```

To try your changes in a real pi, start pi inside the repo. `.pi/extensions/pi-peers.ts` loads the extension from `src/`. pi asks you to trust the project the first time; run `/reload` after each change.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | Unit and schema-compatibility tests. Fast, no pi needed. |
| `node --test test/unit/discovery.test.ts` | One test file. |
| `npm run test:e2e` | Real headless pi agents on this machine: messaging, approvals, loading twice, and the owner gate and agent rules with a scripted model (`test/e2e/faux-model.ts`). It finds pi under `~/.pi/agent`, or set `PI_CLI` to pi's `cli.js`. Makes no real model calls. |

The SSH end-to-end tests (forward and reverse links) run only when you point them at a host you can reach with `ssh` without a password prompt:

| Variable | Meaning |
|---|---|
| `PI_PEERS_E2E_SSH_HOST` | SSH alias of the remote host |
| `PI_PEERS_E2E_REMOTE_REPO` | This repo's path on that host |
| `PI_PEERS_E2E_REMOTE_PI_CLI` | pi's `cli.js` on that host |
| `PI_PEERS_E2E_REMOTE_NODE` | Node ≥ 22.18 on that host (default `node`) |

Please run `npm run typecheck` and `npm test` before opening a pull request, plus `npm run test:e2e` if you changed the extension, the client or the CLI.

## Rules the code follows

- **Plain Node must be able to run it.** The CLI runs straight from `src/` with Node's built-in TypeScript type stripping. That rules out enums, namespaces and constructor parameter properties, and relative imports keep their `.ts` extension. `npm run typecheck` enforces this (`erasableSyntaxOnly`).
- **pi's packages are provided, not bundled.** Import `@earendil-works/*` and `typebox`, but never add them as runtime dependencies.
- **No resources at load time.** The extension opens sockets, timers and processes in `session_start` and closes them in `session_shutdown`, never in the factory.
- **Tests never touch real agents.** Any test that writes discovery files sets `PI_PEERS_HOME` to a temporary folder.
- **One copy per pi.** The extension steps aside when another pi-peers copy is already active in the same pi; keep `test/e2e/duplicate.test.ts` passing.
- **Owner gate patterns** live in `src/guard.ts`. Add a unit test in `test/unit/guard.test.ts` for every pattern you add, covering both a command it must catch and an everyday one it must let through.
- **Agent rules** in `src/rules.ts` go into every agent's system prompt. Keep them short and general; team-specific rules belong in the collaboration guide.

## Changing the protocol

The wire format is defined by [schema/pi-peers-1.0.json](schema/pi-peers-1.0.json), and the decisions behind it are in [ADR 0001](docs/adr/0001-pi-agent-discovery-and-remote-control.md).

1. **Edit the schema first,** then run `npm run gen:types`. Never edit `src/schema.gen.ts` by hand.
2. **Follow the versioning rules in the ADR.** A minor version may only add optional fields, commands, events or error codes. Anything else needs a major version with a declared minimum version.
3. **Add a fixture** under `test/fixtures/<version>/` for every new record shape. The file is named after its `$def`, for example `Delivery-minimal.json`. Old fixtures must keep passing.
4. **Update the ADR** in the same pull request when a decision changes.

## Pull requests

- Keep each pull request to one change, with tests.
- Describe what changed and why, and how you tested it. The pull request template has the checklist.
- Contributions are accepted under the [MIT licence](LICENSE).
