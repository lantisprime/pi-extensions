# Pi Secure Web Search Extension

Adds a `secure_web_search` tool for web research.

## Features

- Uses the current Pi LLM to suggest relevant search queries and reputable websites.
- Searches DuckDuckGo HTML results.
- Allows only HTTPS result URLs.
- Relies on Node/fetch TLS validation for SSL certificate and hostname checks.
- Performs secure DNS-over-HTTPS consistency checks against providers including Cloudflare and Google.
- Checks malware-filtering secure DNS providers including Quad9 and Cloudflare Family/Security DNS, and blocks hosts those providers refuse to resolve.
- Allows user-supplied public or private/local IP addresses via explicit `urls`, but checks IPv4 addresses against DNSBL before fetching.
- Checks IPv4 addresses against DNSBL zones before fetching result pages.
- Fetches text previews from pages that pass security checks.

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

## Saved IP URLs

Users can save IP endpoints that should always be checked/fetched by `secure_web_search`.

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
  "updatedAt": "2026-06-13T00:00:00.000Z",
  "ipUrls": ["https://192.168.1.1/", "https://203.0.113.10/status"]
}
```

These saved URLs are prepended to each `secure_web_search` run and still go through HTTPS/TLS validation and DNSBL checks.

## Install

For global use:

```bash
mkdir -p ~/.pi/agent/extensions/web-search
cp index.ts ~/.pi/agent/extensions/web-search/index.ts
```

Then run:

```text
/reload
```

## Security notes

No web search extension can fully prove a website is safe. This extension is defensive by default: it rejects non-HTTPS URLs, hosts that fail secure DNS consistency checks, hosts blocked by malware-filtering DNS providers, and DNSBL-listed IPv4 addresses. Raw IP HTTPS URLs, including private/local IPs, are allowed only after DNSBL checks where applicable and TLS certificate validation. DNSBL lists and malware-filtering DNS are useful signals but not complete malicious-site detectors.

Secure DNS providers currently used:

- Cloudflare DNS over HTTPS
- Google Public DNS over HTTPS
- Quad9 malware-filtering DNS over HTTPS
- Cloudflare Family/Security DNS over HTTPS
