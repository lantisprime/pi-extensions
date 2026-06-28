# P5c-2 tmux-control: TUI automation surface (paste, wait-for, key-name mode) Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

This plan builds on **tmux-control v0.1** (P5c-1, shipped in [PR #106](https://github.com/lantisprime/pi-extensions/pull/106)) and implements against the lessons captured in [`TMUX_TUI_AUTOMATION.md`](../../TMUX_TUI_AUTOMATION.md) (repo root).

## Episode Search Summary

Searched episodic / file-based memory for `tmux`, `tui`, `automation`, `send-keys`.

Key active memories:

- `test-pi-extensions-via-tmux` (feedback, standing rule set 2026-06-27): **HARD REQUIREMENT** — for any extension feature that spawns processes, opens terminal windows, or drives a TUI, run a *real* tmux end-to-end test (drive the actual thing through tmux + `capture-pane`) and confirm it passes before commit. Unit tests passing is **not** sufficient. Two showstopper bugs shipped twice on unit-tests-only fixes. → Drives REQ-19 and the per-slice real-tmux smoke obligation.
- `knowledge_base/pi-extension-api` (reference): pi extension dev reference — deploy→`~/.pi`→reload; command-handler blocking model + non-blocking pattern; `ctx` session-state gotchas; `.ts` type-stripping limits; feeding a sandboxed child big context via temp-file+read. → Informs the `tmux_drive_claude` long-poll design (don't block the command handler) and the `--experimental-strip-types` test constraints.
- `pi-runbooks` (reference): project runbooks in `.pi/runbooks/` (review, agent invocation, em_* workflows). → Review path for this plan.

No prior episode covers paste-buffer / wait-for / key-name automation specifically; this plan is the first to formalize them as tested contracts.

## Objective

Extend `tmux-control` from a "send literal text + capture" tool into a **TUI-automation surface** that can reliably drive interactive terminal apps (claude, pi, vim) end-to-end. Concretely: deliver multi-line prompts as a single bracketed-paste event, poll a window until it is ready/idle, send key *names* (not just literal text), warn when the terminal can't disambiguate modified keys, and expose a one-call "ask claude and read the answer" recipe — all while preserving the v0.1 argv-only, prefix-gated safety model.

## Why

v0.1 (`sendText` + `-l` literal mode) cannot drive a real TUI reliably:

1. **Multi-line prompts break.** `send-keys -l` of text with `\n` fires Enter on every newline → premature submit. The research doc (§"Newlines in pasted text", §"Option B") shows `load-buffer`/`paste-buffer` with bracketed paste is the correct primitive.
2. **No readiness signal.** `capture-pane` after `send-keys` returns the *current* buffer, not the future state (research §"Timing is the universal pain"). Without a poll-for-marker primitive, callers hand-roll brittle `sleep`s.
3. **Can't send key chords.** `-l` is global across args (research §"⚠️ `-l` is global across all args") — v0.1 can never send `C-c`, `Up`, `Tab`, or aimax-style triple-Enter.
4. **Silent key ambiguity.** Without `extended-keys-format csi-u`, modern TUIs can't tell `Enter` from `Shift+Enter` (research §"Required: extended-keys-format csi-u"). Users hit this with no warning.
5. **The "drive claude" recipe is undocumented in code.** The research doc's §"Reliable workflow" is a 50-line bash script every caller must re-derive.

This slice turns those five lessons into tested, reusable contracts so background-agent orchestration (P5) can drive sub-agents through tmux without re-learning the gotchas.

## Requirements (Ground Truth)

Every requirement maps to at least one automated, falsifiable test. Unit tests use the **fake-executor pattern** (`test-fixtures/fake-tmux.ts`: `createFakeTmux()` / `fake.program([...])` / `fake.calls` / `okResult` / `errResult`) as in `test-exec.mjs`. E2E uses `test-real-tmux-smoke.mjs` (isolated `-L` socket).

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `pasteText` delivers text via `set-buffer` then `paste-buffer -p` (bracketed paste) as a **single** paste op. The argv must include `-p` and **must not** include `-r` (LF→CR conversion disabled) so the TUI receives the text as one bracketed-paste event with no premature submission. | `testPasteMultilineSingleEvent` | MUST | S1. Core anti-premature-submit guarantee. Asserts `args.includes("-p")` and `!args.includes("-r")`. The end-to-end "no premature submit in a live TUI" property is `UNGUARDED-IN-CI` and covered by the multi-line paste smoke step (REQ-19). |
| REQ-2 | `pasteText` is argv-only: the prompt text reaches tmux as a single `argv` element of `set-buffer` (never a shell string, never split). | `testPasteArgvOnly` | MUST | S1. Safety invariant (see Safety table). |
| REQ-3 | `pasteText` rejects text > `MAX_TEXT_BYTES` (4000) with `ok:false` and no tmux call. | `testPasteOversize` | MUST | S1. Flood guard, parity with `sendText`. |
| REQ-4 | `pasteText` deletes the buffer it created (`paste-buffer -d -b <name>`), leaving no orphan tmux buffer — happy path **and** on paste failure (best-effort `delete-buffer`). | `testPasteDeletesBuffer`, `testPasteDeletesBufferOnFail` | MUST | S1. Asserts `-d` present + buffer name matches the one `set-buffer` created, both on success and on paste failure. |
| REQ-5 | `waitForWindow({regex})` returns `{ok:true, matched:"regex"}` when a capture matches before `timeoutMs`. | `testWaitRegexMatch` | MUST | S2. |
| REQ-6 | `waitForWindow` returns `{ok:false, reason:"timeout"}` and stops within a bounded number of polls when no match occurs before `timeoutMs`. | `testWaitTimeout` | MUST | S2. Injected clock; assert it does not exceed `ceil(timeoutMs/intervalMs)+1` captures. |
| REQ-7 | `waitForWindow({stableMs})` returns `{ok:true, matched:"stable"}` only after captured output is unchanged for ≥ `stableMs` and **not** on the first repeat (negative control). | `testWaitStable` (with negative-control case) | SHOULD | S2. Idle detection. |
| REQ-8 | Each `waitForWindow` capture is a separate `capture-pane` exec bounded by `TMUX_INVOCATION_TIMEOUT_MS` (5s); the long wait is achieved by *polling*, never one long exec. | `testWaitPerCallTimeout` | MUST | S2. Asserts every `fake.calls[i]` is `capture-pane` and the long `timeoutMs` is honored across multiple short execs. |
| REQ-9 | `sendText({pressEnterCount:N})` sends **exactly N** separate `send-keys … Enter` invocations (aimax triple-Enter ⇒ N=3). N is clamped to `0..MAX_ENTER_COUNT` (10); N=11 yields 10 calls. | `testSendEnterCount`, `testSendEnterCountClamp` | MUST | S3. Default N=1 when `pressEnter` truthy. |
| REQ-10 | `sendText({pressEnter:false})` (or `pressEnterCount:0`) sends **zero** Enter invocations. | `testSendNoEnter` | MUST | S3. Extends existing `sendText: without Enter` test. |
| REQ-11 | `sendText({mode:"keys"})` omits `-l`, passes each whitespace-separated token as a distinct key argument, and **does not** fire the Enter loop (default `pressEnter:false` in keys mode). Total `send-keys` call count equals exactly one call with the token args. | `testSendKeysMode` (asserts no `-l`, tokens present, total call count = 1, no trailing Enter) | MUST | S5. Enables key chords without double-submit. |
| REQ-12 | `sendText({mode:"literal"})` (default, and when `mode` omitted) keeps `-l` and sends the text as one verbatim argv element. | `testSendLiteralDefault` | MUST | S5. Back-compat with v0.1 (existing `sendText` test must still pass unchanged). |
| REQ-13a | `checkExtendedKeys` returns `{ok:false}` when `extended-keys-format` ≠ `csi-u` (or tmux < 3.5 or version-parse failure), `{ok:true}` when it is `csi-u` on tmux ≥ 3.5. (Renumbered from REQ-13 to avoid collision with the existing tmux-control REQ-13 import-guard rule in `run-control-tests.sh:29`.) | `testExtendedKeysCheckCsiU`, `testExtendedKeysCheckXterm`, `testExtendedKeysCheckOldTmux`, `testExtendedKeysParseFail` | MUST | S4. Pure checker over executor output (parses `tmux -V` and `tmux show-option -gv extended-keys-format`). |
| REQ-14 | The `session_start` extended-keys check is **warn-only**: a failing check emits a `warning` notify but registration of commands/tools/hook still completes and nothing throws. No-socket case (no `$TMUX` and no default socket) is a no-op (no warn, no error). Handler remains **synchronous** — `checkExtendedKeys` is fire-and-forget; the test injects a synchronously-resolved fake executor so the warn lands deterministically before the assertion. | `testSessionStartWarnOnly`, `testSessionStartNoSocketNoop` | MUST | S4. Fire-and-forget inside a sync handler; pinned by the existing `test-extension-integration.mjs:40` "session_start handler is sync" assertion (unchanged). |
| REQ-15 | `tmux_drive_claude` refuses a target window that fails the prefix gate (`resolveTarget` error) and performs **no** send/paste before refusing. | `testDriveRefusesUnprefixed` | MUST | S6. Assert `fake.calls.length === 0` after refusal. |
| REQ-16 | `tmux_drive_claude` composes wait(ready) → paste(prompt) → Enter → wait(done) → capture, and returns the final captured text on success. | `testDriveHappyPath` | MUST | S6. Fake-executor scripted across all phases. |
| REQ-17 | All new functions (`pasteText`, `waitForWindow`, `checkExtendedKeys`, `tmux_drive_claude`) reach tmux **only** through `TmuxExecutor.exec(args[])` (argv-only execFile); no `shell:true`, no `execSync`, no string concatenation into a command. Pinned grep patterns: `shell:\s*true`, `\bexecSync\b`, ` exec\(`. | `testPasteArgvOnly`, `testSendKeysMode` + static guard `grep -E 'shell:\s*true\|\\bexecSync\\b\| exec\('` in `run-control-tests.sh` | MUST | Argv-only invariant. Static guard has a **red-then-green** self-check: deliberately-broken fixture line is added/removed by the test runner to prove the guard bites (per `PLAN_TEMPLATE.md` Verify deny-list). |
| REQ-18 | `sendText` / `tmux_send` route text containing `\n` through `pasteText` automatically (so a multi-line prompt never premature-submits). Opt-out: `mode:"keys"` skips the routing (callers explicitly asked for key tokens). `pressEnter`/`pressEnterCount` thread through to `pasteText`. | `testSendRoutesMultilineToPaste`, `testSendRoutesMultilineRespectsPressEnterFalse` | MUST | S1↔S3 seam. Assert a multi-line `sendText` produces a `paste-buffer -p` call (asserting `-p` too), not N `send-keys -l`. |
| REQ-19 | A real-tmux smoke exercises `pasteText` (multi-line into live pane, no premature submit), `waitForWindow` (regex marker detection), and keys-mode (`C-c` against a live pane) against a live isolated server. | `manual/E2E: test-real-tmux-smoke.mjs` (3 added steps) | SHOULD · `UNGUARDED-IN-CI` | tmux may be absent in CI (smoke `SKIPPED`s). Covering manual step: run `bash test-fixtures/run-control-tests.sh` on a machine with tmux ≥ 3.5 and confirm the new smoke steps print `ok`. Per `test-pi-extensions-via-tmux`, this run is **required before commit**, not optional. **The multi-line paste step is the sole proof of REQ-1's end-to-end "no premature submit" property** — every other assertion of REQ-1 is mechanism-only (asserts `-p` in argv; cannot prove TUI reception). |

**Priority legend:** MUST = blocker for that slice's merge; SHOULD = required before feature complete (one slice may defer); MAY = nice-to-have.

## Non-Goals

- **Launching claude/pi itself inside `tmux_drive_claude`.** S6 drives an *existing* prefix-gated window; it does not spawn the TUI (launch stays in `launchSession` / the agents backend). Auto-launch is an Open Decision.
- **Isolated `-L` socket management from the extension.** The research doc's `tmux -L drive-$$` pattern is for standalone scripts; the extension targets the user's main server (`-S`) via `discoverMainServerPrefix`, gated by prefix. Isolated-socket orchestration is out of scope.
- **OAuth / keychain forwarding** (research §"OAuth and credential forwarding"). Driving claude assumes the target window is already authenticated.
- **`--bare` handling, `--add-dir`, model-specific readiness strings** beyond a configurable default regex.
- **Auto-setting `extended-keys-format`.** S4 is *warn-only* — the extension never mutates the user's tmux server options.
- **Bracketed-paste capability detection.** We assume modern TUIs support it (research §4); a TUI that doesn't is the caller's responsibility (documented edge case).

## Safety / Security

The v0.1 invariant is preserved and extended: **every tmux interaction is argv-only (`execFile`, no shell) and every write/drive target passes the prefix gate (`resolveTarget`) before any bytes are sent.**

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Prompt text interpreted by a shell (metachars, `$()`, `;`) | High | `pasteText` passes text as a single `set-buffer` argv element via `TmuxExecutor.exec`; never a shell string. `set-buffer` data is positional after `-b <name> --`. | `testPasteArgvOnly` (asserts the exact text is one argv element, unsplit) + static `grep` guard (REQ-17) |
| `paste-buffer` LF→CR conversion prematurely submits each line | High | Use `paste-buffer -p` (bracketed paste) with `-r` NOT set; TUI receives one bracketed-paste event. Asserts `-p` present and `-r` absent in argv. | `testPasteMultilineSingleEvent` (asserts argv contains `-p` and not `-r`) + multi-line live-paste smoke step |
| Driving/typing into the user's real shell window | High | `tmux_drive_claude` and all send paths route through `resolveTarget(id, …, {prefix})`; a non-prefixed target is refused before any call. | `testDriveRefusesUnprefixed` (asserts `fake.calls.length===0`) |
| Buffer-name injection via `set-buffer -b <name>` | Low | Buffer name is an extension-controlled constant (`pictl-paste`), never user input. | `testPasteDeletesBuffer`, `testPasteDeletesBufferOnFail` |
| `keys` mode token injection (a token like `; rm`) | Low | Tokens are argv key-name args to `send-keys` (no `-l`); tmux rejects unknown key names with a non-zero exit, surfaced as `ok:false`. No shell involved. | `testSendKeysMode` (asserts tokens are separate argv, not a shell string; total call count = 1, no trailing Enter) |
| `keys` mode double-submit (token + auto-Enter) | Medium | In keys mode, `pressEnter` defaults to `false`; the Enter loop is skipped when `mode === "keys"`. | `testSendKeysMode` (asserts total send-keys call count = 1, no trailing Enter) |
| Leading-dash text misread as a tmux option | Medium · `UNGUARDED-IN-CI` | `set-buffer -b name -- <text>` uses `--` options terminator (OD-1 resolved). The argv shape is unit-falsifiable; the **end-to-end** no-misparse property is only provable in a live tmux. | `testPasteLeadingDash` (argv shape) + multi-line live-paste smoke step (end-to-end) |
| Unbounded poll loop (`waitForWindow`) hanging the agent | Medium | Hard `timeoutMs` cap + bounded poll count; each capture bounded by 5s exec timeout. | `testWaitTimeout`, `testWaitPerCallTimeout` |

**Red-then-green:** `testDriveRefusesUnprefixed` is the negative control for the prefix gate (a non-prefixed target must produce zero calls — proving the gate fires *before* I/O, not after).

## Design

### Key types

```ts
// lib/paste.ts  (S1)
export interface PasteResult {
  ok: boolean;
  sentBytes?: number;
  error?: string;
}
/** Deliver `text` as a single bracketed-paste via set-buffer + paste-buffer -d.
 *  pressEnter default TRUE (submit after paste); pressEnterCount default 1. */
export function pasteText(
  executor: TmuxExecutor,
  socketPrefix: string[],
  target: { sessionName: string; windowIndex: string },
  text: string,
  opts?: { pressEnter?: boolean; pressEnterCount?: number },
): Promise<PasteResult>;

// lib/send.ts  (S3 + S5, extends existing sendText)
export type SendMode = "literal" | "keys";
export interface SendOpts {
  pressEnter?: boolean;       // existing (default true)
  pressEnterCount?: number;   // S3, default 1; clamped 0..MAX_ENTER_COUNT
  mode?: SendMode;            // S5, default "literal"
}

// lib/wait.ts  (S2)
export type WaitResult =
  | { ok: true;  matched: "regex" | "stable"; output: string; elapsedMs: number; polls: number }
  | { ok: false; reason: "timeout" | "capture-error"; output?: string; error?: string; elapsedMs: number; polls: number };
export interface WaitOpts {
  regex?: string | RegExp;     // ready/done marker
  stableMs?: number;           // idle window (output unchanged this long)
  timeoutMs: number;           // hard cap (REQUIRED)
  intervalMs?: number;         // poll cadence, default 1000
  lines?: number;              // capture depth, default 50
}
/** Test seam: inject sleep/now so unit tests run without real time. */
export interface WaitDeps { sleep?: (ms: number) => Promise<void>; now?: () => number; }
export function waitForWindow(
  executor: TmuxExecutor, socketPrefix: string[],
  target: { sessionName: string; windowIndex: string },
  opts: WaitOpts, deps?: WaitDeps,
): Promise<WaitResult>;

// lib/keyscheck.ts  (S4)
export interface KeysCheckResult { ok: boolean; format?: string; version?: string; warning?: string; }
export function checkExtendedKeys(executor: TmuxExecutor, socketPrefix: string[]): Promise<KeysCheckResult>;
```

```ts
// constants additions
export const MAX_ENTER_COUNT = 10;            // S3 bound
export const PASTE_BUFFER_NAME = "pictl-paste"; // S1 fixed buffer name
export const DEFAULT_DRIVE_READY_REGEX = "❯";                 // S6
export const DEFAULT_DRIVE_DONE_REGEX  = "Cooked for|Baked for|✻"; // S6 (research §"Reliable workflow" step 6)
export const DEFAULT_WAIT_INTERVAL_MS = 1000; // S2
```

### Key invariants

- **Argv-only.** Every tmux call is `executor.exec(string[])`. No new code constructs a shell command string. (REQ-17, static guard.)
- **Prefix gate before I/O.** No send/paste/drive happens until `resolveTarget` returns a target. (REQ-15.)
- **Single paste event.** Multi-line text is delivered by exactly one `paste-buffer`, never decomposed into per-line `send-keys`. (REQ-1, REQ-18.)
- **Polling, not long execs.** `waitForWindow` honors a large `timeoutMs` via many ≤5s `capture-pane` execs; the single-invocation 5s cap is never raised. (REQ-8.)
- **Warn, never mutate.** S4 reads tmux options; it never sets them. (Non-Goal.)
- **Buffer hygiene.** Every `set-buffer` is matched by a `paste-buffer -d` of the same named buffer. (REQ-4.)

### Resolution / flow

```text
pasteText:
  text → guard(len ≤ MAX_TEXT_BYTES)
       → set-buffer -b pictl-paste -- <text>            # `--` options terminator (OD-1 resolved)
       → paste-buffer -p -d -b pictl-paste -t <session:index>   # -p = bracketed paste; -d = delete buffer
       → [pressEnter] send-keys -t <session:index> Enter   (× pressEnterCount, default 1)

sendText (updated):
  if text contains "\n" and mode !== "keys"
                                         → delegate to pasteText (REQ-18), threading pressEnter/pressEnterCount
  else if mode === "keys"                → send-keys -t T <tok1> <tok2> …   (no -l; pressEnter defaults to FALSE — REQ-11)
  else                                    → send-keys -l -t T <text>         (v0.1 path)
  if mode !== "keys" and pressEnter !== false
                                         → Enter × pressEnterCount  (clamped 0..MAX_ENTER_COUNT)

waitForWindow:
  loop while elapsed < timeoutMs (deps.now):
    out = captureWindow(lines)          # one ≤5s exec
    if !out.ok            → return {ok:false, reason:"capture-error"}
    if regex && regex.test(out) → return {ok:true, matched:"regex"}
    if stableMs && out===prev for ≥ stableMs → return {ok:true, matched:"stable"}
    prev = out; await deps.sleep(intervalMs)
  return {ok:false, reason:"timeout"}

tmux_drive_claude (tool):
  resolveTarget(window, {prefix})            # REQ-15 gate
  → waitForWindow(readyRegex,  timeout=readyTimeoutMs)
  → pasteText(prompt, pressEnterCount)
  → waitForWindow(doneRegex || stableMs, timeout=doneTimeoutMs)
  → captureWindow(lines)  → return text
```

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `tmux-control/lib/send.ts` | L28–L63 `sendText` | literal `-l` send + separate Enter | **S3/S5**: add `pressEnterCount` + `mode`; **S1**: route multi-line to `pasteText` (L40–L49 region) |
| `tmux-control/lib/send.ts` | L45 `["…","send-keys","-l","-t",t,text]` | literal argv builder | **S5**: branch on `mode` (drop `-l`, split tokens) |
| `tmux-control/lib/send.ts` | L51–L60 Enter block | single Enter | **S3**: loop `pressEnterCount` times |
| `tmux-control/lib/capture.ts` | L24–L38 `captureWindow` | argv `capture-pane -p -J -S` | **S2**: `waitForWindow` consumes this verbatim (no change to capture.ts) |
| `tmux-control/lib/constants.ts` | L1–L8 | shared constants | **S1/S3/S6**: add `MAX_ENTER_COUNT`, `PASTE_BUFFER_NAME`, `DEFAULT_DRIVE_*`, `DEFAULT_WAIT_INTERVAL_MS` |
| `tmux-control/index.ts` | L103–L129 `/tmux-send` + L230–L249 `tmux_send` | send command/tool | **S3/S5**: surface `pressEnterCount`/`mode` params |
| `tmux-control/index.ts` | L192–L267 `registerTools` | tool registry | **S6**: register `tmux_drive_claude` |
| `tmux-control/index.ts` | L370–L374 `session_start` | registers everything (sync) | **S4**: fire-and-forget `checkExtendedKeys` *inside* the sync handler — the existing `test-extension-integration.mjs:40` assertion `startResult === undefined` is preserved unchanged; the warn lands deterministically only when the test injects a synchronously-resolved fake executor (covered by `testSessionStartWarnOnly`). |
| `tmux-control/lib/safety.ts` | L37–L63 `resolveTarget` | prefix gate | **S6**: reused unchanged as the drive gate |
| `tmux-control/test-fixtures/test-exec.mjs` | L70–L112 sendText tests | fake-executor patterns | **S1/S2/S3/S5**: add new fake tests here (or new test files) |
| `tmux-control/test-fixtures/test-real-tmux-smoke.mjs` | L105–L126 | live capture/send steps | **S1/S2/S5**: add paste + wait + keys E2E steps |
| `tmux-control/test-fixtures/run-control-tests.sh` | L29–L37 REQ-13 guard | static import guard | **REQ-17**: add argv-only `grep` guard alongside |

## Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P5c-2-S1` | `pasteText` (set-buffer + paste-buffer -p) for multi-line | `lib/paste.ts` (new), `lib/constants.ts`, `lib/send.ts` (multi-line routing), `index.ts` (`/tmux-paste`?), `test-fixtures/test-exec.mjs` | `pasteText`; `sendText` routes `\n` → paste; `PASTE_BUFFER_NAME` | `testPasteMultilineSingleEvent`, `testPasteArgvOnly`, `testPasteOversize`, `testPasteDeletesBuffer`, `testPasteDeletesBufferOnFail`, `testPasteLeadingDash`, `testSendRoutesMultilineToPaste`, `testSendRoutesMultilineRespectsPressEnterFalse` | argv-only proven; `-p` asserted; buffer auto-deleted (happy + fail); existing `sendText` single-line tests unchanged |
| `P5c-2-S2` | `waitForWindow` polling primitive | `lib/wait.ts` (new), `lib/constants.ts`, `test-fixtures/test-exec.mjs` (or `test-wait.mjs`) | `waitForWindow` w/ injectable clock | `testWaitRegexMatch`, `testWaitTimeout`, `testWaitStable` (with negative-control), `testWaitPerCallTimeout`, `testWaitCaptureError` | bounded polls; per-call ≤5s; deterministic (injected `sleep`/`now`) |
| `P5c-2-S3` | `pressEnterCount` for `sendText` | `lib/send.ts`, `lib/constants.ts`, `index.ts` (param), `test-fixtures/test-exec.mjs` | `pressEnterCount` (default 1, clamp 0..10) | `testSendEnterCount`, `testSendEnterCountClamp`, `testSendNoEnter` | exactly N Enter calls (N clamped); `pressEnter:false`⇒0; existing tests green |
| `P5c-2-S4` | extended-keys warn at `session_start` | `lib/keyscheck.ts` (new), `index.ts` (session_start), `test-fixtures/test-exec.mjs` + `test-extension-integration.mjs` | `checkExtendedKeys`; warn-only wiring (sync handler + fire-and-forget) | `testExtendedKeysCheckCsiU`, `testExtendedKeysCheckXterm`, `testExtendedKeysCheckOldTmux`, `testExtendedKeysParseFail`, `testSessionStartWarnOnly`, `testSessionStartNoSocketNoop` | warn-only (never throws, never mutates); registration still completes; no-socket = no-op |
| `P5c-2-S5` | `mode: 'literal'\|'keys'` for `tmux_send` | `lib/send.ts`, `index.ts` (param + tool schema), `test-fixtures/test-exec.mjs` | `mode` branch (keys omits `-l`, splits tokens, default `pressEnter:false`) | `testSendKeysMode`, `testSendLiteralDefault`, `testSendKeysEmpty` | default stays literal/back-compat; keys mode argv-only, no double-Enter |
| `P5c-2-S6` | `tmux_drive_claude` composite tool | `lib/drive.ts` (new), `index.ts` (tool), `lib/constants.ts`, `test-fixtures/test-exec.mjs` + smoke | `driveClaude` orchestrator + `tmux_drive_claude` tool | `testDriveRefusesUnprefixed`, `testDriveHappyPath`, `testDriveReadyTimeout`, `testDriveDoneTimeoutPartial` | prefix-gated before I/O; composes S1+S2; returns captured text on success, partial on done-timeout |

### Dependency graph

```text
            ┌──────────── S2 (waitForWindow) ───────────┐
            │                                            │
START ──────┼──── S1 (pasteText) ── S3 (pressEnterCount) ── S5 (mode) ──┐
            │                                            │              │
            └──────────── S4 (extended-keys) ───────────┘              │
                                                                       │
                                       S6 (tmux_drive_claude) ◄────────┘
                                       (needs S1 + S2; benefits from S3/S5)
```

- **Parallel-shippable from START:** S1, S2, S4 — disjoint files (S1=`paste.ts`/`send.ts`, S2=`wait.ts`, S4=`keyscheck.ts`). No functional coupling.
- **Serial on `send.ts` file-contention:** S3 → S5 (both edit `sendText`). S3 also needs S1's multi-line routing to already exist in `send.ts` to avoid re-merging the Enter block. Order: **S1 → S3 → S5**. This is a *file-edit* serialization, not a deep functional dependency.
- **S6 hard-depends on S1 (paste) + S2 (wait)**; it *uses* S3 (`pressEnterCount`) and S5 (`mode`) if present but degrades gracefully (defaults N=1, literal). S6 must land last.

## Cut Order

If context or scope grows, cut in this order:

1. **S6** (`tmux_drive_claude`) — pure convenience composite; callers can chain S1+S2 by hand.
2. **S5** (`keys` mode) — key chords are useful but `pressEnterCount` (S3) covers the most common TUI need (submit / triple-Enter).
3. **S4** (extended-keys warn) — diagnostic only; absence degrades to silent (the v0.1 status quo).
4. **S7-defer: stableMs branch of S2** — ship regex-only `waitForWindow` first if needed (downgrade REQ-7 only; REQ-5/6/8 stay).

Do not cut:

- **S1** — multi-line paste is the headline correctness fix (premature-submit is a data-loss-grade bug).
- **S2 regex/timeout core** (REQ-5, REQ-6, REQ-8) — without bounded waiting, every other slice is brittle.
- **The argv-only + prefix-gate invariants** (REQ-2, REQ-15, REQ-17) — non-negotiable safety floor inherited from v0.1.

## Contracts

### `pasteText(executor, socketPrefix, target, text, opts?) → Promise<PasteResult>`

**Input contract:** `text: string`, length ≤ `MAX_TEXT_BYTES` (4000). `target` is session-qualified `{sessionName, windowIndex}` (already prefix-gated by the caller). `opts.pressEnter` default `true`; `opts.pressEnterCount` default `1`, clamped `0..MAX_ENTER_COUNT`.

**Output contract:** `{ ok: true, sentBytes }` on success; `{ ok: false, error }` otherwise. On success: exactly one `set-buffer`, one `paste-buffer -p -d` (bracketed paste, delete-after), then `pressEnterCount` Enter calls (0 if `pressEnter:false`). On paste failure (state D): best-effort `delete-buffer -b pictl-paste` to avoid orphan buffer.

**State table (exhaustive):**

| State | Condition | Output | tmux calls |
|---|---|---|---|
| A. Bad type | `typeof text !== "string"` | `{ok:false, error:"text must be a string"}` | 0 |
| B. Oversize | `text.length > 4000` | `{ok:false, error:"text too long: …"}` | 0 |
| C. set-buffer fails | exec[0] `!ok` | `{ok:false, error:<stderr>}` | 1 |
| D. Paste fails | exec[1] `!ok` | `{ok:false, error:"buffer set but paste failed: …"}` | 2 + best-effort delete-buffer |
| E. Enter fails | any Enter exec `!ok` | `{ok:false, error:"pasted but Enter failed: …"}` | 2 + N' |
| F. Success (paste only) | all ok, `pressEnter:false` | `{ok:true, sentBytes:text.length}` | 2 |
| G. Success (paste+N×Enter) | all ok | `{ok:true, sentBytes:text.length}` | 2 + N |

**Error codes:**

| Code (error substring) | Trigger |
|---|---|
| `text must be a string` | non-string `text` |
| `text too long` | `> MAX_TEXT_BYTES` |
| `buffer set but paste failed` | `paste-buffer` non-zero |
| `pasted but Enter failed` | Enter `send-keys` non-zero |

### `waitForWindow(executor, socketPrefix, target, opts, deps?) → Promise<WaitResult>`

**Input contract:** `opts.timeoutMs` REQUIRED (>0). At least one of `regex` / `stableMs` SHOULD be set; if neither, behaves as a plain `timeoutMs` sleep-poll returning `reason:"timeout"`. `intervalMs` default 1000, `lines` default 50. `deps.sleep`/`deps.now` default to real implementations (tests inject fakes).

**Output contract:** discriminated union (see Key types). `polls` = number of `capture-pane` execs issued; `elapsedMs` ≤ `timeoutMs + intervalMs`.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Regex hit | a capture matches `regex` before timeout | `{ok:true, matched:"regex", output, elapsedMs, polls}` |
| B. Stable | `stableMs` set & output unchanged ≥ `stableMs` | `{ok:true, matched:"stable", …}` |
| C. Capture error | a `capture-pane` returns `!ok` | `{ok:false, reason:"capture-error", error, elapsedMs, polls}` |
| D. Timeout | neither A nor B before `timeoutMs` | `{ok:false, reason:"timeout", output:<last>, elapsedMs, polls}` |

### `sendText(executor, socketPrefix, target, text, opts?)` — updated

**Input contract:** adds `opts.pressEnterCount` (default 1, clamp `0..MAX_ENTER_COUNT` (10); `pressEnter:false` ⇒ 0) and `opts.mode` (`"literal"` default | `"keys"`). In **keys mode**, `pressEnter` defaults to `false` (the Enter loop is skipped) — REQ-11 fixes the v0.1 double-submit bug.

**Output contract:** unchanged shape `{ok, sentBytes?, error?}`. Behavioral additions:

| State | Condition | Behavior |
|---|---|---|
| A. Multi-line, not keys | `text.includes("\n")` and `mode !== "keys"` | delegate to `pasteText` (REQ-18); thread `pressEnter` / `pressEnterCount` through |
| B. Keys mode | `mode==="keys"` | `send-keys -t T <tok…>` (no `-l`); tokens = `text.split(/\s+/)` non-empty; **no Enter loop** (pressEnter defaults to false); total `send-keys` calls = 1 |
| C. Literal (default) | else | `send-keys -l -t T <text>` (v0.1 path, unchanged) |
| D. Enter ×N | `mode !== "keys"` and `pressEnter !== false` | N = clamp(`pressEnterCount ?? 1`, 0, MAX_ENTER_COUNT) separate Enter calls after the text |
| E. Empty keys | `mode==="keys"` & no tokens | `{ok:false, error:"keys mode requires at least one key token"}`, 0 calls |

**Error codes:** existing (`text must be a string`, `text too long`, Enter-failed) + `keys mode requires at least one key token`.

### `tmux_drive_claude` tool (`driveClaude(...)` in `lib/drive.ts`)

**Input contract (tool params):** `window: string` (name or runId), `prompt: string` (≤ `MAX_TEXT_BYTES`), `readyRegex?: string` (default `DEFAULT_DRIVE_READY_REGEX`), `doneRegex?: string` (default `DEFAULT_DRIVE_DONE_REGEX`), `readyTimeoutMs?` (default 30000), `doneTimeoutMs?` (default 120000), `pressEnterCount?` (default 1), `lines?` (default 200).

**Output contract:** `{ content:[{type:"text", text}], details:{ok, phase, target} }`. `phase` ∈ `"resolve"|"ready"|"paste"|"done"|"capture"` (the furthest reached). On any phase failure, `ok:false` and `text` carries the phase + error.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Gate fail | `resolveTarget` error | `{ok:false, phase:"resolve", text:<error>}`, **0 send/paste calls** (REQ-15) |
| B. Not ready | ready wait times out | `{ok:false, phase:"ready", text:"window not ready: …"}` |
| C. Paste fail | `pasteText` `!ok` | `{ok:false, phase:"paste", text:<error>}` |
| D. Never done | done wait times out | `{ok:false, phase:"done", text:<last capture>}` (partial output returned) |
| E. Success | all phases pass | `{ok:true, phase:"capture", text:<captured>}` |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `pasteText` with `"line1\nline2\nline3"` | exactly **one** `paste-buffer`; **zero** per-newline `send-keys -l`; one optional trailing Enter | `testPasteMultilineSingleEvent` |
| EC2 | `pasteText` text starting with `-` (e.g. `"-rf danger"`) | text delivered as positional data after `-b <name>`, not parsed as an option; paste succeeds | `testPasteLeadingDash` + smoke |
| EC3 | `waitForWindow` regex never appears within `timeoutMs` | `{ok:false, reason:"timeout"}`, `polls ≤ ceil(timeoutMs/intervalMs)+1`, last output returned | `testWaitTimeout` |
| EC4 | `waitForWindow` output changes for 3 polls then settles, `stableMs` set | `matched:"stable"` only after the unchanged-for-`stableMs` window, not on first repeat | `testWaitStable` |
| EC5 | `sendText` keys mode `"C-c Enter"` | args contain `C-c` and `Enter` as separate tokens, **no** `-l` flag | `testSendKeysMode` |
| EC6 | `sendText` `pressEnterCount:3` | exactly 3 Enter `send-keys` calls after the text | `testSendEnterCount` |
| EC7 | `session_start` when `extended-keys-format` unset / tmux <3.5 | `warning` notify emitted; commands/tools/hook still registered; no throw | `testSessionStartWarnOnly` |
| EC8 | `tmux_drive_claude` targets a non-prefixed window | refused at `phase:"resolve"`; `fake.calls.length===0` | `testDriveRefusesUnprefixed` |
| EC9 | `waitForWindow` and the window is killed mid-poll (`capture-pane` errors) | `{ok:false, reason:"capture-error"}` immediately — does **not** spin to timeout | `testWaitCaptureError` |
| EC10 | `pasteText` / `tmux_drive_claude` prompt > 4000 bytes | rejected with `text too long`, **0** tmux calls | `testPasteOversize` |
| EC11 | `sendText` keys mode with empty/whitespace text | `{ok:false, error:"keys mode requires at least one key token"}`, 0 calls | `testSendKeysEmpty` |

## Test Case Catalog

Grouped by concern. Every name appears in the Requirements / Edge Cases tables.

```text
Group 1: pasteText (S1) — 8 tests
  testPasteMultilineSingleEvent     (REQ-1, EC1 — asserts args include `-p`, exclude `-r`)
  testPasteArgvOnly                 (REQ-2, REQ-17)
  testPasteOversize                 (REQ-3, EC10)
  testPasteDeletesBuffer            (REQ-4 — happy path)
  testPasteDeletesBufferOnFail      (REQ-4 — best-effort delete on paste failure)
  testPasteLeadingDash              (EC2 — argv shape; end-to-end is UNGUARDED-IN-CI)
  testSendRoutesMultilineToPaste    (REQ-18 — multi-line routes to pasteText)
  testSendRoutesMultilineRespectsPressEnterFalse (REQ-18 — opt-out propagation)

Group 2: waitForWindow (S2) — 5 tests
  testWaitRegexMatch                (REQ-5)
  testWaitTimeout                   (REQ-6, EC3)
  testWaitStable                    (REQ-7, EC4 — with negative-control case)
  testWaitPerCallTimeout            (REQ-8)
  testWaitCaptureError              (EC9)

Group 3: sendText pressEnterCount (S3) — 3 tests
  testSendEnterCount                (REQ-9, EC6)
  testSendEnterCountClamp           (REQ-9 — N=11 ⇒ 10 calls)
  testSendNoEnter                   (REQ-10)

Group 4: extended-keys (S4) — 6 tests
  testExtendedKeysCheckCsiU         (REQ-13a — ok path)
  testExtendedKeysCheckXterm        (REQ-13a — not-ok path)
  testExtendedKeysCheckOldTmux      (REQ-13a — < 3.5 path)
  testExtendedKeysParseFail         (REQ-13a — `tmux -V` parse failure)
  testSessionStartWarnOnly          (REQ-14 — sync handler + injected sync executor)
  testSessionStartNoSocketNoop      (REQ-14 — no $TMUX, no default socket = no-op)

Group 5: send mode (S5) — 3 tests
  testSendKeysMode                  (REQ-11, EC5 — asserts no `-l`, tokens present, total send-keys calls = 1, no trailing Enter)
  testSendLiteralDefault            (REQ-12)
  testSendKeysEmpty                 (EC11)

Group 6: tmux_drive_claude (S6) — 4 tests
  testDriveRefusesUnprefixed        (REQ-15, EC8)
  testDriveHappyPath                (REQ-16)
  testDriveReadyTimeout             (State B in plan)
  testDriveDoneTimeoutPartial       (State D in plan — partial output returned)

Group 7: real-tmux smoke (E2E, SHOULD / UNGUARDED-IN-CI) — 3 added steps
  smoke: pasteText delivers multi-line into a live pane via `-p` (no premature submit) — the sole proof of REQ-1's end-to-end property
  smoke: waitForWindow detects a marker echoed into a live pane
  smoke: sendText keys-mode sends C-c to a live pane

Total: **29 unit tests** + 3 added smoke steps.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| `set-buffer` data starting with `-` misparsed across tmux versions | Medium | Positional-after-`-b` placement; EC2 unit test + live smoke (REQ-19); Open Decision on `--` terminator if a version regresses |
| Bracketed paste unsupported by a target TUI → multi-line still premature-submits | Low | Documented Non-Goal; `keys`/`literal` fallback available; research §4 cited |
| `waitForWindow` flakiness if tests use real timers | Medium | Injectable `sleep`/`now` (test seam) → deterministic unit tests; real timing only in smoke |
| `send.ts` triple-edited (S1, S3, S5) causes merge churn | Low | Enforced serial order S1→S3→S5; each leaves suite green independently |
| `tmux_drive_claude` long `doneTimeoutMs` blocks the tool call | Medium | Tool runs in `execute` (async, not the command handler); bounded by `doneTimeoutMs`; per `knowledge_base/pi-extension-api` non-blocking note |
| Default `doneRegex` (`Cooked for\|✻`) is claude-version-specific | Low | Configurable param; default documented as best-effort; `stableMs` fallback path |

## Open Decisions

- **OD-1 (S1) — RESOLVED.** Use `set-buffer -b pictl-paste -- <text>` with `--` options terminator. Rationale: the `TmuxExecutor` exposes only `exec(args, opts)` with **no stdin channel** (verified — `lib/exec.ts:9–11` has no `input` option), so the doc's safer `load-buffer -` path is unavailable. Without `--`, leading-dash payloads risk being parsed as tmux options. The argv shape is unit-falsifiable; the end-to-end no-misparse property is `UNGUARDED-IN-CI` and covered by the smoke. *If a future tmux version misparses despite `--`, fall back to base64-via-stdin by extending the executor.*
- **OD-2 (S6):** auto-launch the TUI inside `tmux_drive_claude`. Deferred (Non-Goal for now). Rationale: launching into the user's main server collides with the prefix-gate model; revisit if a gated "launch-then-drive" is requested.
- **OD-3 (S2):** expose `waitForWindow` as a user-facing `/tmux-wait` command/tool, or keep it internal (consumed only by S6). Deferred to S2 review. Rationale: avoid surface bloat until a direct caller exists.
- **OD-4 (S3):** use `send-keys -N <count> Enter` (single exec) vs N separate Enter execs. **RESOLVED — N separate execs.** Matches aimax's "triple `send-keys Enter`", makes the count assertable via `fake.calls.length`, and per-exec bounded by the 5s timeout. Revisit only if exec overhead matters in profiling.
- **OD-5 (S1) — RESOLVED.** Use `paste-buffer -p` (bracketed paste) and **do not** set `-r` (LF→CR conversion). Rationale: without `-p`, tmux delivers the buffer as raw bytes with LF→CR conversion, which is exactly the premature-submit bug S1 is meant to fix. With `-p`, tmux wraps the paste in `\x1b[200~...\x1b[201~` and the TUI treats it as a single bracketed-paste event. The `-r` flag would re-disable that conversion — so we leave it off. Asserted via `args.includes("-p") && !args.includes("-r")` in the unit test.

## Done Criteria

- [ ] `bash tmux-control/test-fixtures/run-control-tests.sh` prints all 29 new unit tests passing plus the existing suite.
- [ ] The real-tmux smoke runs its 3 new steps (`ok`) on a tmux ≥ 3.5 host, or cleanly `SKIPPED`s where tmux is absent (REQ-19 manual gate per `test-pi-extensions-via-tmux`).
- [ ] Argv-only static guard (REQ-17) passes: no `shell:true` / `execSync` / template-string exec in new lib files.
- [ ] Each MUST row's named test exists, runs, and fails when its behavior is broken (negative control present for REQ-15 and REQ-14).
- [ ] v0.1 behavior unchanged: every pre-existing `test-exec.mjs` assertion still passes untouched.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | author (claude plan-write) | claude opus 4.8 | 0 (planning) | plan ready for review |
| 2 | adversarial (claude) | claude opus 4.8 | 4 | REVISE-AND-RESUBMIT |
| 3 | author (claude re-review, this rev) | claude opus 4.8 | 0 (post-revision) | APPROVE-WITH-FIXES — see Applied Fixes |

### Applied Fixes (post-adversarial)

| # | Source | Fix |
|---|---|---|
| B1 | Adversarial #1 | Added `paste-buffer -p` (bracketed paste); REQ-1 now asserts `args.includes("-p")` and `!args.includes("-r")`. OD-5 added & resolved. |
| B2 | Adversarial #2 | REQ-1 end-to-end property now tagged `UNGUARDED-IN-CI` with the multi-line paste smoke as covering step. Retracted "no MUST depends on this smoke" claim. |
| B3 | Adversarial #3 | S4 sync-vs-async resolved: handler stays sync; `checkExtendedKeys` is fire-and-forget. `testSessionStartWarnOnly` uses a synchronously-resolved injected executor. Existing `test-extension-integration.mjs:40` assertion unchanged. `testSessionStartNoSocketNoop` added. |
| B4 | Adversarial #4 | Keys mode now defaults `pressEnter` to `false`; Enter loop is skipped when `mode === "keys"`. `testSendKeysMode` asserts total send-keys call count = 1 with no trailing Enter. |
| OD-1 | Adversarial Open Decisions | Resolved: `set-buffer -b name -- <text>` with `--` terminator. Rationale recorded (executor has no stdin channel). Leading-dash Safety row tagged `UNGUARDED-IN-CI`. |
| OD-4 | Already resolved | N separate Enter execs (kept as documented). |
| Renumber | Non-blocking #6 | Plan's `checkExtendedKeys` requirement renumbered REQ-13 → REQ-13a to avoid collision with the existing tmux-control REQ-13 import-guard. |
| Test gaps | Missing tests #1–9 | Added: `testPasteDeletesBufferOnFail`, `testSendEnterCountClamp`, `testExtendedKeysCheckCsiU/Xterm/OldTmux/ParseFail`, `testSessionStartNoSocketNoop`, `testSendRoutesMultilineRespectsPressEnterFalse`, `testDriveReadyTimeout`, `testDriveDoneTimeoutPartial`, stable-wait negative control case. Total 29 unit tests (was 23) + 3 smoke. |

## Appendix: Implementation Plan (outline)

### Files to create

1. `tmux-control/lib/paste.ts` — `pasteText` (S1).
2. `tmux-control/lib/wait.ts` — `waitForWindow` + `WaitDeps` seam (S2).
3. `tmux-control/lib/keyscheck.ts` — `checkExtendedKeys` (S4).
4. `tmux-control/lib/drive.ts` — `driveClaude` orchestrator (S6).
5. (optional) `tmux-control/test-fixtures/test-wait.mjs` — if S2 tests are split out of `test-exec.mjs`.

### Files to modify

| File | Change |
|---|---|
| `lib/send.ts` | S1 multi-line→paste routing; S3 `pressEnterCount` loop; S5 `mode` branch |
| `lib/constants.ts` | add `MAX_ENTER_COUNT`, `PASTE_BUFFER_NAME`, `DEFAULT_DRIVE_READY_REGEX`, `DEFAULT_DRIVE_DONE_REGEX`, `DEFAULT_WAIT_INTERVAL_MS` |
| `index.ts` | S3/S5 params on `/tmux-send` + `tmux_send`; S4 `session_start` warn; S6 `tmux_drive_claude` tool |
| `test-fixtures/test-exec.mjs` | groups 1,3,5,6 (+2 if not split) |
| `test-fixtures/test-extension-integration.mjs` | `testSessionStartWarnOnly` (S4) |
| `test-fixtures/test-real-tmux-smoke.mjs` | 3 added live steps (REQ-19) |
| `test-fixtures/run-control-tests.sh` | argv-only static guard (REQ-17) |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | S1: `lib/paste.ts` + constants + multi-line routing in `send.ts` | Group 1 green; existing send tests green |
| 2 | S2: `lib/wait.ts` with injected clock | Group 2 green |
| 3 | S4: `lib/keyscheck.ts` + warn-only `session_start` | Group 4 green |
| 4 | S3: `pressEnterCount` in `send.ts` (after S1) | Group 3 green; Group 1 still green |
| 5 | S5: `mode` in `send.ts` + tool schema (after S3) | Group 5 green; Group 1/3 still green |
| 6 | S6: `lib/drive.ts` + `tmux_drive_claude` (needs S1,S2) | Group 6 green; full `run-control-tests.sh` green; smoke `ok`/`SKIPPED` |

> **Appendix B (Mechanical Execution Spec)** is intentionally deferred to the implementation handoff: it will pin verbatim `ANCHOR`/`REPLACE` edits and falsifiable per-step `Verify` commands once the plan and reviews are accepted. Each slice's exact diff anchors will be authored against the then-current `send.ts` / `index.ts` to avoid drift.
