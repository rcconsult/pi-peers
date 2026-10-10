# Pi agent: extension and remote-control research

Researched 2026-10-10 against the pi install on this host. `pi --help` and the bundled docs are authoritative for the installed version; re-check them after `pi update`.

## Installed pi

| Item | Value |
|---|---|
| Package | `@earendil-works/pi-coding-agent` (source: github.com/earendil-works/pi) |
| Version | 1.1.0 (`~/.pi/agent/install/current-version`) |
| Managed install root | `~/.pi/agent/` |
| Launcher | `~/.pi/agent/bin/pi` → `pi-launcher.js` → `install/releases/<ver>/node_modules/@earendil-works/pi-coding-agent` |
| User extensions | `~/.pi/agent/extensions/` (currently `cost-status.ts`, `rtk.ts`) |
| Bundled docs and examples | `~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/{docs,examples}/` |

`~/.pi/agent/` also contains credential files (`auth.json`, `*.env`). Never read them into this repo or commit them.

## Language choice: TypeScript

Pi extensions are TypeScript (or JavaScript) modules. Pi loads them through `jiti`, so there is no compile step. Another language only fits as a helper process that a TypeScript extension spawns or calls, or as an RPC client (see below).

## Extensions

Minimal extension (`~/.pi/agent/extensions/hello.ts`):

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

- **Where pi loads them from:** the user or project extensions directory. A single `.ts`/`.js` file works, or a subdirectory with an `index.ts`/`index.js`; npm dependencies go in a `package.json` beside it. Extra paths can be added in settings (`docs/settings.md#resources`).
- **Loading one while developing:** `pi --extension ./my-ext.ts` (`-e`). `--no-extensions` disables discovery, but explicit `-e` paths still load.
- **Distributing:** publish as a pi package (`docs/packages.md`) and install with `pi install <source>`.
- **Lifecycle rules:**
  - The factory may be async; pi waits for it before startup continues.
  - Do **not** start processes, sockets, watchers or timers in the factory, because some invocations load extensions without starting a session. Start them in `session_start` or in the command or tool that needs them.
  - Close session-scoped resources in an idempotent `session_shutdown` handler.
  - `ctx.reload()` replaces the runtime, so don't reuse old state after it.
- **Security:** an extension runs in the pi process with the same OS permissions. It can see prompts, tool calls, files, credentials and session history.

### API integration points (`docs/extensions.md`)

| Capability | API |
|---|---|
| Observe or modify lifecycle | `pi.on()` |
| Model-callable tool | `pi.registerTool()` |
| `/` command | `pi.registerCommand()` |
| Shortcut / CLI flag | `pi.registerShortcut()` / `pi.registerFlag()` |
| Inject user or custom messages | `pi.sendUserMessage()` / `pi.sendMessage()` |
| Persist non-context session data | `pi.appendEntry()` |
| Change tools, model or thinking level | session control methods on `pi` |
| Model provider | `pi.registerProvider()` |
| MCP server | `pi.registerMcpServer()` |
| Per-request model routing | `pi.registerVirtualModel()` |
| Terminal rendering | renderer registration, `ctx.ui` |
| Talk to other extensions | `pi.events` |

Exact types: `src/core/extensions/types.ts` in the earendil-works/pi repo.

## Remote-control options

| Route | Process boundary | Control model | Best fit |
|---|---|---|---|
| **Extension** with its own listener | inside pi | WebSocket/HTTP server started on `session_start`, injecting input via `pi.sendUserMessage()` | Driving an interactive pi session that's already open |
| **RPC mode** (`pi --mode rpc`) | child process | JSONL commands on stdin; responses and events on stdout | Separate controller in any language; best isolation |
| **SDK** (`createAgentSession()`) | in process | Direct TypeScript methods and events | Node/Bun service wanting full API access |

**Initial recommendation:** a TypeScript controller that runs pi in RPC mode through the exported `RpcClient`, adding a small extension only when a live interactive session must be controlled.

This is refined by [ADR 0001](adr/0001-pi-agent-discovery-and-remote-control.md). Peer discovery needs to reach agents that are already running, and RPC mode can't attach to them, so every pi gets a `pi-peers` extension. The extension speaks a protocol based on pi's RPC commands, so RPC-mode children still fit.

### RPC mode essentials (`docs/rpc.md`, `docs/rpc-commands.md`)

- Start it with `pi --mode rpc --no-session`. The normal CLI options (model, tools, session dir, name) still apply.
- `@file` prompt arguments are rejected; send prompts with the `prompt` command.
- Every command accepts an optional `id`, which the matching `response` repeats: `{"id":"req-1","type":"get_state"}`.
- There are four record families:
  - commands (stdin)
  - `response` (stdout)
  - session events (stdout)
  - extension UI records (both directions; `docs/rpc-extension-ui.md`)
- Command groups:
  - **Prompting:** `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`
  - **State:** `get_state`, `get_messages`
  - **Model:** `set_model`, `cycle_model`, `get_available_models`
  - **Thinking:** `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`
  - **Queue modes:** `set_steering_mode`, `set_follow_up_mode`
  - **Compaction:** `compact`, `set_auto_compaction`
  - **Retry:** `set_auto_retry`, `abort_retry`
  - **Bash:** `bash`, `abort_bash`
  - **Session:** `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`
  - **Discovery:** `get_commands`

`RpcClient` usage (from `examples/rpc-client.ts`):

```typescript
import { RpcClient } from "@earendil-works/pi-coding-agent";

const client = new RpcClient({ cliPath: "<path to pi dist/cli.js>", args: ["--no-session"] });
const unsubscribe = client.onEvent((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  } else if (event.type === "tool_execution_start") {
    process.stderr.write(`\n[tool: ${event.toolName}]\n`);
  }
});
try {
  await client.start();
  await client.promptAndWait("Explain this repository");
} finally {
  unsubscribe();
  await client.stop();
}
```

## Reference files to read next

Paths are relative to the bundled package directory.

- Docs:
  - `docs/extensions.md`, `docs/packages.md`, `docs/settings.md`, `docs/security.md`
  - `docs/rpc.md`, `docs/rpc-commands.md`, `docs/rpc-extension-ui.md`, `docs/json.md` (event stream)
  - `docs/sdk.md`, `docs/cli-integration.md`
- Examples:
  - `examples/rpc-client.ts`
  - `examples/rpc-extension-ui.ts`
  - `examples/sdk/`
  - `examples/extensions/`, especially `rpc-demo.ts`, `send-user-message.ts`, `event-bus.ts`, `permission-gate.ts`, `protected-paths.ts`
