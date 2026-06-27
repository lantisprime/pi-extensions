# P5 Adversarial Review

## Review context

Plan reviewed: `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND_PLAN.md` (v1)
Reviewer: `claude-opus-4.5` via `pi --no-tools --model claude-opus-4.5`
Type: Adversarial security review — threat model, trust boundaries, attack surface
Companion: `agents/docs/P5_PLUGGABLE_TERMINAL_BACKEND_PLAN_REVIEW.md` (structural review)

## Threat model

**Trust boundary:** `tmux-terminal` runs in the user's pi process with the user's full filesystem permissions. It accepts a `TermBgAgentConfig` from the `agents` extension (a sibling, trusted by P4-4's design). The config fields `agentName`, `runId`, `cwd` are user-influenced via the `/agents bg <agent> <task>` command line. The `manifestPath` is written by P4-2 preflight into `bg-<timestamp>-<hex>/manifest.json` under the trusted home dir.

**Adversary capabilities (assumed):**
1. **Local untrusted code in a registered agent spec's `task` field** — could contain shell metacharacters intended for injection into the tmux command.
2. **Local untrusted user typing `/agents bg` with crafted `<agent>` name** — could be a registered agent whose name contains shell metacharacters (REQ-3 in agents registration validates names, but a second-order attack via name aliases is plausible).
3. **Network attacker controlling `cwd`** — irrelevant; cwd is local.
4. **Compromised tmux binary or tmux socket** — out of scope (assumes tmux is trusted).
5. **Symlink swap on `manifestPath` between P4-2 write and `launch` call** — TOCTOU within the same tick is essentially impossible (single-threaded JS event loop); cross-tick TOCTOU requires the manifest dir to be writable by an attacker, which requires local code execution.
6. **Symlink swap on `workerPath`** — same: requires local code execution to swap the symlink in the agents extension directory.

**Out of scope:**
- A compromised `agents` extension (P4-4 is the trust anchor).
- A compromised tmux binary.
- A compromised Node runtime.

## Blocking issues

### A1 — `cwd` reaches tmux via `-c <cwd>` without path validation

**Attack:** A user runs `/agents bg scout "task"` while their `cwd` is `/Users/me/$(rm -rf ~)/project`. Or more realistically, an attacker convinces the user to `cd` into a malicious directory and then runs `/agents bg`. The cwd is passed to `tmux new-window -c <cwd>`.

**Defense in current plan:** Plan's REQ-3 says `cwd` is "deliberately not interpolated" — but the **design section** ("`launch` argv") explicitly passes cwd via `-c /path/to/cwd`. This is a contradiction.

**Resolution:** `cwd` is NOT in the tmux command-line in a way that creates injection risk (it's a separate `-c` argv flag, not a shell-interpreted string). But the path itself could be hostile (e.g. a directory with a maliciously-named `bg-worker` symlink, or a path that doesn't exist, causing tmux to fail). The plan should:
- Validate `config.cwd` is an absolute path before passing to tmux.
- If validation fails, return `{ status: "failed", error: "invalid cwd" }` without invoking tmux.
- Add REQ-21: "cwd validation" with test `testLaunchRejectsRelativeCwd` and `testLaunchRejectsCwdWithDotDot`.

### A2 — `manifestPath` is read but not validated for `..` traversal

**Attack:** A bug in P4-2 preflight or a TOCTOU race could result in `manifestPath = "/home/user/.pi/bg-state/bg-x/../../../etc/passwd"`. The `tmux new-window` would happily run `node /home/user/.pi/bg-state/bg-x/../../../etc/passwd <manifest>` — wait, no, `manifest` is the second arg, not the executable. But the WORKER would still be invoked with the wrong manifest, which is itself an integrity violation.

**Defense in current plan:** REQ-3 says "manifestPath is an absolute path written by P4-2 preflight into a server-trusted location." Trust assumption. But no test verifies the plan enforces this assumption at `launch` time.

**Resolution:** Add REQ-20 (already proposed in plan review S1) with stronger scope:
- REQ-20a: `manifestPath` MUST be absolute (starts with `/`).
- REQ-20b: `manifestPath` MUST NOT contain `..` as a path segment.
- REQ-20c: `manifestPath` MUST resolve (via `realpath`) to a path under `path.join(homeDir, ".pi", "bg-state")`.
- REQ-20d: On validation failure, return `{ status: "failed", error: "invalid manifest path" }` and do NOT invoke tmux.

Tests: `testLaunchRejectsRelativeManifestPath`, `testLaunchRejectsDotDotManifestPath`, `testLaunchRejectsManifestOutsideBgStateDir`, `testLaunchAcceptsValidManifestPath`.

### A3 — `agentName` reaches `@pi_agent_name` user-option via tmux — but how?

**Attack:** The plan says "set via `set-window-option … @pi_agent_name <agentName>`." If this is implemented as `tmux set-window-option -t <window> @pi_agent_name <agentName>` via shell, and `agentName` contains `; rm -rf ~`, the shell would interpret it.

**Defense in current plan:** REQ-3 says agentName is NOT interpolated. REQ-4 says argv is used. But the **set-window-option post-exec call** is not explicitly specified as argv-based.

**Resolution:** Explicitly specify in design that all tmux calls use argv arrays. Add test `testLaunchAgentNamePassedAsArgvNotShell`: invoke the backend with `agentName: "scout; touch /tmp/pwned"`, capture all `tmux set-window-option` calls, assert the malicious string appears as a discrete argv element, not in a shell-interpreted string.

### A4 — `workerPath` symlink resolution could be defeated by re-symlink between load and launch

**Attack:** If a malicious actor can write to `agents/lib/` between extension load and the first `launch`, they could swap `bg-worker.ts` to a symlink pointing to their own script. The worker would then run with the user's full permissions, and tmux would never know.

**Defense in current plan:** REQ-12 says workerPath is `realpath`'d at load time and cached. The plan review (B2) flagged that the current tests don't verify `realpath` semantics.

**Resolution:** Plan's REQ-12 mitigation is correct IF `realpath` is actually called (not `path.resolve`). The test `testWorkerPathIsRealpathed` (proposed in plan review T1) catches this. Beyond that, the residual risk is: if the attacker has filesystem write access to `~/.pi/agent/extensions/agents/lib/` between load and first launch, they can already execute arbitrary code by directly editing the agent's source. The tmux layer adds no additional attack surface here.

**Acknowledge as accepted residual** in the Risk Analysis table. No additional mitigation needed beyond the `realpath` test.

### A5 — Window name collision could enable cross-agent attack

**Attack:** Two background agents run concurrently. Agent A has `runId = "bg-1719432000000-a3f9c2b1"` (16-hex prefix `a3f9c2b1`). Agent B has `runId = "bg-1719432000002-a3f9c2b1"` (same 16-hex prefix). Both want `pi-agent-a3f9c2b1` as window name. Agent B's `tmux new-window -n pi-agent-a3f9c2b1` would either:
- Fail (tmux disallows duplicate window names within a session).
- Succeed and replace agent A's window (catastrophic).

**Defense in current plan:** REQ-5 says window name is `pi-agent-<runId-prefix>` where prefix is 16 hex chars. Plan claims "16 hex is unique-per-run within the user's session" but does not prove this. Timestamp collisions in the same millisecond are rare but possible (e.g. via clock skew or rapid `/agents bg` invocations from two agents run sub-agents in parallel).

**Resolution:**
- Use full runId as window name (drop the 16-hex prefix), OR
- Use a longer prefix (32 hex chars covers the full runId), OR
- Add a uniqueness suffix: `pi-agent-<runId-prefix>-<attempt>` and retry on conflict.

The simplest fix is option 1: window name = `pi-agent-<full-runId>` (e.g. `pi-agent-bg-1719432000000-a3f9c2b1e8f4d2b6`). This is still greppable for `list()`, still recoverable via `@pi_run_id`, and collision-proof.

**Required change:** REQ-5 amended: "Window name SHALL be `pi-agent-<full-runId>` (no truncation)." Update test `testLaunchWindowNameFormat` to assert the full runId is in the window name.

### A6 — `list()` filters by `pi-agent-` prefix — but what if an attacker names their window that?

**Attack:** A malicious actor with tmux access on the same machine (e.g. via SSH) creates a tmux window named `pi-agent-evil`. The `list()` call returns it, and the agent UI believes it's a legitimate bg agent.

**Defense in current plan:** REQ-11 filters by prefix. The recovery of `runId` from `@pi_run_id` requires the attacker to also have set that option (only `tmux-terminal` does this). If `@pi_run_id` is unset, the entry has `runId: undefined`.

**Resolution:** The current design is fail-closed IF callers correctly handle `runId: undefined`. The agents extension (P4-5/P4-6) MUST treat `runId: undefined` as "unknown correlation" and not act on it. The plan should make this explicit:
- REQ-22: "`list()` entries with absent `@pi_run_id` SHALL be reported by callers as 'unknown window' and SHALL NOT trigger any kill/result-fetch action."
- Test: `testListEntryWithoutRunIdIsTreatedAsUnknown` (in agents test suite, not tmux-terminal — but tmux-terminal's `testListEmptyUserOptionsDuringLaunchRace` covers the producer side).

### A7 — Tmux user-options allow arbitrary key-value storage — `@pi_run_id` could be set to an attacker's runId

**Attack:** A malicious local user shares the tmux server. They create a window `pi-agent-bg-1234567890-aaaaaaaa` and set `@pi_run_id = "bg-9999999999-bbbbbbbb"` (a runId they control). The agents extension queries `list()` and sees what looks like agent `bg-9999999999-bbbbbbbb` running — possibly triggering a kill or result-fetch on a real runId owned by another agent.

**Defense in current plan:** None. The plan assumes tmux is trusted (Threat Model assumption 4).

**Resolution:** Accept as out-of-scope (per Threat Model). Add to Risk Analysis: "Shared tmux server with untrusted users → cross-user correlation spoofing. Mitigation: document that `tmux-terminal` assumes a single-user tmux server. For multi-user environments, users should run tmux with per-user sockets (`tmux -L <user>`)."

## Non-blocking concerns

- **AB1 — `set-window-option` failure is silently swallowed.** Plan says "best-effort." But if `set-window-option` consistently fails (e.g. tmux version too old, or user has `set -g set-option -u` locked), `list()` will never recover `runId`. Consider adding a diagnostic at `launch` time: if both `set-window-option` calls fail, log a warning to the user.

- **AB2 — No redaction of error messages in `isAlive`/`list`.** Plan's `redactError` only applies to `launch`. If `isAlive` or `list` throws (which they shouldn't per contract), the error propagates and could leak. Currently `isAlive`/`list` return `false`/`[]` on error, so this is a defense-in-depth concern only.

- **AB3 — Race window between `tmux new-window -P` returning and `set-window-option` completing.** If a `list()` call lands in between, the new window appears with empty `@pi_run_id`. EC9 documents this. Acceptable, but consider: `set-window-option` is sync from tmux's perspective (queued), but the test `testListEmptyUserOptionsDuringLaunchRace` should explicitly assert this race.

- **AB4 — `cwd` could be a directory that doesn't exist.** tmux will fail to set the window's cwd and create the window in the user's home dir. Not a security issue but UX. Consider validating `cwd` with `fs.statSync(cwd).isDirectory()` before passing to tmux.

- **AB5 — Plan does not address what tmux binary version is supported.** The README mentions ≥3.0 but no version check in code. If a user has tmux 1.8 (e.g. CentOS 7), the backend silently fails or produces broken windows.

## Missing tests / validation

| # | Test | Rationale |
|---|---|---|
| AT1 | `testLaunchRejectsRelativeCwd` | A1: REQ-21 cwd validation |
| AT2 | `testLaunchRejectsCwdWithDotDot` | A1: REQ-21 cwd validation |
| AT3 | `testLaunchRejectsRelativeManifestPath` | A2: REQ-20a |
| AT4 | `testLaunchRejectsDotDotManifestPath` | A2: REQ-20b |
| AT5 | `testLaunchRejectsManifestOutsideBgStateDir` | A2: REQ-20c |
| AT6 | `testLaunchAcceptsValidManifestPath` | A2: REQ-20d (positive control) |
| AT7 | `testLaunchAgentNamePassedAsArgvNotShell` | A3: agentName injection via set-window-option |
| AT8 | `testLaunchWindowNameUsesFullRunId` | A5: collision-proof window name |
| AT9 | `testListFiltersOutWindowsWithoutAgentPrefix` (negative case) | A6: defensive — already in catalog as `testListFiltersNonAgentWindows`, but ensure it also tests `pi-agent-` followed by non-hex chars. |
| AT10 | `testLaunchFailsClosedWhenWorkerPathContainsShellMetachars` | Pathological case: what if `bg-worker.ts` somehow has a metachar in its path? |
| AT11 | `testFakeExecutorEnforcesTimeoutFromOpts` | Verify timeoutMs is plumbed through to the executor and respected. |

## Safety / security concerns (high-level)

- **AS1 — Trust boundary is correctly identified:** The plan correctly limits the attack surface to tmux argv construction. The interface (`TermBgBackend`) does not expose a "raw command" escape hatch.

- **AS2 — Defense in depth is mostly correct:** The plan layers realpath + path validation + argv-only tmux calls + first-wins registry + idempotent kills. Good.

- **AS3 — TOCTOU on `manifestPath` is acknowledged but mitigation is trust-based.** The plan assumes P4-2 writes the manifest to a trusted location. REQ-20a/b/c codify this in code rather than trust. The plan review's S1 already flagged this; the adversarial review agrees REQ-20 must be added.

- **AS4 — The plan does not address what happens if `agents` is loaded from a non-trusted source.** If a user installs a malicious `agents` extension (e.g. via `npm install evil-agents`), the malicious code could call `registerBgTerminalBackend` first and replace the tmux backend. The first-wins rule protects against same-process competitors but not against the `agents` extension itself being compromised. This is the P4-4 trust anchor and out of scope.

- **AS5 — The plan does not address tmux session persistence.** A tmux session started today survives reboots if the user has tmux configured for it (e.g. `tmux-resurrect`). A bg agent that was supposed to die with the pi session could be revived by tmux-resurrect and continue running. Mitigation: bg-state has a reaper (P4R-1) that cleans up orphaned reservations. Not P5's concern but worth noting.

## Verdict

**conditional-go** — 7 adversarial blockers, 5 non-blocking concerns, 11 missing tests.

The plan's threat model is correct and the interface-level invariants are sound. The blockers are specific test coverage gaps for documented attacks (A1-A6 are all enumerated in the plan's Safety section but lack test coverage). A7 is accepted as out-of-scope per threat model.

## Follow-up applied (resolution sketch)

### A1 — cwd validation
Add REQ-21 with tests AT1, AT2. Implementation: in `launch`, before constructing the tmux argv, check `path.isAbsolute(config.cwd)` and `!config.cwd.split(path.sep).includes("..")`. Return `{ status: "failed", error: "invalid cwd" }` on failure.

### A2 — manifestPath validation
Add REQ-20 (as in plan review S1) with tests AT3, AT4, AT5, AT6. Implementation: in `launch`, validate `config.manifestPath` against the same checks. The "under bg-state dir" check requires `resolveWorkerPath`'s sibling `resolveBgStateDir(homeDir)` helper that returns the canonical trusted root. The plan should add this helper.

### A3 — agentName argv-only
Already enforced by REQ-7's "argv arrays" requirement. Add test AT7 to make the invariant explicit.

### A4 — workerPath realpath
Add `testWorkerPathIsRealpathed` (plan review T1). Residual risk documented in Risk Analysis.

### A5 — window name collision
Amend REQ-5 to use full runId in window name. Add test AT8.

### A6 — list() with absent runId
Add REQ-22 + test AT9.

### A7 — multi-user tmux
Add to Risk Analysis as accepted residual with single-user-tmux-server assumption documented in README.

### AB1–AB5 + AT10/AT11
Applied as v2 polish.

## Final plan stats (v2 target)

- **22 requirements** (REQ-1 through REQ-22, including new cwd, manifestPath, and list()-unknown-window validations)
- **32 test functions** across **14 groups** (v1's 27 + 5 adversarial)
- **15 contract states** (vs. v1's ~6)
- **3 new explicit security mitigations** with automated tests (cwd validation, manifestPath validation, agentName argv-only)
- **1 accepted residual** documented (multi-user tmux)
- **14 mechanical-execution steps** (was 13)

Re-request adversarial review after v2 lands.