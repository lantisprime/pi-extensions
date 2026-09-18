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
- **Result mapping** — text, images (base64 → native image content), embedded resources (text inlined, binaries noted), resource links, and `structuredContent` are mapped to pi tool results. Output is truncated at pi's standard limits (50KB / 2000 lines) with the full text saved to a temp file.
- **Errors** — a result with `isError: true` (or a JSON-RPC error, timeout, or crash) surfaces as a normal pi tool error the model can see and react to.
- **Cancellation** — aborting a turn (Esc) sends `notifications/cancelled` to the server.
- **Reconnect** — if a connection drops, the next tool call reconnects once automatically; HTTP session expiry (404) triggers transparent re-initialization.
- **Sampling/roots/elicitation** are declined (`-32601`); server `ping`s are answered.
- Tools removed server-side after `tools/list_changed` stay registered until session restart (pi has no unregister API); new/changed tools are picked up live.

## Testing

```bash
# Client over stdio against the bundled test server
npm exec -y --package=tsx -- tsx test/run-client-test.mjs

# Streamable HTTP transport
npm exec -y --package=tsx -- tsx test/run-http-test.mjs

# Config loader
npm exec -y --package=tsx -- tsx test/run-config-test.mjs

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
