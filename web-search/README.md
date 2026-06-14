# Pi Secure Web Search Extension

Adds a `secure_web_search` tool for web research.

## Features

- Uses the current Pi LLM to suggest relevant search queries and reputable websites.
- Searches a configured self-hosted SearXNG instance when enabled, otherwise falls back to DuckDuckGo HTML results.
- Allows only HTTPS result URLs and re-checks every redirect target before fetching previews.
- Relies on Node/fetch TLS validation for SSL certificate and hostname checks.
- Performs secure DNS-over-HTTPS consistency checks against providers including Cloudflare and Google.
- Tracks malware-DNS and DNSBL states as blocked, not-blocked, or unchecked instead of treating provider failures as clean or malicious.
- Allows user-supplied public or private/local IP addresses via explicit `urls`, but checks IPv4 addresses against DNSBL before fetching.
- Checks IPv4 addresses against DNSBL zones before fetching result pages.
- Caps fetched text responses before buffering them.
- Scans titles, snippets, and fetched page previews with the shared agent-risk scanner.
- Scans the user's search question before generating a search plan; dangerous questions skip LLM plan generation to avoid prompt-injection vectors.
- Omits suspicious/dangerous page previews by default while still returning citation metadata and scan findings.
- Optionally blocks dangerous results entirely instead of only omitting their previews (`blockDangerous`).
- Block private/reserved IP targets by default in explicit URLs (`blockPrivateIps`, default true).
- Truncates questions to 2000 characters before sending to the search-planning LLM.
- Sanitizes LLM-generated sites to reject IP addresses and URL paths, preventing the model from injecting raw IP targets.
- Requires explicit SearXNG configuration; it does not use random public SearXNG instances by default.
- Includes an optional local SearXNG Docker Compose package for loopback-only use.

## Tool

```text
secure_web_search
```

Parameters:

- `question`: information to search for
- `sites`: optional domains or IP addresses to prioritize in search queries
- `urls`: optional explicit HTTPS URLs to security-check and fetch directly, including public or private/local IP URLs
- `maxResults`: 1-10, default 5
- `fetchPages`: whether to fetch and preview pages, default true
- `includeRiskyContent`: include suspicious/dangerous previews instead of omitting them, default false
- `includeSavedIpUrls`: include globally saved IP URLs from `/web-search-ip`, default false
- `blockDangerous`: entirely omit results whose content scan is dangerous (not just previews), default false
- `blockPrivateIps`: reject explicit URL targets that resolve to private/reserved IP ranges, default true

## Provider Config

By default `secure_web_search` uses DuckDuckGo HTML. To use SearXNG, configure your own SearXNG instance explicitly. Public/non-loopback instances must use HTTPS; local Docker instances may use HTTP only on loopback hosts:

```text
/web-search-config searxng https://search.example.com/search
/web-search-config searxng http://127.0.0.1:8080/search
/web-search-config list
/web-search-config provider auto
/web-search-config provider searxng
/web-search-config provider duckduckgo-html
/web-search-config reset-provider
```

Provider behavior:

- `auto`: uses configured SearXNG when `searxngUrl` exists, otherwise DuckDuckGo HTML; falls back to DuckDuckGo if SearXNG fails.
- `searxng`: requires `searxngUrl` and does not silently fall back.
- `duckduckgo-html`: forces the DuckDuckGo HTML provider.

SearXNG must support JSON output (`format=json`). Prefer a self-hosted/private instance. The extension ships with no public SearXNG default and sends only search query text to the provider. HTTP SearXNG provider URLs are accepted only for `localhost`, `127.x.x.x`, and `::1`; all other SearXNG provider URLs must be HTTPS.

## Optional local SearXNG package

This repo includes a local Docker Compose package at:

```text
web-search/optional-packages/searxng
```

It follows the upstream SearXNG container docs, binds to `127.0.0.1:8080` by default, mounts persistent config/data volumes, enables JSON output, and removes Google engines by default.

Quick start:

```bash
cd web-search/optional-packages/searxng
./init.sh
docker compose up -d
curl 'http://127.0.0.1:8080/search?q=pi&format=json'
```

Then in Pi:

```text
/web-search-config searxng http://127.0.0.1:8080/search
```

See [`optional-packages/searxng/README.md`](optional-packages/searxng/README.md) for management commands and security notes.

## Saved IP URLs

Users can save IP endpoints for explicit opt-in checking/fetching by `secure_web_search`.

Commands:

```text
/web-search-ip add 192.168.1.1
/web-search-ip add https://203.0.113.10/status
/web-search-ip list
/web-search-ip remove 192.168.1.1
/web-search-ip reset
```

Accepted values:

- IPv4 address, converted to `https://<ip>/`
- IPv6 address, converted to `https://[<ip>]/`
- Explicit `https://<ip>/path` URL

Saved IP URLs are stored globally in:

```text
~/.pi/agent/web-search/config.json
```

Example file:

```json
{
  "version": 1,
  "updatedAt": "2026-06-13T00:00:00.000Z",
  "provider": "auto",
  "searxngUrl": "https://search.example.com/search",
  "ipUrls": ["https://192.168.1.1/", "https://203.0.113.10/status"]
}
```

Saved URLs are included only when `includeSavedIpUrls: true` is set, and still go through HTTPS/TLS validation and DNSBL checks.

## Install

For global use:

```bash
mkdir -p ~/.pi/agent/extensions/web-search
cp index.ts ~/.pi/agent/extensions/web-search/index.ts
cp -R lib ~/.pi/agent/extensions/web-search/lib
```

Then run:

```text
/reload
```

## Tests

Redirect/fetch, DuckDuckGo provider, and SearXNG provider unit tests cover DuckDuckGo's canonical `html.duckduckgo.com` endpoint, saved DuckDuckGo HTML parser fixtures, DuckDuckGo ad redirect filtering, SearXNG URL normalization and JSON parsing, the legacy `duckduckgo.com` to `html.duckduckgo.com` redirect, relative HTTPS redirects, non-HTTPS redirect blocking, missing `Location` headers, redirect limits, unsupported content types, JSON content, and response-size caps.

```bash
web-search/test-fixtures/run-redirect-fetch-tests.sh
```

Shared scanner impact checks:

```bash
scripts/verify-shared-sync.sh
scripts/test-security-scan.mjs
```

## Security notes

No web search extension can fully prove a website is safe. This extension is defensive by default: it scans user questions for prompt-injection before generating search plans (dangerous questions skip LLM planning), rejects non-HTTPS URLs and non-HTTPS redirects, validates each redirect hop before fetching a preview, caps response bodies, rejects hosts that fail secure DNS consistency checks, rejects hosts blocked by malware-filtering DNS providers, rejects DNSBL-listed IPv4 addresses, and blocks private/reserved IP targets (can opt out with `blockPrivateIps: false`). Raw IP HTTPS URLs, including private/local IPs when explicitly allowed, go through DNSBL checks where applicable and TLS certificate validation. DNSBL lists and malware-filtering DNS are useful signals but not complete malicious-site detectors; transient provider failures are reported as `unchecked`. Fetched web content is untrusted prompt input, so suspicious/dangerous previews are omitted by default. Use `blockDangerous: true` to omit dangerous results entirely. SearXNG is a provider privacy boundary, not anonymity: the configured SearXNG server still sees search queries, and upstream engines configured on that server may also see them.

Secure DNS providers currently used:

- Cloudflare DNS over HTTPS
- Google Public DNS over HTTPS
- Quad9 malware-filtering DNS over HTTPS
- Cloudflare Family/Security DNS over HTTPS
