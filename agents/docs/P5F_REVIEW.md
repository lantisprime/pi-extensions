# P5F Disk-Backed Per-Project Trust Reader — Plan Review (Pass 1)

## Review metadata

| Field | Value |
|---|---|
| Review artifact under review | `agents/docs/P5F_DISK_BACKED_TRUST_READER_PLAN.md` (commit `92c0e7d`, branch `docs/plan-p5f-trust-reader`, PR #143) |
| Reviewer | codex (codex-cli 0.142.5) |
| Model | `gpt-5.5` high |
| Via | cmux workspace `workspace:31`, surface `surface:48` (cmux 0.64.17) |
| Review type | PLAN review (read-only; no implementation). Codex verified factual claims against `agents/lib/{bg-state,bg-preflight,bg-worker,bg-terminal,bg-args}.ts` + `agents/index.ts` via bounded `read`/`grep` (≤8 tool calls). |
| Verdict | **`changes-requested`** |
| Duration | 2m 15s |

## Verdict

**`changes-requested`**

6 blockers (4 factual errors against the code + 2 contract/test-design issues), 3 non-blocking concerns, 6 missing tests. The plan cannot be marked Accepted until the blockers are resolved and re-reviewed.

> Independently ground-checked by the orchestrator: **Blocker 1 and Blocker 4 confirmed real against the code** — `projectTrusted?: boolean` (bg-state.ts:55) and the global session MAC actually lives at `~/.pi/agent/bg/.session.mac` (file verified on disk), NOT `~/.episodic-memory/.session.mac` as the plan asserts. INV-2 guards the wrong path today.

## Blockers

### 1. REQ-9 / FINAL-14 — factual error: `projectTrusted` is `boolean`, not a snapshot

The plan claims REQ-9 "fills the existing `projectTrusted` shape" with `projectRootSha256` + `keyGenId` (project key). This is **false**. The existing field is a plain boolean.

Evidence:
- `agents/lib/bg-state.ts:51` → `projectTrusted?: boolean;`
- `agents/lib/bg-preflight.ts:100` → writes `diagnostics.projectTrusted` (boolean)
- `agents/lib/bg-worker.ts:202` and `:225` → consume it as boolean.

**Fix:** Either (a) keep `projectTrusted: true|false` and admit no root/keyGenId is stored in the snapshot (defer that to P4R-PROJ which owns the snapshot enrichment), or (b) add a new typed manifest field and update the worker + tests to match. Do NOT claim "composes with existing shape" if the type changes.

### 2. REQ-4 / EC2 — foreign-root fixture is not discriminating

The plan says "mint in project A then read under project B" to prove root binding. But if B has a different (or absent) `.trust.mac`, **MAC verification fails before root comparison runs** — the test passes for the wrong reason (MAC failure, not root-binding failure). Does not prove REQ-4.

**Fix:** For `testReadTrustStore_rejectsForeignProjectRoot_withSentinel`, **inject project A's MAC key into project B** so MAC passes, assert A/B `projectRootSha256` differ first, then assert the cross-read returns `{ok:false, reason:"forged"}`. Renames to `testReadTrustStore_rejectsForeignProjectRoot_withSharedKeySentinel`.

### 3. REQ-1/2/3 — contract is internally inconsistent (return type + throw semantics)

Requirements text says `readProjectTrustStore` returns `ProjectTrustStore | null` and REQ-2 says symlink "throws `TRUST_FILE_IS_SYMLINK`" (plan:L34-36). The Design contract returns `ProjectTrustReadResult` (discriminated union) and says symlink/content failures "never throw" (plan:L91-95, L180-185, L190-198). These contradict.

**Fix:** Pick one API. Prefer the union `ProjectTrustReadResult` (it carries the `reason` the skill's IDLE-classifier and diagnostics need), then rewrite REQ-1/2/3 + test expectations to match: symlink → `{ok:false, reason:"symlink"}` (not a throw), same for absent/forged/malformed. Remove the throw-tag error code `TRUST_FILE_IS_SYMLINK` from the contract's error table, or move it to the key-path guard (`assertNoSymlink` on `.trust.mac`) which legitimately throws per bg-state.ts:199 precedent.

### 4. INV-2 — cites the wrong global MAC-key path

The plan repeatedly says the global session MAC key is at `~/.episodic-memory/.session.mac` (plan:L40, L52, L107). This conflates the **episodic-memory package's** substrate (`~/.episodic-memory/`) with the **pi-extensions `agents` extension's** bg-state dir. The actual global session MAC:

- `resolveTrustedHome()` returns `os.userInfo().homedir` (= `/Users/charltondho`) — `agents/lib/bg-state.ts:21-23`
- `getBgStateDir()` joins `homeDir + ".pi/agent/bg"` — `bg-state.ts:134-136`
- `getBgSessionMacPath()` joins `getBgStateDir() + ".session.mac"` — `bg-state.ts:138-140`
- **Actual path: `~/.pi/agent/bg/.session.mac`** (file confirmed on disk: `/Users/charltondho/.pi/agent/bg/.session.mac`)

**Fix:** Update INV-2 and REQ-7's static checks. The grep guards must reference the real global path helpers — `getBgSessionMacPath`, `getBgStateDir`, `resolveTrustedHome`, `readOrCreateSessionMacKey` — not the `~/.episodic-memory/` path string. The `grep -n "resolveTrustedHome\|readOrCreateSessionMacKey" agents/lib/bg-trust.ts` invariant check is still correct as a guard (the trust module must not import these), but the prose claiming the global key is at `~/.episodic-memory/.session.mac` is wrong.

### 5. Completeness — 9-state read table not fully mapped to tests

The state table defines States A–I (absent / symlink / malformed-JSON / schema-invalid / key-absent / MAC-malformed / MAC-mismatch / root-mismatch / valid). The Test Case Catalog's Group 1 covers A, B, F, G, H, I only. **Missing test coverage for C (corrupt JSON), D (schema-invalid), E (key-absent).** EC1 and EC8 mention E and C as edge cases, but they are not present in the actual Group-1 catalog.

**Fix:** Add to Group 1: `testReadTrustStore_rejectsCorruptJson` (C), `testReadTrustStore_rejectsSchemaInvalid` (D), `testReadTrustStore_keyAbsentTreatedAsForged` (E). Move EC1/EC8 from "edge cases" into the populated catalog; do not list an edge case that has no backing test.

### 6. Appendix B P5F-1 — not executor-ready

The mechanical execution spec violates its own executor-ready gate (plan:L349):

- Step 1.1 says "Full source" but supplies **prose describing the implementation**, not verbatim source code. Uses "mirrors `readOrCreateSessionMacKey` body", "readUtf8FileNoSymlink-style helper" — the executor must now decide what that body and helper are.
- Implementation Sequence Step 1 literally says "**Decide** `resolveProjectRoot` rule" (plan:L324) — a decision handed to the executor; the gate explicitly forbids "decide".
- Test step 1.3 imports `signBgPayload from ./bg-state.ts` inside an `agents/test/` file — that path resolves wrong (should be `../lib/bg-state.ts`).

**Fix:** Provide verbatim source for `bg-trust.ts` step 1.1 (every constant/regex/signature/error-string spelled out, per the shared-constants block), remove all "mirrors"/"style helper" decision language, resolve OD-1 (`resolveProjectRoot` rule) IN THE PLAN rather than deferring to Step 1, and fix the test import path to `../lib/bg-state.ts`.

## Non-blocking concerns

1. **REQ-6 atomicity is asserted more than proven.** `testWrite_atomicTempRename` only checks "no `.tmp` survives on success"; it does not prove final-path preservation-on-failure or temp-cleanup-after-failed-rename. Add a failure-injection test, OR explicitly allow orphaned 0600 temp files in the spec (document the residual rather than assert a guarantee).
2. **REQ-10 should be automated, not `UNGUARDED-IN-CI`.** Security-sensitive + easy to regress; an injected-mock ordering test is cheap. Prefer keeping it automated rather than falling back to the manual grep.
3. **OD-1 is a blocker for *execution readiness* only, not for the architecture.** Deferring the `resolveProjectRoot` rule to P5F-1 is acceptable IF P5F-1 is NOT handed to a low-capability executor. If P5F-1 will be executor-run, OD-1 must be resolved in the plan before review pass 2.

## Missing tests

| Test name | Asserts |
|---|---|
| `testReadTrustStore_rejectsCorruptJson` | existing non-symlink file with invalid JSON → `{ok:false, reason:"malformed"}` (State C) |
| `testReadTrustStore_rejectsSchemaInvalid` | parsed JSON with missing/wrong-type fields → `{ok:false, reason:"malformed"}` (State D) |
| `testReadTrustStore_keyAbsentTreatedAsForged` | valid-looking trust file with absent `.trust.mac` → does NOT create trust on read → `{ok:false, reason:"forged"}` (State E) |
| `testReadTrustStore_rejectsForeignProjectRoot_withSharedKeySentinel` | project A's key injected into B, MAC passes, root mismatch alone → `{ok:false, reason:"forged"}` (fixes Blocker 2) |
| `testWrite_atomicFailureLeavesFinalUntouched` | injected failure before/at rename leaves prior final file unchanged + documents temp cleanup (fixes non-blocking #1) |
| `testBgCommand_explicitBackendOverridesDefault_discriminating` | default = tmux, explicit `--backend cmux`, BOTH registered/available, assert cmux launch path used (discriminating, not happy-path — fixes REQ-8's regression guard) |

## Factual-claim audit

| Claim (Existing Hook Points + INV-1..6) | Verdict | Evidence |
|---|---|---|
| bg-args.ts parse first-token `--backend`/`--profile` (States B/C) | **VERIFIED** | `bg-args.ts:9, 12, 20, 30` |
| bg-terminal.ts `getBgTerminalBackendByName` + preference probe | **VERIFIED** | `bg-terminal.ts:157` (`getBgTerminalBackendByName`), `:175` (`selectBgTerminalBackend`) |
| index.ts `/agents bg` handler + `selectBgTerminalBackend` call at L685-691 | **FALSE** | `index.ts:685` cited lines parse/validate only; the actual `selectBgTerminalBackend` call is at `index.ts:695` (per INV-4 audit). **Plan's line citation is wrong** — must be corrected to L695 (or re-verified) in the hook table. |
| bg-preflight.ts manifest construction + `projectTrusted` | **VERIFIED (as boolean)** | `bg-preflight.ts:86` (manifest built), `:102` (`projectTrusted` boolean). Confirms Blocker 1. |
| bg-state.ts `projectTrusted` field + MAC primitives | **VERIFIED** | `bg-state.ts:51` (field, boolean), `:167` (readOrCreateSessionMacKey), `:203` (signBgPayload), `:207` (verifyBgPayloadMac) |
| bg-worker.ts homeDir check + registry read | **VERIFIED** | `bg-worker.ts:123` (homeDir, N1), `:213` (readProjectRegistry) |
| `resolveProjectRoot` hook point | **FALSE (NEW, not existing)** | `P5F_DISK_BACKED_TRUST_READER_PLAN.md:147` — not an existing hook; the row is a NEW/deferred helper, not a reuse. Mark as CREATED, not MODIFIED. |
| INV-1 (per-project authority root) | **PLAN-ONLY** | No existing implementation; the field/`projectRootSha256` binding is new. (This is expected — INV-1 proposes a new invariant; codex flags that it's not a "currently holds" invariant.) |
| INV-2 (key isolation) | **FALSE as written** | Wrong global key path (actual: `bg-state.ts:134, 138` → `~/.pi/agent/bg/.session.mac`). Confirms Blocker 4. |
| INV-3 (fail-closed to preference probe) | **PLAN-ONLY** | Current fallback probe (`selectBgTerminalBackend`) exists at `bg-terminal.ts:175`; the fail-closed *behavior* is new. |
| INV-4 (explicit overrides default) | **VERIFIED** | Explicit branch exists before the fallback/default insertion point, `index.ts:695`. |
| INV-5 (signing primitive reuse) | **VERIFIED** | Primitives exist at `bg-state.ts:203, 207, 214` (`signBgPayload`, `verifyBgPayloadMac`, `keyGenIdFromKey`). |
| INV-6 (no cwd comparison) | **VERIFIED** | `cwd` is advisory-only at `bg-state.ts:25` (N6 comment) + `bg-worker.ts:123`. |

## orchestrator summary for next pass

The plan architecturally *composes* correctly (the design is sound: per-project MAC key, fail-closed read states, root binding) but is **factually wrong on 4 grounded points** (Blockers 1, 4 + index.ts line citation + the REQ-1/2/3 throw-vs-union inconsistency) and **test-design incomplete** (Blocker 2 + Blocker 5). Blocker 6 (executor-readiness) is a self-correcting gate violation: fix it by resolving OD-1 in the plan body and providing verbatim source.

Recommended next pass before re-review:
1. Fix Blocker 4 (INV-2 global path) + the index.ts L685→L695 citation — both are one-line corrections grounded above.
2. Fix Blocker 1 (REQ-9) — decide between (a) defer root/keyGenId to P4R-PROJ, keep `projectTrusted: boolean` today, or (b) add a new typed snapshot field and own the worker/test migration.
3. Fix Blocker 3 (pick union over throw) + propagate through REQ-1/2/3 and the contracts section.
4. Fix Blocker 2 (inject shared key) + Blocker 5 (add C/D/E tests) — both are test-catalog additions.
5. Fix Blocker 6 (verbatim source + resolve OD-1 in-plan) — only required if P5F-1 will be executor-run; acceptable to keep P5F-2/P5F-3 step-tables deferred per the plan's existing note.

Re-review on the same cmux surface after these revisions.
