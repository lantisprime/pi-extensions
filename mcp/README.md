# MCP Bridge

Connects [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers to pi. Every tool an MCP server exposes becomes a native pi tool the model can call, alongside built-ins.

Zero runtime dependencies — the MCP protocol (JSON-RPC 2.0) is implemented directly, over both standard transports:

- **stdio** — the extension spawns the server process (local servers, like `@modelcontextprotocol/server-filesystem`)
- **Streamable HTTP** — connects to a remote URL (protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05`)

## Quick start

1. Install the extension (global, all projects):

   ```bash
   mkdir -p ~/.pi/extensions
   cp -R mcp ~/.pi/extensions/
   ```

   Or test it in-place first:

   ```bash
   pi -e ./mcp/index.ts
   ```

2. Declare your servers in `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project-local):

   ```json
   {
     "mcpServers": {
       "filesystem": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
       },
       "github": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-github"],
         "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
       },
       "docs": {
         "url": "https://docs.example.com/mcp",
         "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
       }
     }
   }
   ```

3. Start pi. Servers connect at session start; their tools appear as
   `mcp_<server>_<tool>` (e.g. `mcp_filesystem_read_file`).

## Config format

```jsonc
{
  "mcpServers": {
    "<name>": {
      // Stdio transport: spawn a process
      "command": "npx",
      "args": ["-y", "some-server"],
      "env": { "KEY": "value" },     // merged over process.env
      "cwd": "/optional/working/dir",

      // ...or HTTP transport (exactly one of command/url)
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer token" },
      "headersCommand": "~/.pi/agent/mcp-headers-example.sh",

      // Optional, both transports
      "enabled": true,      // set false to skip without deleting
      "lazy": false,        // progressive disclosure: 2 meta tools instead of N full schemas
      "timeout": 30000,     // connect + tools/list timeout, ms
      "callTimeout": 120000 // tools/call timeout, ms (0 = no timeout)
    }
  }
}
```

- Project entries override global entries with the same name.
- `${VAR}` and `$VAR` in any string are expanded from the environment (unmatched → empty).
- `~` in `cwd` expands to the home directory.
- `headersCommand` (HTTP only) runs via `sh -c` at connect time and again
  automatically after a 401 response (single retry); its stdout must be a JSON
  object of header strings, merged over `headers`. Use it for servers that
  need short-lived tokens minted per connection — same contract as Claude
  Code's `headersHelper`. The command's environment is inherited; token values
  never appear in logs or errors.
- **Security:** project-local configs are only honored in trusted projects (they can spawn arbitrary processes). Global config is always honored.

## Commands

| Command | Effect |
|---|---|
| `/mcp` | Show server status in the widget |
| `/mcp reconnect <name>` | Restart a server and re-discover its tools |
| `/mcp tools [server]` | List discovered tools (and descriptions) |

## Behavior details

- **Tool naming** — registered as `mcp_<server>_<tool>`, sanitized to `[a-z0-9_]`; a numeric suffix avoids collisions.
- **Lazy mode (`"lazy": true`)** — progressive disclosure for large servers: instead of registering every server tool (each schema stamped into every request), registers exactly two meta tools: `mcp_<server>_tools` (list tools with one-line summaries; pass `"tool"` for a full description + JSON schema) and `mcp_<server>_call` (invoke by name with an arguments object). Cuts per-server prompt cost from O(all schemas) to two small schemas; the trade-off is one extra discovery hop before the first call. `tools/list_changed` refreshes the listing transparently.
- **Result mapping** — text, images (base64 → native image content), embedded resources (text inlined, binaries noted), resource links, and `structuredContent` are mapped to pi tool results. Output is truncated at pi's standard limits (50KB / 2000 lines) with the full text saved to a temp file.
- **Errors** — a result with `isError: true` (or a JSON-RPC error, timeout, or crash) surfaces as a normal pi tool error the model can see and react to.
- **Cancellation** — aborting a turn (Esc) sends `notifications/cancelled` to the server.
- **Reconnect** — if a connection drops, the next tool call reconnects once automatically; HTTP session expiry (404) triggers transparent re-initialization.
- **Sampling/roots/elicitation** are declined (`-32601`); server `ping`s are answered.
- Tools removed server-side after `tools/list_changed` stay registered until session restart (pi has no unregister API); new/changed tools are picked up live.

## Relationship to pi's built-in MCP extension

Registering `/mcp` makes this bridge **replace** pi's built-in MCP extension in
sessions — the documented replacement mechanism (pi `docs/mcp.md`, "Replace the
built-in MCP support"). The startup notice about `builtin:mcp` is expected and
harmless; shell-level `pi mcp add/list` commands keep working because they edit
`mcp.json`, which this bridge reads.

The bridge also connects servers that other extensions register with
`pi.registerMcpServer()` (pi `docs/extensions.md`, "MCP servers"): they are read
via `pi.getMcpServers()` on `session_start` and reconciled on
`mcp_servers_change` — new registrations connect, config changes reconnect,
unregistrations disconnect (tools stay registered until restart). A
file-configured server with the same name takes precedence.

Built-in-style fields are accepted where they make sense:

- `headers` values starting with `!` run a shell command whose entire stdout
  becomes the header value (pi's `!command` contract), re-evaluated after a 401
  just like `headersCommand`. Command failures are reported exit-code/signal
  only — command text, stderr, and secrets never reach error messages.
- `timeout` (built-in: per-request **seconds**) maps to the bridge's tools/call
  timeout in ms.
- `exposure`: pi's documented default (`codemode`) and `deferred` map to the
  bridge's lazy meta tools; `direct` registers every tool; `hidden` is skipped.
  Per-tool `toolExposure` overrides are not supported (warned, ignored).
- `oauth` and `auth: { provider }` entries are skipped with a warning (the
  bridge implements neither).

Unregister semantics: when the source extension calls `pi.unregisterMcpServer()`
or a config change arrives, the bridge closes the connection, refuses later
auto-reconnects, and re-registers the affected tools as `hidden` + erroring so
stale entries are unreachable (pi has no tool-unregister API). A later
re-registration with the same name revives the server under the same tool names.

## Known limitations

- Registered servers without explicit `timeout` get the bridge's default tools/
  call timeout (120s), not pi's per-request 60s; initialize/tools/list stay at
  the bridge's 30s connect timeout.
- Tools a server removes after `tools/list_changed` stay registered (failing
  remotely) until restart.
- A server-side connection drop while a connect is still in flight waits for
  that connect to finish before the next reconnect.
- Tool names are `mcp_<server>_<tool>` (single underscores) where pi's built-in
  MCP support uses `mcp__<server>__<tool>`. The bridge also collapses any `-` to
  `_`, so an upstream LiteLLM gateway alias like `searxng-web-search` becomes
  `mcp_searxng_searxng_searxng_web_search` (server × alias × tool, all three
  tokens underscored). Anything that keys off pi's native `mcp__server__tool`
  shape — codemode `describeNamespace()` hints, docs, external scripts — will
  not match the bridge's names. Names are also capped at 120 chars.

## Testing

```bash
# Client over stdio against the bundled test server
npm exec -y --package=tsx -- tsx test/run-client-test.mjs

# Streamable HTTP transport
npm exec -y --package=tsx -- tsx test/run-http-test.mjs

# Config loader
npm exec -y --package=tsx -- tsx test/run-config-test.mjs

# Registered-server wiring (config mapping + !cmd resolution)
npm exec -y --package=tsx -- tsx test/run-wiring-test.mjs

# Typecheck
npm exec -y --package=typescript@5.9.3 -- tsc --noEmit -p tsconfig.json
```

`test/test-mcp-server.mjs` (stdio) and `test/test-mcp-server-http.mjs` (HTTP) are minimal MCP servers used by the tests — also handy as protocol references.

## Layout

```
mcp/
├── index.ts            # Extension: lifecycle, tool registration, /mcp command
├── lib/
│   ├── jsonrpc.ts      # JSON-RPC 2.0 message types/helpers
│   ├── stdio.ts        # Transport: spawned process, newline-delimited JSON
│   ├── http.ts         # Transport: Streamable HTTP (+ SSE responses, sessions)
│   ├── client.ts       # MCP client: initialize, tools/list, tools/call
│   ├── config.ts       # Config discovery/merge, ${VAR} expansion
│   └── errors.ts       # SessionExpiredError
└── test/               # Test servers + harnesses (see above)
```
