# mcp-gateway

Bridge pi to an MCP gateway (LiteLLM proxy MCP endpoint). Execute remote MCP tools with security scanning at four points.

## Security Model

This extension implements a defense-in-depth security model with four scan points:

1. **Tool description scanning** (`mcp_list_tools`): Every tool description from the gateway is scanned before display. Dangerous descriptions are replaced with placeholders.

2. **TOFU manifest pinning** (`mcp_list_tools`): The first call to list tools captures a fingerprint (SHA256) of all available tools. Subsequent calls compare fingerprints:
   - Match → "manifest: ok"
   - Change → "manifest: CHANGED" — `mcp_call` is blocked until the user explicitly accepts changes with `/mcp-gateway accept-changes <server>`

3. **Outbound argument scanning** (`mcp_call`): Tool arguments are scanned before sending to the gateway. If the scan detects dangerous content (e.g., API keys, prompt injection), the call is **hard-blocked** with no bypass option.

4. **Inbound result scanning** (`mcp_call`): Results from the gateway are scanned before display. Dangerous content is omitted by default. Users can set `includeRiskyContent=true` to see it (for security research only).

## Configuration

The extension reads configuration from `~/.pi/agent/mcp-gateway/config.json` and credentials from `~/.pi/agent/models.json`:

```json
{
  "version": 1,
  "updatedAt": "2025-07-23T00:00:00.000Z",
  "gatewayUrl": "https://your-litellm-proxy.example.com",
  "servers": ["github", "filesystem"],
  "manifests": {
    "github": {
      "fingerprint": "abc123...",
      "acceptedAt": "2025-07-23T00:00:00.000Z"
    }
  }
}
```

### Gateway Resolution

By default, the extension reads `providers.litellm.apiKey` and `providers.litellm.baseUrl` from `~/.pi/agent/models.json`. The gateway URL is derived from the origin of `baseUrl`.

To override the gateway URL, use `/mcp-gateway set-gateway <https-url>`.

## Commands

- `/mcp-gateway status` — Show current gateway URL, allowlisted servers, and manifest states
- `/mcp-gateway add-server <name>` — Add a server to the allowlist
- `/mcp-gateway remove-server <name>` — Remove a server (also drops its manifest)
- `/mcp-gateway accept-changes <server>` — Re-list tools and accept a new manifest fingerprint
- `/mcp-gateway set-gateway <https-url>` — Override the gateway URL (https only)
- `/mcp-gateway reset` — Clear all configuration

## Tools

### `mcp_list_tools`

List tools available on configured MCP gateway servers.

```typescript
mcp_list_tools({ server?: string })
```

**Security:** Tool descriptions are scanned; dangerous ones are replaced. Manifests are checked for changes.

### `mcp_call`

Execute a tool on a configured MCP gateway server.

```typescript
mcp_call({
  server: string,
  tool: string,
  arguments?: unknown,
  includeRiskyContent?: boolean // default: false
})
```

**Security:** Outbound arguments are scanned (hard-block on dangerous). Inbound results are scanned (omit by default).

## Prerequisites

1. **LiteLLM MCP Server**: A running LiteLLM proxy with MCP server endpoints at `/mcp/<server>`
2. **Virtual-key Grant**: The `litellm` provider in `~/.pi/agent/models.json` must have an `apiKey` (can be env var: `$VAR_NAME`)

## Testing

```bash
bash mcp-gateway/test-fixtures/run-mcp-gateway-tests.sh
```
