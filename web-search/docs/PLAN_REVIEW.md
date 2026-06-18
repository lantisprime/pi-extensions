# Secure Web Search Plan Review

## Review Scope

Reviewed `web-search/PLAN.md` for architecture, sequencing, privacy, security, implementation feasibility, validation coverage, shared scanner impact, and fit with findings from `GITHUB_PI_EXTENSION_RESEARCH.md`.

## Executive Verdict

**Go, with staged implementation.**

The plan correctly avoids jumping straight from DuckDuckGo scraping to a broad provider system. It stabilizes the current path first, then introduces provider abstraction, then adds optional SearXNG and specialized free providers.

The most important constraints are correct:

- no paid API requirement for default functionality
- no direct Google scraping
- every provider must feed into the common security pipeline
- shared scanner remains source-of-truth in `shared/security-scan.ts`
- DuckDuckGo HTML remains a fallback, not the long-term sole dependency

## Strengths

### S-001: Stabilize before expanding

The W0 phase fixes the current redirect issue and adds tests before provider abstraction. This prevents a common failure mode: adding abstraction around unstable behavior.

### S-002: Security pipeline remains centralized

The target architecture makes providers return candidates, then applies security checks centrally. This is critical. Provider-specific code should not bypass HTTPS, redirect, DNS, DNSBL, size, or content-risk checks.

### S-003: Privacy stance is explicit

The plan clearly says:

- no direct Google scraping
- no browser cookies by default
- no random public SearXNG instances by default
- send only query text, not full conversation context

This is stronger than most web-search extension approaches reviewed on GitHub.

### S-004: No-paid default is preserved

The plan allows future providers but does not make paid APIs required. This matches the user constraint.

### S-005: Validation contracts are concrete

Contracts WS-001 through WS-012 cover the current bug, redirect/security behavior, scanner sync, provider pipeline, and future Google/SearXNG constraints.

## Risks and Required Mitigations

### R-001: Provider abstraction can accidentally weaken security

**Risk:** Future providers may be tempted to return already-fetched content or pre-trusted URLs, bypassing common checks.

**Mitigation:** The provider interface should return only raw candidates, not trusted results:

```ts
type SearchCandidate = { title: string; url: string; snippet: string; provider: string };
```

Fetched page previews must remain in the common pipeline.

### R-002: SearXNG public instance temptation

**Risk:** Users may configure random public SearXNG instances that log queries, inject results, or behave inconsistently.

**Mitigation:** Docs should strongly recommend self-hosted/private instances. The tool should not ship with a public default SearXNG URL.

### R-003: Google privacy claims can be overstated

**Risk:** Saying “private Google search” is misleading. Google still sees the query and the SearXNG/VPN/Tor exit IP.

**Mitigation:** Use wording like “privacy boundary” and “reduces direct exposure,” not “anonymous.”

### R-004: DuckDuckGo HTML parser remains fragile

**Risk:** Even with the canonical endpoint, class names or markup can change.

**Mitigation:** Add parser fixture tests with saved minimal DuckDuckGo HTML samples. WS-001 covers URL construction, but parsing should also be fixture-tested.

Add contract:

```text
WS-013: DuckDuckGo parser fixture compatibility
```

### R-005: DNS consistency can be flaky in E2E tests

**Risk:** Live E2E searches can fail because DNS providers disagree transiently.

**Mitigation:** Keep CI unit tests deterministic and keep live E2E as smoke/manual or non-blocking unless stable. CI should not depend on live DuckDuckGo/network behavior beyond package install where possible.

### R-006: Config growth can become messy

**Risk:** Existing config stores saved IP URLs. Adding provider config to the same file is reasonable but needs versioning/default handling.

**Mitigation:** Add a `version` field or tolerate missing fields carefully. Keep backward compatibility with existing `ipUrls`.

Suggested config shape:

```ts
type WebSearchConfig = {
  version?: 1;
  updatedAt: string;
  ipUrls: string[];
  provider?: "auto" | "duckduckgo-html" | "searxng";
  searxngUrl?: string;
  allowGoogleViaSearxng?: boolean;
  stripTrackingParams?: boolean;
};
```

### R-007: Tracking parameter stripping can break some URLs

**Risk:** Aggressive parameter removal can break signed URLs or result redirects.

**Mitigation:** Start with conservative stripping for known tracking params only:

- `utm_*`
- `fbclid`
- `gclid`
- `mc_cid`
- `mc_eid`

Do not remove unknown params.

### R-008: Specialized providers can dilute scope

**Risk:** GitHub/Wikipedia/Stack Exchange providers could expand this extension too much.

**Mitigation:** Treat W4 as optional after provider abstraction and SearXNG. Each specialized provider should have explicit trigger logic and tests.

## Missing Validation Contracts

Add these to `web-search/PLAN.md` before implementing W1/W2:

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

## Implementation Plan Review

### W0 — Stabilize current DuckDuckGo path

**Verdict:** Correct and should be completed first.

Current W0 is already mostly implemented:

- redirect helper extracted
- DuckDuckGo canonical endpoint helper added
- redirect unit tests added
- CI hook added
- shared scanner checks pass

Before considering W0 complete, add a DuckDuckGo parser fixture test or explicitly defer it.

### W1 — Provider interface extraction

**Verdict:** Good next step after W0.

Keep it mechanical:

- Move existing DuckDuckGo code into provider module.
- Do not change external tool schema yet.
- Do not add SearXNG yet.
- Tests should prove output parity.

### W2 — Config and provider selection

**Verdict:** Good but should be conservative.

Do not add too many commands. Prefer config file plus `/web-search-ip` staying focused unless diagnostics require a new command.

Potential command:

```text
/web-search status
```

But avoid command sprawl unless needed.

### W3 — SearXNG provider

**Verdict:** Valuable but risky.

Add only after provider abstraction tests exist. Require explicit configured URL. Do not include a public default.

### W4 — Specialized free providers

**Verdict:** Defer.

GitHub provider likely has highest value. Wikipedia/Stack Exchange are useful but narrower. Do not let these block SearXNG/provider abstraction.

### W5 — Privacy and observability hardening

**Verdict:** Should be partly pulled earlier.

Provider name in details/output should be added in W1, not W5, because it helps validate provider abstraction.

## Recommended Revised Milestones

1. **W0a:** redirect helper + tests + canonical DuckDuckGo endpoint.
2. **W0b:** DuckDuckGo parser fixture test.
3. **W1:** provider interface extraction with DuckDuckGo parity.
4. **W2:** config/provider selection with backward compatibility tests.
5. **W3:** optional self-hosted SearXNG provider.
6. **W4:** conservative tracking-param stripping and privacy docs.
7. **W5:** optional specialized free providers, starting with GitHub.

## Code Review Notes On Current Direction

- Extracting `redirect-fetch.ts` is a good move because it makes redirect behavior deterministic and unit-testable without live network/LLM calls.
- `REDIRECT_STATUSES` shared between security HEAD checks and content fetch checks avoids drift.
- `buildDuckDuckGoHtmlSearchUrl()` is small but useful because it makes WS-001 easy to test and prevents accidentally reverting to the redirecting endpoint.
- Keep the helper free of web-search-specific DNS logic by injecting `checkRedirectTarget`; this preserves testability.

## Final Recommendation

Proceed with W0 and W1. Before W3/SearXNG, add parser fixture tests and provider-pipeline tests so future providers cannot bypass security checks.

The plan is sound if the project keeps one rule absolute:

> Providers discover candidate URLs; only the common secure pipeline decides what the agent can see.
