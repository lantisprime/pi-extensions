# P5E1 Backend Selector Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

## Episode Search Summary

Searched episodic memory for `canonical-workplan`, `--backend`, `backend selector`, `selectBgTerminalBackend`, `P5b`, `preference`.

Key active memories:

- `20260704-054011-post-merge-sync-p5d-cmux-control-complet-7ea6`: P5d cmux-control COMPLETE; P5d closed; "Multiple-backend selection via `--backend` flag — deferred until 2+ backends ship (P5b-1 cmux-terminal is the second backend, so this is now timely)."
- `20260628-115957-handoff-p5b-1-s1-complete-p5b-1-s2-is-ne-be85`: P5b-1 (cmux-terminal) handoff context.
- `20260627-140714-resume-checkpoint-p5c-shipped-pr-106-p5c-98d5`: earlier canonical workplan head (P5c → P5c-2), superseded chain.

No prior decision rejects a `--backend` selector; the deferral reason ("until 2+ backends ship") is now satisfied.

## Objective

Let the user explicitly select which registered terminal backend (`tmux` or `cmux` today) launches a single background agent run via a **positional, first-token** `--backend <name>` flag on `/agents bg`: `/agents bg --backend <name> <agent> <task>`. Without the flag, behavior is unchanged. This proves the user-facing selection seam end-to-end while leaving reaper routing (already name-based via `ownerBackendName`) untouched.

## Why

Today backend selection is purely automatic. `selectBgTerminalBackend()` in `agents/lib/bg-terminal.ts:166` sorts registered backends by `preference` (higher wins; default 0) and picks the first whose `isAvailable()` returns true. `cmux-terminal` registers with `preference: 10` (winning over `tmux-terminal`'s default 0), so cmux always launches when both are loaded and reachable. The user has no per-launch override: the only existing knobs are (a) don't load `cmux-terminal`, (b) make cmux unreachable, or (c) edit the `preference` constants and restart.

This matters because:

1. With 2+ backends shipping (tmux-terminal + cmux-terminal), preference-based selection is no longer expressive enough: the user cannot debug "which backend did this run actually launch on," force a fall-through to test the secondary, or pin a backend for a project.
2. The plumbing already supports name-based lookup (`getBgTerminalBackendByName(name)`, used by the reaper at `agents/index.ts:535`), but no user-facing path calls it. The selector is a one-call gap from "internal reaper seam" to "user-visible knob."
3. P5b alternative backends (zellij/wezterm/headless) will multiply the registered set to 3+. Without an explicit selector, every new backend widens the "which one did I just launch on?" surface. This slice is the prerequisite for cleanly testing P5b's fall-through paths from the CLI.

**Why positional-first (not greedy-anywhere):** `/agents bg`'s existing tokenizer (`tokens[0]` = agent name, rest = task) has no quote-awareness and no unknown-flag parser — any token (including `--backend`-shaped text) that appears after the agent name becomes part of the task. Consuming `--backend` greedily anywhere in the stream would (a) strip legitimate task text that happens to contain `--backend`, and (b) leave `--backend=cmux` / second `--backend foo` pairs in `restArgs` where they would NOT reliably produce a usage error (they'd silently become task text). Confining `--backend` to the **first token only** sidesteps the whole class of ambiguity: a `--backend` token that appears anywhere else is, by the existing contract, just task text and passes through unchanged. This is the design decision that makes the slice's contract falsifiable without quote-aware parsing.

## Requirements (Ground Truth)

Every requirement SHALL be testable and SHALL map to at least one test or validation check.

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `/agents bg --backend <name> <agent> <task>` SHALL launch via the registered backend whose `name` equals `<name>`, bypassing the preference-ordered `selectBgTerminalBackend()` probe. The selected backend's `name` SHALL appear verbatim in the success notification (existing `via ${backend.name}` message). | `testBackendFlagLaunchesNamedBackend`, `testBackendFlagBypassesPreference` | MUST | `<name>` is matched exact-case against `TermBgBackend.name` (e.g. `"tmux"`, `"cmux"`). No substring/normalize. Positional: `--backend` MUST be the first whitespace-delimited token. |
| REQ-2 | When `--backend <name>` is the first token and no registered backend has that `name`, the command SHALL notify an error that (a) names the requested `<name>` and (b) lists every currently-registered backend name (from `listBgTerminalBackends()`), in registration order. The command SHALL NOT call `backend.launch()`. | `testBackendFlagUnknownNameErrorsWithList`, `testBackendFlagUnknownNameDoesNotLaunch` | MUST | Message regexes assert both the requested name and a registered sibling. Separate test proves `launch()` was never called. |
| REQ-3 | When `--backend <name>` is first and the named backend is registered but `isAvailable()` returns false (or throws), the command SHALL notify an error naming `<name>` AND the canonical "registered but unavailable" wording; it SHALL NOT silently fall through to the preference selector. | `testBackendFlagUnavailableDoesNotFallThrough`, `testBackendFlagUnavailableNamesBackend` | MUST | Load-bearing: explicit selection errors rather than silently picking a different backend. `testBackendFlagUnavailableDoesNotFallThrough` registers a second, *available* backend at higher preference and asserts that one was NOT used. |
| REQ-4 | When `--backend <name>` is first and the named backend is registered + available, but `backend.launch()` returns `status: "failed"`, the existing cleanup path (write `bg-result` `failed` + `markBgRunDone`) SHALL run unchanged, and the failure notification SHALL name the attempted backend's `name` via a one-line edit to the existing `Launch failed: ...` notification (→ `Launch failed via ${backend.name}: ...`). This is the ONLY change below tokenization; all other post-tokenization code is byte-unchanged. | `testBackendFlagLaunchFailureCleansAndNamesBackend` | MUST | The existing `testLaunchFailureCleansReservation` does NOT assert the notification string (only `result.ok`, `launch.status`, slot count), so the one-line edit keeps it green. The new test asserts `lastNotified` matches `/via <name>/`. |
| REQ-5 | When the first token is NOT `--backend`, `handleBgCommand` SHALL behave exactly as before: call `selectBgTerminalBackend()` and emit the existing "none-registered" / "all-unavailable" / "via <name>" messages. No existing test assertion changes. | `testPreflightToLaunchContract`, `testBgCommandFallsThroughToTmux`, `testBgCommandReportsNoneAvailable`, `testBgCommandListsProbedBackendsWhenAllUnavailable`, `testBgBeforeSessionStart` | MUST | Back-compat gate. `parseBgArgs` returns `restArgs === rawArgs` (the ORIGINAL, untrimmed string) when the first token isn't `--backend`, so `handleBgCommand`'s `tokens = parse.restArgs.split(/\s+/)` is byte-identical to today's `tokens = args.split(/\s+/)`. The command dispatcher trims `parsed.rest` before calling `handleBgCommand`, so leading/trailing whitespace never reaches this path in production; returning the untrimmed original preserves the direct-call behavior exactly — including today's `"  scout task".split(/\s+/) → ["","scout","task"] → empty agentName → usage-error` path. These five pre-existing tests MUST stay green unmodified. |
| REQ-6 | When the first token IS `--backend`, the parser SHALL consume exactly the first two tokens (`--backend` + the following value) and place all remaining tokens in `restArgs`. The consumed pair SHALL NOT appear in the agent name or task text. When the first token is NOT `--backend`, `restArgs` SHALL equal `rawArgs` (the original, untrimmed string — no consumption). | `testBackendFlagMidArgsNotConsumed`, `testParseFlagWithValue`, `testParseNoFlag`, `testParseNoFlagPreservesRawArgs` | MUST | Negative control lives in the pure-parser tests (`testParseFlagWithValue` would fail if the strip didn't happen) and in the integration test `testBackendFlagNotInLaunchConfigOrManifest` (REQ-12). |
| REQ-7 | When `--backend` is the first token AND no value follows (`/agents bg --backend`), the command SHALL notify `Usage: /agents bg <agent> <task> [--backend <name>]` and SHALL NOT launch. | `testBackendFlagMissingValueErrors`, `testParseFlagNoValue` | MUST | Catches the bare-flag edge before tokenization produces an empty `<name>`. |
| REQ-9 | The selected backend's `name` SHALL be persisted as `ownerBackendName` on the reservation via the existing `updateBgReservationOwner(...)` call, so the reaper routes `isAlive()` to the same backend that launched the run, across parent Pi restarts. The persisted value SHALL equal the user's `--backend <name>`, not the preference winner. | `testBackendFlagPersistsOwnerName` | MUST | No new persistence code: the existing post-launch patch already uses `backend.name`. |
| REQ-10 | The `--backend` parser SHALL be a pure function of the raw `args` string (no I/O, no registry reads) so it is independently unit-testable without registering any backend. It SHALL be positional: only the literal first token `"--backend"` triggers flag consumption. | `testParseNoFlag`, `testParseFlagWithValue`, `testParseFlagNoValue`, `testParseEqualsFormNotConsumed`, `testParseDuplicateSecondPairPassesThrough`, `testParseNoFlagPreservesRawArgs` | SHOULD | New `parseBgArgs` lives in `agents/lib/bg-args.ts` (new file) so it can be imported and tested without the global registry / `AgentsContext`. |
| REQ-11 | The slice SHALL NOT change `selectBgTerminalBackend`, `getBgTerminalBackendByName`, `getBgTerminalBackend`, `listBgTerminalBackends`, `registerBgTerminalBackend`, or the `TermBgBackend` interface in `agents/lib/bg-terminal.ts`. | Done Criteria: `git diff --stat agents/lib/bg-terminal.ts \| wc -l` returns `0` | MUST | The seam is already correct; this slice only adds new callers. The Done-Criteria gate is content-based (not mtime), proven falsifiable in Appendix B step 1.9's red-control. |
| REQ-12 | No `--backend` token, no `<name>` value, and no fragment of the consumed pair SHALL appear in `backend.launch(config)`'s `agentName`, `runId`, `manifestPath`, or `cwd` fields, NOR in the persisted `BgRunManifest.task` field (read from disk). The legitimate task text SHALL appear intact in `BgRunManifest.task`. | `testBackendFlagNotInLaunchConfigOrManifest` | MUST | `BgRunManifest` (`agents/lib/bg-state.ts:39-51`) has fields `{ version, runId, identity, task, options, mac, keyGenId }` — there is NO `argvPreview` field. The non-leak assertions target the launch config + the real `manifest.task`. Falsifiable: a broken `parseBgArgs` (no strip) would put `--backend` in `agentName` and the whole raw string in `manifest.task`. |

**Priority legend:** MUST = first-slice merge blocker; SHOULD = required before feature complete (one slice may defer); MAY = nice-to-have.

**Note on REQ-8 (dropped vs. earlier draft):** an earlier draft had a REQ-8 that asserted `--backend=cmux` is "rejected with a usage error." That was wrong against the live parser (there is no unknown-flag parser; `--backend=cmux` left in `restArgs` would silently become the agent name or task text). The positional design makes `--backend=cmux` simply a non-flag first token → it flows into the existing agent-resolution path and either fails as "unknown agent `--backend=cmux`" or (when not first) becomes task text. No special rejection is needed or wanted. Behavior is covered by `testBackendEqualsFormPassedThrough` + `testParseEqualsFormNotConsumed` (EC8).

## Non-Goals

Out of scope for this feature:

- Persistent config ("always prefer tmux for this project" via `agents config` / trust reader). Needs the disk-backed trust reader (deferred per canonical workplan).
- Runtime reordering of the `preference` constants (e.g. a `/agents backend cmux-disable` toggle).
- NLP routing ("use cmux" → `--backend cmux`). Pairs with the separate NL → `/agents bg` intent-gate follow-up.
- Any new terminal backend (zellij/wezterm/headless): that is P5b; this slice only consumes existing registered backends.
- Backends that are not loaded at `/agents bg` time. A `--backend foo` for an extension that isn't installed errors as "unknown name" (REQ-2), not "please install foo."
- `--backend=` `=`-form and short-form `-b`. Explicitly out of scope: the equals-form is NOT recognized (it is not the literal token `--backend`), so it passes through to the existing agent/task paths unchanged (see EC8).
- Quote-aware / greedy-anywhere flag parsing. Out of scope by design (see "Why positional-first").
- Changing the `args` parameter or the post-tokenization body of `handleBgCommand` EXCEPT the one-line launch-failure notification edit (see REQ-4: `Launch failed: ...` → `Launch failed via ${backend.name}: ...`). Preflight, launch, cleanup, `updateBgReservationOwner`, and status line are all byte-unchanged.

## Safety / Security

The `--backend <name>` value is user-controlled argv. It is matched against `TermBgBackend.name` (already-registered, code-defined constants: `TMUX_BACKEND_NAME = "tmux"`, `CMUX_BACKEND_NAME = "cmux"`). It is NOT used to derive a binary path, NOT placed in any shell command, and NOT persisted as anything other than the `ownerBackendName` metadata field already covered by the N3/N5 security model. The threat surface is therefore "user chooses among their own installed extensions," which is already the implicit selector's authority.

The one residual concern: a `--backend` value that survives into the agent name, task text, or worker-internal manifest `task` field would leak user-controlled data into the spawn boundary. REQ-6 + REQ-12 close this with dedicated negative controls. Each must name a real observed value, not a constant.

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| `--backend` value leaks into launch config or `BgRunManifest.task` | High | Consume `--backend <name>` only as the first two tokens; strip the pair from `restArgs` before agent/task split. Assert a fake-backend `name` sentinel is absent from every launch-config field AND from `manifest.task` (read from disk); assert the legitimate task sentinel IS present in `manifest.task`. | `testBackendFlagNotInLaunchConfigOrManifest` (positive: sentinel present in raw args, absent from launch config + manifest.task); negative control = `testParseFlagWithValue` (a `parseBgArgs` that fails to strip would fail this unit test). |
| Named-but-unavailable backend silently falls through to preference winner, masking the user's intent | Medium | Reject the fall-through explicitly: named-but-unavailable errors and does NOT call `selectBgTerminalBackend()`. | `testBackendFlagUnavailableDoesNotFallThrough` (negative: register a higher-preference available sibling; assert that sibling's `launch()` was NOT called). |
| Positional-only enforcement silently misroutes a user who wrote `--backend` mid-string expecting it to be honored | Low | Document the positional contract in the missing-value usage string (`Usage: /agents bg <agent> <task> [--backend <name>]`). The mid-string `--backend` token becomes task text (existing behavior), so no data is lost and no security boundary is crossed — the user just gets the default-backend launch with `--backend` literally in their task. | `testBackendFlagMidArgsNotConsumed` (asserts the `--backend` token survives intact in `manifest.task` and the run launches via the default-selected backend). |

## Design

### Key types

```ts
// agents/lib/bg-args.ts (NEW file)

/** Result of parsing the raw `args` string passed to `/agents bg`. */
export interface BgArgsParseResult {
	/** The literal token following `--backend`, or undefined when the
	 *  first token is not `--backend`. Empty string "" means `--backend`
	 *  was the ONLY token (REQ-7) — caller MUST treat as a usage error,
	 *  NOT as "no flag." */
	readonly backendName?: string;
	/** true iff `--backend` was the first token AND no value followed.
	 * Callers check this BEFORE checking `backendName`. */
	readonly backendFlagMissingValue: boolean;
	/** The remaining args string with the `--backend <name>` pair removed.
	 *  This is what gets re-tokenized into <agent> <task>. When the first
	 *  token is not `--backend`, equals the original UNTRIMMED rawArgs
	 *  (byte-identical to today's `args`). When the first token IS
	 *  `--backend`, equals tokens[2..].join(" ") (whitespace-collapsed). */
	readonly restArgs: string;
}

/** Pure parse: positional, no I/O, no registry reads. REQ-10. */
export function parseBgArgs(rawArgs: string): BgArgsParseResult;
```

```ts
// agents/lib/bg-terminal.ts (UNCHANGED — re-used as-is)
export function getBgTerminalBackendByName(name: string): TermBgBackend | undefined;
export function listBgTerminalBackends(): readonly TermBgBackend[];
// SelectBgTerminalResult: { ok: true; backend } | { ok: false; reason };
```

### Key invariants

- `parseBgArgs` is a pure function of `rawArgs` (REQ-10). It never touches `globalThis`, the registry, or `AgentsContext`.
- `--backend` is matched by exact-case string equality as the FIRST whitespace-delimited token, against `TermBgBackend.name`. No `.toLowerCase()`, no substring, no `.includes()`. (Same exact-match rule the reaper relies on at `agents/index.ts:535`.)
- The `--backend <name>` pair is removed from the token stream BEFORE agent/task split (REQ-6), so it cannot appear in `agentName`, `task`, `BgRunManifest.task`, or the launch config.
- Named selection never calls `selectBgTerminalBackend()` and never falls through (REQ-3). The two code paths (explicit / automatic) are disjoint inside `handleBgCommand`.
- The reservation's `ownerBackendName` is always the literal `backend.name` that performed the launch (REQ-9) — already true today; new test proves it holds under the `--backend` path.
- A `--backend` token that is NOT the first token is preserved verbatim in `restArgs` and flows into the existing agent/task contract (it becomes task text). This is a deliberate, documented property — not a parse failure.

### Resolution / flow

```text
handleBgCommand(args, ctx, diag)
  │
  ├─ parse = parseBgArgs(args)       ← NEW (lib/bg-args.ts); pure, positional
  │     → { backendName?, backendFlagMissingValue, restArgs }
  │
  ├─ if parse.backendFlagMissingValue: notify usage; return        (REQ-7)
  │
  ├─ if parse.backendName !== undefined:                          (REQ-1..3,9)
  │     named = getBgTerminalBackendByName(parse.backendName)
  │     if !named:
  │         names = listBgTerminalBackends().map(b => b.name).join(", ")
  │         notify `Unknown backend 'X'. Registered: <names>`; return   (REQ-2)
  │     try { if typeof named.isAvailable === "function" && !(await named.isAvailable()):
  │         notify `Backend 'X' is registered but unavailable.`; return  (REQ-3)
  │     } catch { notify same; return }
  │     backend = named
  │
  ├─ else (first token is not --backend):                         (REQ-5)
  │     selection = await selectBgTerminalBackend();              (UNCHANGED)
  │     if !selection.ok: notify none-registered / all-unavailable; return
  │     backend = selection.backend
  │
  ├─ tokens = parse.restArgs.split(/\s+/)   (today: args.split)
  │     ... existing <agent> <task> parse, preflight, launch, cleanup ...
  │
  └─ (existing post-launch updateBgReservationOwner uses backend.name)   (REQ-9)
```

Two existing lines change inside `handleBgCommand`: (1) `const tokens = args.split(/\s+/);` → `const tokens = parse.restArgs.split(/\s+/);`, and (2) the launch-failure notification `Launch failed: ${...}` → `Launch failed via ${backend.name}: ${...}` (REQ-4). The selection block above tokenization (L666-676 today) is replaced wholesale with the parse + branch (single anchored EDIT — see Appendix B step 1.4). Everything else below tokenization — preflight, launch, cleanup, `updateBgReservationOwner`, status line — is byte-unchanged.

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/index.ts` | L28 | `import { getBgTerminalBackend, getBgTerminalBackendByName, selectBgTerminalBackend } from "./lib/bg-terminal.ts";` | EDIT (anchored): append `listBgTerminalBackends` to this import, and add a new `import { parseBgArgs } from "./lib/bg-args.ts";` line. |
| `agents/index.ts` | L661 | `export async function handleBgCommand(args, ctx, diagnostics)` | Add `parseBgArgs(args)` at the top; branch on `backendFlagMissingValue` / `backendName`. |
| `agents/index.ts` | L666-676 | the `const selection = await selectBgTerminalBackend(); ... const backend = selection.backend;` block | EDIT (anchored, single-block replace): wrap with the parse + named-branch + else-fallback. |
| `agents/index.ts` | L673 (post-block) | `const tokens = args.split(/\s+/);` | EDIT (anchored): `args` → `parse.restArgs`. |
| `agents/index.ts` | L722 | `ctx.ui.notify(`Launch failed: ${launchResult.error ?? "unknown error"}`, "error");` | EDIT (anchored): include `backend.name` → `Launch failed via ${backend.name}: ${...}`. The ONLY edit below tokenization (REQ-4). |
| `agents/index.ts` | L727-740 | post-launch `updateBgReservationOwner(..., { ownerBackendName: backend.name })` | UNCHANGED — already uses `backend.name`. New test asserts REQ-9. |
| `agents/lib/bg-terminal.ts` | L165-189 | `selectBgTerminalBackend` | UNCHANGED (REQ-11). |
| `agents/lib/bg-terminal.ts` | L156-158 | `getBgTerminalBackendByName` | UNCHANGED; becomes a SECOND production caller (was reaper-only). |
| `agents/lib/bg-terminal.ts` | L189-191 | `listBgTerminalBackends` | UNCHANGED; first production caller (for the unknown-name error list). |
| `agents/lib/bg-state.ts` | L39-51 | `export type BgRunManifest = { version, runId, identity, task, options, mac, keyGenId }` | UNCHANGED. Referenced by REQ-12 tests via `readBgManifest`. **There is NO `argvPreview` field.** |
| `tmux-terminal/lib/constants.ts` | L6 | `TMUX_BACKEND_NAME = "tmux"` | UNCHANGED. |
| `cmux-terminal/lib/constants.ts` | L3, L5 | `CMUX_BACKEND_NAME = "cmux"`, `CMUX_BACKEND_PREFERENCE = 10` | UNCHANGED. |
| `agents/test-fixtures/test-bg.mjs` | L118-160 | `makeFakeBackend({ name })` | Already supports `opts.name`; reused as-is. |
| `agents/test-fixtures/test-bg.mjs` | L35-48 | `readBgManifest` already imported | Reused as-is for REQ-12 (no new import). |
| `agents/test-fixtures/test-bg.mjs` | `main()` at EOF | test registration block | APPEND new `test(...)` lines after the existing ones. |

## Slice Ladder

Single slice. Feature is ~300 LOC; splitting would create artificial seams. List for traceability.

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P5E1-1` | positional `--backend <name>` selector on `/agents bg` | `agents/lib/bg-args.ts` (NEW), `agents/index.ts`, `agents/test-fixtures/test-bg.mjs`, `agents/test-fixtures/test-bg-args.mjs` (NEW), `agents/test-fixtures/run-p5e1-tests.sh` (NEW) | `parseBgArgs`; import + branch in `handleBgCommand`; 20 new tests; run script. | See Test Case Catalog. | REQ-11 (no `bg-terminal.ts` changes; gated by `git diff --stat ... \| wc -l = 0`), REQ-5 (5 existing tests stay green unmodified). |

### Dependency graph

```text
P5E1-1 (single slice; no internal sub-slice deps)
   ↑ (depends on already-merged P5b-1 cmux-terminal providing a second backend for integration tests)
   ↑ (depends on P4-5 handleBgCommand shape, unchanged below tokenization)
```

No parallel slices. P5b alternative backend work (zellij/wezterm) can start independently of this slice; they'd use the `--backend <name>` seam this slice exposes to verify fall-through paths.

## Cut Order

If context or implementation scope grows, cut in this order:

1. REQ-10 (pure `parseBgArgs` in its own file) — fold parsing inline into `handleBgCommand`. Re-introduce when stable.
2. The `testParse*` pure-parser test file — keep only the integration tests in `test-bg.mjs`.
3. EC8 / `testBackendEqualsFormPassedThrough` — keep the pure-parser `testParseEqualsFormNotConsumed` only.

Do not cut:

- REQ-1 (named launch behavior) — this IS the feature.
- REQ-2 / REQ-3 (unknown-name and unavailable error paths) — these are the safety surface.
- REQ-5 (back-compat: 5 existing tests stay green unmodified) — non-negotiable; a regression here means the slice broke the automatic path.
- REQ-6 (flag pair not in agent/task) — security boundary; cutting reopens the leak surface.
- REQ-12 (no leak into launch config / `manifest.task`) — security boundary.
- REQ-11 (no `bg-terminal.ts` changes) — the guard that keeps the seam correct.

## Contracts

### `parseBgArgs(rawArgs: string): BgArgsParseResult`

**Input contract:** `rawArgs` is the verbatim `args` string passed to `handleBgCommand` (the user's input after `/agents bg `). May be empty, whitespace-only, start with `--backend`, or not.

**Output contract:** See `BgArgsParseResult` above. Pure; deterministic; no throws.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. No flag | `rawArgs` is empty/whitespace OR the first whitespace-delimited token (of `trimmed`) is not exactly `"--backend"` | `{ restArgs: <rawArgs, UNTRIMMED original> }` (no `backendName`, `backendFlagMissingValue: false`) — byte-identical to today's `args` so `handleBgCommand`'s `.split(/\s+/)` sees the same token stream |
| B. Flag with value | the first token is `"--backend"` AND there is at least one more token | `{ backendName: <tokens[1]>, backendFlagMissingValue: false, restArgs: <tokens[2..].join(" ")> }` (whitespace-collapsed by split+join; no leading/trailing whitespace) |
| C. Flag with no value | the first token is `"--backend"` AND it is the only token | `{ backendName: "", backendFlagMissingValue: true, restArgs: "" }` |

**Corollaries (follow from A; listed for the Edge Cases table):**
- `--backend=cmux` as the first token → State A (it is not the exact token `"--backend"`); `restArgs` keeps it whole.
- A `--backend` token anywhere after the first token → State A; that token is preserved verbatim in `restArgs` and becomes task text downstream.
- A second `--backend <name>` pair after a valid first pair → State B for the FIRST pair; the second pair stays in `restArgs` as task text (no recursion).

**Error codes:** `parseBgArgs` does not throw. All error states are encoded as fields the caller branches on (`backendFlagMissingValue` for C; downstream errors for State-A-with-garbage come from the existing agent-resolution / tokenization usage paths).

### `handleBgCommand` selection branch (informal)

| State | `parse.backendFlagMissingValue` | `parse.backendName` | registry result | Output |
|---|---|---|---|---|
| 1 | true | (ignored) | (none) | notify usage; return (REQ-7) |
| 2 | false | undefined | (none — no flag) | existing `selectBgTerminalBackend()` path (REQ-5) |
| 3 | false | `"X"` | `getBgTerminalBackendByName(X)` → undefined | notify `Unknown backend 'X'. Registered: <names>`; return (REQ-2) |
| 4 | false | `"X"` | backend found, `isAvailable()` → false/throw | notify `Backend 'X' is registered but unavailable.`; return (REQ-3) |
| 5 | false | `"X"` | backend found, available | backend = named backend; proceed to tokenization (REQ-1) |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `--backend` is the only token (`/agents bg --backend`) | State C → `backendFlagMissingValue: true` → usage error, no launch. | `testBackendFlagMissingValueErrors`, `testParseFlagNoValue` |
| EC2 | `--backend cmux` with cmux + tmux both registered + available, cmux preferred (pref 10) | State B → launches via cmux (named path); success notification `via cmux`. tmux's `launch()` NOT called. | `testBackendFlagLaunchesNamedBackend` (positive: `via cmux`), `testBackendFlagBypassesPreference` (asserts tmux NOT called) |
| EC3 | `--backend tmux` with both registered + available, cmux preferred | State B → launches via tmux despite cmux's higher preference. cmux's `launch()` NOT called. | `testBackendFlagBypassesPreference` |
| EC4 | `--backend zellij` with only tmux + cmux registered | State B → `getBgTerminalBackendByName("zellij")` = undefined → notify `Unknown backend 'zellij'. Registered: tmux, cmux` (registration order); no launch. | `testBackendFlagUnknownNameErrorsWithList`, `testBackendFlagUnknownNameDoesNotLaunch` |
| EC5 | `--backend cmux` with cmux registered but `isAvailable()` → false; tmux registered + available + pref 10 | State B → notify `Backend 'cmux' is registered but unavailable.`; do NOT launch via tmux. | `testBackendFlagUnavailableDoesNotFallThrough`, `testBackendFlagUnavailableNamesBackend` |
| EC6 | Multi-word task: `/agents bg --backend cmux scout do research now` | State B → backendName=`cmux`, restArgs=`scout do research now`; agentName=`scout`, task=`do research now`; launches via cmux. | `testBackendFlagLaunchesNamedBackend` (task = multi-word) |
| EC7 | `--backend` text inside the task: `/agents bg scout do --backend thing` | State A (first token is `scout`, not `--backend`) → no flag → existing path; the literal `--backend` survives as part of `manifest.task` ("do --backend thing"); launches via the preference winner. | `testBackendFlagMidArgsNotConsumed` (asserts `manifest.task` contains `--backend` literally) |
| EC8 | `--backend=cmux` first token: `/agents bg --backend=cmux scout task` | State A (first token is `--backend=cmux`, not `--backend`) → no flag → existing path: `selectBgTerminalBackend()` runs first; if a backend is available, tokenization yields agentName=`--backend=cmux` → `resolveRegisteredRunTarget` fails with the existing unknown-agent error; if no backend is available, the no-backend error fires before agent resolution. NOT a special `--backend=` rejection. | `testBackendEqualsFormPassedThrough` (asserts the existing error fires — unknown-agent when a backend is available, no-backend when none — not a successful launch), `testParseEqualsFormNotConsumed` (asserts `restArgs` keeps `--backend=cmux`) |
| EC9 | `--backend CMUX` (wrong case) | State B → `getBgTerminalBackendByName("CMUX")` → undefined (exact match) → unknown-name error lists `tmux, cmux`. | `testBackendFlagCaseSensitive` |
| EC10 | Duplicate flag, second pair after a valid first pair: `/agents bg --backend tmux scout --backend cmux thing` | State B for the first pair → backendName=`tmux`, restArgs=`scout --backend cmux thing`; agentName=`scout`, task=`--backend cmux thing`; launches via tmux (the second pair is task text, not consumed). | `testBackendFlagDuplicateSecondPairPassesThrough`, `testParseDuplicateSecondPairPassesThrough` |
| EC11 | Launch failure under `--backend`: `--backend tmux scout task` where tmux's `launch()` returns `failed` | Existing cleanup (write `bg-result` `failed` + `markBgRunDone`) runs; failure notification names `tmux`. | `testBackendFlagLaunchFailureCleansAndNamesBackend` |

## Test Case Catalog

Grouped by concern. Every test name here SHALL appear in the Requirements table OR be explicitly tagged as an Edge-Case-only test (EC7/EC8/EC10/EC11 below).

```text
Group 1: named-launch happy path (2 tests)
  testBackendFlagLaunchesNamedBackend      (REQ-1, EC2, EC6)
  testBackendFlagBypassesPreference        (REQ-1, EC2, EC3)

Group 2: error paths (5 tests)
  testBackendFlagMissingValueErrors        (REQ-7, EC1)
  testBackendFlagUnknownNameErrorsWithList (REQ-2, EC4)
  testBackendFlagUnknownNameDoesNotLaunch  (REQ-2, EC4)
  testBackendFlagUnavailableDoesNotFallThrough (REQ-3, EC5)
  testBackendFlagUnavailableNamesBackend   (REQ-3, EC5)

Group 3: positional contract + leak boundary (4 tests)
  testBackendFlagMidArgsNotConsumed        (REQ-6, EC7)
  testBackendFlagNotInLaunchConfigOrManifest (REQ-12)
  testBackendEqualsFormPassedThrough       (EC8)
  testBackendFlagDuplicateSecondPairPassesThrough (EC10)

Group 4: case sensitivity + launch failure + persistence (3 tests)
  testBackendFlagCaseSensitive             (EC9)
  testBackendFlagLaunchFailureCleansAndNamesBackend (REQ-4, EC11)
  testBackendFlagPersistsOwnerName         (REQ-9)

Group 5: back-compat — UNMODIFIED pre-existing, asserted green (5 tests)
  testPreflightToLaunchContract            (REQ-5)
  testBgCommandFallsThroughToTmux          (REQ-5)
  testBgCommandReportsNoneAvailable        (REQ-5)
  testBgCommandListsProbedBackendsWhenAllUnavailable (REQ-5)
  testBgBeforeSessionStart                 (REQ-5)

Group 6: pure-parser unit (6 tests)
  testParseNoFlag                          (REQ-10, State A)
  testParseFlagWithValue                   (REQ-6, REQ-10, State B)
  testParseFlagNoValue                     (REQ-7, REQ-10, State C)
  testParseEqualsFormNotConsumed           (REQ-10, EC8)
  testParseDuplicateSecondPairPassesThrough (REQ-10, EC10)
  testParseNoFlagPreservesRawArgs          (REQ-5, REQ-10 — State A returns untrimmed rawArgs; back-compat)
```

Total: 25 tests = 20 new (Groups 1-4 + Group 6: 2+5+4+3+6 = 20) + 5 pre-existing asserted-green (Group 5).

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Parsing `--backend` shifts the token layout for the no-flag path | High | Positional design: when the first token is not `--backend`, `restArgs === rawArgs` (the ORIGINAL untrimmed string), so `handleBgCommand`'s `tokens = parse.restArgs.split(/\s+/)` is byte-identical to today's `tokens = args.split(/\s+/)` — including the leading-whitespace → empty agentName → usage-error path. REQ-5 + the 5 back-compat tests gate this. |
| Named-but-unavailable silently falls through to the preference winner | Medium | REQ-3 explicit-error contract + `testBackendFlagUnavailableDoesNotFallThrough` negative control. |
| `--backend` value leaks into launch config or `BgRunManifest.task` | High | REQ-6 (positional strip) + REQ-12 (assert a fake-backend name sentinel is absent from every launch-config field AND from `manifest.task`; assert the legitimate task sentinel IS present). Negative control = `testParseFlagWithValue` (a broken strip fails this unit test). |
| Drift in `agents/lib/bg-terminal.ts` (selector/refactor) breaks the reaper's existing name-routing | Medium | REQ-11: zero lines changed in `bg-terminal.ts`, gated by `git diff --stat agents/lib/bg-terminal.ts \| wc -l = 0`. The red-control in Appendix B step 1.9 proves the gate is content-sensitive. |
| User writes `--backend` mid-string expecting it to be honored | Low | Positional contract is documented in the missing-value usage string (`Usage: /agents bg <agent> <task> [--backend <name>]`). Mid-string `--backend` becomes task text (no data loss, no security boundary crossed). `testBackendFlagMidArgsNotConsumed` proves the token survives intact. |
| Second production caller of `getBgTerminalBackendByName` (was reaper-only) creates a hidden coupling | Low | No change to the function (REQ-11); the slice proves the seam is reusable without modification — adding a caller is the desired property, not a regression. |

## Open Decisions

- **Persistent default backend per project**: deferred. Needs the trust-reader layer (P4R-PROJ). Decided: out of scope (Non-Goals).
- **NLP routing "use cmux" → `--backend cmux`**: deferred to the NL → `/agents bg` intent-gate follow-up. Rationale: this slice keeps parsing purely textual; the NLP hook can emit the `--backend` flag once it exists.
- **Listing available (not just registered) backends in the unknown-name error**: punted. The unknown-name error lists registered names (REQ-2) because probing `isAvailable()` for every registered backend on every unknown-name path adds latency and side effects. Revisit if users report confusion.
- **Whether `--backend unknown` should also surface in `/agents bg-status`**: punted. `bg-status` already shows `via <name>` per run once a run exists; no selector decision is needed there.
- **Flag-position flexibility (allow `--backend <name>` after `<agent>` too)**: explicitly rejected in this slice (Non-Goals). Greedy-anywhere parsing reintroduces the EC7/EC10 ambiguity. If users clamor for it, a future slice adds quote-aware parsing; until then, positional-first is the documented contract.

## Done Criteria

All MUST requirements passing = done. Concretely:

- [ ] `bash agents/test-fixtures/run-p5e1-tests.sh` prints all 25 tests passing (20 new + 5 back-compat).
- [ ] `git diff --stat agents/lib/bg-terminal.ts | wc -l` returns `0` (REQ-11). The red-control in Appendix B step 1.9 proves this gate is content-sensitive.
- [ ] `git diff agents/test-fixtures/test-bg.mjs` shows the 5 back-compat test bodies UNCHANGED (REQ-5) — only APPENDED `test(...)` registrations at `main()` and the new test functions.
- [ ] Manual smoke (UNGUARDED-IN-CI, optional): with both `tmux-terminal` and `cmux-terminal` loaded and cmux reachable, `/agents bg --backend tmux scout test` launches a `pi-agent-*` window in tmux (not cmux). Captured via `tmux list-windows -F '#{window_name}' \| grep pi-agent-` matching the runId returned in the success notification.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | codex (via cmux) | gpt-5.5 high | 7 | changes-requested — see "Resolved blockers (R1 → R2)" below |
| 2 | codex (via cmux) | gpt-5.5 high | 2 | changes-requested — R1 7/7 resolved; 2 new blockers (R2-B1 REQ-4 notification, R2-B2 untrimmed State A) + 3 nits — see "Resolved blockers (R2 → R3)" below |
| 3 | codex (via cmux) | gpt-5.5 high | 0 | approve-with-nits — R2 5/5 resolved; 2 nits (Risk-Analysis row wording, Files-to-modify table omission) fixed post-R3 — see "Resolved blockers (R3 final)" below |
| 4 | (pending — optional R4 confirmation) | | | |

### Resolved blockers (R1 → R2 revisions)

| # | R1 blocker | Resolution in this revision |
|---|---|---|
| 1 | REQ-8/EC8 wrong against current behavior — no unknown-flag parser; `--backend=cmux` left in `restArgs` would silently become agent/task, not error. | Dropped REQ-8. Adopted positional-first: `--backend` is only recognized as the literal first token, so `--backend=cmux` is State A and flows to the existing agent-resolution path. EC8 rewritten; new tests `testBackendEqualsFormPassedThrough` + `testParseEqualsFormNotConsumed`. |
| 2 | EC7 contradicted the greedy parser (no quote-awareness). | Positional design eliminates the contradiction: a `--backend` token after the first position is State A and passes through as task text. EC7 rewritten to assert the literal `--backend` survives in `manifest.task`. New test `testBackendFlagMidArgsNotConsumed`. |
| 3 | EC10 was false (leftover duplicate flag becomes task text, not usage error). | EC10 rewritten to reflect actual positional behavior: second pair stays in `restArgs` as task text and launches via the first-named backend. New tests `testBackendFlagDuplicateSecondPairPassesThrough` + `testParseDuplicateSecondPairPassesThrough`. |
| 4 | REQ-12 asserted a nonexistent `argvPreview` manifest field. | Verified `BgRunManifest` (`agents/lib/bg-state.ts:39-51`) has `{ version, runId, identity, task, options, mac, keyGenId }` — no `argvPreview`. REQ-12 rewritten to assert a fake-backend name sentinel is absent from `backend.launch(config)`'s `agentName`/`runId`/`manifestPath`/`cwd` AND from `BgRunManifest.task` (read via `readBgManifest`); legitimate task sentinel IS present in `manifest.task`. |
| 5 | Appendix B step 1.5's anchored replacement was unsafe (1.4 already rewrote part of the block 1.5 re-anchored on). | Collapsed into a single anchored EDIT (step 1.4) that replaces the entire L666-676 selection block with the parse + named-branch + else-fallback in one `ANCHOR → REPLACE`. No two-step split. |
| 6 | Test accounting inconsistent (9 vs 15 vs 15+5+6). | Reconciled: 20 new (Groups 1-4: 2+5+4+3 = 14 integration; Group 6: 6 pure-parser) + 5 back-compat = 25 total. Every test in the Catalog maps to a REQ or an EC; every MUST REQ maps to ≥1 named test. |
| 7 | Red-control for REQ-11 used `touch` (mtime-only), which `git diff --stat` does not detect. | Switched to a content-modifying break: `printf 'export const __BREAK=1;\n' >> agents/lib/bg-terminal.ts` then `git diff --stat agents/lib/bg-terminal.ts \| wc -l` (must be ≥1, red), then `git checkout agents/lib/bg-terminal.ts` (restore, green). Step 1.9 also drops the aspirational `BREAK_REQ3`/`BREAK_REQ6` env-var language (no test consumes those) and replaces it with concrete temporary-source-edit red-then-green controls. |

### Resolved blockers (R2 → R3 revisions)

| # | R2 blocker/nit | Resolution in this revision |
|---|---|---|
| R2-B1 (HIGH) | REQ-4 said the failure notification names the backend, but the plan also said everything below tokenization is byte-unchanged. Live `agents/index.ts:722` is `Launch failed: ${...}` with no `backend.name`. | Added a one-line anchored EDIT (Appendix B step 1.5): `Launch failed: ${...}` → `Launch failed via ${backend.name}: ${...}`. Updated REQ-4, Non-Goals, Resolution/flow, and Existing Hook Points (L722 row) to acknowledge this as the ONLY edit below tokenization. Verified the existing `testLaunchFailureCleansReservation` does NOT assert the notification string (only `result.ok`, `launch.status`, slot count), so it stays green. |
| R2-B2 (MED) | Plan claimed no-flag trimming is back-compatible because `.split(/\s+/)` "already tolerates leading/trailing whitespace" — false: `"  scout task".split(/\s+/)` → `["","scout","task"]` → empty agentName → usage error today, but trimmed `restArgs` would launch. | `parseBgArgs` State A now returns the ORIGINAL UNTRIMMED `rawArgs` (not `trimmed`). Updated the Shared-constants source, State A table row, REQ-5/REQ-6 wording, Key-types JSDoc, and the `testParseNoFlagPreservesRawArgs` test (asserts `parseBgArgs('  scout do  ').restArgs === '  scout do  '` and `parseBgArgs('   ').restArgs === '   '`). Dropped the false "already tolerates" claim. |
| R2-N1 (nit) | Group 6 said "6 tests" but step 1.2 listed 7 assertion bodies. | Folded the whitespace-only assertion into `testParseNoFlagPreservesRawArgs` (now 2 assertions in one test). Group 6 stays at 6 named tests; step 1.2 labels each assertion with its test name. |
| R2-N2 (nit) | EC8 should note backend selection runs before agent resolution. | EC8 rewritten: `selectBgTerminalBackend()` runs first; if a backend is available → unknown-agent error on `--backend=cmux`; if none → no-backend error fires first. |
| R2-N3 (nit) | Risk table said positional behavior is documented in the usage string AND unknown-name error, but the unknown-name error doesn't mention positional syntax. | Risk table row corrected: positional contract is documented in the missing-value usage string only; removed the false "and in the unknown-name error" claim. |

### Resolved blockers (R3 final nits)

| # | R3 nit | Resolution |
|---|---|---|
| R3-N1 | Risk Analysis table row (line ~317) still said "documented in the usage string and the unknown-name error" — a second instance missed in R2. | Corrected to "documented in the missing-value usage string" only. |
| R3-N2 | Appendix "Files to modify" table for `agents/index.ts` listed (a)(b)(c) but omitted the launch-failure notification edit. | Added (c) for the L722 notification edit; renumbered the args.split change to (d). |

## Appendix: Implementation Plan

### Files to create

1. `agents/lib/bg-args.ts` — `parseBgArgs` pure function + `BgArgsParseResult` type (REQ-10).
2. `agents/test-fixtures/test-bg-args.mjs` — pure-parser unit tests (Group 6, 6 tests). Imports `parseBgArgs` from `../lib/bg-args.ts`.
3. `agents/test-fixtures/run-p5e1-tests.sh` — test runner invoking `test-bg-args.mjs` + `test-bg.mjs`.

### Files to modify

| File | Change |
|---|---|
| `agents/index.ts` | (a) extend the existing L28 import to add `listBgTerminalBackends`, and add a new `import { parseBgArgs } from "./lib/bg-args.ts";` line; (b) replace the L666-676 selection block with the parse + named-branch + else-fallback (single anchored EDIT); (c) change the L722 launch-failure notification `Launch failed: ${...}` → `Launch failed via ${backend.name}: ${...}` (REQ-4 — the only edit below tokenization); (d) change `const tokens = args.split(/\s+/);` to `const tokens = parse.restArgs.split(/\s+/);`. |
| `agents/test-fixtures/test-bg.mjs` | APPEND 14 new `test*` functions (Groups 1-4) + their `await test(...)` registrations inside `main()` at EOF (above the final `console.log`). No new imports needed — `listBgTerminalBackends` and `readBgManifest` are already imported (L51, L35). |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | Author `agents/lib/bg-args.ts` with `parseBgArgs` + `BgArgsParseResult` (positional-first source from Appendix B Shared constants). | `npx --yes tsx -e "import('./agents/lib/bg-args.ts').then(m=>{const r=m.parseBgArgs('--backend cmux scout do'); if(r.backendName!=='cmux'\|\|r.restArgs!=='scout do')throw new Error(JSON.stringify(r));console.log('OK')})"` prints `OK`. |
| 2 | Author `agents/test-fixtures/test-bg-args.mjs` (Group 6, 6 pure-parser tests). | `npx --yes tsx agents/test-fixtures/test-bg-args.mjs` exits 0 with 6 `✓` lines. |
| 3 | Apply the four anchored EDITs to `agents/index.ts` (import line, selection block, notification line, args.split line). | `grep -n 'listBgTerminalBackends, selectBgTerminalBackend\|parseBgArgs(args)\|Launch failed via\|parse.restArgs.split' agents/index.ts` returns the expected matches; `npx --yes tsx -e "import('./agents/index.ts').then(m=>typeof m.handleBgCommand==='function'&&console.log('OK'))"` prints `OK`. |
| 4 | APPEND the 14 new integration tests to `agents/test-fixtures/test-bg.mjs`. | `grep -c 'await test(' agents/test-fixtures/test-bg.mjs` increases by 14; the 5 back-compat `test(...)` lines remain. |
| 5 | Author `agents/test-fixtures/run-p5e1-tests.sh`; `chmod +x`. | `bash agents/test-fixtures/run-p5e1-tests.sh` prints all 25 tests passing and exits 0. |
| 6 | Run the red-then-green controls (Appendix B step 1.9). | Each control goes RED on the broken input and GREEN after revert. |

### Risks

(Mirrors the Risk Analysis table; see above.)

## Appendix B: Mechanical Execution Spec (for a low-capability executor)

### Executor contract (copy verbatim into the plan)

1. Do the steps **in numeric order**. Do not skip, reorder, or batch.
2. Each step says exactly which file, what to add/change, and how to verify.
3. **Make no design decisions.** If a step is ambiguous or the anchor text is not found verbatim, **STOP and ask**.
4. Run the verify command after each step. If it fails, fix only that step; do not proceed until green.
5. Slice test command: `bash agents/test-fixtures/run-p5e1-tests.sh`.
6. **Edit exactly ONE file per step** — the single file named in that step's `File` column. Read-only references (look but never edit): `agents/lib/bg-terminal.ts`, `agents/lib/bg-state.ts`, `tmux-terminal/lib/constants.ts`, `cmux-terminal/lib/constants.ts`.
7. **Surgical edits only — minimize blast radius.** For an existing file, use an anchored find-and-replace: the step gives the **verbatim `ANCHOR`** and the **exact `REPLACE`** text. Change only that span; never rewrite a whole file or function. Three action kinds only: **CREATE** (whole-file write — brand-new file), **EDIT** (anchored `ANCHOR → REPLACE` on existing content), **APPEND** (add a new export/block at end of an existing file).
8. One slice = one commit, message `P5E1-1: positional --backend selector for /agents bg`, with the required `Co-Authored-By` trailer.
9. **No aspirational output.** Every human-readable line that *describes a check* MUST be backed by an assertion that actually performs that check.

**Executor-ready gate:** every step's `File` column names exactly one file; every step on an existing file quotes a verbatim `ANCHOR` + exact `REPLACE` (smallest diff that achieves the change); whole-file `Write` appears only for new-file create steps; no step text contains "decide", "choose", "figure out", "as appropriate", "if needed", "etc.", "e.g.", or — as a *description of intent* — "assert that", "verify that", "check that", or "ensure"; every constant, error string, regex, and signature appears verbatim.

### Shared constants / types (add once)

```ts
// agents/lib/bg-args.ts — exact source for the CREATE step below.
export interface BgArgsParseResult {
	readonly backendName?: string;
	readonly backendFlagMissingValue: boolean;
	readonly restArgs: string;
}

export function parseBgArgs(rawArgs: string): BgArgsParseResult {
	const trimmed = (rawArgs ?? "").trim();
	const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
	if (tokens[0] !== "--backend") {
		// State A: return the ORIGINAL untrimmed rawArgs so handleBgCommand's
		// `parse.restArgs.split(/\s+/)` is byte-identical to today's
		// `args.split(/\s+/)` (including the leading-whitespace → empty
		// agentName → usage-error path). The command dispatcher trims
		// `parsed.rest` in production, so this only matters for direct calls.
		return { backendFlagMissingValue: false, restArgs: rawArgs ?? "" };
	}
	// State C: `--backend` is the only token (no value follows).
	if (tokens.length < 2) {
		return { backendFlagMissingValue: true, backendName: "", restArgs: "" };
	}
	// State B: `--backend <name>` is the first two tokens; rest becomes agent+task.
	const name = tokens[1];
	const rest = tokens.slice(2).join(" ");
	return { backendName: name, backendFlagMissingValue: false, restArgs: rest };
}
```

Error-string constants (used verbatim in the `handleBgCommand` branch):

```ts
const ERR_NO_BACKEND_VALUE = "Usage: /agents bg <agent> <task> [--backend <name>]";
const ERR_UNKNOWN_BACKEND = (name: string, names: string) =>
	`Unknown backend '${name}'. Registered: ${names}`;
const ERR_BACKEND_UNAVAILABLE = (name: string) =>
	`Backend '${name}' is registered but unavailable.`;
```

### `P5E1-1` — positional `--backend` selector on `/agents bg` (REQ-1..7,9..12)

| Step | File | Exact action (CREATE / EDIT anchored / APPEND) | Verify |
|---|---|---|---|
| 1.1 | `agents/lib/bg-args.ts` | **CREATE** (Write). Full contents: the exact source in "Shared constants / types" above. | `npx --yes tsx -e "import('./agents/lib/bg-args.ts').then(m=>{const a=m.parseBgArgs('scout do');const b=m.parseBgArgs('--backend cmux scout do');const c=m.parseBgArgs('--backend');if(a.backendName!==undefined\|\|a.restArgs!=='scout do')throw new Error('A');if(b.backendName!=='cmux'\|\|b.restArgs!=='scout do')throw new Error('B');if(!c.backendFlagMissingValue)throw new Error('C');console.log('OK')})"` prints `OK`. |
| 1.2 | `agents/test-fixtures/test-bg-args.mjs` | **CREATE** (Write). Full contents: a `node:test`-style module that imports `parseBgArgs` from `../lib/bg-args.ts` and runs the 6 Group-6 tests. Each assertion references the literal observed value of `parseBgArgs(...)` against an expected concrete string. Test bodies (verbatim, 6 named tests): `assert.deepStrictEqual(parseBgArgs('scout do'), { backendFlagMissingValue: false, restArgs: 'scout do' });` (testParseNoFlag) `assert.deepStrictEqual(parseBgArgs('--backend cmux scout do'), { backendName: 'cmux', backendFlagMissingValue: false, restArgs: 'scout do' });` (testParseFlagWithValue) `assert.deepStrictEqual(parseBgArgs('--backend'), { backendName: '', backendFlagMissingValue: true, restArgs: '' });` (testParseFlagNoValue) `assert.deepStrictEqual(parseBgArgs('--backend=cmux scout'), { backendFlagMissingValue: false, restArgs: '--backend=cmux scout' });` (testParseEqualsFormNotConsumed) `assert.deepStrictEqual(parseBgArgs('--backend tmux scout --backend cmux thing'), { backendName: 'tmux', backendFlagMissingValue: false, restArgs: 'scout --backend cmux thing' });` (testParseDuplicateSecondPairPassesThrough) `assert.deepStrictEqual(parseBgArgs('  scout do  '), { backendFlagMissingValue: false, restArgs: '  scout do  ' });` AND `assert.deepStrictEqual(parseBgArgs('   '), { backendFlagMissingValue: false, restArgs: '   ' });` (testParseNoFlagPreservesRawArgs — asserts State A returns the UNTRIMMED original). (6 named tests; each prints `✓ <name>`). | `npx --yes tsx agents/test-fixtures/test-bg-args.mjs` exits 0 and prints 6 `✓` lines. Negative control: temporarily edit `bg-args.ts` to return `{ backendFlagMissingValue: false, restArgs: rawArgs ?? '' }` unconditionally (skip ALL flag consumption), re-run → exits non-zero on `testParseFlagWithValue` and `testParseDuplicateSecondPairPassesThrough`; revert. |
| 1.3 | `agents/index.ts` | **EDIT** (anchored). `ANCHOR:` `import { getBgTerminalBackend, getBgTerminalBackendByName, selectBgTerminalBackend } from "./lib/bg-terminal.ts";` → `REPLACE:` `import { getBgTerminalBackend, getBgTerminalBackendByName, listBgTerminalBackends, selectBgTerminalBackend } from "./lib/bg-terminal.ts";`<newline>`import { parseBgArgs } from "./lib/bg-args.ts";` | `grep -n 'listBgTerminalBackends, selectBgTerminalBackend' agents/index.ts` matches once; `grep -n "from \"./lib/bg-args.ts\"" agents/index.ts` matches once. |
| 1.4 | `agents/index.ts` | **EDIT** (anchored, single-block replace). `ANCHOR:` the exact 11-line block beginning `	const selection = await selectBgTerminalBackend();` and ending `	const backend = selection.backend;` (lines L666-676, byte-for-byte including the leading single-tab on each line) → `REPLACE:` the exact block from "Replace block for step 1.4" below (single anchored replacement; the existing `if (!selection.ok) { ... }` body is moved INSIDE the `else` branch verbatim, and a new `parse + named-branch` precedes it). | `grep -n 'parseBgArgs(args)' agents/index.ts` matches once; `grep -n 'let backend;' agents/index.ts` matches once; `npx --yes tsx -e "import('./agents/index.ts').then(m=>typeof m.handleBgCommand==='function'&&console.log('OK'))"` prints `OK`. |
| 1.5 | `agents/index.ts` | **EDIT** (anchored). `ANCHOR:` `		ctx.ui.notify(`Launch failed: ${launchResult.error ?? "unknown error"}`, "error");` → `REPLACE:` `		ctx.ui.notify(`Launch failed via ${backend.name}: ${launchResult.error ?? "unknown error"}`, "error");` (REQ-4 — the only edit below tokenization). | `grep -n 'Launch failed via' agents/index.ts` matches once; `grep -n 'Launch failed:' agents/index.ts` returns 0 lines. |
| 1.6 | `agents/index.ts` | **EDIT** (anchored). `ANCHOR:` `	const tokens = args.split(/\s+/);` → `REPLACE:` `	const tokens = parse.restArgs.split(/\s+/);` | `grep -n 'parse.restArgs.split' agents/index.ts` matches once; `grep -n 'args.split' agents/index.ts` returns 0 lines inside `handleBgCommand`. |
| 1.7 | `agents/test-fixtures/test-bg.mjs` | **APPEND** the 14 new test functions (Groups 1-4) immediately above the line `console.log("P4-7 bg integration tests passed");` inside `main()`, and APPEND their `await test("...", <name>)` registrations in the same edit, before that final `console.log`. Each new test uses the existing `makeFakeBackend({ name: "cmux" })` / `{ name: "tmux" }` / `{ name: "zznoleak-probe" }` helpers, `registerBgTerminalBackend`, `withTempHome`, `setupRegisteredUserAgent`, `makeCtx`, `resetAll`, and `readBgManifest`. Each assertion references an observed captured value (`backend._getConfigLog()[0]` field, `lastNotified`, or a `readBgManifest(...).task` field) against an expected concrete value. Negative controls for REQ-3: register a higher-preference available sibling and assert its `_getConfigLog().length === 0`. The REQ-12 test registers a fake backend named `"zznoleak-probe"`, runs `handleBgCommand("--backend zznoleak-probe researcher legit-task-sentinel-9f8", ctx, diag)`, and asserts `config.agentName === "researcher"`, none of `config.{agentName,runId,manifestPath,cwd}` contains `"zznoleak-probe"` or `"--backend"`, and `readBgManifest(paths).task === "legit-task-sentinel-9f8"`. | `grep -c 'await test(' agents/test-fixtures/test-bg.mjs` is 14 greater than before this step; `git diff agents/test-fixtures/test-bg.mjs \| grep '^-' \| grep -v '^---'` shows NO removals from the 5 back-compat tests (their bodies unchanged). |
| 1.8 | `agents/test-fixtures/run-p5e1-tests.sh` | **CREATE** (Write). Full contents: `#!/usr/bin/env bash`<newline>`set -euo pipefail`<newline>`cd "$(dirname "$0")/../.."`<newline>`npx --yes tsx agents/test-fixtures/test-bg-args.mjs`<newline>`npx --yes tsx agents/test-fixtures/test-bg.mjs`<newline>. After write: `chmod +x agents/test-fixtures/run-p5e1-tests.sh`. | `bash agents/test-fixtures/run-p5e1-tests.sh` prints all 25 tests passing and exits 0. |
| 1.9 | (whole slice) | Red-then-green controls (run inline; each must go RED then GREEN after revert; nothing committed in between). **(a) REQ-11 content gate:** `printf 'export const __BREAK_REQ11 = 1;\n' >> agents/lib/bg-terminal.ts` then `git diff --stat agents/lib/bg-terminal.ts \| wc -l` MUST print a number ≥ 1 (RED); then `git checkout agents/lib/bg-terminal.ts` and re-run `git diff --stat agents/lib/bg-terminal.ts \| wc -l` MUST print `0` (GREEN). **(b) REQ-3 negative:** temporarily delete the `if (typeof named.isAvailable === "function" && !(await named.isAvailable())) { ... return; }` branch from `agents/index.ts`; `bash agents/test-fixtures/run-p5e1-tests.sh` MUST exit non-zero on `testBackendFlagUnavailableDoesNotFallThrough` (RED); revert; re-run MUST exit 0 (GREEN). **(c) REQ-4/REQ-6/REQ-12 negative:** temporarily edit `agents/lib/bg-args.ts` to return `{ backendFlagMissingValue: false, restArgs: rawArgs ?? '' }` unconditionally (skip ALL flag consumption); `bash agents/test-fixtures/run-p5e1-tests.sh` MUST exit non-zero on `testParseFlagWithValue`, `testParseDuplicateSecondPairPassesThrough`, `testBackendFlagNotInLaunchConfigOrManifest`, AND `testBackendFlagLaunchFailureCleansAndNamesBackend` (RED — the latter fails because `--backend` would not be consumed so the named-backend path is never taken); revert; re-run MUST exit 0 (GREEN). | After all three controls reverted: `bash agents/test-fixtures/run-p5e1-tests.sh` exits 0 AND `git diff --stat agents/lib/bg-terminal.ts \| wc -l` prints `0` AND `git diff --stat agents/index.ts agents/lib/bg-args.ts` shows only the intended changes. |

### Replace block for step 1.4

`ANCHOR` (the exact current text at `agents/index.ts` L666-676, each line preceded by a single tab `\t`):

```text
	const selection = await selectBgTerminalBackend();
	if (!selection.ok) {
		if (selection.reason === "none-registered") {
			ctx.ui.notify("No terminal backend installed. Load tmux-terminal or equivalent to use background agents.", "warning");
		} else {
			const probed = selection.probed.map((p) => p.name).join(", ");
			ctx.ui.notify(`Terminal backends registered but unavailable: ${probed}`, "error");
		}
		return;
	}
	const backend = selection.backend;
```

`REPLACE` (each top-level line preceded by a single tab; nested lines by 2+ tabs):

```text
	const parse = parseBgArgs(args);
	if (parse.backendFlagMissingValue) {
		ctx.ui.notify("Usage: /agents bg <agent> <task> [--backend <name>]", "warning");
		return;
	}
	let backend;
	if (parse.backendName !== undefined) {
		const named = getBgTerminalBackendByName(parse.backendName);
		if (!named) {
			const names = listBgTerminalBackends().map((b) => b.name).join(", ");
			ctx.ui.notify(`Unknown backend '${parse.backendName}'. Registered: ${names}`, "error");
			return;
		}
		try {
			if (typeof named.isAvailable === "function" && !(await named.isAvailable())) {
				ctx.ui.notify(`Backend '${named.name}' is registered but unavailable.`, "error");
				return;
			}
		} catch (err) {
			ctx.ui.notify(`Backend '${named.name}' is registered but unavailable.`, "error");
			return;
		}
		backend = named;
	} else {
		const selection = await selectBgTerminalBackend();
		if (!selection.ok) {
			if (selection.reason === "none-registered") {
				ctx.ui.notify("No terminal backend installed. Load tmux-terminal or equivalent to use background agents.", "warning");
			} else {
				const probed = selection.probed.map((p) => p.name).join(", ");
				ctx.ui.notify(`Terminal backends registered but unavailable: ${probed}`, "error");
			}
			return;
		}
		backend = selection.backend;
	}
```

### Definition of done (whole plan)

`bash agents/test-fixtures/run-p5e1-tests.sh` prints all 25 tests passing (20 new + 5 back-compat), `git diff --stat agents/lib/bg-terminal.ts | wc -l` prints `0`, `git diff agents/test-fixtures/test-bg.mjs` shows no removals among the 5 back-compat test bodies, and the optional manual smoke (UNGUARDED-IN-CI) launches a `pi-agent-*` window in tmux under `--backend tmux` with both backends loaded.
