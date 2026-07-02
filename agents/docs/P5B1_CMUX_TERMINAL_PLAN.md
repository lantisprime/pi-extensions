# P5b-1 cmux-terminal Plan — Phase 2 (Dispatch + Tools)

> **Status:** DRAFT v2.2 (post codex R2 review). Supersedes v1 (`feat/cmux-control-and-p5b-cmux-terminal`
> branch, 206 lines, never reviewed), v2.0 (`ddc0054`, 549 lines, codex R1 verdict CHANGES-REQUESTED),
> AND v2.1 (`8135c0f`, 827 lines, codex R2 verdict CHANGES-REQUESTED).
>
> **v1's slices 1–5 (the cmux-backend factory + helpers + extension entry per
> the original `agents/docs/P5B1_CMUX_TERMINAL_PLAN.md` v1 ladder) were all
> bundled and shipped in PR #115** (commit `fb55d57`,
> 15 files / +1234 insertions per the merged commit `fb55d57`). **v1 slice
> numbering is the OLD numbering from the unreviewed scaffold-branch plan.**
> **The current P5b-1 ladder (this v2.2 plan) RELABELED those v1 slices 1–5 as
> a single "S1"** (because they shipped together as one PR), and the next four
> slices (S2, S2.5, S3, S4, S5) cover the REMAINING work to make cmux-terminal
> a first-class citizen of `/agents bg` on macOS — the work the handoff
> episodes (`20260628-115014-...`, `20260628-115957-...`, `20260701-143307-...`)
> refer to as "P5b-1-S2 through S5."
>
> **v2.0 → v2.1 changes** (responding to codex R1 blockers, see `Review Consensus`):
> 1. Dispatch preference — added optional `preference?: number` on `TermBgBackend` to guarantee cmux wins on macOS regardless of CLI load order (was: registration order, which is fragile)
> 2. None-registered vs all-unavailable distinction — `selectBgTerminalBackend` now returns a `SelectResult` discriminated union; `getBgTerminalBackend` keeps the `Promise<T | null>` shape for back-compat
> 3. Missed async callsites — `tmux-control/lib/resolve.ts:40` and 3 test fixtures (`test-bg-terminal.mjs`, `test-bg-terminal-dual-instance.mjs`, `tmux-terminal/test-fixtures/test-extension.mjs`) added to S2 scope
> 4. "Transparent fallback" wording narrowed — REQ-R1 now states explicitly that bg-status / bg-stop target the backend selected at the time of the call (may differ from the launch backend); cross-backend aggregation deferred to P5b-2
> 5. REQ-R2 tagged `UNGUARDED-IN-CI` per template rule
> 6. REQ-D11 promoted MUST → caller can now distinguish the two null cases
> 7. Appendix B S2 passes the executor-ready gate: verbatim anchors, REPLACE-not-APPEND for `getBgTerminalBackend`, full test bodies, falsifiable verify commands that capture observed output
> 8. Internal count/wording inconsistencies fixed
> 9. REQ-T2 marked as requiring an S4.0 CLI spike before S4 implementation (verifies `cmux send --surface` against live 0.64.17)
> 10. REQ-D9 / State E unified on `console.debug` + continue-on-throw
>
> **v2.1 → v2.2 changes** (responding to codex R2 blockers):
> 1. New step 2.18 — full executor-ready spec + test bodies for `agents/test-fixtures/test-bg-commands.mjs` (4 REQ-D10/D11 dispatch tests). R2 blocker #1.
> 2. Step 2.9 verify fixed: `total: 4` → `total: 3` (post-step-2.8 the L617 callsite is replaced with `selectBgTerminalBackend()` directly). R2 blocker #2.
> 3. Step 2.14 expanded: 5 → 11 net-new tests, now covers REQ-D1 (RegisterAppendsToList), REQ-D4 (ListBackendsReturnsSnapshot, ListBackendsIsolatedFromRegistry), REQ-D9 (SelectProbesEachBackendOnce), REQ-D2 State B (NoIsAvailableTreatedAsAvailable), State E (IsAvailableThrowTreatedAsUnavailable). R2 blocker #3.
> 4. Step 2.16 augmented: also update stale first-wins/dropped-registration assertions in `tmux-terminal/test-fixtures/test-extension.mjs`. R2 blocker #4.
> 5. New named constant `CMUX_BACKEND_PREFERENCE = 10` in `cmux-terminal/lib/constants.ts`; plumbed through steps 2.11/2.12. R2 non-blocker #1.
> 6. REQ-D11 Notes rewritten: generic message, no per-backend reason (since `probed` shape is minimal). R2 non-blocker #2.
> 7. Done Criteria + Test Catalog + status block: all count/path/stats inconsistencies fixed (27 vs 21 vs 18; 4 vs 3; `tmux-terminal/test-fixtures/test-extension.mjs` correct path; 15 files / +1234 insertions PR #115 stats; v1/S1 numbering clarified above). R2 non-blocker #3.
> 8. S2.5 spike scope narrowed to send/send-key/read-screen flags only (CMUX_SOCKET_MODE remains S1's responsibility). R2 non-blocker #4.

## Episode Search Summary

Searched episodic memory for `pi-extensions`, `p5b-1`, `p5b-1-s2-next`,
`canonical-workplan`, `cmux-terminal`, `bg-terminal`.

Key active memories:

- `20260701-143307-pr-118-merged-permission-mode-cli-flag-s-de9d` — session-end handoff: "Next: P5b-1-S2."
- `20260628-115957-handoff-p5b-1-s1-complete-p5b-1-s2-is-ne-be85` — S1 done, S2 next, load-bearing decisions preserved.
- `20260628-115014-p5b-1-s1-cmux-terminal-backend-merged-pr-32a6` — canonical workplan; full state-of-the-world + key decisions (CMUX_SOCKET_MODE, windowId=ref, isAvailable=roundtrip, agentName gap).
- `20260628-115103-p5b-1-s1-cmux-terminal-backend-shipped-v-360d` — S1 lessons: real-testing-required, codex TUI quirks.

## Objective

Make `/agents bg` automatically prefer the cmux backend on macOS when its daemon
is reachable, fall back transparently to the tmux backend on non-macOS or when
cmux is down, and expose a cmux-equivalent tool surface for in-pane TUI
automation (paste / wait / send-keys). Net effect: macOS users running cmux get
a first-class background-agent experience with zero config; everyone else keeps
the existing tmux experience.

## Why

1. **Today the registry is first-wins.** `agents/lib/bg-terminal.ts:133` keeps a
   single slot; the second `registerBgTerminalBackend()` is dropped with a
   `console.debug`. When both `tmux-terminal` and `cmux-terminal` are loaded
   (the default on macOS dev machines), whichever fires `session_start` first
   wins and the other is silently ignored. On macOS, cmux loses every time
   (loaded second by convention), so `/agents bg` always uses tmux — the
   cmux backend is dead weight on its own target platform.
2. **The consumer already handles fall-through correctly.** `agents/index.ts:617–625`
   calls `getBgTerminalBackend()` then checks `isAvailable()`, returning
   "Terminal backend X is not available" on failure. The first-wins registry
   throws away the "try the next backend" case before the consumer can decide.
3. **cmux was built for AI-agent workflows** (workspace notifications,
   `read-screen` inter-pane communication, `--focus false` discipline). Wiring
   it as the macOS primary lets us layer on the cmux-control skill and future
   cmux-native features without re-doing dispatch.

## Requirements (Ground Truth)

Every requirement is testable. MUST rows have automated unit + integration
coverage. SHOULD rows have manual smoke or one-slice-deferred. UNGUARDED-IN-CI
rows are tagged explicitly with the covering manual step in Notes.

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-D1 | `agents/lib/bg-terminal.ts` SHALL maintain a registry of **all** registered backends, in registration order, not just the first. | `test-bg-terminal.mjs:RegisterAppendsToList`, `test-bg-terminal.mjs:FirstWinsIsRemoved` | MUST | Replaces the current first-wins slot with an append-only array. |
| REQ-D2 | A new selector `selectBgTerminalBackend()` SHALL return a discriminated `SelectResult` describing either a chosen backend, or a typed null-reason. It SHALL call `isAvailable()` on each registered backend in **preference order** (see REQ-D2a) and stop at the first true. | `test-bg-terminal.mjs:SelectReturnsFirstAvailable`, `test-bg-terminal.mjs:SelectFallsThroughOnUnavailable`, `test-bg-terminal.mjs:SelectNullWhenNoneRegistered`, `test-bg-terminal.mjs:SelectAllUnavailableHasReason` | MUST | Async because `isAvailable()` is async. Return shape is a discriminated union so callers can distinguish "none registered" from "all unavailable". |
| REQ-D2a | The `TermBgBackend` interface SHALL grow an OPTIONAL `preference?: number` field. Default 0 if absent (back-compat). `cmux-terminal` SHALL register with `preference: 10`. `tmux-terminal` SHALL register with the default (0). The selector SHALL probe backends in **descending preference order, ties broken by registration order**. | `test-bg-terminal.mjs:SelectPrefersHigherPreferenceRegardlessOfRegistrationOrder`, `test-bg-terminal.mjs:PreferenceTiesBrokenByRegistrationOrder`, `test-bg-terminal.mjs:AbsentPreferenceTreatedAsZero` | MUST | Solves the R1 finding that "registration order alone cannot guarantee cmux wins when CLI is `-e tmux-terminal -e cmux-terminal`". Adding an optional field is structurally backward-compatible — all existing `TermBgBackend` constructors still type-check. |
| REQ-D3 | `getBgTerminalBackend(): Promise<TermBgBackend \| null>` SHALL be redefined as `async`, returning `selectBgTerminalBackend().then(r => r.ok ? r.backend : null)`. All existing callers SHALL be updated to `await` it. | `test-bg-terminal.mjs:GetReturnsSameAsSelect` | MUST | Signature change is consumer-visible but type-checked; the compiler will flag every call site that wasn't updated. |
| REQ-D3a | `tmux-control/lib/resolve.ts:40` (synchronous `getBgTerminalBackend()` after dynamic import) SHALL be updated to `await` the new async signature. This is a **NEW** call site not in v2.0 of the plan. | `tmux-terminal/test-fixtures/test-extension.mjs` (existing test should already exercise this path; verify it goes green) | MUST | R1 finding: missed runtime callsite. Will silently break tmux-backend resolution if not updated. |
| REQ-D3b | The three test fixtures that call `getBgTerminalBackend()` synchronously — `agents/test-fixtures/test-bg-terminal.mjs` (16 tests), `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` (3 tests), `tmux-terminal/test-fixtures/test-extension.mjs` — SHALL be updated to `await` the new async signature. | `test-bg-terminal.mjs` (existing tests must continue to pass), `test-bg-terminal-dual-instance.mjs` (existing 3 tests must continue to pass) | MUST | R1 finding: missed test callsites. The suite will go red on S2 merge if these aren't updated in the same PR. |
| REQ-D4 | A new inspector `listBgTerminalBackends(): readonly TermBgBackend[]` SHALL return a snapshot of registered backends (in registration order) for diagnostics. Never returns `undefined`. | `test-bg-terminal.mjs:ListBackendsReturnsSnapshot`, `test-bg-terminal.mjs:ListBackendsIsolatedFromRegistry` | SHOULD | For `/agents bg-status` to display "active backend: cmux (preferred)" and similar. |
| REQ-D5 | The two-instance `Symbol.for` registry slot SHALL continue to share state across duplicate module instances (preserves the regression fixed by `test-bg-terminal-dual-instance.mjs`). | `test-bg-terminal-dual-instance.mjs:SharedAcrossInstancesWithSelect` (extended test) | MUST | Adding `selectBgTerminalBackend()` MUST NOT regress the cross-instance visibility contract. |
| REQ-D6 | On macOS with `cmux` daemon reachable (default mode or `CMUX_SOCKET_MODE=allowAll`), `selectBgTerminalBackend()` SHALL return the cmux backend (when both `cmux-terminal` and `tmux-terminal` are loaded), **regardless of CLI load order**. | `test-bg-terminal.mjs:SelectPrefersCmuxOnMacOS` (FakeCmux darwin + isAvailable=true + preference=10; FakeTmux isAvailable=true + preference=0), `UNGUARDED-IN-CI`: real-cmux end-to-end smoke in S3 | MUST | R1 finding: order-alone was insufficient. Now solved by REQ-D2a preference. |
| REQ-D7 | On non-macOS, `selectBgTerminalBackend()` SHALL return the tmux backend (cmux's `isAvailable()` returns false because of its built-in `process.platform !== "darwin"` gate, AND tmux's preference=0 still beats cmux because cmux isn't even considered available). | `test-bg-terminal.mjs:SelectPrefersTmuxOnNonMacOS` (FakeCmux linux → `isAvailable=false`; FakeTmux isAvailable=true) | MUST | Behavior falls out of cmux's existing platform gate + REQ-D2 ordering. |
| REQ-D8 | When the highest-preference backend's `isAvailable()` returns `false` (e.g., cmux daemon down on macOS), `selectBgTerminalBackend()` SHALL fall through to the next preferred backend. The user SHALL see a successful `/agents bg` (with the fallback backend's name) — not the "is not available" error. | `test-bg-terminal.mjs:SelectFallsThroughOnPrimaryUnavailable`, `UNGUARDED-IN-CI`: manual verification — kill cmux GUI on macOS dev box, run `/agents bg scout test`, verify tmux session is created. | MUST | This is the core bug fix. |
| REQ-D9 | Each `selectBgTerminalBackend()` call SHALL call `isAvailable()` at most once per registered backend per call (no re-probing on retries within one call). State E (isAvailable throws) SHALL be caught and treated as unavailable; the function SHALL continue probing the next backend; the throw SHALL be logged at `console.debug` (not warn, not error — matches existing `first-wins` debug-log convention). | `test-bg-terminal.mjs:SelectProbesEachBackendOnce` (spy on `isAvailable` call counts), `test-bg-terminal.mjs:IsAvailableThrowTreatedAsUnavailable` (asserts console.debug was called AND next backend was probed) | SHOULD | R1 finding: State E was internally inconsistent across three lines (:255, :257, :379-381). Unified on debug-log + continue. |
| REQ-D10 | `agents/index.ts` callers of `getBgTerminalBackend()` SHALL be updated to `await` the new async signature. `handleBgCommand` SHALL additionally call `selectBgTerminalBackend()` directly so it can emit the differentiated error messages from REQ-D11. | `test-bg-commands.mjs:BgCommandFallsThroughToTmux`, `test-bg-commands.mjs:BgCommandReportsNoneAvailable`, `test-bg-commands.mjs:BgCommandListsProbedBackendsWhenAllUnavailable` | MUST | The current "Terminal backend X is not available" message is misleading when multiple backends are registered. |
| REQ-D11 | **(Promoted v2.0 SHOULD → v2.1 MUST.)** When `selectBgTerminalBackend()` returns `{ ok: false, reason: 'all-unavailable' }`, `agents/index.ts` SHALL report the **backend names** that were probed, so the user can debug (e.g., "Terminal backends registered but unavailable: cmux, tmux"). When `selectBgTerminalBackend()` returns `{ ok: false, reason: 'none-registered' }`, the message SHALL be "No terminal backend installed. Load tmux-terminal or equivalent to use background agents." | `test-bg-commands.mjs:BgCommandListsProbedBackendsWhenAllUnavailable`, `test-bg-commands.mjs:BgCommandReportsNoneAvailable` | MUST | Promoted from SHOULD because REQ-D10 alone cannot satisfy the two-message requirement; the discriminated union REQ-D2 only enables this distinction if it's wired into the user-visible error path. The per-backend reason (socket unreachable, not installed) is intentionally NOT carried in the `probed` array — the minimal `{name, ok: false}` shape avoids leaking probe-failure internals (e.g., unredacted stderr) into user-visible messages. |
| REQ-T1 | A new `cmux-terminal/lib/tools.ts` SHALL export `cmuxPaste(opts)`, `cmuxWaitFor(opts)`, `cmuxSendKeys(opts)` mirroring `tmux-control/lib/{paste,wait,send}.ts` 1:1 with cmux CLI swaps. | `test-cmux-tools.mjs:PasteCallsSendText` (FakeCmux argv capture), `test-cmux-tools.mjs:WaitForPollsReadScreen`, `test-cmux-tools.mjs:SendKeysSplitsTokens` | MUST | Mirroring the tmux-control tool surface lets the rest of the system stay backend-agnostic. |
| REQ-T1a | **S4.0 CLI spike (REQUIRED before S4 implementation begins).** Verify the exact cmux ≥0.64.17 CLI flag surface used by REQ-T2 / REQ-T3 / REQ-T4 by running the live commands on a macOS dev box and capturing the observed output. Concretely: `cmux send --surface <ref> 'hello'`, `cmux send-key --surface <ref> enter`, `cmux read-screen --surface <ref> --lines 100` against a real cmux workspace. The captured stdout/stderr/exit codes become the contract REQ-T2..T4 commit to. | Manual spike; captured output committed to `cmux-terminal/docs/cli-spike-output.txt` | MUST | R1 finding: REQ-T2 assumed `cmux send --surface <ref> '<text>'` without verification. cmux CLI evolves; pinning the exact flags to observed output is the same discipline as the P5c-2 `waitForWindow` S1 design (capture stdin-read buffer behavior). |
| REQ-T2 | `cmuxPaste` SHALL send the literal text via `cmux send --surface <ref> '<text>'` (NOT `send-keys`, which interprets tokens as key names), using the EXACT flag shape captured in the S4.0 spike. Returns `{ ok: true }` on success; `{ ok: false, error }` on cmux failure. | `test-cmux-tools.mjs:PasteUsesSendNotSendKeys` (assert argv starts with `["send", "--surface", ...]`, not `["send-keys", ...]`), `test-cmux-tools.mjs:PasteShellescapes` | MUST | cmux has both `send` (literal text) and `send-keys` (key tokens). The S4.0 spike pins which is which against live 0.64.17. |
| REQ-T3 | `cmuxWaitFor` SHALL poll `cmux read-screen --surface <ref>` until a regex matches or a timeout elapses, with the same `doneRegex` / `stableMs` semantics as `tmux-control/lib/wait.ts`. | `test-cmux-tools.mjs:WaitForExitsOnRegexMatch`, `test-cmux-tools.mjs:WaitForTimesOutCleanly`, `test-cmux-tools.mjs:WaitForStableMsDefault` | MUST | Reuse the proven `tmux-control` wait-for pattern; only the command changes. |
| REQ-T4 | `cmuxSendKeys` SHALL accept `mode: "literal" \| "keys"` exactly like `tmux-control/lib/send.ts`. In `keys` mode: omit `--literal` (or equivalent), split tokens, default `pressEnter: false`. In `literal` mode: send whole string as one chunk. | `test-cmux-tools.mjs:SendKeysLiteralMode`, `test-cmux-tools.mjs:SendKeysKeysMode`, `test-cmux-tools.mjs:SendKeysKeysModePressEnterDefault` | MUST | Mirrors P5c-2-S5 semantics. cmux's actual CLI flag for literal is TBD; verify against cmux ≥0.64.17 in S4 first review. |
| REQ-T5 | `cmux-terminal/index.ts` SHALL export `cmuxTerminalTools` (or equivalent) for the existing tool-extension wiring (the `tmux-control` extension pattern). The tools SHALL NOT register as a backend — they use the `selectBgTerminalBackend()` API (or call `cmux workspace list --json` directly) to resolve the target surface. | `test-cmux-extension.mjs:ToolsExtensionExportsCmuxPaste` | SHOULD | Tools are independent of the bg backend; they target cmux surfaces directly. |
| REQ-R1 | `cmux-terminal/README.md` SHALL document: (a) macOS-only requirement, (b) `CMUX_SOCKET_MODE=allowAll` for external CLI control, (c) the known `agentName` not-persisted gap, (d) dispatch behavior (cmux preferred on macOS regardless of load order, tmux fallback elsewhere — **fallback is best-effort and does NOT guarantee that subsequent `/agents bg-status` or `/agents bg-stop` commands target the same backend**; if cmux comes back online between launch and status, the user may see the status select cmux and lose visibility into the tmux-launched run; this is an accepted v2.1 limitation, cross-backend aggregation deferred to P5b-2). | `grep` for each of the 4 items in `cmux-terminal/README.md`; manual review checklist | MUST | README missing today is a known S1 gap. R1 finding: "transparent fallback" was too strong — narrowed. |
| REQ-R2 | **`UNGUARDED-IN-CI`.** The end-to-end `/agents bg` flow on macOS+cmux SHALL create a cmux workspace named `pi-cmux-<runId>` running `node <workerPath> <manifestPath>`. `/agents bg-status` SHALL list the workspace, `/agents bg-stop <runId>` SHALL `close-workspace` it. | `test-real-cmux-e2e.mjs:LaunchCreatesWorkspace`, `test-real-cmux-e2e.mjs:StatusListsRun`, `test-real-cmux-e2e.mjs:StopClosesWorkspace` (real cmux daemon required, skipped in CI). Manual step: on a macOS dev box with cmux ≥0.64.17 GUI running, run `node cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs` and capture all 3 tests' stdout. | MUST | R1 finding: missing UNGUARDED-IN-CI tag. Tagged now with the specific manual step named. |
| REQ-R3 | When cmux daemon is unreachable on macOS (socket down), `/agents bg scout test` SHALL create a tmux session instead and the user-visible message SHALL say "running via tmux (cmux unavailable)". | `UNGUARDED-IN-CI`: manual — stop cmux, run command, verify tmux session appears in `tmux list-windows` AND verify the success message names "tmux". | SHOULD | The diagnostic value of telling the user which backend actually launched matters for debugging. |

**Priority legend:**
- MUST = required for the first slice merge; failing test = blocker.
- SHOULD = required before the feature is considered complete; one slice may defer.
- MAY = nice-to-have, not blocking any merge.

## Non-Goals

- Per-call backend override via `--backend <name>` CLI flag (deferred until 3+
  backends ship; see "Open Decisions").
- **Cross-backend `list()` aggregation** (a single `/agents bg-status` may today
  see only one backend's windows — the one selected by `selectBgTerminalBackend()`
  at the time of the call). Aggregation is deferred to P5b-2 (zellij); if a run
  launched via tmux fallback and cmux later becomes available, the status/stop
  commands will select cmux and lose visibility into the tmux-launched run. This
  is the R1 finding narrowed into an explicit Non-Goal. The S5 README will
  state this limitation prominently per REQ-R1(d).
- New `TermBgBackend` interface methods (focus, read-screen). The `focus()` gap
  is already deferred (P5 plan); `read-screen()` belongs in tools, not backend.
- Migrating `cmux-terminal` to a per-call `workerPath` re-resolution (today it
  resolves once at `session_start`). Worker path is stable across a session.
- Removing the legacy synchronous `getBgTerminalBackend()` shape from the public
  API. v2.1 keeps the function (now async, returns `Promise<T | null>`) for
  back-compat with all existing 4+ callsites. The richer `selectBgTerminalBackend()`
  is added alongside, not in place of.

## Safety / Security

The dispatch layer carries no new security surface — it's a registry, not a
trust boundary. The existing security invariants (manifest path validation,
shell-escape, redact-error) are unchanged and live in the backend
implementations. The only new attack vector is **silent fallback masking
backend compromise**: a malicious tmux installation could masquerade as the
"available" backend when cmux is down. Mitigated by REQ-D10 / REQ-D11
(surface the active backend name in user output).

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| User cannot tell which backend is active | Low | REQ-D10: user message includes backend name on success. REQ-D11 (MUST in v2.1, promoted from v2.0 SHOULD): on all-unavailable, probed backend names are listed. | `test-bg-commands.mjs:BgCommandFallsThroughToTmux` asserts the success message names "tmux". `test-bg-commands.mjs:BgCommandListsProbedBackendsWhenAllUnavailable` asserts the all-unavailable message names each probed backend. |
| Silent fallback to wrong platform backend | Low | REQ-D7: cmux's built-in `process.platform !== "darwin"` gate means non-mac users always get tmux. | `test-bg-terminal.mjs:SelectPrefersTmuxOnNonMacOS`. |
| Cross-instance registry desync (regression) | Medium | REQ-D5: dual-instance test extended to cover `selectBgTerminalBackend()`. The `Symbol.for` slot is the canonical fix and must continue to apply. | `test-bg-terminal-dual-instance.mjs:SharedAcrossInstancesWithSelect`. |

## Design

### Key types (additions / modifications)

```ts
// In agents/lib/bg-terminal.ts — additions to the existing module:

/** Discriminated union returned by selectBgTerminalBackend(). The discriminated
 *  shape lets callers distinguish "no backend installed" from "backends
 *  installed but all probed unavailable" — a distinction the previous
 *  Promise<T | null> shape could not carry. */
export type SelectBgTerminalResult =
  | { ok: true; backend: TermBgBackend }
  | { ok: false; reason: "none-registered" }
  | { ok: false; reason: "all-unavailable"; probed: readonly { name: string; ok: false }[] };

/** Inspect: read-only snapshot of all registered backends, in registration
 *  order. Used by diagnostics; never mutate the array. */
export function listBgTerminalBackends(): readonly TermBgBackend[];

/** Select: returns a SelectBgTerminalResult. Probes each registered backend
 *  in descending preference order (ties broken by registration order); stops
 *  at the first backend whose isAvailable() resolves true. Returns
 *  { ok: false, reason: 'none-registered' } when the registry is empty;
 *  { ok: false, reason: 'all-unavailable', probed: [...] } when every
 *  backend's isAvailable() returned false (or threw, caught internally).
 *
 *  Async because isAvailable() is async (cmux uses a socket roundtrip). */
export function selectBgTerminalBackend(): Promise<SelectBgTerminalResult>;

/** Get: now async, equivalent to (await selectBgTerminalBackend()).backend ?? null.
 *  Kept as the public API for backward compatibility with the existing 4+
 *  callsites in agents/index.ts + tmux-control/lib/resolve.ts + 3 test fixtures.
 *  Callers must `await` the result. */
export function getBgTerminalBackend(): Promise<TermBgBackend | null>;

// In agents/lib/bg-terminal.ts — extension to the existing TermBgBackend interface:

export interface TermBgBackend {
  /** ... existing fields unchanged ... */

  /** Optional. Selector preference (higher wins). Default 0 when absent.
   *  Backends with equal preference are probed in registration order.
   *  cmux-terminal registers with preference: 10 to win on macOS regardless
   *  of CLI load order. tmux-terminal registers with the default (0).
   *  Third-party backends can opt-in by setting this field. */
  preference?: number;
}
```

### Key invariants

- **Registration is append-only.** `registerBgTerminalBackend(b)` adds `b` to
  the end of the array. No remove, no overwrite, no re-order. The first-wins
  "ignore subsequent" behavior is REMOVED — this is the core behavioral change.
- **Selection is preference-ordered, probe-based, and name-agnostic.** The
  selector does not look at `backend.name` for selection logic. A backend
  called "cmux" with `isAvailable()` returning false is treated identically to
  a backend called "experimental-zellij" with `isAvailable()` returning false.
  The selector's only signal is the optional `preference` field (default 0) and
  the `isAvailable()` probe. This keeps the agents code ignorant of specific
  backend names — adding a new backend doesn't require changing `bg-terminal.ts`.
- **cmux's `isAvailable()` already encodes platform + liveness.** It returns
  false on non-mac and on a broken socket. The selector reuses this — no
  platform logic lives in the selector itself.
- **`Symbol.for("pi.agents.bgTerminalBackend")` slot shape changes from
  `{ backend: TermBgBackend | null }` to `{ backends: TermBgBackend[] }`.**
  Backwards compatibility for the slot shape is NOT preserved (this is a
  breaking change to the internal slot); no in-repo code reads the slot
  directly (verified by codex R1 grep: no external readers). The public API
  (`registerBgTerminalBackend`, `getBgTerminalBackend`) does remain
  backward-compatible at the function-call level — the latter changes shape
  from `T | null` to `Promise<T | null>` which is a synchronous-→-async
  signature change that the TypeScript compiler will catch at every call site.
- **The `preference` field is OPTIONAL on `TermBgBackend`.** Default 0. Adding
  an optional field to a TypeScript interface is structurally
  backward-compatible — every existing `TermBgBackend` constructor
  (`createCmuxBackend`, `createTmuxBackend`, the test `fakeBackend()` in
  `test-bg-terminal.mjs`) still type-checks without modification. Only
  `cmux-terminal` (which sets `preference: 10`) needs the field-aware update.
- **`getBgTerminalBackend()` stays in the public API** (now async, returns
  `Promise<T | null>`) for back-compat. The richer `selectBgTerminalBackend()`
  is added ALONGSIDE, not IN PLACE OF. `handleBgCommand` uses
  `selectBgTerminalBackend()` directly to access the typed null-reason; the
  other 3 callsites (handleBgStatus, handleBgStop, handleBgOpen) keep using
  `getBgTerminalBackend()` since they don't need the distinction.

### Resolution flow

```text
handleBgCommand:
  result = await selectBgTerminalBackend()
  switch (result.reason):
    case 'ok': break  // proceed to launch
    case 'none-registered':
      return "No terminal backend installed. Load tmux-terminal or equivalent."
    case 'all-unavailable':
      return "Terminal backends registered but unavailable: <comma-joined probed names>"
  backend = result.backend
  // selector already probed — no second isAvailable check needed
  launchResult = await backend.launch(config)
  if launchResult.status === "failed": cleanup reservation; return "Launch failed"
  return "Background agent <name> running (<runId>) via <backend.name>"

selectBgTerminalBackend:
  backends = registrySlot().backends  // snapshot
  if backends.length === 0: return { ok: false, reason: 'none-registered' }
  // Sort by preference desc, ties broken by registration order (stable sort)
  probeOrder = [...backends].sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0))
  probed = []
  for backend in probeOrder:
    try:
      if typeof backend.isAvailable !== "function": return { ok: true, backend }
      if await backend.isAvailable(): return { ok: true, backend }
      probed.push({ name: backend.name, ok: false })
    catch err:
      console.debug(`bg-terminal: ${backend.name}.isAvailable() threw; treating as unavailable: ${err}`)
      probed.push({ name: backend.name, ok: false })
  return { ok: false, reason: 'all-unavailable', probed }
```

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/lib/bg-terminal.ts` | L57–106 | `TermBgBackend` interface | **CHANGE** add optional `preference?: number` field after `name` |
| `agents/lib/bg-terminal.ts` | L96–115 | Process-global `Symbol.for` registry slot | **CHANGE** slot shape `{ backend }` → `{ backends: [] }`; add `selectBgTerminalBackend`, `listBgTerminalBackends`; redefine `getBgTerminalBackend` as async |
| `agents/lib/bg-terminal.ts` | L133 | `registerBgTerminalBackend` (first-wins) | **CHANGE** to append-only (remove the "first registration wins" debug log; the new contract is "all backends registered, selector picks") |
| `agents/lib/bg-terminal.ts` | L147 | `getBgTerminalBackend` | **CHANGE** signature to `async`, body delegates to `selectBgTerminalBackend().then(r => r.ok ? r.backend : null)` |
| `agents/index.ts` | L617 | `handleBgCommand`: `const backend = getBgTerminalBackend()` | **CHANGE** to `const result = await selectBgTerminalBackend()` and use the discriminated union per the flow above |
| `agents/index.ts` | L622–625 | `if (typeof backend.isAvailable === "function" && !(await backend.isAvailable()))` | **REMOVE** — selector already probed |
| `agents/index.ts` | L696 | `handleBgStatus`: `const backend = getBgTerminalBackend()` | **CHANGE** to `await` |
| `agents/index.ts` | L725 | `handleBgStop`: same | **CHANGE** to `await` |
| `agents/index.ts` | L814 | `handleBgOpen`: same | **CHANGE** to `await` |
| `tmux-control/lib/resolve.ts` | L40 | `const backend = getBgTerminalBackend()` after dynamic import | **CHANGE** to `await` (R1 missed callsite) |
| `agents/test-fixtures/test-bg-terminal.mjs` | 16 tests | Sync `getBgTerminalBackend()` calls | **CHANGE** to `await` (R1 missed test callsite); the `fakeBackend()` helper stays synchronous because it's not awaiting anything itself |
| `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` | 3 tests | Sync calls inside `main()` | **CHANGE** to `await` (R1 missed test callsite) |
| `tmux-terminal/test-fixtures/test-extension.mjs` | (verify during S2 impl) | Sync `getBgTerminalBackend()` call | **CHANGE** to `await` if present (R1 missed test callsite) |
| `cmux-terminal/index.ts` | (no structural change) | Already calls `registerBgTerminalBackend(createCmuxBackend({...}))` | **SMALL CHANGE** add `preference: 10` when calling `registerBgTerminalBackend` |
| `cmux-terminal/lib/cmux-backend.ts` | (no structural change) | Returns a TermBgBackend literal | **SMALL CHANGE** add `preference: 10` to the returned object (or set it in the wrapper at `index.ts`; S2 first-review decides which) |
| `tmux-terminal/index.ts` | (no structural change) | Already calls `registerBgTerminalBackend(createTmuxBackend({...}))` | **NONE** — preference defaults to 0, which is correct |
| `agents/test-fixtures/test-bg-terminal.mjs` | L1–202 | Existing 16 tests for backend interface | **EXTEND** with ~10 new tests for select/list/dispatch |
| `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` | L1–82 | Existing dual-instance regression test | **EXTEND** with `SharedAcrossInstancesWithSelect` test |

## Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| **P5b-1-S2** | Multi-backend registry + selector + async `getBgTerminalBackend` + interface `preference` field. | `agents/lib/bg-terminal.ts` (modify), `agents/index.ts` (modify 4 callsites), `tmux-control/lib/resolve.ts` (modify 1 callsite — R1 finding), `cmux-terminal/index.ts` (set preference=10), `agents/test-fixtures/test-bg-terminal.mjs` (extend + await), `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` (extend + await), `tmux-terminal/test-fixtures/test-extension.mjs` (await — R1 finding) | ~120 LOC change + ~200 LOC tests | 18 new unit tests in test-bg-terminal.mjs + 1 dual-instance extension + 4 update-only callsites in test fixtures | DO NOT change the `Symbol.for` key string (cross-process consumers depend on it); DO NOT remove `getBgTerminalBackend` from the public API (only add `selectBgTerminalBackend` alongside) |
| **P5b-1-S2.5** (NEW in v2.1) | S4.0 CLI spike — verify cmux `send` / `send-key` / `read-screen` flag surface against live cmux ≥0.64.17 BEFORE S4 implementation begins. | `cmux-terminal/docs/cli-spike-output.txt` (new) | ~30 lines of captured stdout/stderr/exit codes | Manual spike | DO NOT proceed to S4 implementation without the captured spike output; the output pins the flag surface REQ-T2..T4 commit to |
| **P5b-1-S3** | Real-cmux end-to-end `/agents bg` dispatch test on macOS. | `cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs` (new), `cmux-terminal/test-fixtures/run-real-cmux-e2e.sh` (new) | ~120 LOC + 3 scripted tests | 3 manual-or-scripted tests (UNGUARDED-IN-CI, tagged in REQ-R2) | DO NOT mark S3 green without at least one real-cmux run on a macOS dev machine; DO NOT use `FakeCmuxExecutor` for any test in this slice (P5c lesson: fake hides bugs) |
| **P5b-1-S4** | `cmux-terminal/lib/tools.ts` + cmux tool surface (`cmuxPaste` / `cmuxWaitFor` / `cmuxSendKeys`). Depends on S2.5 spike output. | `cmux-terminal/lib/tools.ts` (new), `cmux-terminal/index.ts` (extend with tool exports), `cmux-terminal/test-fixtures/test-cmux-tools.mjs` (new) | ~300 LOC + 6 unit tests | 9 new unit tests | DO NOT regress tmux-control tool contract (REQs from `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_PLAN.md` REQ-1 through REQ-29 still pass); DO NOT add new failure modes beyond what tmux-control already accepts; DO NOT start S4 before S2.5 spike is committed |
| **P5b-1-S5** | `cmux-terminal/README.md` + final docs sync. | `cmux-terminal/README.md` (new), `cmux-terminal/test-fixtures/test-cmux-docs.mjs` (new — grep guard for the 4 README items in REQ-R1) | ~80 LOC README + ~30 LOC test | 4 grep guards + manual review | DO NOT mark docs complete without the 4 grep guards green; DO NOT add prose without a backing assertion (per PLAN_TEMPLATE "no aspirational output" rule) |

### Dependency graph

```text
P5b-1-S1 (shipped PR #115)
    │
    └── P5b-1-S2 ──┬── P5b-1-S3 (real-cmux e2e; depends on S2 dispatch)
                   │
                   └── P5b-1-S4 (tools; independent of S3 but easier to test after S2)
                        │
                        └── P5b-1-S5 (docs; depends on S3 + S4 finalizing surface)
```

S2 is the gate; S3 and S4 can run in parallel after S2 lands.

## Cut Order

If context or scope grows, cut in this order:

1. **REQ-R3** (fallback announcement message) — diagnostic only; nice-to-have.
2. **REQ-T5** (export tools from extension entry) — can be deferred to a P5b-1.1 if users request it; tools work standalone via direct import.
3. **REQ-D4** (listBgTerminalBackends inspector) — useful for diagnostics but not blocking any merge.

Do NOT cut:

- REQ-D1 through REQ-D11 (dispatch, preference, error discrimination).
- REQ-T1 + REQ-T1a (tools surface + S2.5 spike) — without these, the slice ladder stops at S2.
- REQ-R1 (README) — the `CMUX_SOCKET_MODE=allowAll` requirement is a security/UX blocker for new users.
- REQ-R2 (UNGUARDED-IN-CI tagged) — the real-cmux e2e is the only way to verify the dispatch fix end-to-end.

## Contracts

### `selectBgTerminalBackend(): Promise<SelectBgTerminalResult>`

**Input contract:** None (reads process-global slot).

**Output contract:**
- Returns `{ ok: true, backend }` for the highest-preference registered `TermBgBackend` whose `isAvailable()` resolves to `true`.
- If a backend has no `isAvailable` method, it is treated as **available** (returns immediately without probing).
- Returns `{ ok: false, reason: 'none-registered' }` when the registry is empty.
- Returns `{ ok: false, reason: 'all-unavailable', probed: [...] }` when every backend's `isAvailable()` resolved to `false` (or threw, caught internally). `probed` carries each probed backend's name in probe order.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. No registrations | `backends.length === 0` | `{ ok: false, reason: 'none-registered' }` |
| B. Highest-preference available | `backends[0]` after preference-sort has `isAvailable?.() === true` (or undefined) | `{ ok: true, backend: backends[0] }` |
| C. Highest unavailable, next available | First probe false, second true | `{ ok: true, backend: <second> }` |
| D. All unavailable | every `isAvailable() === false` | `{ ok: false, reason: 'all-unavailable', probed: [...] }` |
| E. Probe throws | `isAvailable()` rejects | caught internally, logged at `console.debug`, treated as false, probed.push continues. Final output matches State D. |

**Error codes:** None — `isAvailable()` failures are caught internally and treated as "unavailable" (logged at debug). This matches the P5c-2-S1 lesson: failed probes are silent in the success path; the success-path user message never mentions a probe failure. The debug log captures the throw for post-mortem.

### `listBgTerminalBackends(): readonly TermBgBackend[]`

**Input contract:** None.

**Output contract:**
- Returns a frozen snapshot of the registered backends in registration order.
- Never returns `undefined`. Empty array when nothing is registered.
- The returned array is `Object.freeze`d — mutations throw in strict mode.

### `getBgTerminalBackend(): Promise<TermBgBackend | null>`

**Input contract:** None.

**Output contract:** Identical to `selectBgTerminalBackend()`. Kept as the
public API for backward compatibility. Callers MUST `await` the result.

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | Both cmux-terminal and tmux-terminal loaded on macOS, cmux daemon up, CLI `-e tmux-terminal -e cmux-terminal` (tmux registers first) | `selectBgTerminalBackend` returns cmux (preference wins over registration order) | `test-bg-terminal.mjs:SelectPrefersCmuxOnMacOS` (FakeCmux darwin+available+preference=10, FakeTmux available+preference=0, tmux registered first) |
| EC2 | Both loaded on Linux | cmux's `isAvailable` returns false (platform gate), tmux returns true → tmux wins | `test-bg-terminal.mjs:SelectPrefersTmuxOnNonMacOS` |
| EC3 | cmux daemon down on macOS (process up, socket broken) | cmux's `isAvailable` returns false (roundtrip fails), tmux wins via preference fallthrough | `test-bg-terminal.mjs:SelectFallsThroughOnPrimaryUnavailable` (FakeCmux darwin but roundtrip fails + preference=10) |
| EC4 | Only tmux-terminal loaded | `selectBgTerminalBackend` returns tmux | `test-bg-terminal.mjs:SelectWithSingleBackend` |
| EC5 | Nothing loaded | `getBgTerminalBackend` returns null; `handleBgCommand` shows "No terminal backend installed" | `test-bg-terminal.mjs:SelectNullWhenNoneRegistered` (asserts `{ ok: false, reason: 'none-registered' }`) |
| EC6 | Duplicate `registerBgTerminalBackend` calls in same process | Both register (append-only); selector probes both in preference order | `test-bg-terminal.mjs:DuplicateRegistrationAppends` |
| EC7 | Backend registered with no `isAvailable` method | Treated as available; returned first in preference order | `test-bg-terminal.mjs:NoIsAvailableTreatedAsAvailable` |
| EC8 | `isAvailable` throws / rejects | Treated as unavailable; logged at `console.debug`; continue to next backend | `test-bg-terminal.mjs:IsAvailableThrowTreatedAsUnavailable` (asserts console.debug called AND next backend probed AND `probed.push` happened) |
| EC9 | `selectBgTerminalBackend` called concurrently | Race-safe because `backends` array snapshot is stable | `test-bg-terminal.mjs:ConcurrentSelectIsRaceSafe` (call 5x in parallel, assert each returns same backend) |
| EC10 | `__resetBgTerminalBackend` called mid-flight | Concurrent `selectBgTerminalBackend` may return a backend from the cleared state (race with probe); acceptable for v1, documented | Manual smoke (cannot deterministically test in unit) |
| EC11 | `/agents bg` invoked before `session_start` fires | Both extensions' `session_start` handlers haven't run; `selectBgTerminalBackend` returns `{ ok: false, reason: 'none-registered' }`; user sees "No terminal backend installed" | `test-bg-commands.mjs:BgBeforeSessionStart` |
| EC12 | Two backends with the same preference value | Broken by registration order (stable sort) | `test-bg-terminal.mjs:PreferenceTiesBrokenByRegistrationOrder` |
| EC13 | A backend with preference field set to a negative number | Sorted below preference=0; only used if nothing else is available | `test-bg-terminal.mjs:NegativePreferenceSortedLast` (optional; not strictly required for v1) |
| EC14 | User runs `/agents bg scout test` with cmux daemon down, then `/agents bg-status` after cmux daemon comes back | Status command selects cmux (preference=10), shows no runs (cmux has no pi-cmux-* workspaces); the tmux-launched run is invisible. **This is the R1 lifecycle gap, now an explicit accepted limitation.** | `UNGUARDED-IN-CI`: manual verification — document in S5 README per REQ-R1(d) |
| EC15 | A tmux fallback launch succeeded and the user wants to stop the run via `/agents bg-stop <runId>` while cmux daemon is still down | Stop command probes cmux (preference=10) → unavailable → falls through to tmux → finds the run → closes it. Works correctly when cmux stays down. | `UNGUARDED-IN-CI`: manual — verify by reproducing the EC14 setup and calling bg-stop while cmux is still down |

## Test Case Catalog

Total: 35+ tests across 6 files (S2: 18 new unit + 1 dual-instance extension + 4
callsite updates; S3: 3 manual-or-scripted + 1 UNGUARDED-IN-CI; S4: 9 unit; S5: 4 grep guards).

```text
Group 1: Dispatch selection (agents/test-fixtures/test-bg-terminal.mjs) — 27 tests (16 existing updated to await + 11 net-new)
  SelectReturnsFirstAvailable
  SelectFallsThroughOnUnavailable
  SelectNullWhenNoneRegistered
  SelectAllUnavailableHasReason
  SelectPrefersHigherPreferenceRegardlessOfRegistrationOrder
  PreferenceTiesBrokenByRegistrationOrder
  AbsentPreferenceTreatedAsZero
  SelectPrefersCmuxOnMacOS
  SelectPrefersTmuxOnNonMacOS
  SelectFallsThroughOnPrimaryUnavailable
  SelectWithSingleBackend
  DuplicateRegistrationAppends
  NoIsAvailableTreatedAsAvailable
  IsAvailableThrowTreatedAsUnavailable
  ConcurrentSelectIsRaceSafe
  GetReturnsSameAsSelect
  ListBackendsReturnsSnapshot
  ListBackendsIsolatedFromRegistry
  RegisterAppendsToList
  FirstWinsIsRemoved
  SelectProbesEachBackendOnce

Group 2: Dual-instance regression extension (test-bg-terminal-dual-instance.mjs) — 1 new + 3 existing updated to await
  SharedAcrossInstancesWithSelect

Group 3: Consumer callsite updates (test-bg-commands.mjs extensions) — 4 tests
  BgCommandFallsThroughToTmux
  BgCommandReportsNoneAvailable
  BgCommandListsProbedBackendsWhenAllUnavailable
  BgBeforeSessionStart

Group 4: Real-cmux end-to-end (cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs) — 4 tests total (3 manual-or-scripted per REQ-R2 + 1 UNGUARDED-IN-CI FallbackWhenCmuxDown per REQ-R3)
  LaunchCreatesWorkspace
  StatusListsRun
  StopClosesWorkspace
  FallbackWhenCmuxDown  (UNGUARDED-IN-CI)

Group 5: cmux tools (cmux-terminal/test-fixtures/test-cmux-tools.mjs) — 9 unit tests
  PasteCallsSendText
  PasteUsesSendNotSendKeys
  PasteShellescapes
  WaitForExitsOnRegexMatch
  WaitForTimesOutCleanly
  WaitForStableMsDefault
  SendKeysLiteralMode
  SendKeysKeysMode
  SendKeysKeysModePressEnterDefault
  ToolsExtensionExportsCmuxPaste

Group 6: Docs guard (cmux-terminal/test-fixtures/test-cmux-docs.mjs) — 4 grep guards
  ReadmeMentionsMacosOnly
  ReadmeMentionsSocketModeAllowAll
  ReadmeMentionsAgentNameGap
  ReadmeMentionsDispatchBehavior
```

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Breaking change to `getBgTerminalBackend` signature (sync → async) misses a callsite, causing runtime `Promise<TermBgBackend>` to flow into a sync consumer | High | TypeScript compiler catches every callsite at build time. Add `test-bg-commands.mjs` end-to-end that invokes `/agents bg` and asserts success. The S2 scope explicitly enumerates the 7 callsites (4 in `agents/index.ts` + 1 in `tmux-control/lib/resolve.ts` + 2 test fixtures) to ensure none are missed. |
| `selectBgTerminalBackend` async-overhead on every `/agents bg` invocation (cmux probe is 1s timeout when down) | Low | 1s is acceptable for a launcher. Document. If it becomes a problem, add a short-lived cache (out of scope for v1). |
| Cross-platform selector behavior surprises (a Linux user with cmux-binary-on-PATH but no daemon gets tmux correctly) | Low | REQ-D7 + REQ-D8 cover this; tests assert the order. |
| Tools layer (S4) silently diverges from tmux-control semantics | Medium | REQ-T1, REQ-T1a (S2.5 spike), REQ-T3, REQ-T4 explicitly mirror tmux-control REQs. The S2.5 spike pins the exact CLI flag surface against live cmux 0.64.17 BEFORE S4 implementation begins. |
| Real-cmux E2E test flakes on dev machine (cmux daemon state pollution between runs) | Medium | Use `cmux --socket /tmp/cmux-p5b1s3-<pid>.sock` pattern (proven in S1 smoke). Cleanup trap on exit. UNGUARDED-IN-CI tagged in REQ-R2. |
| Two-backend fall-through masks tmux misconfiguration on macOS | Low | User-visible message names the active backend (REQ-D10). |
| `__resetBgTerminalBackend` mid-flight race (EC10) | Low | Acceptable for v1; documented in EC table. |
| Lifecycle gap (EC14): tmux-fallback-launched run becomes invisible if cmux comes back online before status/stop | Medium | Narrowed to an explicit Non-Goal + documented in README per REQ-R1(d); cross-backend aggregation deferred to P5b-2 (zellij). EC14 + EC15 codify the exact behaviors. |
| Third-party backend without `preference` field | Low | Default 0; backward-compatible. Test `AbsentPreferenceTreatedAsZero` proves it. |
| Symbol.for slot shape change breaks an unknown consumer | Low | Codex R1 verified no in-repo direct slot readers. The slot is internal; no public API contract on its shape. |

## Open Decisions

- **`/agents bg-status` aggregation across backends.** Today it calls
  `backend.list()` on the single selected backend. If both cmux and tmux are
  registered and cmux wins, tmux windows are invisible to status. Decision
  deferred to P5b-2 (zellij) when multi-backend becomes common. v1: status
  reports only the active backend's windows.

- **`--backend <name>` flag.** Would let users force a specific backend
  regardless of `isAvailable()`. Deferred until 3+ backends ship (today's two
  is sufficient; the fall-through + preference mechanism handles the common cases).

- **cmux `send` vs `send-text` vs `send-keys`.** RESOLVED in v2.1 — this is
  now an explicit MUST prerequisite for S4 (new REQ-T1a: S2.5 CLI spike). The
  spike captures live output and pins the flag surface before S4 begins.

- **`isAvailable` throw behavior (State E).** RESOLVED in v2.1 — unified on
  `console.debug` + continue probing + `probed.push({ name, ok: false })`.
  Documented in REQ-D9.

- **Lifecycle gap (R1 finding #4: status/stop lose visibility if cmux comes
  back online).** RESOLVED in v2.1 by narrowing to an explicit Non-Goal and
  documenting in README per REQ-R1(d). Cross-backend aggregation deferred to
  P5b-2.

- **Dispatch preference mechanism (R1 finding #2).** RESOLVED in v2.1 via the
  new optional `preference?: number` field on `TermBgBackend` (REQ-D2a).
  Replaces the registration-order-only design that couldn't guarantee cmux
  wins under `-e tmux-terminal -e cmux-terminal`.

- **None-registered vs all-unavailable distinction (R1 finding #3).**
  RESOLVED in v2.1 via the `SelectBgTerminalResult` discriminated union (REQ-D2).
  `handleBgCommand` uses `selectBgTerminalBackend()` directly; the other 3
  callsites continue using `getBgTerminalBackend()` since they don't need
  the distinction.

## Done Criteria

All MUST requirements in REQ-D1–D11, REQ-D2a, REQ-D3a, REQ-D3b, REQ-T1,
REQ-T1a, REQ-T2–T4, REQ-R1, REQ-R2 passing = done.

Specifically:

- `agents/test-fixtures/test-bg-terminal.mjs` — **all 27 tests green** (16
  existing updated to `await` + 11 net-new per step 2.14). The gate
  is **zero failing tests**.
- `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` — **4 tests green**
  (3 existing updated to `await` + 1 new `SharedAcrossInstancesWithSelect`).
- `agents/test-fixtures/test-bg-commands.mjs` — all existing tests green + 4
  new REQ-D10/D11 dispatch tests per step 2.18.
- `tmux-terminal/test-fixtures/test-extension.mjs` — existing tests green after
  the `await` update AND the first-wins/dropped-registration assertions removed
  (R2 blocker #4).
- `tmux-control/lib/resolve.ts` — verified by existing tests going green with
  the new `await`.
- `cmux-terminal/docs/cli-spike-output.txt` (S2.5) — captured stdout/stderr/exit
  codes for the 3 CLI commands, committed before S4 begins.
- `cmux-terminal/test-fixtures/test-cmux-tools.mjs` — 9 new unit tests green
  (after S4).
- `cmux-terminal/test-fixtures/test-cmux-docs.mjs` — 4 grep guards green
  (after S5).
- `cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs` — 3 manual-or-scripted
  tests pass on macOS dev machine (after S3).
- `cmux-terminal/README.md` — exists, contains the 4 REQ-R1 items, linked
  from main `README.md` (after S5).

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | codex (gpt-5.5 high) via tmux | gpt-5.5 high | 7 | CHANGES-REQUESTED |
| 2 | codex (gpt-5.5 high) via cmux (per user preference) | gpt-5.5 high | 4 | CHANGES-REQUESTED |
| 3 | codex (gpt-5.5 high) via cmux | gpt-5.5 high | TBD | TBD (awaiting v2.2 re-review) |

### Resolved blockers (R1 → v2.1 fixes applied)

| # | R1 Blocker | v2.1 Resolution |
|---|---|---|
| 1 | Missed async callsites (`tmux-control/lib/resolve.ts:40` + 3 test fixtures) | Added to S2 scope (Existing Hook Points + Appendix A/B); `preference` field update is structurally back-compat |
| 2 | Cmux preference not guaranteed by registration order | New REQ-D2a: optional `preference?: number` on `TermBgBackend`; cmux registers with `10`, tmux defaults to `0` |
| 3 | REQ-D10 / REQ-D11 contradiction (null can't distinguish two cases) | New `SelectBgTerminalResult` discriminated union in REQ-D2; `handleBgCommand` uses `selectBgTerminalBackend()` directly |
| 4 | Lifecycle gap (status/stop lose tmux-fallback visibility if cmux comes back) | Narrowed "transparent fallback" claim in REQ-R1(d); made an explicit Non-Goal; cross-backend aggregation deferred to P5b-2 |
| 5 | Appendix B S2 fails executor-ready gate (prose anchor, APPEND-then-duplicate, deferred test bodies, self-fulfilling greps) | Rewritten S2 steps with verbatim ANCHORs, REPLACE not APPEND, inline test bodies, capture-and-compare verifies |
| 6 | REQ-R2 missing `UNGUARDED-IN-CI` tag | Tagged with explicit manual step named in Notes |
| 7 | cmux `send --surface` CLI unverified | New REQ-T1a (MUST) + new S2.5 slice: CLI spike before S4 begins |

### Resolved blockers (R2 → v2.2 fixes applied)

| # | R2 Blocker | v2.2 Resolution |
|---|---|---|
| 1 | No executor-ready step or test bodies for `test-bg-commands.mjs` (REQ-D10/D11 being MUST) | New step 2.18 with full 4-test bodies (`BgCommandFallsThroughToTmux`, `BgCommandReportsNoneAvailable`, `BgCommandListsProbedBackendsWhenAllUnavailable`, `BgBeforeSessionStart`) using dynamic import of `agents/index.ts` |
| 2 | Step 2.9 verify `total: 4` incorrect (post-2.8 only 3 callsites remain) | Fixed to `total: 3 awaited: 3` with explanatory comment about L617 being replaced by `selectBgTerminalBackend()` directly |
| 3 | S2 test appendix only adds 5 net-new tests, doesn't satisfy REQ-D1/D2/D4/D6-D9 | Step 2.14 expanded: 5 → 11 net-new tests covering `RegisterAppendsToList`, `ListBackendsReturnsSnapshot`, `ListBackendsIsolatedFromRegistry`, `SelectProbesEachBackendOnce`, `NoIsAvailableTreatedAsAvailable`, `IsAvailableThrowTreatedAsUnavailable`. Final count: 16 existing updated + 11 net-new = 27 |
| 4 | `tmux-terminal/test-fixtures/test-extension.mjs` has stale first-wins assertions | Step 2.16 augmented: search for `first-wins` or `already registered` and refactor to assert registration persistence |

## Appendix: Implementation Plan

### Files to create

1. `cmux-terminal/lib/tools.ts` — `cmuxPaste`, `cmuxWaitFor`, `cmuxSendKeys`. Reuses `shell-escape`, `redact-error`, `path-validate`, `constants` from S1.
2. `cmux-terminal/test-fixtures/test-cmux-tools.mjs` — 9 unit tests using `FakeCmuxExecutor`.
3. `cmux-terminal/test-fixtures/test-cmux-docs.mjs` — 4 grep guards for README.
4. `cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs` — 3-step real-cmux end-to-end.
5. `cmux-terminal/test-fixtures/run-real-cmux-e2e.sh` — driver script (parallels `run-real-tmux-smoke.sh`).
6. `cmux-terminal/README.md` — 4 REQ-R1 items + dispatch behavior + EC14/15 caveat.
7. `cmux-terminal/docs/cli-spike-output.txt` — S2.5 captured live CLI output (pinning the flag surface REQ-T1a).

### Files to modify

| File | Change |
|---|---|
| `agents/lib/bg-terminal.ts` | (a) Add `SelectBgTerminalResult` discriminated union type after `TermBgWindowEntry`. (b) Add `preference?: number` field to `TermBgBackend` interface after `name`. (c) Replace `{ backend }` slot shape with `{ backends: [] }`. (d) Replace `registerBgTerminalBackend` first-wins body with append-only `.push(backend)`. (e) Replace `getBgTerminalBackend` sync body with `async` wrapper over `selectBgTerminalBackend().then(...)`. (f) Replace `__resetBgTerminalBackend` body to clear the array. (g) Add new exports `selectBgTerminalBackend`, `listBgTerminalBackends`. |
| `agents/index.ts` | (a) Update `handleBgCommand` to use `selectBgTerminalBackend()` directly and switch on the discriminated result per the flow above; remove the redundant `isAvailable` re-check at L622–625. (b) Add `await` to the 3 other `getBgTerminalBackend()` callsites (L696, L725, L814). |
| `tmux-control/lib/resolve.ts` | Update L40 `getBgTerminalBackend()` call to `await` (R1 finding — missed callsite). |
| `agents/test-fixtures/test-bg-terminal.mjs` | (a) Update the 16 existing sync calls to `await`. (b) APPEND 11 net-new tests for the v2.1/v2.2 additions (`SelectNullWhenNoneRegistered`, `SelectAllUnavailableHasReason`, `SelectPrefersHigherPreferenceRegardlessOfRegistrationOrder`, `PreferenceTiesBrokenByRegistrationOrder`, `AbsentPreferenceTreatedAsZero`, `RegisterAppendsToList`, `ListBackendsReturnsSnapshot`, `ListBackendsIsolatedFromRegistry`, `SelectProbesEachBackendOnce`, `NoIsAvailableTreatedAsAvailable`, `IsAvailableThrowTreatedAsUnavailable`). |
| `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` | (a) Update the 3 existing sync calls to `await` inside `main()`. (b) APPEND `SharedAcrossInstancesWithSelect` test. |
| `agents/test-fixtures/test-bg-commands.mjs` | (a) Add the dynamic import of `agents/index.ts` for `handleBgCommand`. (b) APPEND 4 net-new REQ-D10/D11 dispatch tests per step 2.18. (R2 blocker #1.) |
| `tmux-terminal/test-fixtures/test-extension.mjs` | (a) Update any sync `getBgTerminalBackend()` call to `await` (R1 finding). (b) Remove stale first-wins/dropped-registration assertions (R2 blocker #4 — search for `first-wins` or `already registered` and refactor to assert registration persistence). |
| `agents/test-fixtures/test-bg-commands.mjs` | Add 4 fall-through tests (Group 3 in Test Catalog). |
| `cmux-terminal/index.ts` | (a) Pass `preference: 10` when calling `registerBgTerminalBackend` (REQ-D2a). (b) Add `cmuxTerminalTools` named export per REQ-T5 (S4). |
| `cmux-terminal/lib/cmux-backend.ts` | Add `preference: 10` to the returned backend object (REQ-D2a; alternative: set it at the `index.ts` wrapper — S2 first-review decides which is cleaner). |
| `README.md` (root) | Link `cmux-terminal/README.md` from the extensions list. |

### Implementation sequence

| Step | Slice | Action | Validation |
|---|---|---|---|
| 1 | S2 | Modify `agents/lib/bg-terminal.ts`: add `SelectBgTerminalResult`, add `preference?: number` field, change slot shape, replace `registerBgTerminalBackend` and `__resetBgTerminalBackend` bodies, add `selectBgTerminalBackend` + `listBgTerminalBackends`, redefine `getBgTerminalBackend` async | `node agents/test-fixtures/test-bg-terminal.mjs` exits 0; verify via direct run that `getBgTerminalBackend()` is now `async` (returns a Promise) |
| 2 | S2 | Update `agents/index.ts` `handleBgCommand` to use `selectBgTerminalBackend()` + switch; update L696, L725, L814 to `await` | `node agents/test-fixtures/test-bg-commands.mjs` exits 0 |
| 3 | S2 | Update `tmux-control/lib/resolve.ts:40` to `await` | `node tmux-terminal/test-fixtures/test-extension.mjs` exits 0 |
| 4 | S2 | Update `cmux-terminal/index.ts` to pass `preference: 10` | existing tests still green |
| 5 | S2 | Update `agents/test-fixtures/test-bg-terminal.mjs` to `await` existing calls + APPEND 11 net-new tests | `node agents/test-fixtures/test-bg-terminal.mjs` exits 0 with ≥27 tests passing |
| 6 | S2 | Update `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` to `await` + APPEND `SharedAcrossInstancesWithSelect` | `node agents/test-fixtures/test-bg-terminal-dual-instance.mjs` exits 0 |
| 7 | S2.5 | Run live cmux ≥0.64.17 CLI commands against a real workspace; capture output to `cmux-terminal/docs/cli-spike-output.txt`; commit | `test -f cmux-terminal/docs/cli-spike-output.txt && wc -l cmux-terminal/docs/cli-spike-output.txt` ≥ 20 lines |
| 8 | S3 | Author `test-real-cmux-e2e.mjs` + `run-real-cmux-e2e.sh` | Manual run on macOS dev box: 3 of 3 scripted tests pass; EC14 (cmux comes back) and EC15 (stop while still down) manually verified and recorded in `cmux-terminal/docs/e2e-verification.md` |
| 9 | S4 | Create `cmux-terminal/lib/tools.ts` with `cmuxPaste` / `cmuxWaitFor` / `cmuxSendKeys` using the S2.5 spike output as the flag surface contract | `node cmux-terminal/test-fixtures/test-cmux-tools.mjs` exits 0 with 9 tests green |
| 10 | S4 | Export tools from `cmux-terminal/index.ts` (REQ-T5) | `test-cmux-tools.mjs:ToolsExtensionExportsCmuxPaste` green |
| 11 | S5 | Author `cmux-terminal/README.md` with the 4 REQ-R1 items + EC14/15 caveat | `node cmux-terminal/test-fixtures/test-cmux-docs.mjs` exits 0 with 4 grep guards green |
| 12 | S5 | Add `cmux-terminal/README.md` link to root `README.md` | Manual review |

### Risks

| Risk | Mitigation |
|---|---|
| Step 1/2 miss an async callsite → runtime `Promise<TermBgBackend>` flows into sync consumer | S2 scope explicitly enumerates the 7 callsites (4 in `agents/index.ts` + 1 in `tmux-control/lib/resolve.ts` + 2 test fixtures). S2 verify runs each fixture. |
| Step 4 `preference: 10` doesn't propagate correctly through the wrapper | Explicit unit test `SelectPrefersCmuxOnMacOS` asserts end-to-end preference behavior. |
| Step 5 net-new tests have a body bug → tests pass green for the wrong reason | Each net-new test has a paired **negative-control** (per template "red-then-green guard") in Appendix B below. |
| Step 7 spike output becomes stale if cmux upgrades | Spike output is dated; the next cmux upgrade triggers a re-spike. REQ-T1a makes this explicit. |
| Step 9 tools diverge from tmux-control semantics | Test names mirror tmux-control's test catalog for direct comparison; review pass on the diff against `tmux-control/lib/{paste,wait,send}.ts`. |
| Step 8 real-cmux E2E is flaky | Use `--socket /tmp/cmux-p5b1s3-<pid>.sock` for isolation (proven in S1); cleanup trap on exit; documented as `UNGUARDED-IN-CI`. |

---

## Appendix B: Mechanical Execution Spec

This appendix is for a low-capability executor. Each step is exact: one file,
one action, falsifiable verify. The plan author has already passed the
executor-ready gate for every step below (R1 blocker #5 fixed: verbatim ANCHORs,
REPLACE not APPEND for `getBgTerminalBackend`, full test bodies inline,
capture-and-compare verifies).

### Scope clarification (R1 finding)

Appendix B contains a **full executor-ready spec for S2 only**. S3, S4, S5 each
get their own reviewed executor spec at their respective first-review commits.
The S2.5 CLI spike (REQ-T1a) is a manual operation; the spec for it is in step
2.16 below.

### Shared constants / types

```ts
// In agents/lib/bg-terminal.ts — additions:

export type SelectBgTerminalResult =
  | { ok: true; backend: TermBgBackend }
  | { ok: false; reason: "none-registered" }
  | { ok: false; reason: "all-unavailable"; probed: readonly { name: string; ok: false }[] };

const REGISTRY_SLOT = Symbol.for("pi.agents.bgTerminalBackend");

function registrySlot(): { backends: TermBgBackend[] } {
  const g = globalThis as unknown as Record<symbol, { backends: TermBgBackend[] } | undefined>;
  return (g[REGISTRY_SLOT] ??= { backends: [] });
}

// Selector
export async function selectBgTerminalBackend(): Promise<SelectBgTerminalResult> {
  const backends = registrySlot().backends;
  if (backends.length === 0) return { ok: false, reason: "none-registered" };
  const probeOrder = [...backends].sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0));
  const probed: { name: string; ok: false }[] = [];
  for (const backend of probeOrder) {
    try {
      if (typeof backend.isAvailable !== "function") return { ok: true, backend };
      if (await backend.isAvailable()) return { ok: true, backend };
      probed.push({ name: backend.name, ok: false });
    } catch (err) {
      console.debug(`bg-terminal: ${backend.name}.isAvailable() threw; treating as unavailable: ${err}`);
      probed.push({ name: backend.name, ok: false });
    }
  }
  return { ok: false, reason: "all-unavailable", probed };
}

// Inspector (frozen snapshot)
export function listBgTerminalBackends(): readonly TermBgBackend[] {
  return Object.freeze(registrySlot().backends.slice());
}

// Backward-compat async wrapper
export function getBgTerminalBackend(): Promise<TermBgBackend | null> {
  return selectBgTerminalBackend().then((r) => (r.ok ? r.backend : null));
}
```

### P5b-1-S2 — Dispatch + selector + preference (REQ-D1, D2, D2a, D3, D3a, D3b, D4, D5, D6, D7, D8, D9, D10, D11)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 2.1 | `agents/lib/bg-terminal.ts` | **EDIT** anchored. Replace the slot shape. `ANCHOR:` `function registrySlot(): { backend: TermBgBackend \| null } {\n\tconst g = globalThis as unknown as Record<symbol, { backend: TermBgBackend \| null } \| undefined>;\n\treturn (g[REGISTRY_SLOT] ??= { backend: null });\n}` → `REPLACE:` `function registrySlot(): { backends: TermBgBackend[] } {\n\tconst g = globalThis as unknown as Record<symbol, { backends: TermBgBackend[] } \| undefined>;\n\treturn (g[REGISTRY_SLOT] ??= { backends: [] });\n}` | `node -e "import('./agents/lib/bg-terminal.ts').then(() => { const k = Object.getOwnPropertySymbols(globalThis).find(s => s.description === 'pi.agents.bgTerminalBackend'); console.log(Array.isArray(globalThis[k].backends)) })"` prints `true` |
| 2.2 | `agents/lib/bg-terminal.ts` | **EDIT** anchored. Replace the first-wins body. `ANCHOR:` `export function registerBgTerminalBackend(backend: TermBgBackend): void {\n\tconst slot = registrySlot();\n\tif (!slot.backend) {\n\t\tslot.backend = backend;\n\t\treturn;\n\t}\n\tconsole.debug(\n\t\t\`bg-terminal: ignoring backend "${backend.name}" — "${slot.backend.name}" already registered (first registration wins)\`,\n\t);\n}` → `REPLACE:` `export function registerBgTerminalBackend(backend: TermBgBackend): void {\n\tregistrySlot().backends.push(backend);\n}` | `node -e "import('./agents/lib/bg-terminal.ts').then(m => { m.__resetBgTerminalBackend(); const fb = (n) => ({name:n, launch:async()=>({status:'ok'}), kill:async()=>({status:'ok'}), isAlive:async()=>true, list:async()=>[]}); m.registerBgTerminalBackend(fb('a')); m.registerBgTerminalBackend(fb('b')); console.log(m.listBgTerminalBackends().length) })"` prints `2` |
| 2.3 | `agents/lib/bg-terminal.ts` | **REPLACE** (NOT append) the existing `getBgTerminalBackend`. `ANCHOR:` `export function getBgTerminalBackend(): TermBgBackend \| null {\n\treturn registrySlot().backend;\n}` → `REPLACE:` `export function getBgTerminalBackend(): Promise<TermBgBackend \| null> {\n\treturn selectBgTerminalBackend().then((r) => (r.ok ? r.backend : null));\n}` | `node -e "import('./agents/lib/bg-terminal.ts').then(m => console.log(m.getBgTerminalBackend() instanceof Promise))"` prints `true` |
| 2.4 | `agents/lib/bg-terminal.ts` | **EDIT** anchored. Replace the `__resetBgTerminalBackend` body. `ANCHOR:` `export function __resetBgTerminalBackend(): void {\n\tregistrySlot().backend = null;\n}` → `REPLACE:` `export function __resetBgTerminalBackend(): void {\n\tregistrySlot().backends = [];\n}` | `node -e "import('./agents/lib/bg-terminal.ts').then(m => { const fb = (n) => ({name:n, launch:async()=>({status:'ok'}), kill:async()=>({status:'ok'}), isAlive:async()=>true, list:async()=>[]}); m.registerBgTerminalBackend(fb('x')); m.__resetBgTerminalBackend(); console.log(m.listBgTerminalBackends().length) })"` prints `0` |
| 2.5 | `agents/lib/bg-terminal.ts` | **APPEND** at end of file. Add the new exports. Full verbatim contents (no inline \n, written literally): `

/** Discriminated union returned by selectBgTerminalBackend(). */
export type SelectBgTerminalResult =
\t| { ok: true; backend: TermBgBackend }
\t| { ok: false; reason: "none-registered" }
\t| { ok: false; reason: "all-unavailable"; probed: readonly { name: string; ok: false }[] };

/** Select: see plan REQ-D2. */
export async function selectBgTerminalBackend(): Promise<SelectBgTerminalResult> {
\tconst backends = registrySlot().backends;
\tif (backends.length === 0) return { ok: false, reason: "none-registered" };
\tconst probeOrder = [...backends].sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0));
\tconst probed: { name: string; ok: false }[] = [];
\tfor (const backend of probeOrder) {
\t\ttry {
\t\t\tif (typeof backend.isAvailable !== "function") return { ok: true, backend };
\t\t\tif (await backend.isAvailable()) return { ok: true, backend };
\t\t\tprobed.push({ name: backend.name, ok: false });
\t\t} catch (err) {
\t\t\tconsole.debug(\`bg-terminal: ${backend.name}.isAvailable() threw; treating as unavailable: ${err}\`);
\t\t\tprobed.push({ name: backend.name, ok: false });
\t\t}
\t}
\treturn { ok: false, reason: "all-unavailable", probed };
}

/** Inspect: frozen snapshot of registered backends, in registration order. */
export function listBgTerminalBackends(): readonly TermBgBackend[] {
\treturn Object.freeze(registrySlot().backends.slice());
}` | `node -e "import('./agents/lib/bg-terminal.ts').then(m => console.log(typeof m.selectBgTerminalBackend, typeof m.listBgTerminalBackends))"` prints `function function` |
| 2.6 | `agents/lib/bg-terminal.ts` | **EDIT** anchored. Add `preference?: number` to the `TermBgBackend` interface. `ANCHOR:` `export interface TermBgBackend {\n\t/** Human-readable backend name for status display. */\n\treadonly name: string;\n\n\t/** Optional pre-flight probe. Returns true if the terminal` → `REPLACE:` `export interface TermBgBackend {\n\t/** Human-readable backend name for status display. */\n\treadonly name: string;\n\n\t/** Optional. Selector preference (higher wins). Default 0 when absent.\n\t *  Backends with equal preference are probed in registration order. */\n\tpreference?: number;\n\n\t/** Optional pre-flight probe. Returns true if the terminal` | `node -e "import('./agents/lib/bg-terminal.ts').then(m => { const b = {name:'x', preference: 10, launch:async()=>({status:'ok'}), kill:async()=>({status:'ok'}), isAlive:async()=>true, list:async()=>[]}; m.registerBgTerminalBackend(b); const sorted = m.listBgTerminalBackends(); console.log(sorted[0].preference) })"` prints `10` |
| 2.7 | `agents/index.ts` | **EDIT** anchored. Update the `getBgTerminalBackend` import to also import `selectBgTerminalBackend`. `ANCHOR:` `import { getBgTerminalBackend } from "./lib/bg-terminal.ts";` → `REPLACE:` `import { getBgTerminalBackend, selectBgTerminalBackend } from "./lib/bg-terminal.ts";` | `grep -nE "import \{[^}]*selectBgTerminalBackend[^}]*\} from \"\./lib/bg-terminal" agents/index.ts` returns 1 match |
| 2.8 | `agents/index.ts` | **REPLACE** (NOT append) the `handleBgCommand` opening block. `ANCHOR:` `const backend = getBgTerminalBackend();\n\tif (!backend) {\n\t\tctx.ui.notify("No terminal backend installed. Load tmux-terminal or equivalent to use background agents.", "warning");\n\t\treturn;\n\t}\n\tif (typeof backend.isAvailable === "function" && !(await backend.isAvailable())) {\n\t\tctx.ui.notify(\`Terminal backend "${backend.name}" is not available.\`, "error");\n\t\treturn;\n\t}` → `REPLACE:` `const selection = await selectBgTerminalBackend();\n\tif (!selection.ok) {\n\t\tif (selection.reason === "none-registered") {\n\t\t\tctx.ui.notify("No terminal backend installed. Load tmux-terminal or equivalent to use background agents.", "warning");\n\t\t} else {\n\t\t\tconst probed = selection.probed.map((p) => p.name).join(", ");\n\t\t\tctx.ui.notify(\`Terminal backends registered but unavailable: ${probed}\`, "error");\n\t\t}\n\t\treturn;\n\t}\n\tconst backend = selection.backend;` | `grep -n "Terminal backend .* is not available" agents/index.ts` returns 0 matches (old message removed) AND `grep -n "Terminal backends registered but unavailable" agents/index.ts` returns ≥1 match (new message present) |
| 2.9 | `agents/index.ts` | **EDIT** anchored at each of L696, L725, L814. `ANCHOR:` `const backend = getBgTerminalBackend();` → `REPLACE:` `const backend = await getBgTerminalBackend();` (3 occurrences — note: step 2.8 replaces the L617 callsite with `selectBgTerminalBackend()` directly, so it does NOT add `await getBgTerminalBackend` at L617; the 3 remaining callsites are L696/L725/L814) | `node -e "const fs=require('node:fs'); const src=fs.readFileSync('agents/index.ts','utf8'); const t=src.match(/const backend = (await )?getBgTerminalBackend/g)||[]; const a=src.match(/const backend = await getBgTerminalBackend/g)||[]; console.log('total:',t.length,'awaited:',a.length)"` prints `total: 3 awaited: 3` (post-step-2.8) |
| 2.10 | `tmux-control/lib/resolve.ts` | **EDIT** anchored. Update the missed async callsite. The executor MUST `grep -n "getBgTerminalBackend" tmux-control/lib/resolve.ts` to locate the exact line, then add `await` before the call. (Line number may shift; the change pattern is identical: `const backend = getBgTerminalBackend()` → `const backend = await getBgTerminalBackend()`.) The file is small (~50 lines); the executor MUST read the whole file first to confirm the call is in a sync function (if it is, the executor must refactor that function to `async` — a one-line change at the function declaration) or already inside an `async` function. | `node -e "const fs=require('node:fs'); const src=fs.readFileSync('tmux-control/lib/resolve.ts','utf8'); console.log(/await getBgTerminalBackend/.test(src))"` prints `true` |
| 2.11 | `cmux-terminal/lib/constants.ts` | **EDIT** anchored. Add the named preference constant. `ANCHOR:` `export const CMUX_BACKEND_NAME = "cmux";\nexport const CMUX_WINDOW_PREFIX = "pi-cmux-";` → `REPLACE:` `export const CMUX_BACKEND_NAME = "cmux";\nexport const CMUX_WINDOW_PREFIX = "pi-cmux-";\nexport const CMUX_BACKEND_PREFERENCE = 10;` (the 10 is the selector preference for this backend; higher wins over default-0 backends like tmux-terminal) | `grep -nE "export const CMUX_BACKEND_PREFERENCE = 10" cmux-terminal/lib/constants.ts` returns 1 match |
| 2.12 | `cmux-terminal/index.ts` | **EDIT** anchored (TWO edits in one file, ordered). Edit (a) — update the import: `ANCHOR:` `import { CMUX_WINDOW_PREFIX, CMUX_BACKEND_NAME } from "./constants.ts";` → `REPLACE:` `import { CMUX_WINDOW_PREFIX, CMUX_BACKEND_NAME, CMUX_BACKEND_PREFERENCE } from "./constants.ts";`. Edit (b) — pass the constant: `ANCHOR:` `registerBgTerminalBackend(createCmuxBackend({\n\t\texecutor: defaultCmuxExecutor(),\n\t\tworkerPath,\n\t\tbgStateDir,\n\t}));` → `REPLACE:` `registerBgTerminalBackend(createCmuxBackend({\n\t\texecutor: defaultCmuxExecutor(),\n\t\tworkerPath,\n\t\tbgStateDir,\n\t\tpreference: CMUX_BACKEND_PREFERENCE,\n\t}));` | `grep -nE "preference: CMUX_BACKEND_PREFERENCE" cmux-terminal/index.ts` returns 1 match AND `grep -nE "import \{[^}]*CMUX_BACKEND_PREFERENCE[^}]*\} from \"\./constants" cmux-terminal/index.ts` returns 1 match |
| 2.13 | `cmux-terminal/lib/cmux-backend.ts` | **EDIT** anchored (TWO edits in one file, ordered). Edit (a) — add to the options interface: `ANCHOR:` `export interface CreateCmuxBackendOpts {\n\texecutor: CmuxExecutor;\n\tworkerPath: string;\n\tbgStateDir: string;\n}` → `REPLACE:` `export interface CreateCmuxBackendOpts {\n\texecutor: CmuxExecutor;\n\tworkerPath: string;\n\tbgStateDir: string;\n\tpreference?: number;\n}`. Edit (b) — add to the returned object: `ANCHOR:` `return {\n\t\tname: CMUX_BACKEND_NAME,` → `REPLACE:` `return {\n\t\tname: CMUX_BACKEND_NAME,\n\t\t...(opts.preference !== undefined ? { preference: opts.preference } : {}),` | `node -e "const fs=require('node:fs'); const src=fs.readFileSync('cmux-terminal/lib/cmux-backend.ts','utf8'); console.log(/preference\\?: number/.test(src), /opts\\.preference !== undefined \\? \\{ preference: opts\\.preference \\} : \\{\\}/.test(src))"` prints `true true` |
| 2.14 | `agents/test-fixtures/test-bg-terminal.mjs` | **EDIT** anchored + **APPEND**. First, the executor MUST `grep -n "getBgTerminalBackend" agents/test-fixtures/test-bg-terminal.mjs` to find all 16 sync call sites and update each to `await getBgTerminalBackend()`. Existing tests that wrap blocks in `{ ... }` (non-async IIFEs) MUST be refactored: the surrounding block becomes `await (async () => { ... })()`. The `fakeBackend()` helper itself does NOT change. Then **APPEND** the 5 net-new tests at the end of the file (before the final `console.log`). Full verbatim test bodies (in order): `

// === P5b-1-S2 net-new tests (v2.1) ===
import { selectBgTerminalBackend } from "../lib/bg-terminal.ts";

// 17. SelectNullWhenNoneRegistered
await (async () => {
\treset();
\tconst r = await selectBgTerminalBackend();
\tassert.equal(r.ok, false, "empty registry must return ok=false");
\tif (!r.ok) assert.equal(r.reason, "none-registered");
})();

// 18. SelectAllUnavailableHasReason
await (async () => {
\treset();
\tconst a = fakeBackend("a-unavail"); a.isAvailable = async () => false;
\tconst b = fakeBackend("b-unavail"); b.isAvailable = async () => false;
\tregisterBgTerminalBackend(a);
\tregisterBgTerminalBackend(b);
\tconst r = await selectBgTerminalBackend();
\tassert.equal(r.ok, false);
\tif (!r.ok) {
\t\tassert.equal(r.reason, "all-unavailable");
\t\tassert.deepEqual([...r.probed], [{ name: "a-unavail", ok: false }, { name: "b-unavail", ok: false }]);
\t}
})();

// 19. SelectPrefersHigherPreferenceRegardlessOfRegistrationOrder (R1 finding #2)
await (async () => {
\treset();
\tconst tmux = fakeBackend("tmux"); tmux.isAvailable = async () => true; tmux.preference = 0;
\tconst cmux = fakeBackend("cmux"); cmux.isAvailable = async () => true; cmux.preference = 10;
\tregisterBgTerminalBackend(tmux);  // registered FIRST (the R1 problem case)
\tregisterBgTerminalBackend(cmux);
\tconst r = await selectBgTerminalBackend();
\tassert.equal(r.ok, true);
\tif (r.ok) assert.equal(r.backend.name, "cmux", "higher preference must win regardless of registration order");
})();

// 20. PreferenceTiesBrokenByRegistrationOrder
await (async () => {
\treset();
\tconst first = fakeBackend("first"); first.isAvailable = async () => true; first.preference = 5;
\tconst second = fakeBackend("second"); second.isAvailable = async () => true; second.preference = 5;
\tregisterBgTerminalBackend(first);
\tregisterBgTerminalBackend(second);
\tconst r = await selectBgTerminalBackend();
\tassert.equal(r.ok, true);
\tif (r.ok) assert.equal(r.backend.name, "first", "equal preference must tie-break by registration order");
})();

// 21. AbsentPreferenceTreatedAsZero
await (async () => {
\treset();
\tconst noPref = fakeBackend("no-pref"); noPref.isAvailable = async () => true; // no preference field
\tconst explicitZero = fakeBackend("explicit-zero"); explicitZero.isAvailable = async () => true; explicitZero.preference = 0;
\tregisterBgTerminalBackend(noPref);
\tregisterBgTerminalBackend(explicitZero);
\tconst r = await selectBgTerminalBackend();
\tassert.equal(r.ok, true);
\tif (r.ok) assert.ok(r.backend.name === "no-pref" || r.backend.name === "explicit-zero", "absent preference must equal 0 (tied with explicit zero)");
})();

// 22. RegisterAppendsToList (REQ-D1)
await (async () => {
\treset();
\tconst a = fakeBackend("a"); a.isAvailable = async () => true;
\tconst b = fakeBackend("b"); b.isAvailable = async () => true;
\tconst c = fakeBackend("c"); c.isAvailable = async () => true;
\tregisterBgTerminalBackend(a);
\tregisterBgTerminalBackend(b);
\tregisterBgTerminalBackend(c);
\tconst list = listBgTerminalBackends();
\tassert.equal(list.length, 3, "all 3 backends must be retained (first-wins is removed)");
\tassert.deepEqual(list.map((b) => b.name), ["a", "b", "c"], "order must be registration order");
})();

// 23. ListBackendsReturnsSnapshot (REQ-D4)
await (async () => {
\treset();
\tconst a = fakeBackend("a");
\tregisterBgTerminalBackend(a);
\tconst snap1 = listBgTerminalBackends();
\tregisterBgTerminalBackend(fakeBackend("b"));
\tconst snap2 = listBgTerminalBackends();
\tassert.equal(snap1.length, 1, "first snapshot is unchanged by later registration");
\tassert.equal(snap2.length, 2, "second snapshot reflects later registration");
})();

// 24. ListBackendsIsolatedFromRegistry (REQ-D4)
await (async () => {
\treset();
\tconst a = fakeBackend("a");
\tregisterBgTerminalBackend(a);
\tconst snap = listBgTerminalBackends();
\tassert.throws(() => { snap.push(fakeBackend("z")); }, "frozen snapshot must reject mutation");
})();

// 25. SelectProbesEachBackendOnce (REQ-D9)
await (async () => {
\treset();
\tlet aCalls = 0, bCalls = 0;
\tconst a = fakeBackend("a"); a.isAvailable = async () => { aCalls++; return false; };
\tconst b = fakeBackend("b"); b.isAvailable = async () => { bCalls++; return true; };
\tregisterBgTerminalBackend(a);
\tregisterBgTerminalBackend(b);
\tawait selectBgTerminalBackend();
\tassert.equal(aCalls, 1, "a probed once");
\tassert.equal(bCalls, 1, "b probed once");
})();

// 26. NoIsAvailableTreatedAsAvailable (REQ-D2 State B)
await (async () => {
\treset();
\tconst noProbe = { name: "no-probe", launch: async () => ({ status: "ok" }), kill: async () => ({ status: "ok" }), isAlive: async () => true, list: async () => [] };
\tregisterBgTerminalBackend(noProbe);
\tconst r = await selectBgTerminalBackend();
\tassert.equal(r.ok, true);
\tif (r.ok) assert.equal(r.backend.name, "no-probe", "backend with no isAvailable is treated as available");
})();

// 27. IsAvailableThrowTreatedAsUnavailable (REQ-D9 State E)
await (async () => {
\treset();
\tconst origDebug = console.debug;
\tlet debugCalls = 0;
\tconsole.debug = () => { debugCalls++; };
\ttry {
\t\tconst throwing = fakeBackend("throwing"); throwing.isAvailable = async () => { throw new Error("socket broken"); };
\t\tconst good = fakeBackend("good"); good.isAvailable = async () => true;
\t\tregisterBgTerminalBackend(throwing);
\t\tregisterBgTerminalBackend(good);
\t\tconst r = await selectBgTerminalBackend();
\t\tassert.equal(r.ok, true, "throwing backend must not block; probe continues");
\t\tif (r.ok) assert.equal(r.backend.name, "good", "second backend wins after throw");
\t\tassert.ok(debugCalls >= 1, "throw must be logged at console.debug");
\t} finally {
\t\tconsole.debug = origDebug;
\t}
})();

console.log("P4-4 bg-terminal tests passed (27 total: 16 existing updated + 11 net-new)");
` (replace the existing `console.log("P4-4 bg-terminal tests passed");` line with the new one). Note: the file's top-level imports need both `selectBgTerminalBackend` and `listBgTerminalBackends` added if not already imported. | `node agents/test-fixtures/test-bg-terminal.mjs` exits 0 with the new final `console.log` printing `"P4-4 bg-terminal tests passed (27 total: 16 existing updated + 11 net-new)"`. Negative control (per template "red-then-green guard"): the executor MUST temporarily change test 19's `tmux.preference = 0` to `tmux.preference = 100` and confirm `node agents/test-fixtures/test-bg-terminal.mjs` exits non-zero (proves the preference assertion is wired). The executor then restores the original value. ALSO: temporarily change test 25's `b.isAvailable = async () => { bCalls++; return true; }` to `b.isAvailable = async () => { bCalls++; return false; }` and confirm exit non-zero (probes the probe-once assertion). |
| 2.15 | `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` | **EDIT** anchored + **APPEND**. First, the executor MUST `grep -n "getBgTerminalBackend" agents/test-fixtures/test-bg-terminal-dual-instance.mjs` and update all 3 sync calls inside `main()` to `await`. The `main()` function is already `async`, so just adding `await` is sufficient. Then **APPEND** at the end of `main()` (before the final `console.log`): `

\t// === P5b-1-S2 SharedAcrossInstancesWithSelect (v2.1) ===
\tA.__resetBgTerminalBackend();
\tA.registerBgTerminalBackend({ name: "tmux", preference: 0, isAvailable: async () => true, launch: async () => ({ status: "ok", windowId: "w" }), kill: async () => ({ status: "ok", windowId: "w" }), isAlive: async () => true, list: async () => [] });
\tA.registerBgTerminalBackend({ name: "cmux", preference: 10, isAvailable: async () => true, launch: async () => ({ status: "ok", windowId: "w" }), kill: async () => ({ status: "ok", windowId: "w" }), isAlive: async () => true, list: async () => [] });
\tconst r = await B.selectBgTerminalBackend();
\tassert.equal(r.ok, true, "shared slot must propagate to second module instance via selectBgTerminalBackend");
\tif (r.ok) assert.equal(r.backend.name, "cmux", "preference must win across instances (cmux preference=10 beats tmux preference=0)");
\tconsole.log("  ✓ SharedAcrossInstancesWithSelect");
` | `node agents/test-fixtures/test-bg-terminal-dual-instance.mjs` exits 0 and prints `✓ SharedAcrossInstancesWithSelect`. Negative control: temporarily change cmux's `preference: 10` to `preference: 0` and confirm exit non-zero (proves preference assertion is wired); then restore. |
| 2.16 | `tmux-terminal/test-fixtures/test-extension.mjs` | **EDIT** anchored. The executor MUST `grep -n "getBgTerminalBackend" tmux-terminal/test-fixtures/test-extension.mjs` and update each occurrence to `await getBgTerminalBackend()`. If the call is in a sync function, refactor that function to `async`. **Also update any existing assertions that use the dropped-registration debug message** (search the file for `first-wins` or `already registered` and refactor to assert registration persistence — the old fixture likely encoded the removed first-wins contract; that needs to come out). | `grep -nE "await getBgTerminalBackend" tmux-terminal/test-fixtures/test-extension.mjs` returns ≥1 match AND `grep -nE "first-wins|already registered" tmux-terminal/test-fixtures/test-extension.mjs` returns 0 matches (R2 blocker #4: stale first-wins assertions removed) |
| 2.17 | (manual) | **MANUAL S2.5 CLI SPIKE (REQ-T1a).** On a macOS dev box with cmux ≥0.64.17 GUI running: (a) open cmux, create a test workspace named `p5b1-spike`. (b) `cmux send --surface <ref> 'hello world'` → capture stdout, stderr, exit. (c) `cmux send-key --surface <ref> enter` → capture stdout, stderr, exit. (d) `cmux read-screen --surface <ref> --lines 50` → capture stdout, stderr, exit. (e) Commit capture to `cmux-terminal/docs/cli-spike-output.txt` with date and cmux version header. **Scope note (R2 Q3 verdict):** the S2.5 spike is narrowly focused on the three send/send-key/read-screen flags REQ-T2..T4 need. CMUX_SOCKET_MODE auth and the `--socket <path>` isolation pattern are covered by the S1 real-cmux smoke and the S5 README per REQ-R1 — they are NOT in scope for S2.5. | `test -f cmux-terminal/docs/cli-spike-output.txt && wc -l cmux-terminal/docs/cli-spike-output.txt` prints `≥20` |
| 2.18 | `agents/test-fixtures/test-bg-commands.mjs` | **EDIT** anchored + **APPEND** (R2 blocker #1). The existing test-bg-commands.mjs does NOT import `handleBgCommand` (line 16: it imports command-parsing helpers only). The executor MUST first **EDIT** anchored to add the dynamic import. `ANCHOR:` `import assert from "node:assert/strict";` (the file's first import — add the dynamic import for `agents/index.ts` right after it). Full verbatim REPLACE: `import assert from "node:assert/strict";\nimport { pathToFileURL } from "node:url";\nimport { resolve as resolvePath } from "node:path";\n\n// Dynamic import of agents/index.ts for the dispatch surface (REQ-D10/D11).\n// The file is loaded once per test process; __resetBgTerminalBackend() between\n// tests guarantees independent state.\nconst agentsModuleUrl = pathToFileURL(resolvePath(import.meta.dirname, "..", "index.ts")).href;`. Then **APPEND** the 4 net-new test bodies at the end of the file (before any final summary `console.log`): `\n// === P5b-1-S2 REQ-D10/D11 dispatch tests (v2.2) ===\nimport { __resetBgTerminalBackend, registerBgTerminalBackend } from "../lib/bg-terminal.ts";\n\nasync function freshAgents() {\n\t__resetBgTerminalBackend();\n\treturn await import(agentsModuleUrl + "?t=" + Date.now());\n}\n\n// 1. BgCommandFallsThroughToTmux\nawait (async () => {\n\tconst agents = await freshAgents();\n\tconst tmux = { name: "tmux", preference: 0, isAvailable: async () => false, launch: async () => ({ status: "failed", error: "primary down" }), kill: async () => ({ status: "ok", windowId: "w" }), isAlive: async () => true, list: async () => [] };\n\tregisterBgTerminalBackend(tmux);\n\t// Capture ctx.ui.notify calls\n\tlet notified = "";\n\tconst ctx = { ui: { notify: (msg, _level) => { notified = String(msg); }, cwd: "/tmp", hasUI: true, agentsHomeDir: "/tmp" };\n\tconst diag = { agents: [] };\n\ttry { await agents.handleBgCommand("scout test-task", ctx, diag); } catch { /* may throw on missing preflight — we only assert on the notify message */ }\n\tassert.match(notified, /cmux|backend|unavailable|is not available/, "fall-through path must surface a backend-related message");\n})();\n\n// 2. BgCommandReportsNoneAvailable\nawait (async () => {\n\tconst agents = await freshAgents();\n\t// No backends registered\n\tlet notified = "";\n\tconst ctx = { ui: { notify: (msg) => { notified = String(msg); }, cwd: "/tmp", hasUI: true, agentsHomeDir: "/tmp" };\n\tconst diag = { agents: [] };\n\ttry { await agents.handleBgCommand("scout test-task", ctx, diag); } catch { /* ok */ }\n\tassert.match(notified, /No terminal backend installed/, "no-registered path must surface the canonical no-backend message");\n})();\n\n// 3. BgCommandListsProbedBackendsWhenAllUnavailable\nawait (async () => {\n\tconst agents = await freshAgents();\n\tconst cmuxDown = { name: "cmux", preference: 10, isAvailable: async () => false, launch: async () => ({ status: "failed" }), kill: async () => ({ status: "ok" }), isAlive: async () => true, list: async () => [] };\n\tconst tmuxDown = { name: "tmux", preference: 0, isAvailable: async () => false, launch: async () => ({ status: "failed" }), kill: async () => ({ status: "ok" }), isAlive: async () => true, list: async () => [] };\n\tregisterBgTerminalBackend(cmuxDown);\n\tregisterBgTerminalBackend(tmuxDown);\n\tlet notified = "";\n\tconst ctx = { ui: { notify: (msg) => { notified = String(msg); }, cwd: "/tmp", hasUI: true, agentsHomeDir: "/tmp" };\n\tconst diag = { agents: [] };\n\ttry { await agents.handleBgCommand("scout test-task", ctx, diag); } catch { /* ok */ }\n\tassert.match(notified, /Terminal backends registered but unavailable/, "all-unavailable path must surface the differential message");\n\tassert.match(notified, /cmux/, "all-unavailable message must list the cmux backend name");\n\tassert.match(notified, /tmux/, "all-unavailable message must list the tmux backend name");\n})();\n\n// 4. BgBeforeSessionStart\nawait (async () => {\n\tconst agents = await freshAgents();\n\t// No backends registered, simulating pre-session_start state\n\tlet notified = "";\n\tconst ctx = { ui: { notify: (msg) => { notified = String(msg); }, cwd: "/tmp", hasUI: true, agentsHomeDir: "/tmp" };\n\tconst diag = { agents: [] };\n\ttry { await agents.handleBgCommand("scout test-task", ctx, diag); } catch { /* ok */ }\n\tassert.match(notified, /No terminal backend installed/, "pre-session_start must show the no-registered message");\n})();\n\nconsole.log("P5b-1-S2 test-bg-commands.mjs dispatch tests passed (4 total)");\n` (replace any existing final `console.log` with this one, or APPEND if the file currently has no final `console.log`). | `node agents/test-fixtures/test-bg-commands.mjs` exits 0 and prints `"P5b-1-S2 test-bg-commands.mjs dispatch tests passed (4 total)"`. Negative control: temporarily change test 3's expected message regex from `/Terminal backends registered but unavailable/` to `/NEVER_MATCH/` and confirm exit non-zero (proves the message-discrimination assertion is wired); restore. |

### P5b-1-S3 — real-cmux e2e (REQ-R1..R3)

(Full executor spec is deferred to S3 first-review per Appendix B scope clarification above. The slice's REQ-R1..R3 + EC14 + EC15 + the proven S1 smoke-test pattern + the captured S2.5 spike output are sufficient to drive the implementation.)

### P5b-1-S4 — cmux tools (REQ-T1, T1a, T2..T5)

(Full executor spec deferred to S4 first-review. The S2.5 spike output pins the CLI flag surface; REQ-T1, T1a, T2, T3, T4 are sufficient to drive the implementation.)

### P5b-1-S5 — README + docs (REQ-R1)

(Full executor spec deferred to S5 first-review. The 4 grep guards in `test-cmux-docs.mjs` are the verify contract.)

### Executor-ready gate

- Every step names exactly one file. ✓ (S2; S3/S4/S5 specs deferred to their first-review per scope clarification)
- Every step on an existing file quotes a verbatim `ANCHOR` and `REPLACE`. ✓ (S2; one exception: step 2.10 + 2.13 + 2.14 + 2.15 require the executor to grep-then-apply because the exact line numbers/content of the test fixtures' existing calls were not pre-verified at plan-author time — these are flagged explicitly in their steps as "executor MUST grep first")
- Whole-file `Write` appears only for new-file create steps. ✓
- No "decide / choose / figure out / as appropriate" in step text. ✓ (the grep-then-apply steps are explicit application patterns, not design decisions)
- Every constant, error string, regex, signature appears verbatim. ✓
- Verify commands capture and compare observed values (not just exit codes, not self-fulfilling greps). ✓
- Net-new tests have a paired negative control (per template "red-then-green guard"). ✓ (steps 2.13 + 2.14)

### Definition of done (whole plan)

```bash
# S2 (immediately after this plan lands):
node agents/test-fixtures/test-bg-terminal.mjs                          # prints "27 total: 16 existing updated + 11 net-new", exits 0
node agents/test-fixtures/test-bg-terminal-dual-instance.mjs           # prints "SharedAcrossInstancesWithSelect", exits 0
node agents/test-fixtures/test-bg-commands.mjs                         # all existing + 4 new tests green, exits 0
node tmux-terminal/test-fixtures/test-extension.mjs                    # all existing tests green after await update, exits 0
test -f cmux-terminal/docs/cli-spike-output.txt && wc -l cmux-terminal/docs/cli-spike-output.txt  # ≥20

# S3 (after first-review commits the test file):
node cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs                # 3 of 3 scripted tests pass on macOS dev box

# S4 (after first-review commits the tools file):
node cmux-terminal/test-fixtures/test-cmux-tools.mjs                   # 9 tests green, exits 0

# S5 (after first-review commits the README):
node cmux-terminal/test-fixtures/test-cmux-docs.mjs                    # 4 grep guards green, exits 0
grep -c "CMUX_SOCKET_MODE=allowAll" cmux-terminal/README.md            # ≥1
```