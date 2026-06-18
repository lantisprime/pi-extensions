# P3f-4 Code Review

Reviewer: gpt-5.5 (via `pi --no-tools`)
Implementation: `agents/lib/child-runner.ts`, `agents/lib/profiles.ts`, `agents/lib/run-resolver.ts`, `agents/test-fixtures/test-child-runner.mjs`

## Rounds

| Round | Verdict | Blockers |
|---|---|---|
| 1 | changes-requested | 3 |
| 2 | approve-with-nits | 0 |

## Round 1 blockers (3) — all resolved

### B1: Spill setup not fail-closed
- `createWriteStream` opens async; try/catch missed async open errors; error listener attached late → could crash parent or spawn before spill confirmed.
- **Fix:** attach error listener synchronously; `await` the stream's `open` event before spawn; cleanup partial spill dir on setup failure.

### B2: spillWriteError only forced spill-error on completed
- `spillWriteError && status === "completed"` left timeout/safety-kill paths as their original status despite a spill write error.
- **Fix:** `spillWriteError ? "spill-error" : status` (applies across all paths).

### B3: --profile dropped on ctx.agentsChildRunner path
- Custom-runner call passed `childOptions` without `profileOverride`.
- **Fix:** pass `profileOverride` via options (only when defined to avoid deepEqual noise); `runChildAgent` falls back to `options.profileOverride`.

## Non-blocking concerns (all resolved)
- 5s stream-wait timer: now cleared in `finish` + `unref()`'d
- Late stdout after timeout/safety-kill: writes gated on `!closed && !writableEnded && !destroyed`
- Setup failure after mkdtemp: now cleans up the partial dir
- Parser `--profile` duplicate check: now token-level (no longer rejects `--profiled` substring in task)

## Round 2 nits
- `safetyTimer` referenced in `finish` before declaration (TDZ risk on synchronous finish) — fixed by declaring `let safetyTimer` before the closure and setting it after `end()`.
- (Not fixed, platform-only) Resolving on `finish` vs `close` for Windows fd-on-unlink — acceptable for macOS/Linux target; deferred.

## Verdict

**approve-with-nits** — all blockers resolved; no new blockers. Implementation ready for PR.
