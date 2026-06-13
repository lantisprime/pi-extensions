# Pi Extensions

This project contains custom [Pi](https://pi.dev) extensions.

## Extensions

### Permission Policy

Path:

```text
permission-policy/index.ts
```

Global install location:

```text
~/.pi/agent/extensions/permission-policy/index.ts
```

Adds a permission gate for sensitive Pi tool usage.

Gated actions include:

- Reading files outside the current project folder
- Running bash commands
- Running destructive shell commands
- Running git commands
- Searching/fetching from the web
- Writing or editing files

Permission decisions can be:

- Allow once
- Allow for current session
- Allow permanently for this project
- Deny once
- Deny for current session
- Deny permanently for this project

Persistent project permissions are stored outside the repo under:

```text
~/.pi/agent/permission-policy/projects/<project-path-hash>.json
```

Commands:

```text
/permissions
/permissions reset
/permissions mode ask
/permissions mode read-only
/permissions mode auto
```

Status line:

```text
permission: ask
permission: read-only
permission: auto
```

Shortcut:

```text
ctrl+shift+m
```

Cycles permission mode:

```text
ask -> read-only -> auto -> ask
```

See [`permission-policy/README.md`](permission-policy/README.md) for details.

---

### Secure Web Search

Path:

```text
web-search/index.ts
```

Global install location:

```text
~/.pi/agent/extensions/web-search/index.ts
```

Adds a `secure_web_search` tool for web research.

Features:

- Uses the current Pi LLM to suggest relevant search queries and reputable websites
- Searches DuckDuckGo HTML results
- Requires HTTPS URLs
- Uses Node/fetch TLS certificate and hostname validation
- Performs secure DNS-over-HTTPS consistency checks
- Checks malware-filtering DNS providers
- Checks IPv4 addresses against DNSBL zones
- Supports explicit public or private/local IP HTTPS URLs
- Supports saved IP URLs via commands

Secure DNS providers currently used:

- Cloudflare DNS over HTTPS
- Google Public DNS over HTTPS
- Quad9 malware-filtering DNS over HTTPS
- Cloudflare Family/Security DNS over HTTPS

Tool:

```text
secure_web_search
```

Useful parameters:

- `question`: search question
- `sites`: domains or IPs to prioritize in search queries
- `urls`: explicit HTTPS URLs to check/fetch directly
- `maxResults`: 1-10
- `fetchPages`: whether to fetch page previews

Saved IP URL commands:

```text
/web-search-ip add 192.168.1.1
/web-search-ip add https://203.0.113.10/status
/web-search-ip list
/web-search-ip remove 192.168.1.1
/web-search-ip reset
```

Saved IP URLs are stored globally in:

```text
~/.pi/agent/web-search/config.json
```

See [`web-search/README.md`](web-search/README.md) for details.

## Installing extensions globally

From this project root:

```bash
mkdir -p ~/.pi/agent/extensions/permission-policy
cp permission-policy/index.ts ~/.pi/agent/extensions/permission-policy/index.ts

mkdir -p ~/.pi/agent/extensions/web-search
cp web-search/index.ts ~/.pi/agent/extensions/web-search/index.ts
```

Then in Pi:

```text
/reload
```

or restart Pi.
