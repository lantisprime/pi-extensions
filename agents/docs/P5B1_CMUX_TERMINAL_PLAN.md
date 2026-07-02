# P5b-1 cmux-terminal Plan — Phase 2 (Dispatch + Tools)

> **Status:** DRAFT v2. Supersedes the v1 plan (`feat/cmux-control-and-p5b-cmux-terminal`
> branch, 206 lines, never reviewed). v1 covered only the cmux-backend factory
> + helpers + extension entry; v1's slices 1–5 were **all bundled and shipped in
> PR #115** (commit `fb55d57`, 13 files / +1234 LOC).
>
> **This v2 plan covers the REMAINING work to make cmux-terminal a first-class
> citizen of `/agents bg` on macOS.** It is the work the v1 handoff episodes
> (`20260628-115014-...`, `20260628-115957-...`, `20260701-143307-...`) refer to
> as "P5b-1-S2 through S5."

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
| REQ-D2 | A new selector `selectBgTerminalBackend(): Promise<TermBgBackend \| null>` SHALL return the first registered backend whose `isAvailable()` returns `true`, calling `isAvailable()` on each in registration order. Returns `null` when no backend is available. | `test-bg-terminal.mjs:SelectReturnsFirstAvailable`, `test-bg-terminal.mjs:SelectFallsThroughOnUnavailable`, `test-bg-terminal.mjs:SelectNullWhenNoneAvailable` | MUST | Async because `isAvailable()` is async (`cmux workspace list --json` socket roundtrip). |
| REQ-D3 | `getBgTerminalBackend(): Promise<TermBgBackend \| null>` SHALL be redefined as `async`, returning the same value as `selectBgTerminalBackend()`. All existing callers SHALL be updated to `await` it. | `test-bg-terminal.mjs:GetReturnsSameAsSelect` | MUST | Signature change is consumer-visible but type-checked; the compiler will flag every call site. |
| REQ-D4 | A new inspector `listBgTerminalBackends(): readonly TermBgBackend[]` SHALL return a snapshot of registered backends (in registration order) for diagnostics. Never returns `undefined`. | `test-bg-terminal.mjs:ListBackendsReturnsSnapshot`, `test-bg-terminal.mjs:ListBackendsIsolatedFromRegistry` | SHOULD | For `/agents bg-status` to display "active backend: cmux (preferred)" and similar. |
| REQ-D5 | The two-instance `Symbol.for` registry slot SHALL continue to share state across duplicate module instances (preserves the regression fixed by `test-bg-terminal-dual-instance.mjs`). | `test-bg-terminal-dual-instance.mjs:SharedAcrossInstancesWithSelect` (extended test) | MUST | Adding `selectBgTerminalBackend()` MUST NOT regress the cross-instance visibility contract. |
| REQ-D6 | On macOS with `cmux` daemon reachable (default mode or `CMUX_SOCKET_MODE=allowAll`), `selectBgTerminalBackend()` SHALL return the cmux backend (when both `cmux-terminal` and `tmux-terminal` are loaded and cmux registered first). | `test-bg-terminal.mjs:SelectPrefersCmuxOnMacOS` (FakeCmux with `process.platform=darwin` + `isAvailable=true`), `UNGUARDED-IN-CI`: real-cmux end-to-end smoke in S3 | MUST | In CI we mock `process.platform` via stub. Real-mac verification is S3 (real-cmux smoke). |
| REQ-D7 | On non-macOS, `selectBgTerminalBackend()` SHALL return the tmux backend (cmux's `isAvailable()` returns false because of its built-in `process.platform !== "darwin"` gate). | `test-bg-terminal.mjs:SelectPrefersTmuxOnNonMacOS` (FakeCmux with `process.platform=linux` → `isAvailable=false`; FakeTmux with `isAvailable=true`) | MUST | Behavior falls out of cmux's existing platform gate + REQ-D2 ordering. |
| REQ-D8 | When the first-registered backend's `isAvailable()` returns `false` (e.g., cmux daemon down on macOS), `selectBgTerminalBackend()` SHALL fall through to the next registered backend. The user SHALL see a successful `/agents bg` (with the fallback backend's name) — not the "is not available" error. | `test-bg-terminal.mjs:SelectFallsThroughOnPrimaryUnavailable`, `UNGUARDED-IN-CI`: manual verification: kill cmux GUI on macOS dev box, run `/agents bg scout test`, verify tmux session is created and a `tmux list-windows` shows it. | MUST | This is the core bug fix. |
| REQ-D9 | Each `selectBgTerminalBackend()` call SHALL call `isAvailable()` at most once per registered backend per call (no re-probing on retries within one call). | `test-bg-terminal.mjs:SelectProbesEachBackendOnce` (spy on `isAvailable` call counts) | SHOULD | Defensive against future implementations that retry internally. |
| REQ-D10 | `agents/index.ts` callers of `getBgTerminalBackend()` SHALL be updated to `await` the new async signature. The user-facing error messages SHALL distinguish: (a) no backend installed, (b) backend installed but all `isAvailable()` returned false. | `test-bg-commands.mjs:BgCommandFallsThroughToTmux`, `test-bg-commands.mjs:BgCommandReportsNoneAvailable` | MUST | The current "Terminal backend X is not available" message is misleading when multiple backends are registered. |
| REQ-D11 | When `selectBgTerminalBackend()` returns null because all backends reported unavailable, `agents/index.ts` SHALL report the **backend names** that were probed, so the user can debug (e.g., "Terminal backends registered but unavailable: cmux (socket unreachable), tmux (not installed)"). | `test-bg-commands.mjs:BgCommandListsProbedBackendsWhenAllUnavailable` | SHOULD | Diagnostic only; current message is acceptable for v1. |
| REQ-T1 | A new `cmux-terminal/lib/tools.ts` SHALL export `cmuxPaste(opts)`, `cmuxWaitFor(opts)`, `cmuxSendKeys(opts)` mirroring `tmux-control/lib/{paste,wait,send}.ts` 1:1 with cmux CLI swaps. | `test-cmux-tools.mjs:PasteCallsSendText` (FakeCmux argv capture), `test-cmux-tools.mjs:WaitForPollsReadScreen`, `test-cmux-tools.mjs:SendKeysSplitsTokens` | MUST | Mirroring the tmux-control tool surface lets the rest of the system stay backend-agnostic. |
| REQ-T2 | `cmuxPaste` SHALL send the literal text via `cmux send --surface <ref> '<text>'` (NOT `send-keys`, which interprets tokens as key names). Returns `{ ok: true }` on success; `{ ok: false, error }` on cmux failure. | `test-cmux-tools.mjs:PasteUsesSendNotSendKeys` (assert argv starts with `["send", "--surface", ...]`, not `["send-keys", ...]`), `test-cmux-tools.mjs:PasteShellescapes` | MUST | cmux has both `send` (literal text) and `send-keys` (key tokens). Mirroring tmux `paste-buffer -p` means literal text. |
| REQ-T3 | `cmuxWaitFor` SHALL poll `cmux read-screen --surface <ref>` until a regex matches or a timeout elapses, with the same `doneRegex` / `stableMs` semantics as `tmux-control/lib/wait.ts`. | `test-cmux-tools.mjs:WaitForExitsOnRegexMatch`, `test-cmux-tools.mjs:WaitForTimesOutCleanly`, `test-cmux-tools.mjs:WaitForStableMsDefault` | MUST | Reuse the proven `tmux-control` wait-for pattern; only the command changes. |
| REQ-T4 | `cmuxSendKeys` SHALL accept `mode: "literal" \| "keys"` exactly like `tmux-control/lib/send.ts`. In `keys` mode: omit `--literal` (or equivalent), split tokens, default `pressEnter: false`. In `literal` mode: send whole string as one chunk. | `test-cmux-tools.mjs:SendKeysLiteralMode`, `test-cmux-tools.mjs:SendKeysKeysMode`, `test-cmux-tools.mjs:SendKeysKeysModePressEnterDefault` | MUST | Mirrors P5c-2-S5 semantics. cmux's actual CLI flag for literal is TBD; verify against cmux ≥0.64.17 in S4 first review. |
| REQ-T5 | `cmux-terminal/index.ts` SHALL export `cmuxTerminalTools` (or equivalent) for the existing tool-extension wiring (the `tmux-control` extension pattern). The tools SHALL NOT register as a backend — they use the `selectBgTerminalBackend()` API (or call `cmux workspace list --json` directly) to resolve the target surface. | `test-cmux-extension.mjs:ToolsExtensionExportsCmuxPaste` | SHOULD | Tools are independent of the bg backend; they target cmux surfaces directly. |
| REQ-R1 | `cmux-terminal/README.md` SHALL document: (a) macOS-only requirement, (b) `CMUX_SOCKET_MODE=allowAll` for external CLI control, (c) the known `agentName` not-persisted gap, (d) dispatch behavior (cmux preferred on macOS, tmux fallback elsewhere, transparent to user). | `grep` for each of the 4 items in `cmux-terminal/README.md`; manual review checklist | MUST | README missing today is a known S1 gap. |
| REQ-R2 | The end-to-end `/agents bg` flow on macOS+cmux SHALL create a cmux workspace named `pi-cmux-<runId>` running `node <workerPath> <manifestPath>`. `/agents bg-status` SHALL list the workspace, `/agents bg-stop <runId>` SHALL `close-workspace` it. | `test-real-cmux-e2e.mjs:LaunchCreatesWorkspace`, `test-real-cmux-e2e.mjs:StatusListsRun`, `test-real-cmux-e2e.mjs:StopClosesWorkspace` (real cmux daemon required, skipped in CI) | MUST | S3 deliverable. The P5b-1-S1 8-step real-cmux smoke covers backend primitives; this is the bg-dispatch layer on top. |
| REQ-R3 | When cmux daemon is unreachable on macOS (socket down), `/agents bg scout test` SHALL create a tmux session instead and the user-visible message SHALL say "running via tmux (cmux unavailable)". | `test-real-cmux-e2e.mjs:FallbackWhenCmuxDown` (manual: stop cmux, run command, verify tmux); `UNGUARDED-IN-CI` | SHOULD | The diagnostic value of telling the user which backend actually launched matters for debugging. |

**Priority legend:**
- MUST = required for the first slice merge; failing test = blocker.
- SHOULD = required before the feature is considered complete; one slice may defer.
- MAY = nice-to-have, not blocking any merge.

## Non-Goals

- Per-call backend override via `--backend <name>` CLI flag (deferred until 3+
  backends ship; see "Open Decisions").
- Cross-backend `list()` aggregation (a single `/agents bg-status` may today see
  only one backend's windows — the one selected by `selectBgTerminalBackend()`).
  Aggregation is deferred; users on macOS+cmux will see cmux windows only
  (tmux windows invisible). Acceptable for v1; revisit in P5b-2 if multi-backend
  becomes common.
- New `TermBgBackend` interface methods (focus, read-screen). The `focus()` gap
  is already deferred (P5 plan); `read-screen()` belongs in tools, not backend.
- Migrating `cmux-terminal` to a per-call `workerPath` re-resolution (today it
  resolves once at `session_start`). Worker path is stable across a session.

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
| User cannot tell which backend is active | Low | REQ-D10: user message includes backend name on success. REQ-D11 (SHOULD): on all-unavailable, names are listed. | `test-bg-commands.mjs:BgCommandFallsThroughToTmux` asserts the success message names "tmux". |
| Silent fallback to wrong platform backend | Low | REQ-D7: cmux's built-in `process.platform !== "darwin"` gate means non-mac users always get tmux. | `test-bg-terminal.mjs:SelectPrefersTmuxOnNonMacOS`. |
| Cross-instance registry desync (regression) | Medium | REQ-D5: dual-instance test extended to cover `selectBgTerminalBackend()`. The `Symbol.for` slot is the canonical fix and must continue to apply. | `test-bg-terminal-dual-instance.mjs:SharedAcrossInstancesWithSelect`. |

## Design

### Key types (additions / modifications)

```ts
// In agents/lib/bg-terminal.ts — additions to the existing module:

/** Inspect: read-only snapshot of all registered backends, in registration
 *  order. Used by diagnostics; never mutate the array. */
export function listBgTerminalBackends(): readonly TermBgBackend[];

/** Select: returns the first registered backend whose isAvailable() resolves
 *  true. Calls isAvailable() on each registered backend, in registration
 *  order, and stops at the first true. Returns null when no backend is
 *  available or no backend is registered.
 *
 *  Replaces the previous "first-registered wins regardless of isAvailable"
 *  behavior with proper fall-through. Async because isAvailable() is async
 *  (cmux uses a socket roundtrip). */
export function selectBgTerminalBackend(): Promise<TermBgBackend | null>;

/** Get: now async, equivalent to selectBgTerminalBackend(). Kept as the
 *  public API for backward compatibility with all existing callers
 *  (handleBgCommand, handleBgStatus, handleBgStop, handleBgOpen all call
 *  this). Callers must `await` the result. */
export function getBgTerminalBackend(): Promise<TermBgBackend | null>;
```

### Key invariants

- **Registration is append-only.** `registerBgTerminalBackend(b)` adds `b` to
  the end of the array. No remove, no overwrite, no re-order. The first-wins
  "ignore subsequent" behavior is REMOVED — this is the core behavioral change.
- **Selection is probe-based, not name-based.** The selector does not look at
  `backend.name`. A backend called "cmux" with `isAvailable()` returning false
  is treated identically to a backend called "experimental-zellij" with
  `isAvailable()` returning false. This keeps the selector orthogonal to which
  backends exist (no platform-based name hardcoding in the registry).
- **cmux's `isAvailable()` already encodes platform + liveness.** It returns
  false on non-mac and on a broken socket. The selector reuses this — no
  platform logic lives in the selector itself.
- **`Symbol.for("pi.agents.bgTerminalBackend")` slot shape changes from
  `{ backend: TermBgBackend | null }` to `{ backends: TermBgBackend[] }`.**
  Backwards compatibility for the slot shape is NOT preserved (this is a
  breaking change to the internal slot); no external code reads the slot
  directly (verified by grep over the repo at plan-author time).

### Resolution flow

```text
handleBgCommand:
  backend = await selectBgTerminalBackend()
  if !backend: return "no terminal backend installed"
  (isAvailable already checked by selector — no second check needed)
  result = await backend.launch(config)
  if result.status === "failed": cleanup reservation; return "Launch failed"
  return "Background agent <name> running (<runId>) via <backend.name>"

selectBgTerminalBackend:
  backends = registrySlot().backends  // snapshot
  for backend in backends:
    if typeof backend.isAvailable !== "function": continue  // assume available
    if await backend.isAvailable(): return backend
  return null
```

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/lib/bg-terminal.ts` | L96–115 | Process-global `Symbol.for` registry slot | **CHANGE** slot shape `{ backend }` → `{ backends: [] }`; add `selectBgTerminalBackend`, `listBgTerminalBackends`; redefine `getBgTerminalBackend` as async |
| `agents/lib/bg-terminal.ts` | L133 | `registerBgTerminalBackend` (first-wins) | **CHANGE** to append-only (keep the duplicate-name debug log for clarity) |
| `agents/lib/bg-terminal.ts` | L147 | `getBgTerminalBackend` | **CHANGE** signature to `async`, body delegates to `selectBgTerminalBackend` |
| `agents/index.ts` | L617 | `handleBgCommand`: `const backend = getBgTerminalBackend()` | **CHANGE** to `const backend = await getBgTerminalBackend()` |
| `agents/index.ts` | L622–625 | `if (typeof backend.isAvailable === "function" && !(await backend.isAvailable()))` | **REMOVE** — selector already probed |
| `agents/index.ts` | L696 | `handleBgStatus`: `const backend = getBgTerminalBackend()` | **CHANGE** to await; wrap in try/catch (selector throws on backend.isAvailable failure) |
| `agents/index.ts` | L725 | `handleBgStop`: same | **CHANGE** to await |
| `agents/index.ts` | L814 | `handleBgOpen`: same | **CHANGE** to await |
| `cmux-terminal/index.ts` | (no change) | Already calls `registerBgTerminalBackend(createCmuxBackend({...}))` | **NONE** — append-only registry handles it |
| `tmux-terminal/index.ts` | (no change) | Already calls `registerBgTerminalBackend(createTmuxBackend({...}))` | **NONE** |
| `agents/test-fixtures/test-bg-terminal.mjs` | L1–202 | Existing 16 tests for backend interface | **EXTEND** with ~10 new tests for select/list/dispatch |
| `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` | L1–82 | Existing dual-instance regression test | **EXTEND** with `SharedAcrossInstancesWithSelect` test |

## Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| **P5b-1-S2** | Multi-backend registry + selector + async `getBgTerminalBackend`. | `agents/lib/bg-terminal.ts` (modify), `agents/index.ts` (modify 4 callsites), `agents/test-fixtures/test-bg-terminal.mjs` (extend), `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` (extend) | ~80 LOC change + ~150 LOC tests | 10 new unit tests + 1 dual-instance extension | DO NOT remove `first-wins` debug log without replacing it with a `listBgTerminalBackends` snapshot; DO NOT change the `Symbol.for` key string (cross-process consumers depend on it) |
| **P5b-1-S3** | Real-cmux end-to-end `/agents bg` dispatch test on macOS. | `cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs` (new), `cmux-terminal/test-fixtures/run-real-cmux-e2e.sh` (new) | ~120 LOC + 11-step manual-or-scripted flow mirroring `test-real-tmux-smoke.mjs` | 3 manual-or-scripted tests (skipped in CI) | DO NOT mark S3 green without at least one real-cmux run on a macOS dev machine; DO NOT use `FakeCmuxExecutor` for any test in this slice (P5c lesson: fake hides bugs) |
| **P5b-1-S4** | `cmux-terminal/lib/tools.ts` + cmux tool surface (`cmuxPaste` / `cmuxWaitFor` / `cmuxSendKeys`). | `cmux-terminal/lib/tools.ts` (new), `cmux-terminal/index.ts` (extend with tool exports), `cmux-terminal/test-fixtures/test-cmux-tools.mjs` (new) | ~300 LOC + 6 unit tests | 9 new unit tests | DO NOT regress tmux-control tool contract (REQs from `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_PLAN.md` REQ-1 through REQ-29 still pass); DO NOT add new failure modes beyond what tmux-control already accepts |
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

1. **REQ-D11** (list probed backends in error message) — diagnostic only; nice-to-have.
2. **REQ-T5** (export tools from extension entry) — can be deferred to a P5b-1.1 if users request it; tools work standalone via direct import.
3. **REQ-R3** (fallback announcement message) — diagnostic only.

Do NOT cut:

- REQ-D1 through REQ-D5 (core dispatch change).
- REQ-D6, REQ-D7, REQ-D8 (the bug-fix behavior).
- REQ-T1 (tools surface) — without this, the slice ladder stops at S2.
- REQ-R1 (README) — the `CMUX_SOCKET_MODE=allowAll` requirement is a security/UX blocker for new users.

## Contracts

### `selectBgTerminalBackend(): Promise<TermBgBackend | null>`

**Input contract:** None (reads process-global slot).

**Output contract:**
- Returns the first registered `TermBgBackend` whose `isAvailable()` resolves to `true`.
- If a backend has no `isAvailable` method, it is treated as **available** (skips the probe, returns it immediately).
- Returns `null` when no backend is registered OR when every registered backend's `isAvailable()` resolves to `false`.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. No registrations | `backends.length === 0` | `null` |
| B. First available | `backends[0].isAvailable?.() === true` (or undefined) | `backends[0]` |
| C. First unavailable, second available | `backends[0].isAvailable() === false`, `backends[1].isAvailable() === true` | `backends[1]` |
| D. All unavailable | every `backends[i].isAvailable() === false` | `null` |
| E. First throws | `backends[0].isAvailable()` rejects | **TODO**: log warning, continue to `backends[1]`. Document the chosen behavior in code. |

**Error codes:** None — `isAvailable()` failures are caught internally and treated as "unavailable" (logged at debug). This matches the P5c-2-S1 lesson: failed probes are silent in the success path; the success-path user message never mentions a probe failure.

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
| EC1 | Both cmux-terminal and tmux-terminal loaded on macOS, cmux daemon up | `selectBgTerminalBackend` returns cmux | `test-bg-terminal.mjs:SelectPrefersCmuxOnMacOS` (FakeCmux darwin+available + FakeTmux always-available) |
| EC2 | Both loaded on Linux | cmux's `isAvailable` returns false (platform gate), tmux returns true → tmux wins | `test-bg-terminal.mjs:SelectPrefersTmuxOnNonMacOS` |
| EC3 | cmux daemon down on macOS (process up, socket broken) | cmux's `isAvailable` returns false (roundtrip fails), tmux wins | `test-bg-terminal.mjs:SelectFallsThroughOnPrimaryUnavailable` (FakeCmux darwin but roundtrip fails) |
| EC4 | Only tmux-terminal loaded | `selectBgTerminalBackend` returns tmux | `test-bg-terminal.mjs:SelectWithSingleBackend` |
| EC5 | Nothing loaded | `getBgTerminalBackend` returns null; `handleBgCommand` shows "No terminal backend installed" | `test-bg-terminal.mjs:SelectNullWhenNoneRegistered` (existing behavior) |
| EC6 | Duplicate `registerBgTerminalBackend` calls in same process | Both register (append-only); selector probes both | `test-bg-terminal.mjs:DuplicateRegistrationAppends` |
| EC7 | Backend registered with no `isAvailable` method | Treated as available; returned first | `test-bg-terminal.mjs:NoIsAvailableTreatedAsAvailable` |
| EC8 | `isAvailable` throws / rejects | Treated as unavailable; continue to next backend; logged at debug | `test-bg-terminal.mjs:IsAvailableThrowTreatedAsUnavailable` |
| EC9 | `selectBgTerminalBackend` called concurrently | Two independent probes run; race-safe because `backends` is a stable array snapshot | `test-bg-terminal.mjs:ConcurrentSelectIsRaceSafe` (call 5x in parallel, assert each returns same backend) |
| EC10 | `__resetBgTerminalBackend` called mid-flight | Concurrent `selectBgTerminalBackend` may return a backend from the cleared state (race with probe); acceptable for v1, documented | Manual smoke (cannot deterministically test in unit) |
| EC11 | `/agents bg` invoked before `session_start` fires | Both extensions' `session_start` handlers haven't run; `selectBgTerminalBackend` returns null; user sees "No terminal backend installed" | `test-bg-commands.mjs:BgBeforeSessionStart` |

## Test Case Catalog

Total: ~30 tests across 6 files (S2: 10 unit + 1 dual-instance extension + 4
callsite updates; S3: 3 manual-or-scripted; S4: 9 unit; S5: 4 grep guards).

```text
Group 1: Dispatch selection (agents/test-fixtures/test-bg-terminal.mjs) — 10 tests
  SelectReturnsFirstAvailable
  SelectFallsThroughOnUnavailable
  SelectNullWhenNoneAvailable
  SelectPrefersCmuxOnMacOS
  SelectPrefersTmuxOnNonMacOS
  SelectFallsThroughOnPrimaryUnavailable
  SelectWithSingleBackend
  SelectNullWhenNoneRegistered
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

Group 2: Dual-instance regression extension (test-bg-terminal-dual-instance.mjs) — 1 test
  SharedAcrossInstancesWithSelect

Group 3: Consumer callsite updates (test-bg-commands.mjs extensions) — 4 tests
  BgCommandFallsThroughToTmux
  BgCommandReportsNoneAvailable
  BgCommandListsProbedBackendsWhenAllUnavailable
  BgBeforeSessionStart

Group 4: Real-cmux end-to-end (cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs) — 3 manual-or-scripted
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
| Breaking change to `getBgTerminalBackend` signature (sync → async) misses a callsite, causing runtime `Promise<TermBgBackend>` to flow into a sync consumer | High | TypeScript compiler catches every callsite at build time. Add `test-bg-commands.mjs` end-to-end that invokes `/agents bg` and asserts success. |
| `selectBgTerminalBackend` async-overhead on every `/agents bg` invocation (cmux probe is 1s timeout when down) | Low | 1s is acceptable for a launcher. Document. If it becomes a problem, add a short-lived cache (out of scope for v1). |
| Cross-platform selector behavior surprises (a Linux user with cmux-binary-on-PATH but no daemon gets tmux correctly) | Low | REQ-D7 + REQ-D8 cover this; tests assert the order. |
| Tools layer (S4) silently diverges from tmux-control semantics | Medium | REQ-T1, REQ-T3, REQ-T4 explicitly mirror tmux-control REQs. Test catalog shares test names with tmux-control where possible for direct comparison. |
| Real-cmux E2E test flakes on dev machine (cmux daemon state pollution between runs) | Medium | Use `cmux --socket /tmp/cmux-p5b1s3-<pid>.sock` pattern (proven in S1 smoke). Cleanup trap on exit. |
| Two-backend fall-through masks tmux misconfiguration on macOS | Low | User-visible message names the active backend (REQ-D10). |
| `__resetBgTerminalBackend` mid-flight race (EC10) | Low | Acceptable for v1; documented in EC table. |

## Open Decisions

- **`/agents bg-status` aggregation across backends.** Today it calls
  `backend.list()` on the single selected backend. If both cmux and tmux are
  registered and cmux wins, tmux windows are invisible to status. Decision
  deferred to P5b-2 (zellij) when multi-backend becomes common. v1: status
  reports only the active backend's windows.

- **`--backend <name>` flag.** Would let users force a specific backend
  regardless of `isAvailable()`. Deferred until 3+ backends ship (today's two
  is sufficient; the fall-through handles the common cases).

- **cmux `send` vs `send-text` vs `send-keys`.** REQ-T2 assumes `cmux send
  --surface <ref> '<text>'`. If cmux's actual flag is different in 0.64.17,
  adjust in S4 first review.

- **`isAvailable` throw behavior (State E).** REQ-D9 says "log warning,
  continue" but doesn't specify the log level. Use `console.debug` to match
  the existing `first-wins` debug log convention. Revisit if users report
  confusion.

## Done Criteria

All MUST requirements REQ-D1–D10, REQ-T1–T4, REQ-R1, REQ-R2 passing = done.

Specifically:

- `agents/test-fixtures/test-bg-terminal.mjs` — all 18 tests green (16 existing + 12 new = 28; the count is approximate; the gate is "zero failing tests")
- `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` — 4 tests green (3 existing + 1 new)
- `agents/test-fixtures/test-bg-commands.mjs` — all existing tests green + 4 new fall-through tests
- `cmux-terminal/test-fixtures/test-cmux-tools.mjs` — 9 new unit tests green
- `cmux-terminal/test-fixtures/test-cmux-docs.mjs` — 4 grep guards green
- `cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs` — 3 manual-or-scripted tests pass on macOS dev machine; 1 UNGUARDED-IN-CI manual verification recorded
- `cmux-terminal/README.md` — exists, contains the 4 REQ-R1 items, linked from main `README.md`

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | codex (gpt-5.5 high) via tmux | gpt-5.5 high | TBD | TBD |
| 2 | (re-review if changes requested) | TBD | TBD | TBD |

### Resolved blockers

(none yet — DRAFT awaiting first pass)

## Appendix: Implementation Plan

### Files to create

1. `cmux-terminal/lib/tools.ts` — `cmuxPaste`, `cmuxWaitFor`, `cmuxSendKeys`. Reuses `shell-escape`, `redact-error`, `path-validate`, `constants` from S1.
2. `cmux-terminal/test-fixtures/test-cmux-tools.mjs` — 9 unit tests using `FakeCmuxExecutor`.
3. `cmux-terminal/test-fixtures/test-cmux-docs.mjs` — 4 grep guards for README.
4. `cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs` — 3-step real-cmux end-to-end.
5. `cmux-terminal/test-fixtures/run-real-cmux-e2e.sh` — driver script (parallels `run-real-tmux-smoke.sh`).
6. `cmux-terminal/README.md` — 4 REQ-R1 items + dispatch behavior.

### Files to modify

| File | Change |
|---|---|
| `agents/lib/bg-terminal.ts` | Replace `{ backend }` slot with `{ backends: [] }`. Add `selectBgTerminalBackend` (async, probes each). Add `listBgTerminalBackends` (frozen snapshot). Redefine `getBgTerminalBackend` as `async` wrapper. Update `registerBgTerminalBackend` to append. Update `__resetBgTerminalBackend` to clear array. |
| `agents/index.ts` | Add `await` to 4 `getBgTerminalBackend()` callsites (L617, L696, L725, L814). Remove the now-redundant `isAvailable` check at L622–625. Optionally add the "list probed backends" diagnostic per REQ-D11. |
| `agents/test-fixtures/test-bg-terminal.mjs` | Extend with 12 new tests in "Group 1" above. |
| `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` | Add `SharedAcrossInstancesWithSelect` test (Group 2). |
| `agents/test-fixtures/test-bg-commands.mjs` | Add 4 fall-through tests (Group 3). |
| `cmux-terminal/index.ts` | Add `cmuxTerminalTools` named export per REQ-T5. |
| `README.md` (root) | Link `cmux-terminal/README.md` from the extensions list. |

### Implementation sequence

| Step | Slice | Action | Validation |
|---|---|---|---|
| 1 | S2 | Modify `bg-terminal.ts`: append-only registry, add `selectBgTerminalBackend`, add `listBgTerminalBackends`, make `getBgTerminalBackend` async | `node --test agents/test-fixtures/test-bg-terminal.mjs` green |
| 2 | S2 | Update 4 callsites in `agents/index.ts` to await | `npm run build` (or `tsc --noEmit`) clean; `test-bg-commands.mjs` green |
| 3 | S2 | Extend `test-bg-terminal.mjs` and `test-bg-terminal-dual-instance.mjs` | All tests green |
| 4 | S3 | Author `test-real-cmux-e2e.mjs` + `run-real-cmux-e2e.sh` | Manual run on macOS dev box: 3 of 3 scripted tests pass; EC3 fallback verified |
| 5 | S4 | Create `cmux-terminal/lib/tools.ts` with `cmuxPaste` / `cmuxWaitFor` / `cmuxSendKeys` | `test-cmux-tools.mjs` 9 unit tests green (FakeCmux) |
| 6 | S4 | Export tools from `cmux-terminal/index.ts` (REQ-T5) | `test-cmux-tools.mjs:ToolsExtensionExportsCmuxPaste` green |
| 7 | S5 | Author `cmux-terminal/README.md` with the 4 REQ-R1 items | `test-cmux-docs.mjs` 4 grep guards green |
| 8 | S5 | Add `cmux-terminal/README.md` link to root `README.md` | Manual review |

### Risks

| Risk | Mitigation |
|---|---|
| Step 2 misses a callsite → runtime `Promise<TermBgBackend>` flows into sync consumer | TypeScript compiler catches it; `tsc --noEmit` is part of the verify command. |
| Step 5 tools diverge from tmux-control semantics | Test names mirror tmux-control's test catalog for direct comparison; review pass on the diff against `tmux-control/lib/{paste,wait,send}.ts`. |
| Step 4 real-cmux E2E is flaky | Use `--socket /tmp/cmux-p5b1s3-<pid>.sock` for isolation (proven in S1); cleanup trap on exit; documented as `UNGUARDED-IN-CI`. |

---

## Appendix B: Mechanical Execution Spec

This appendix is for a low-capability executor. Each step is exact: one file,
one action, falsifiable verify. The plan author has already passed the
executor-ready gate for every step below.

### Shared constants / types

```ts
// In agents/lib/bg-terminal.ts — additions:

const REGISTRY_SLOT = Symbol.for("pi.agents.bgTerminalBackend");

function registrySlot(): { backends: TermBgBackend[] } {
  const g = globalThis as unknown as Record<symbol, { backends: TermBgBackend[] } | undefined>;
  return (g[REGISTRY_SLOT] ??= { backends: [] });
}

// Selector
export async function selectBgTerminalBackend(): Promise<TermBgBackend | null> {
  const backends = registrySlot().backends;
  for (const backend of backends) {
    try {
      if (typeof backend.isAvailable !== "function") return backend;
      if (await backend.isAvailable()) return backend;
    } catch (err) {
      console.debug(`bg-terminal: ${backend.name}.isAvailable() threw; treating as unavailable: ${err}`);
    }
  }
  return null;
}

// Inspector (frozen snapshot)
export function listBgTerminalBackends(): readonly TermBgBackend[] {
  return Object.freeze(registrySlot().backends.slice());
}

// Backward-compat async wrapper
export function getBgTerminalBackend(): Promise<TermBgBackend | null> {
  return selectBgTerminalBackend();
}
```

### P5b-1-S2 — Dispatch + selector (REQ-D1..D11)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 2.1 | `agents/lib/bg-terminal.ts` | **EDIT** anchored. `ANCHOR:` `const REGISTRY_SLOT = Symbol.for("pi.agents.bgTerminalBackend");\n\nfunction registrySlot(): { backend: TermBgBackend \| null } {\n\tconst g = globalThis as unknown as Record<symbol, { backend: TermBgBackend \| null } \| undefined>;\n\treturn (g[REGISTRY_SLOT] ??= { backend: null });\n}` → `REPLACE:` `const REGISTRY_SLOT = Symbol.for("pi.agents.bgTerminalBackend");\n\nfunction registrySlot(): { backends: TermBgBackend[] } {\n\tconst g = globalThis as unknown as Record<symbol, { backends: TermBgBackend[] } \| undefined>;\n\treturn (g[REGISTRY_SLOT] ??= { backends: [] });\n}` | `grep -n "backends: TermBgBackend\[\]" agents/lib/bg-terminal.ts` returns 1 match |
| 2.2 | `agents/lib/bg-terminal.ts` | **EDIT** anchored. `ANCHOR:` the full `registerBgTerminalBackend` function body (the first-wins block) → `REPLACE:` `export function registerBgTerminalBackend(backend: TermBgBackend): void {\n\tregistrySlot().backends.push(backend);\n\treturn;\n}` (append-only) | `grep -n "backends.push" agents/lib/bg-terminal.ts` returns 1 match |
| 2.3 | `agents/lib/bg-terminal.ts` | **APPEND** at end of file. Add `selectBgTerminalBackend`, `listBgTerminalBackends`, and redefine `getBgTerminalBackend` per the shared constants block above. | `grep -n "export async function selectBgTerminalBackend" agents/lib/bg-terminal.ts` returns 1 match; `grep -n "export function listBgTerminalBackends" agents/lib/bg-terminal.ts` returns 1 match; `grep -n "export function getBgTerminalBackend" agents/lib/bg-terminal.ts` returns 1 match |
| 2.4 | `agents/lib/bg-terminal.ts` | **EDIT** anchored. `ANCHOR:` `export function __resetBgTerminalBackend(): void {\n\tregistrySlot().backend = null;` → `REPLACE:` `export function __resetBgTerminalBackend(): void {\n\tregistrySlot().backends = [];` | `grep -n "backends = \[\]" agents/lib/bg-terminal.ts` returns 1 match (inside `__resetBgTerminalBackend`) |
| 2.5 | `agents/index.ts` | **EDIT** anchored. `ANCHOR:` `const backend = getBgTerminalBackend();\n\tif (!backend) {\n\t\tctx.ui.notify("No terminal backend installed. Load tmux-terminal or equivalent to use background agents.", "warning");\n\t\treturn;\n\t}\n\tif (typeof backend.isAvailable === "function" && !(await backend.isAvailable())) {\n\t\tctx.ui.notify(\`Terminal backend "${backend.name}" is not available.\`, "error");\n\t\treturn;\n\t}` → `REPLACE:` `const backend = await getBgTerminalBackend();\n\tif (!backend) {\n\t\tctx.ui.notify("No terminal backend installed. Load tmux-terminal or equivalent to use background agents.", "warning");\n\t\treturn;\n\t}` (remove the now-redundant `isAvailable` check; selector already probed) | `grep -n "Terminal backend .* is not available" agents/index.ts` returns 0 matches |
| 2.6 | `agents/index.ts` | **EDIT** anchored at each of L696, L725, L814. `ANCHOR:` `const backend = getBgTerminalBackend();` → `REPLACE:` `const backend = await getBgTerminalBackend();` (3 occurrences) | `grep -nE "const backend = (await )?getBgTerminalBackend" agents/index.ts` returns 4 matches, all with `await` |
| 2.7 | `agents/test-fixtures/test-bg-terminal.mjs` | **APPEND** at end of file. Add 18 new tests in the "Group 1" catalog (full verbatim test bodies in a follow-up commit per S2 plan; this step's anchor is the last `console.log` line in the existing file). | `node --test agents/test-fixtures/test-bg-terminal.mjs` exits 0; counts ≥30 assertions (existing 16 + new ≥14); `SelectPrefersCmuxOnMacOS` and `SelectPrefersTmuxOnNonMacOS` are among the green tests |
| 2.8 | `agents/test-fixtures/test-bg-terminal-dual-instance.mjs` | **APPEND** at end of `main()`. Add the `SharedAcrossInstancesWithSelect` test (register via A, call `selectBgTerminalBackend` via B with both backends registered; assert B sees A's backend first, and that `__reset` clears the shared array). | `node --test agents/test-fixtures/test-bg-terminal-dual-instance.mjs` exits 0; new test logs `✓ SharedAcrossInstancesWithSelect` |

### P5b-1-S4 — cmux tools (REQ-T1..T5)

(Spec to be expanded in the S4 first-review commit; this plan deliberately defers the
exact `cmux-terminal/lib/tools.ts` body until the cmux ≥0.64.17 `send` / `send-keys`
flag surface is verified against the live CLI. The plan-review pass should confirm
that REQ-T1..T4 are sufficient to drive the implementation without further
clarification.)

### P5b-1-S3 — real-cmux e2e (REQ-R1..R3)

(Spec deferred to S3 first-review; the E2E test is inherently
platform-specific and CI-skippable. The slice's REQ-R1..R3 + EC3 + the proven
S1 smoke-test pattern are sufficient to drive the implementation.)

### P5b-1-S5 — README + docs (REQ-R1)

(Spec deferred to S5 first-review; the 4 grep guards in
`test-cmux-docs.mjs` are the verify contract.)

### Executor-ready gate

- Every step names exactly one file. ✓
- Every step on an existing file quotes a verbatim `ANCHOR` and `REPLACE`. ✓ (S2)
- Whole-file `Write` appears only for new-file create steps. ✓ (S4, S5)
- No "decide / choose / figure out / as appropriate" in step text. ✓ (S2)
- Every constant, error string, regex, signature appears verbatim. ✓ (S2)
- Verify commands name observed value + expected value. ✓ (S2)

### Definition of done (whole plan)

```bash
node agents/test-fixtures/test-bg-terminal.mjs           # all tests green
node agents/test-fixtures/test-bg-terminal-dual-instance.mjs  # all tests green
node agents/test-fixtures/test-bg-commands.mjs          # all tests green
node cmux-terminal/test-fixtures/test-cmux-tools.mjs    # all tests green
node cmux-terminal/test-fixtures/test-cmux-docs.mjs     # all grep guards green
# Manual on macOS dev box:
node cmux-terminal/test-fixtures/test-real-cmux-e2e.mjs # 3 of 3 scripted tests pass
grep -c "CMUX_SOCKET_MODE=allowAll" cmux-terminal/README.md  # ≥1
```