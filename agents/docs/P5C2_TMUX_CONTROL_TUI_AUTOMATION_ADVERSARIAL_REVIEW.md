# P5c-2 tmux-control TUI automation surface — Adversarial Review

Reviewer: claude (adversarial pass, inline)
Plan: `agents/docs/P5C2_TMUX_CONTROL_TUI_AUTOMATION_PLAN.md`
Code under change: `tmux-control/lib/send.ts`, `lib/capture.ts`, `lib/exec.ts`, `lib/safety.ts`, `index.ts`, `test-fixtures/*`
Grounding: `TMUX_TUI_AUTOMATION.md` (repo root)

> Note on the cited style reference: the task points at `agents/P3F3_ADVERSARIAL_REVIEW.md`, which does not exist. The actual prior adversarial review is `agents/P3F4_ADVERSARIAL_REVIEW.md`; this review follows its round/blocker structure plus the section layout requested in the task.

## Summary

The plan is well-structured, correctly identifies the five v0.1 gaps, and inherits the argv-only + prefix-gate safety floor cleanly. But it should **not** be accepted as written. The headline correctness primitive (S1 `pasteText`) omits the one tmux flag that makes multi-line paste actually work — `paste-buffer -p` (bracketed paste) — so, as specified, it will reproduce the exact premature-submit bug it exists to fix, and the default `paste-buffer` LF→CR conversion turns every newline into an Enter. Worse, REQ-1's fake-executor test asserts only *invocation count*, so it goes green while the real behavior is broken — precisely the unit-green/real-broken trap the `test-pi-extensions-via-tmux` standing rule was created to catch. S4 (warn-only extended-keys check) collides with an existing test that pins `session_start` as synchronous, and the plan never says whether the async check is awaited or fire-and-forget — which decides whether its MUST test can even be deterministic. OD-1 (`set-buffer --` terminator) is load-bearing, not deferrable: the executor has no stdin channel, so the safer `load-buffer -` path is unavailable and `set-buffer` argv-parsing of the payload is the only option, making the leading-dash mitigation depend on an unresolved decision. Verdict: **REVISE-AND-RESUBMIT**.

## Blocking issues

1. **`pasteText` omits `paste-buffer -p`; default LF→CR conversion will premature-submit every line.**
   The Resolution/flow (plan L162–L167) and constants emit `paste-buffer -d -b pictl-paste -t <session:index>` — no `-p`, no `-r`. tmux's documented `paste-buffer` default **converts every LF in the buffer to CR** (the `-r` flag turns that off), and **without `-p` no bracketed-paste markers are emitted**. So a multi-line buffer is delivered to the TUI as `line1<CR>line2<CR>line3<CR>` — i.e. one Enter per newline, the same data-loss-grade premature submit S1 is meant to eliminate (Why §1, plan L29). The plan's own grounding contradicts the design: `TMUX_TUI_AUTOMATION.md` §Sources notes *"aimax — uses `paste-buffer -p` + triple `send-keys Enter`"*, and §4 ("Newlines in pasted text") rests the whole single-event guarantee on bracketed paste. REQ-1 (plan L43) measures the wrong observable: it counts `paste-buffer` invocations and `send-keys Enter` invocations, both of which are correct even while the TUI receives N carriage returns.
   **Concrete fix:** specify `paste-buffer -p -d -b pictl-paste -t T` (bracketed paste, delete-after), decide `-r` explicitly, and reword REQ-1 to require `-p` present in the argv. Add `args.includes("-p")` to `testPasteMultilineSingleEvent`. Surface the `-p`/`-r` choice as an explicit Open Decision resolved against live tmux *before* acceptance, not "the test is the arbiter" during S1.

2. **REQ-1 is a MUST whose only falsifiable proof of the real property is the `UNGUARDED-IN-CI` smoke.**
   REQ-19's Notes (plan L61) assert *"The MUST rows above each have a non-skippable fake-executor unit test, so no MUST depends on this smoke."* That is false for REQ-1's actual requirement ("delivered as a **single paste event**"). The fake-executor cannot observe whether the bytes reach the pane as a bracketed paste vs N Enters (see B1) — only the real-tmux smoke (REQ-19, SHOULD, `UNGUARDED-IN-CI`) can. Per `PLAN_TEMPLATE.md` (L53–L59), "a smoke that can `command -v … ||`-skip is **not** coverage"; a MUST proven only by a skippable smoke is a hollow green.
   **Concrete fix:** (a) make the *mechanism* unit-falsifiable by pinning and asserting `-p` (B1); and (b) tag the *end-to-end no-premature-submit delivery* property as `UNGUARDED-IN-CI` with the named covering smoke step (the multi-line live-paste step), rather than claiming no MUST depends on the smoke. Promote that smoke step's status so REQ-1's real coverage is a tracked residual, not an invisible gap.

3. **S4 (warn-only extended-keys) collides with the existing synchronous-`session_start` invariant, and its required test's determinism is unspecified.**
   `index.ts:370` registers a **synchronous** `session_start` handler, and `test-fixtures/test-extension-integration.mjs:40` pins exactly that: `assert.equal(startResult, undefined, "session_start handler is sync (returns undefined)")`. `checkExtendedKeys` is async (`executor.exec`). To `await` it, the handler must become async (return a Promise) — which **breaks** that existing assertion and violates the plan's own Done-criterion "v0.1 behavior unchanged: every pre-existing assertion still passes untouched" (plan L413), an unledgered fixture change. To keep it sync, the check must be fire-and-forget — in which case `testSessionStartWarnOnly` (REQ-14, MUST) cannot deterministically assert that the warning fired while registration completed, because the warn races registration. The plan's Hook Points row (L203, "call `checkExtendedKeys` here, warn-only") presents a non-trivial behavioral change as a no-op edit.
   **Concrete fix:** pick one and write it down: either (i) keep the handler sync, fire-and-forget the check, and make `testSessionStartWarnOnly` deterministic by injecting a **synchronously-resolved** fake executor so the warn lands before the assertion; or (ii) convert the handler to async and enumerate the `test-extension-integration.mjs:40` edit as an anchored fixture-change step (before → after). Also specify the no-socket case: when `getSocketPrefix()` is `null` (no tmux server), `checkExtendedKeys` must no-op, not emit a spurious "extended keys not set" warning.

4. **`keys` mode with the default `pressEnter:true` double-submits the obvious use case.**
   REQ-11/EC5 (plan L53, L336) give the canonical example `"C-c Enter"` ⇒ argv `… C-c Enter`. But `sendText`'s Enter loop (Contracts state-table row D, plan L307) fires for *any* call where `pressEnter !== false`. So `sendText("C-c Enter", {mode:"keys"})` sends `C-c`, `Enter` (as a token), **then another `Enter`** from the loop — a spurious extra submit; and a bare `sendText("C-c", {mode:"keys"})` (the primary "send Ctrl-C" use) sends `C-c` then an unwanted `Enter`. `testSendKeysMode` (REQ-11) asserts only that tokens are present and `-l` is absent — it never asserts the *total* `send-keys` call count, so this bug ships green.
   **Concrete fix:** in `keys` mode, default `pressEnter` to `false` (or skip the Enter loop entirely when `mode==="keys"`), and add a total-call-count assertion to `testSendKeysMode` (e.g. `"C-c"` keys-mode ⇒ exactly one `send-keys` call, no trailing Enter).

## Non-blocking issues

1. **Error-path orphan buffer (state D).** `paste-buffer -d` only deletes on success; on paste failure (Contracts state D, plan L267) the `pictl-paste` buffer survives. REQ-4 ("leaving no orphan tmux buffer") is proven happy-path only. Low impact because the buffer name is a fixed constant and the next `set-buffer` overwrites it — but say so, or add a best-effort `delete-buffer` on the paste-fail path.
2. **`waitForWindow` treats the first capture error as fatal.** EC9 / state C (plan L293, L340) returns `capture-error` on the first `!ok`. `TMUX_TUI_AUTOMATION.md` §5 explicitly warns the window list is volatile when pi spawns subagents; a transient capture failure during churn would abort a wait that would otherwise succeed (e.g. `tmux_drive_claude` bailing mid-think). Decide deliberately: either tolerate K transient errors before failing, or document fail-fast as intentional.
3. **REQ-18 routing under-specifies opts pass-through.** The flow (plan L169–L173) routes multi-line to `pasteText` *before* the mode/`pressEnter` branch, but the state table row A (plan L304) doesn't say whether `pressEnter:false` / `pressEnterCount` / `mode:"keys"` are threaded into the `pasteText` call. A multi-line `sendText(..., {pressEnter:false})` must not submit. Specify the thread-through.
4. **Silent `pressEnterCount` clamp.** Contract clamps `0..MAX_ENTER_COUNT` (10) silently (plan L256, L298). No boundary test (N=11 ⇒ 10). Either document the silent clamp and test the boundary, or reject out-of-range with an error.
5. **REQ-17 argv-only grep guard is under-specified and risks being a no-op or false-positive.** The plan says grep new lib files for "`shell` / `execSync` / template-string exec" (plan L59, L207). These files use `${…}` template literals heavily (e.g. `send.ts:40`), so a naive template-string grep either floods with false positives or is quietly tuned to match nothing. Pin the exact patterns (`shell:\s*true`, `\bexecSync\b`, `` exec\(`` `) and give the guard a red-then-green check (a deliberately-broken fixture line that the guard catches) so the guard is proven to bite — per `PLAN_TEMPLATE.md` Verify deny-list.
6. **REQ-number collision.** The plan's local REQ-13 (`checkExtendedKeys`, plan L55) collides with the repo's well-known "REQ-13" import guard — which `run-control-tests.sh:29` literally banners as `"Verifying REQ-13 …"`. Since the plan also adds a new guard to that same script (REQ-17), two different "REQ-13"s in the same file is a real traceability hazard. Renumber the plan's checkExtendedKeys requirement.
7. **tmux version acquisition for the `<3.5` branch is unspecified.** REQ-13/`checkExtendedKeys` claims `{ok:false}` for "tmux < 3.5" but the design never says how the version is read (`tmux -V`) or how a parse failure is handled. Name the mechanism and the parse-failure fallback.
8. **`stableMs` over `capture-pane` without `-e`.** `captureWindow` uses `-p -J -S` (no `-e`, confirmed `capture.ts:32`), which is correct for marker matching but means an animated footer ("Cooked for 3s"→"4s", spinner `✻`) keeps the text changing, so `stableMs` legitimately won't fire while the TUI is "thinking." That's the intended behavior — but call it out so a caller doesn't set `stableMs` expecting idle detection during an active spinner.

## Missing tests / validation

1. **No test asserts `-p` in the paste argv** (because the design omits it). After B1, `testPasteMultilineSingleEvent` must assert `args.includes("-p")` — otherwise REQ-1 still can't fail when the bracketed-paste flag is dropped.
2. **`testSendKeysMode` doesn't assert Enter behavior in keys mode** (B4) — needs a total `send-keys`-call-count assertion to catch the double-submit.
3. **No clamp-boundary test for `pressEnterCount`** (non-blocking #4): N=11⇒10 and N=0 paths are unasserted.
4. **`testSessionStartWarnOnly` has no specified deterministic seam** (B3): without a synchronously-resolved injected executor, the warn races registration and the test is flaky or vacuous.
5. **`checkExtendedKeys` three-way coverage is collapsed into one test.** `testExtendedKeysCheck` (REQ-13) is named for both `≠csi-u` and `=csi-u`; the `tmux<3.5` branch and the version-parse-failure path are not separately asserted. Split or add cases.
6. **`testWaitStable` needs a negative control.** EC4 (plan L335) requires "not on first repeat." The test must assert that an *identical* capture on the first repeat does **not** return `matched:"stable"` (only after the unchanged-for-`stableMs` window) — otherwise it can't fail when stable fires too early.
7. **The leading-dash safety mitigation is only smoke-provable.** `testPasteLeadingDash` (EC2, REQ-2) asserts argv shape; it cannot prove that *real tmux* won't misparse `-rf danger` as options after `set-buffer -b name` (that depends on OD-1's `--` decision). So the Medium "leading-dash" Safety row is effectively `UNGUARDED-IN-CI` and must be tagged as such, with the multi-line/leading-dash smoke step named as its covering check.
8. **`tmux_drive_claude` error phases are untested.** The drive state table (plan L320–L326) declares itself exhaustive (A–E), but only A (`testDriveRefusesUnprefixed`) and E (`testDriveHappyPath`) have tests. Rows B (ready timeout → `phase:"ready"`), C (paste fail → `phase:"paste"`), and D (done timeout → partial capture returned) have no named tests — the "partial output returned" guarantee of row D is exactly the kind of thing that silently regresses.
9. **`waitForWindow` degenerate "neither regex nor stableMs"** (Input contract, plan L283: behaves as a plain timeout sleep-poll) has no named test.

## Standing-rule compliance

**`test-pi-extensions-via-tmux` (real-tmux smoke obligation): PARTIAL.**
The plan does add live smoke steps and declares the run "required before commit" (plan L61) — good. But the headline correctness property (multi-line, no premature submit) is observable **only** in that smoke (B1/B2), while the smoke is SHOULD / `UNGUARDED-IN-CI` and REQ-1 is MUST. That is the exact unit-green/real-broken gap this rule exists to close. To reach PASS: pin `-p` so the *mechanism* is unit-falsifiable (B1) **and** tag the end-to-end delivery property `UNGUARDED-IN-CI` with the named smoke step (B2). The two showstoppers the memory cites both shipped on unit-tests-only confidence; the plan currently re-creates that footing for S1.

**`PLAN_TEMPLATE.md` falsifiable-MUST rule: FAIL (as written).**
- REQ-1 (MUST) maps to a unit test that passes regardless of the real premature-submit bug (B1/B2). Non-falsifiable for its stated property.
- REQ-14 (MUST) maps to a test whose determinism/feasibility is unresolved and which collides with an existing pinned assertion (B3).
- Remaining MUST rows (REQ-2, 3, 4, 9, 10, 11, 12, 15, 16, 17, 18) do map to genuine fake-executor assertions and are fine in principle (subject to the missing-test gaps above). Fix REQ-1/REQ-14 and the rule is satisfiable.

**REQ-13 (no static `agents/lib` import outside the allowed file): PASS (not regressed).**
The guard at `run-control-tests.sh:31` greps all of `lib/` + `index.ts` for `from "../../agents/lib/"` and allows only `lib/resolve.ts`. The four new lib files (`paste.ts`, `wait.ts`, `keyscheck.ts`, `drive.ts`) import only `./exec.ts`, `./constants.ts`, `./capture.ts`, `./safety.ts` per the design — none touches `agents/lib`, and the existing guard already covers new files in `lib/`. The plan's additive REQ-17 guard does not weaken it. (Note: the standing-rule phrasing "outside `agents/lib/bg-terminal.ts`" describes the *agents* extension's guard; tmux-control's local guard allows `resolve.ts` — both hold independently. See non-blocking #6 on the number collision.)

## Existing hook points — drift check

Verified each cited `file:line` against the actual source:

| Plan row | Claim | Verdict |
|---|---|---|
| `lib/send.ts` L28–L63 `sendText` | literal `-l` send + separate Enter | **Accurate** (`send.ts:28–63`). |
| `lib/send.ts` L45 argv builder | `["…","send-keys","-l","-t",t,text]` | **Accurate** (`send.ts:45`). |
| `lib/send.ts` L51–L60 Enter block | single Enter | **Accurate** (`send.ts:51–60`). |
| `lib/capture.ts` L24–L38 `captureWindow` | `capture-pane -p -J -S`, no change | **Accurate** (`capture.ts:24–38`; uses `-p -J -S`, no `-e`). |
| `lib/constants.ts` L1–L8 | shared constants | **Accurate** (file is 8 lines). |
| `index.ts` L103–L129 `/tmux-send` | send command | **Accurate** (`index.ts:103–129`). |
| `index.ts` L230–L249 `tmux_send` | send tool | **Accurate** (`index.ts:230–249`). |
| `index.ts` L192–L267 `registerTools` | tool registry | **Accurate** (`index.ts:192–267`). |
| `index.ts` L370–L374 `session_start` | "call `checkExtendedKeys` here, warn-only" | **Line refs accurate; impact understated.** The handler is synchronous and pinned sync by `test-extension-integration.mjs:40`. Adding an async check here is a behavior/contract change, not a localized warn-only insert (see B3). |
| `lib/safety.ts` L37–L63 `resolveTarget` | prefix gate, reused unchanged | **Accurate** (`safety.ts:37–63`). |
| `test-exec.mjs` L70–L112 sendText tests | fake-executor patterns | **Accurate** (sendText block is L70–112). |
| `test-real-tmux-smoke.mjs` L105–L126 | live capture/send steps | **Accurate** (capture step ~L105, sendText step ~L111–118; file is 147 lines). |
| `run-control-tests.sh` L29–L37 REQ-13 guard | static import guard | **Accurate** (guard is L29–37). |

Additional drift note (not in the plan's table): the plan's design commits to `set-buffer` (argv) over the research doc's verified `load-buffer -` (stdin). This is **forced**, not optional: the executor (`exec.ts:9–11`) exposes only `exec(args, opts)` with **no stdin channel**, so `load-buffer -` cannot be used without extending the executor interface. The plan should state this rationale explicitly — it's the reason the leading-dash risk (and OD-1) exists at all.

## Open Decisions — load-bearing?

- **OD-1 (`set-buffer -b name -- <text>` vs no `--`): LOAD-BEARING — resolve before acceptance.** It decides whether the Medium "leading-dash" Safety mitigation actually holds, and because the executor has no stdin (above) `load-buffer -` is not an escape hatch — `set-buffer` argv parsing of the payload is the only option. "Deferred to S1 … the test is the arbiter" (plan L402) doesn't work: the only arbiter test is the `UNGUARDED-IN-CI` smoke, which can't gate CI. Resolve now by running `set-buffer -b x -- "-rf danger"` (and without `--`) against the live tmux and recording the result in the plan.
- **OD-2 (auto-launch inside `tmux_drive_claude`): OK to defer.** Genuine Non-Goal; no slice depends on it.
- **OD-3 (expose `waitForWindow` as `/tmux-wait`): OK to defer.** Pure surface-area decision; no correctness impact; S6 consumes it internally regardless.
- **OD-4 (N separate Enter execs vs `send-keys -N count`): effectively resolved in-plan** (N separate execs, with a stated rationale and assertability benefit, plan L405). Fine to keep as recorded.
- **Un-surfaced load-bearing decision #1 — `paste-buffer -p`/`-r` (B1).** This is presented as settled design but is the single most important unproven assumption. Promote it to an explicit, resolved-before-acceptance decision.
- **Un-surfaced load-bearing decision #2 — `session_start` sync-vs-async for S4 (B3).** Must be decided in the plan, not discovered in implementation.

## Verdict

**REVISE-AND-RESUBMIT.**

Must change before acceptance:
- **B1** — add `paste-buffer -p` (and decide `-r`); reword REQ-1 to require and assert it. Without this, S1 ships the premature-submit bug it was written to kill.
- **B2** — give REQ-1 real coverage: unit-assert the `-p` mechanism *and* tag the end-to-end no-submit delivery `UNGUARDED-IN-CI` with the named smoke step. Retract the "no MUST depends on this smoke" claim.
- **B3** — resolve S4's sync-vs-async `session_start` and the determinism of `testSessionStartWarnOnly`; ledger any change to `test-extension-integration.mjs:40`; specify no-socket no-op.
- **B4** — fix the `keys`-mode default-Enter double-submit and assert call count.
- **OD-1** — resolve the `set-buffer --` decision against live tmux now; tag the leading-dash Safety row `UNGUARDED-IN-CI`.

Address non-blocking #1–#8 and missing-tests #1–#9 in the resubmit. The plan's bones are sound — slice ladder, dependency graph, safety floor, and most fake-executor mappings are solid — so a focused revision (not a rewrite) should clear the bar.
