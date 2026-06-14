# Pi Extensions

This project contains custom [Pi](https://pi.dev) extensions.

## Shared scanner packaging approach

The repo has a shared deterministic agent-risk scanner source:

```text
shared/security-scan.ts
```

However, each extension is intended to remain independently installable. To avoid runtime cross-extension dependencies, the shared scanner is **vendored** into extensions that need it:

```text
prompt-shield/lib/security-scan.ts
web-search/lib/security-scan.ts
```

After editing `shared/security-scan.ts`, sync the vendored copies:

```bash
scripts/sync-shared.sh
```

Then run the scanner smoke test:

```bash
scripts/test-security-scan.mjs
```

This gives the project one source of truth for scanner logic while preserving independent extension installs.

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
/permissions mode yolo
```

Status line:

```text
│ permission: ask
│ permission: read-only
│ permission: auto
│ permission: yolo
```

Shortcut:

```text
ctrl+shift+m
```

Cycles permission mode:

```text
ask -> read-only -> auto -> yolo -> ask
```

YOLO mode auto-allows by default and is dangerous; it shows a warning/confirmation when enabled and still hard-blocks `rm -f`/`rm -rf` style commands and apparent repository deletion.

See [`permission-policy/README.md`](permission-policy/README.md) for details.

---

### Prompt Shield

Path:

```text
prompt-shield/index.ts
```

Global install location:

```text
~/.pi/agent/extensions/prompt-shield/index.ts
```

Scans project/global Pi resources for prompt-injection and agent-security risk. Supports monitor, ask, and block-dangerous modes.

Scans:

- `.pi/skills/`
- `.agents/skills/`
- `.pi/prompts/`
- `.pi/extensions/`
- `.pi/SYSTEM.md`
- `.pi/APPEND_SYSTEM.md`
- `AGENTS.md`
- `CLAUDE.md`

Detection basis:

- deterministic pattern scoring from vendored shared scanner for instruction override, secret exfiltration, destructive commands, hidden text, role simulation, and obfuscation
- LLM review for suspicious resources
- SHA-256 cache to avoid repeated LLM calls for unchanged files
- automatic activation when Pi tools install or update skills, prompts, or extensions
- hash-based approvals and denials; deny deletes risky resources from disk
- LLM review for suspicious resources on scan (approve/deny do not force it)
- scan summaries that suggest exact follow-up commands
- permission-policy integration via stricter permissions when unapproved risk is active

Commands:

```text
/prompt-shield
/prompt-shield scan
/prompt-shield llm
/prompt-shield audit
/prompt-shield mode monitor|ask|block-dangerous
/prompt-shield approve <path>
/prompt-shield deny <path>
/prompt-shield approvals
/prompt-shield reset
```

Storage:

```text
~/.pi/agent/prompt-shield/config.json
~/.pi/agent/prompt-shield/cache.json
~/.pi/agent/prompt-shield/audit.jsonl
~/.pi/agent/prompt-shield/state.json
```

Helper scripts:

```text
prompt-shield/scripts/approve-installed-extensions.sh
prompt-shield/scripts/status.sh
prompt-shield/scripts/rescan.sh
```

See [`prompt-shield/README.md`](prompt-shield/README.md) for details.

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
- Searches configured self-hosted SearXNG when enabled, otherwise DuckDuckGo HTML results
- Includes an optional local SearXNG Docker Compose package at `web-search/optional-packages/searxng`
- Requires HTTPS result URLs; SearXNG provider URLs can use HTTP only on local loopback
- Uses Node/fetch TLS certificate and hostname validation
- Performs secure DNS-over-HTTPS consistency checks
- Checks malware-filtering DNS providers
- Checks IPv4 addresses against DNSBL zones
- Scans user questions before search planning to block LLM prompt-injection
- Supports explicit public or private/local IP HTTPS URLs
- Supports saved IP URLs via commands
- Supports provider config via `/web-search-config`
- Blocks private/reserved IP targets by default (can opt out with `blockPrivateIps`)
- Optionally blocks dangerous results entirely (`blockDangerous`)
- Scans fetched web content with the shared agent-risk scanner and omits suspicious/dangerous previews by default

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
- `includeRiskyContent`: include suspicious/dangerous previews instead of omitting them, default false
- `includeSavedIpUrls`: include globally saved IP URLs, default false
- `blockDangerous`: omit dangerous results entirely, not just previews, default false
- `blockPrivateIps`: reject private/reserved IP targets, default true

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

Optional local SearXNG quick start:

```bash
cd web-search/optional-packages/searxng
./init.sh
docker compose up -d
```

Then configure Pi:

```text
/web-search-config searxng http://127.0.0.1:8080/search
/web-search-config provider auto
/web-search-config list
```

Use `provider auto` to fall back to DuckDuckGo HTML if local SearXNG is down, or `provider searxng` for strict SearXNG-only mode.

See [`web-search/README.md`](web-search/README.md) for details.

---

### Tool Context Loader

Path:

```text
tool-context-loader/index.ts
```

Global install location:

```text
~/.pi/agent/extensions/tool-context-loader/index.ts
```

P1c status: discovery + diagnostics, preload index only, and JIT tool-result injection. It scans configured runbook/episode roots, parses lightweight frontmatter metadata, respects project trust for project-local roots, exposes diagnostics, appends compact metadata-only preload indexes for active tools with matching `injection: preload` records, and appends bounded advisory-wrapped body excerpts after matching tool results for explicit `injection: tool_result` records. Parallel race-safety hardening remains deferred to P1d.

Default project roots, scanned only when trusted:

```text
.pi/runbooks
.runbooks
.episodic-memory/episodes
```

Commands:

```text
/tool-context-loader
/tool-context-loader status
/tool-context-loader verbose
/tool-context-loader rescan
/tool-context-loader on
/tool-context-loader off
```

See [`tool-context-loader/README.md`](tool-context-loader/README.md) for details.

## Installing extensions globally

From this project root:

```bash
mkdir -p ~/.pi/agent/extensions/permission-policy
cp permission-policy/index.ts ~/.pi/agent/extensions/permission-policy/index.ts

mkdir -p ~/.pi/agent/extensions/web-search
cp web-search/index.ts ~/.pi/agent/extensions/web-search/index.ts
cp -R web-search/lib ~/.pi/agent/extensions/web-search/lib

mkdir -p ~/.pi/agent/extensions/prompt-shield
cp prompt-shield/index.ts ~/.pi/agent/extensions/prompt-shield/index.ts
cp -R prompt-shield/lib ~/.pi/agent/extensions/prompt-shield/lib

mkdir -p ~/.pi/agent/extensions/tool-context-loader
cp tool-context-loader/index.ts ~/.pi/agent/extensions/tool-context-loader/index.ts
```

Then in Pi:

```text
/reload
```

or restart Pi.
