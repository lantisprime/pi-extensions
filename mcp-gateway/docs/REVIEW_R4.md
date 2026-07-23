# mcp-gateway review round 4 — GLM-5.2 (neuralwatt), 2026-07-23

Frozen diff: 2,269 lines (working tree at 08:46, post fold-round-3 rebuild).
Reviewer: pi + GLM-5.2 via neuralwatt, read-only adversarial, behavior-simulated.
Seat cost: $0.469 (↑51k ↓31k).

## Verdict: REJECT (1×P1, 6×P3)

1. **[P1] Scan-evasion + key leakage on the mcp_call callTool-throw path.**
   `mcp-gateway/index.ts` (catch around callTool) renders `error.message`
   verbatim into model-facing output with `inbound n/a` — no inbound scan. The
   message is the fully gateway-controlled JSON-RPC error string built in
   `mcp-client.ts` (`MCP error ${code}: ${message}`). A malicious gateway can
   inject instructions or reflect the bearer key, unscanned/unredacted.
   Behavior-simulated: a reflected `sk-…` key reached output.
   Violates: PLAN intro scan-everything, resolveGatewayAuth key-never rule,
   amendment 7.
2. **[P3] Amendment 7 "EVERY return path appends the security summary" violated**
   on gateway-not-configured, server-not-allowlisted, and manifest-blocked
   early returns.
3. **[P3] doNotification swallows the 3xx-redirect throw** — `initialize()`
   succeeds when the `notifications/initialized` POST gets a 302 (simulated).
   Transport rule "ANY 3xx -> throw" is absolute; amendment 2 only tolerates
   202/empty-body.
4. **[P3] mcp_list_tools emits tool NAME and inputSchema JSON unscanned** —
   only descriptions go through `applyDescriptionPolicy`; a malicious tool
   name is an unscanned injection surface.
5. **[P3] Unscoped additions beyond the frozen spec**: (a) `redactObfuscation`
   in shared/security-scan.ts (redaction beyond amendment 4's secret-material
   scope); (b) `typescript@6` pin in scripts/test-security-scan.mjs; (c)
   `coerceToolArguments` gate not in the PLAN's mcp_call gate list.
6. **[P3] Test gap**: no test exercises the mcp_call callTool-throw output
   path; `tool error:` prefix never asserted end-to-end — finding 1 shipped
   with no regression guard.
7. **[P3] set-gateway stores the raw URL** (userinfo-capable) and status echoes
   it verbatim; should normalize to origin like the default-gateway derivation.

## Fold classification (orchestrator, grounded in code inspection)

| # | Class | Route |
|---|-------|-------|
| 1 | ACCEPT | builder — scan + policy-render the throw-path message (new pure helper in security-gates.ts), amendment 11 |
| 2 | ACCEPT | builder — append summary line on all early returns, amendment 12 |
| 3 | ACCEPT | builder — notifications rethrow redirect + HTTP>=400; tolerate any 2xx/empty body, amendment 13 |
| 4 | ACCEPT-WITH-MOD | builder — scan name+schema; risky name ⇒ omit tool from listing with placeholder; risky schema ⇒ omit schema line, amendment 14 |
| 5 | ACCEPT-WITH-MOD | orchestrator doc fix — keep all three, authorized retroactively by amendment 15 |
| 6 | ACCEPT | builder — tests for throw path (scanned/redacted) + tool error prefix, amendment 16 |
| 7 | ACCEPT | builder — set-gateway normalizes to `new URL(v).origin`, amendment 17 |

# Re-review round 5 — GLM-5.2 (same seat), 2026-07-23

Frozen diff R5 (post fold-round-4 build). Seat cumulative cost: $1.654.

## Verdict: HOLD-1

- F2/F3/F4/F5/F6/F7 verified CLOSED (behavior-simulated: 302→reject, 500→reject,
  200/empty tolerated; risky tool name omitted from content; set-gateway strips
  userinfo/path/query; `details` confirmed NOT model-facing — providers send
  only `content`).
- F1 PARTIALLY closed → residual **[P1]**: `renderTransportError` omits the
  message and redacts secret-material matches, but the appended findings list
  echoes the **exfiltration-category match verbatim** — the exfiltration regex
  captures the full reflected bearer key when the gateway shapes the error as
  `exfiltrate <key> token now`. Full key reaches model context, no opt-in.
  Simulated & confirmed. Also: the amendment-16 test never asserts the full
  key is absent, so the leak shipped unguarded.

## Fold (orchestrator): ACCEPT → amendment 18

Cross-finding secret scrub in shared/security-scan.ts: every raw secret
identified by a secret-material finding is redacted wherever it appears in any
other finding's match. Plus hardened tests (scanner-level + gate-level
full-key-absent assertions). Routed to builder, fold round 5.

# Confirm round 6 — GLM-5.2 (same seat), 2026-07-23

Frozen diff R6 (post fold-round-5 build). Seat cumulative cost: $2.249.

## Verdict: HOLD-2

- R5 P1 (F1) CONFIRMED CLOSED: exact bearer-key sim now redacts the exfiltration
  match; full key + `sk-litellm-` prefix absent from output; full-key-absent
  asserted at scanner + gate levels; all four gates green.
- New F1 **[P3]** prefix-subset scrub ordering: when secret A prefixes secret B
  in one match, scrubbing A first splits inside B and B's tail fragment
  (`…7890`) survives. Orchestrator-reproduced on disk. Fix = sort
  dedupSecrets by descending length.
- New F2 **[P2]** O(n²) scanner DoS newly exposed on the mcp_call inbound path:
  up to 2 MB gateway-controlled text feeds the quadratic scanner with no
  pre-scan size guard (measured 100k=9.6s, 400k=161s). Pre-existing scanner
  behavior, new mcp-gateway surface. Fix = SCAN_INPUT_CAP guard before the
  inbound scan.

## Fold (orchestrator): both ACCEPT → amendments 19 (F1) + 20 (F2)

Routed to builder, fold round 6.
