# Secure Web Search Plan

## Purpose

Evolve `secure_web_search` from a DuckDuckGo-HTML-only implementation into a more reliable, privacy-conscious, security-first web research extension while preserving independent installability and shared scanner safety.

## TL;DR Current Plan

- **Current priority:** stabilize the existing DuckDuckGo HTML path and redirect handling.
- **Next milestone:** finish and keep CI coverage for redirect/fetch behavior.
- **Near-term provider strategy:** keep DuckDuckGo HTML as the default free fallback, but introduce provider boundaries so SearXNG and specialized free providers can be added safely.
- **No paid APIs by default.** Paid providers should not be required for core functionality.
- **Privacy stance:** avoid direct Google scraping; if Google is ever used, use explicit opt-in through a self-hosted SearXNG instance only.
- **Security stance:** every result and fetched page still passes HTTPS, redirect, DNS/malware/DNSBL, size, and prompt-injection checks.
- **Shared scanner stance:** do not fork scanner behavior inside web-search. Continue vendoring `shared/security-scan.ts` and running sync checks.

## Design References

- `web-search/README.md` — current behavior and user-facing docs.
- `web-search/index.ts` — current extension implementation.
- `web-search/lib/security-scan.ts` — vendored copy of shared scanner.
- `shared/security-scan.ts` — source of truth for scanner logic.
- `GITHUB_PI_EXTENSION_RESEARCH.md` — ecosystem research; notes provider fallback chains in other web extensions.
- `WORKPLAN.md` — repo-wide sequencing and validation gates.

## Current Architecture

Current flow:

```text
user question
  -> question risk scan
  -> LLM search planner
  -> DuckDuckGo HTML search
  -> parse result URLs/snippets
  -> securityCheckUrl per result
  -> optional fetchPagePreview
  -> content risk scan
  -> formatted citations/results
```

Key security checks:

- HTTPS only.
- Manual redirect validation.
- DNS-over-HTTPS consistency checks.
- Malware-filtering DNS checks.
- DNSBL checks for IPv4 addresses.
- Private/reserved explicit IP blocking by default.
- Response byte caps.
- Shared prompt-injection/agent-risk scanner for questions and content.

## Target Architecture

Introduce a provider boundary while preserving security checks after provider output.

```text
SearchProvider
  -> raw search results
  -> normalized SearchCandidate[]
  -> common security/content pipeline
  -> SearchResult[]
```

Provider candidates:

1. `duckduckgo-html`
   - Default free fallback.
   - Uses canonical `https://html.duckduckgo.com/html/?q=...` endpoint to avoid avoidable redirects.
   - Fragile because it scrapes HTML.

2. `searxng`
   - Optional self-hosted provider.
   - Best privacy-preserving no-paid option.
   - Must be explicitly configured; do not use random public instances by default.
   - Can disable Google by default or allow Google only by explicit per-query opt-in.

3. Specialized free providers, future optional:
   - GitHub search/API for code/docs/repo research.
   - Wikipedia/Wikidata for encyclopedic facts.
   - Stack Exchange API for programming Q&A.

All providers must return candidates that go through the same common security pipeline.

## Privacy Policy

Default:

- Do not use Google directly.
- Do not use browser cookies.
- Do not use public/random SearXNG instances by default.
- Send only the search query to providers, not full conversation context.
- Strip tracking params from result URLs where safe.

Google-compatible mode, future optional:

- Only through self-hosted SearXNG.
- Must require explicit config and explicit query/tool parameter opt-in.
- Must not use user browser cookies or Google account context.

Example future config:

```json
{
  "provider": "auto",
  "searxngUrl": "https://search.example.com/search",
  "allowGoogleViaSearxng": false,
  "requireExplicitGoogle": true,
  "stripTrackingParams": true
}
```

## Implementation Plan

### Phase W0a — Stabilize current DuckDuckGo path

Status: implemented.

Scope:

- Extract redirect-following fetch helper.
- Add deterministic redirect/fetch unit tests.
- Use canonical DuckDuckGo HTML endpoint.
- Keep E2E smoke test for `secure_web_search` returning at least one result.
- Run shared scanner sync/tests to prove no scanner drift.

### Phase W0b — DuckDuckGo parser fixture coverage

Status: implemented.

Scope:

- Add saved minimal DuckDuckGo HTML fixture.
- Test parser extraction of title, URL, and snippet.
- Keep fixture small and deterministic.
- Do not rely on live DuckDuckGo in CI.

Files:

- `web-search/index.ts`
- `web-search/lib/redirect-fetch.ts`
- `web-search/lib/duckduckgo.ts`
- `web-search/test-fixtures/test-redirect-fetch.ts`
- `web-search/test-fixtures/run-redirect-fetch-tests.sh`
- `.github/workflows/ci.yml`
- `web-search/README.md`

### Phase W1 — Provider interface extraction

Status: partially implemented for DuckDuckGo HTML; future provider selection/config remains W2.

Scope:

- Define a small `SearchProvider` interface.
- Move DuckDuckGo search URL construction and parsing into `lib/providers/duckduckgo-html.ts` or equivalent.
- Add provider name to `details` for observability.
- Keep existing output format stable.
- Do not add new providers yet.
- Ensure providers return only raw candidates; the common secure pipeline remains the only path to visible results.

Suggested type:

```ts
type SearchCandidate = {
  title: string;
  url: string;
  snippet: string;
  provider: string;
};

type SearchProvider = {
  name: string;
  search(plan: SearchPlan, maxResults: number, signal?: AbortSignal): Promise<SearchCandidate[]>;
};
```

### Phase W2 — Config and provider selection

Status: implemented for `auto`, `duckduckgo-html`, and explicit `searxng` config.

Scope:

- Add config loading for provider selection.
- Support `duckduckgo-html` and `auto` initially, both resolving to DuckDuckGo.
- Keep behavior backward compatible when no config exists.
- Add `/web-search-config` or extend current commands only if necessary.

Example config path:

```text
~/.pi/agent/web-search/config.json
```

Extend existing config rather than introduce another file.

### Phase W3 — Self-hosted SearXNG provider

Status: implemented for HTTPS self-hosted SearXNG JSON output with explicit config and DuckDuckGo fallback only in `auto` mode.

Scope:

- Add optional `searxng` provider.
- Require configured base URL.
- Reject untrusted public/random instances by default.
- Support JSON output if available; otherwise parse only if stable enough.
- Run all result URLs through common security pipeline.
- Default Google disabled unless explicitly configured on the SearXNG server and explicitly requested.

### Phase W4 — Specialized free providers

Scope:

- Add optional GitHub provider for code/repo searches.
- Consider Wikipedia/Wikidata and Stack Exchange providers.
- Keep each provider explicitly scoped and disabled unless useful for the query/sites.

### Phase W5 — Privacy and observability hardening

Scope:

- Add rejected provider diagnostics.
- Add conservative tracking parameter stripping for known tracking params only.
- Add docs for privacy modes.
- Add tests for provider selection and URL normalization.

## Validation Contracts

### WS-001: DuckDuckGo canonical endpoint

**Given** a DuckDuckGo query  
**When** the search URL is built  
**Then** it uses `https://html.duckduckgo.com/html/` rather than redirecting `https://duckduckgo.com/html/`.

### WS-002: HTTPS redirect following

**Given** an HTTPS URL redirects to another HTTPS URL  
**When** content is fetched  
**Then** the redirect target is checked before fetching  
**And** content is returned if checks pass.

### WS-003: non-HTTPS redirect blocked

**Given** an HTTPS URL redirects to HTTP  
**When** content is fetched  
**Then** fetching is rejected before following the target.

### WS-004: missing redirect location blocked

**Given** a redirect response lacks `Location`  
**When** content is fetched  
**Then** fetching is rejected with a clear diagnostic.

### WS-005: redirect limit enforced

**Given** redirects exceed `MAX_REDIRECTS`  
**When** content is fetched  
**Then** fetching is rejected.

### WS-006: content type enforced

**Given** a response has unsupported content type  
**When** content is fetched  
**Then** fetching is rejected.

### WS-007: byte caps enforced

**Given** content length or streamed bytes exceed `MAX_FETCH_BYTES`  
**When** content is fetched  
**Then** fetching is rejected before unbounded buffering.

### WS-008: shared scanner sync preserved

**Given** web-search changes are made  
**When** scanner tests run  
**Then** `scripts/verify-shared-sync.sh` and `scripts/test-security-scan.mjs` pass.

### WS-009: E2E no unchecked redirect

**Given** `secure_web_search` runs a normal web query  
**When** DuckDuckGo redirects or provider redirects occur  
**Then** no `unchecked redirect` error is produced.

### WS-010: provider common pipeline

**Given** any provider returns candidates  
**When** results are processed  
**Then** each candidate goes through the same HTTPS, redirect, DNS, DNSBL, size, and content-risk checks.

### WS-011: SearXNG is explicit

**Given** no SearXNG URL is configured  
**When** provider selection runs  
**Then** SearXNG is not used.

### WS-012: Google is explicit and indirect

**Given** future Google support is requested  
**When** provider selection runs  
**Then** Google is only used via configured self-hosted SearXNG and explicit opt-in, never by direct scraping.

### WS-013: DuckDuckGo parser fixture compatibility

**Given** a saved minimal DuckDuckGo HTML fixture  
**When** parser runs  
**Then** expected title, URL, and snippet are extracted.

### WS-014: provider cannot bypass security pipeline

**Given** a provider returns a candidate URL  
**When** results are processed  
**Then** the candidate is not emitted unless `securityCheckUrl` succeeds.

### WS-015: config backward compatibility

**Given** an existing config with only `updatedAt` and `ipUrls`  
**When** config loads  
**Then** provider defaults are applied without losing saved IP URLs.

### WS-016: tracking param stripping is conservative

**Given** a URL with `utm_source` and a functional non-tracking query param  
**When** URL normalization runs  
**Then** tracking params are removed and functional params remain.

## Test Plan

Unit tests:

```bash
web-search/test-fixtures/run-redirect-fetch-tests.sh
```

Shared scanner impact:

```bash
scripts/verify-shared-sync.sh
scripts/test-security-scan.mjs
```

CI-equivalent:

```bash
scripts/verify-shared-sync.sh
scripts/test-security-scan.mjs
web-search/test-fixtures/run-redirect-fetch-tests.sh
npx --yes tsx permission-policy/test-fixtures/test-classification.ts
```

E2E smoke examples:

```bash
pi --no-extensions -e ./web-search/index.ts --no-builtin-tools --tools secure_web_search --mode json -p 'Call secure_web_search with question "agentic AI workplan", maxResults 1, fetchPages false.'
```

## Done Criteria

- Redirect/fetch tests pass in CI.
- Shared scanner sync/tests pass.
- DuckDuckGo normal search E2E produces results without `unchecked redirect`.
- Explicit HTTPS redirects are followed only after target checks.
- Non-HTTPS redirects are rejected.
- README documents tests, provider behavior, and privacy stance.
- No paid API is required for default functionality.
