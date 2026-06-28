# P5c-2 tmux-control TUI automation surface — Re-Review

Reviewer: claude (re-review pass 3, inline)
Plan: `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_PLAN.md`
Prior review: `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_ADVERSARIAL_REVIEW.md` (pass 2 — REVISE-AND-RESUBMIT, 4 blockers + OD-1)
Code spot-checked: `tmux-control/lib/exec.ts`, `test-fixtures/test-extension-integration.mjs:40`, `test-fixtures/run-control-tests.sh:29`, `index.ts:370`

## Verdict

**APPROVE-WITH-MINOR-FIXES** — all 4 blockers and OD-1 are genuinely and completely fixed with grounded rationale; two doc-consistency defects remain (test count 29≠31≠23; one orphan test name in the Slice Ladder).

## Blocking issues from prior review — fix status

### B1 — `paste-buffer -p` missing (LF→CR premature-submit)

- **Status**: FIXED
- **Where**: REQ-1 (plan L43): *"delivers text via `set-buffer` then `paste-buffer -p` (bracketed paste)… The argv must include `-p` and must not include `-r`… Asserts `args.includes("-p")` and `!args.includes("-r")`."* Resolution/flow L168: `paste-buffer -p -d -b pictl-paste -t <session:index>   # -p = bracketed paste`. Safety table L81. New OD-5 (L418) records the decision with rationale.
- **Notes**: Complete. The observable the prior review said was wrong (invocation count) is replaced by an argv-content assertion (`-p` present, `-r` absent), which is genuinely falsifiable. The conclusion (use `-p`, leave `-r` off) matches the grounding doc (`TMUX_TUI_AUTOMATION.md` §Sources: *"aimax — uses `paste-buffer -p`"*). Minor prose wrinkle in OD-5 — *"The `-r` flag would re-disable that conversion"* slightly conflates LF→CR replacement with bracketed-paste wrapping — but the decision is correct (with `-p` active, the TUI treats bytes between `\e[200~`/`\e[201~` as literal input regardless of CR/LF) and the residual is honestly tagged UNGUARDED-IN-CI + smoke-gated. Not worth a revision.

### B2 — REQ-1 end-to-end property only provable in smoke (UNGUARDED-IN-CI gap)

- **Status**: FIXED
- **Where**: REQ-1 Notes (plan L43): *"The end-to-end 'no premature submit in a live TUI' property is `UNGUARDED-IN-CI` and covered by the multi-line paste smoke step (REQ-19)."* REQ-19 (L61): *"The multi-line paste step is the sole proof of REQ-1's end-to-end 'no premature submit' property — every other assertion of REQ-1 is mechanism-only (asserts `-p` in argv; cannot prove TUI reception)."*
- **Notes**: Complete. The false *"no MUST depends on this smoke"* claim from pass 2 is retracted (Applied Fixes B2, L441) and replaced with an explicit two-layer split: mechanism (unit, `-p` in argv) + delivery (smoke, UNGUARDED-IN-CI). This is exactly the `test-pi-extensions-via-tmux` posture the standing rule demands.

### B3 — `session_start` sync-vs-async collision

- **Status**: FIXED
- **Where**: REQ-14 (plan L56): *"Handler remains synchronous — `checkExtendedKeys` is fire-and-forget; the test injects a synchronously-resolved fake executor so the warn lands deterministically before the assertion."* Hook Points L207 spells out the same and pins `test-extension-integration.mjs:40` unchanged. `testSessionStartNoSocketNoop` added (L381, EC7-adjacent) for the no-socket no-op.
- **Notes**: The sync-vs-async dilemma is resolved cleanly toward option (i): handler stays sync, check is fire-and-forget. Verified against source — `index.ts:370` returns `void` (sync), and `test-extension-integration.mjs:40` does assert `startResult === undefined`; the fix preserves both. **One implementation caveat to pin during S4** (non-blocking): a "synchronously-resolved" injected executor still schedules its `.then` callback on the microtask queue, so `testSessionStartWarnOnly` cannot do `handler(); assert(warned)` literally synchronously — it must flush microtasks first (e.g. `await Promise.resolve()` / `await new Promise(r => setImmediate(r))`) before asserting the warn fired. Determinism is fully achievable (no real timers, no race once microtasks are flushed); the plan's phrasing "lands before the assertion" just needs that one tick. Worth a sentence in the test, not a plan blocker.

### B4 — keys-mode double-submit (token + auto-Enter)

- **Status**: FIXED
- **Where**: REQ-11 (plan L53): *"does not fire the Enter loop (default `pressEnter:false` in keys mode)… Total `send-keys` call count equals exactly one call with the token args."* Contracts state-table row B (L309): *"no Enter loop (pressEnter defaults to false); total `send-keys` calls = 1"*. Safety table L85 (dedicated "keys mode double-submit" row). `testSendKeysMode` now asserts total call count = 1, no trailing Enter (L53, L384).
- **Notes**: Complete. The canonical `"C-c"` / `"C-c Enter"` use cases no longer get a spurious extra Enter, and the test gains the call-count assertion the prior review said was missing.

### OD-1 — `set-buffer -- <text>` terminator (load-bearing)

- **Status**: FIXED (resolved, not deferred)
- **Where**: OD-1 (plan L414): *"RESOLVED. Use `set-buffer -b pictl-paste -- <text>` with `--` options terminator. Rationale: the `TmuxExecutor` exposes only `exec(args, opts)` with no stdin channel (verified — `lib/exec.ts:9–11`)…"* Resolution/flow L167. Safety table L86 (leading-dash row tagged `UNGUARDED-IN-CI`).
- **Notes**: The decision is now made in the plan rather than punted to "the test is the arbiter." I independently verified the load-bearing premise against source: `lib/exec.ts` defines `exec(args: string[], opts: { timeoutMs })` with no `input`/stdin option — so `load-buffer -` is genuinely unavailable and `set-buffer … --` is the only path. Rationale is sound and accurate; the documented fallback (base64-via-stdin by extending the executor if a future tmux misparses despite `--`) is a reasonable escape hatch.

## New issues introduced

**None blocking.** Checked the two specific risks the fixes could create:

1. **Did adding `-p` break an existing test?** No. `paste-buffer` is a brand-new primitive (`pasteText`); no pre-existing `test-exec.mjs` assertion references it. The v0.1 literal `send-keys -l` path (REQ-12) is untouched, so the "v0.1 behavior unchanged" Done-criterion (L426) still holds.
2. **Did defaulting `pressEnter:false` in keys mode break S6's drive flow?** No. `driveClaude` submits the prompt via `pasteText` (which defaults `pressEnter:true`, plan L103/L260) → explicit Enter, **not** via keys mode. The keys-mode default only affects callers who explicitly pass `mode:"keys"`, which is exactly the intended scope. REQ-18's multi-line routing threads `pressEnter`/`pressEnterCount` into `pasteText` and is unaffected by the keys-mode default (keys mode opts out of paste routing by design, L172).

Minor consistency drift exists (see below) but introduces no new correctness or safety regression.

## Test catalog — coverage sanity

Spot-checked 5 REQ → test mappings:

| REQ | Claimed test(s) | In catalog? | Asserts the stated property? |
|---|---|---|---|
| REQ-1 | `testPasteMultilineSingleEvent` | ✅ Group 1 | ✅ asserts `-p` in / `-r` out of argv (the B1 fix) |
| REQ-4 | `testPasteDeletesBuffer`, `testPasteDeletesBufferOnFail` | ✅ Group 1 | ✅ happy-path + paste-fail best-effort delete (closes non-blocking #1) |
| REQ-9 | `testSendEnterCount`, `testSendEnterCountClamp` | ✅ Group 3 | ✅ exact-N + N=11⇒10 clamp boundary (closes non-blocking #4) |
| REQ-13a | `…CsiU`, `…Xterm`, `…OldTmux`, `…ParseFail` | ✅ Group 4 | ✅ four-way split (closes missing-test #5) |
| REQ-15 | `testDriveRefusesUnprefixed` | ✅ Group 6 | ✅ negative control, `fake.calls.length===0` |

All five map cleanly and the prior review's missing-test gaps (#1–#9) are visibly closed (drive B/C/D phases, stable negative control, keys-empty, no-socket no-op all now named).

**Count discrepancy (MINOR FIX):** the six group headers enumerate **29** distinct tests — Group 1 (8) + Group 2 (5) + Group 3 (3) + Group 4 (6) + Group 5 (3) + Group 6 (4) = 29. But:
- L399 claims **"Total: 31 unit tests"** — off by 2 against its own enumeration.
- L422 (Done Criteria) still says **"all 23 new unit tests"** — stale pre-revision number.

Neither 31 nor 23 matches the actual 29. Reconcile to 29 (or, if two tests were intended but dropped from the catalog, add them). Per Rule 14, the count is exactly the kind of drift-prone prose state that should match what's enumerated.

## REQ-13 → REQ-13a renumbering

**Consistent — no orphan `REQ-13 → checkExtendedKeys` reference.** The three remaining bare `REQ-13` mentions all correctly point at the *existing* import-guard, not at `checkExtendedKeys`:
- L211 (Hook Points): *"L29–L37 REQ-13 guard … static import guard"* — refers to the real guard; verified `run-control-tests.sh:29` literally banners `"Verifying REQ-13 (no agents/lib imports outside resolve.ts)"`.
- L446 (Applied Fixes): documents the renumber itself.

The `checkExtendedKeys` requirement is REQ-13a everywhere it matters (L55 requirement row; L376–L379 catalog; L447). The collision the prior review flagged (non-blocking #6) is resolved.

**One orphan test name (MINOR FIX), separate from the REQ number:** the Slice Ladder S4 row (L220) still lists the old collapsed `testExtendedKeysCheck`, which no longer exists anywhere else — the catalog split it into four. The Slice Ladder "Tests" column is also a stale subset for S2 (omits `testWaitCaptureError`), S3 (omits `testSendEnterCountClamp`), and S6 (omits `testDriveReadyTimeout`, `testDriveDoneTimeoutPartial`). These columns predate the test additions. At minimum fix the L220 orphan name; ideally reconcile the column to the catalog or label it "illustrative subset."

## Open Decisions resolution quality

- **OD-1 (RESOLVED) — sound.** Rationale is grounded in verified source (`exec.ts` has no stdin channel), the `--` terminator is the correct mitigation for leading-dash payloads, and the residual is honestly tagged UNGUARDED-IN-CI with a named fallback. ✅
- **OD-5 (RESOLVED) — sound, with a cosmetic wrinkle.** Decision (use `-p`, leave `-r` off) is correct and matches the grounding doc and aimax precedent. The explanatory sentence about `-r` "re-disabling that conversion" is slightly muddled but does not change the (correct) outcome, and the end-to-end property is smoke-backstopped. ✅
- **OD-2 (auto-launch inside drive) — still OK to defer.** Genuine Non-Goal; collides with the prefix-gate model; no slice depends on it. ✅
- **OD-3 (`/tmux-wait` surface) — still OK to defer.** Pure surface-area decision, zero correctness impact; S6 consumes `waitForWindow` internally regardless. ✅
- **OD-4 (N separate Enter execs) — resolved, fine as recorded.** ✅

## Final verdict

**APPROVE-WITH-MINOR-FIXES**

All four blockers (B1 `-p`, B2 UNGUARDED-IN-CI tagging, B3 sync `session_start`, B4 keys-mode double-submit) and OD-1 are genuinely and completely fixed, with rationale I independently verified against the actual source (`exec.ts` no-stdin, `test-extension-integration.mjs:40` sync assertion, `run-control-tests.sh:29` guard). No new blocking issue is introduced — `-p` touches only the new paste path, and the keys-mode `pressEnter:false` default does not reach S6's drive flow. The only residue is documentation hygiene: reconcile the test count (catalog enumerates 29, not 31, and Done Criteria's "23" is stale) and fix the orphan `testExtendedKeysCheck` name in the Slice Ladder S4 row — none of which blocks implementation. Clear to proceed to the mechanical-execution-spec handoff once those two doc fixes land.
