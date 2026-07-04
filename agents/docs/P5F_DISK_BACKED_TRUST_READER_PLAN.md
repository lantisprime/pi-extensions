# P5F Disk-Backed Per-Project Trust Reader Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

## Episode Search Summary

Searched episodic memory for `trust`, `authority-root`, `Mac key`, `default backend`, `project-trusted`, `P4R-PROJ` in project `pi-extensions`.

Key active memories:

- `20260704-122521-post-merge-sync-p5-nl-agents-bg-intent-g-d94b` (canonical-workplan chain head): P5 NL→`/agents bg` intent-gate COMPLETE; lists the two deferred items this plan addresses ("persistent per-project default backend — needs trust reader" and "P4R-PROJ — needs disk-backed trust reader").
- `20260628-115957-handoff-p5b-1-s1-complete-p5b-1-s2-is-ne-be85` (canonical-workplan, superseded chain member): P5b-1-S1 cmux-terminal backend merged; documents the `TermBgBackend` `preference`-ordered registry the default-backend resolver will query.
- `20260627-083228-pi-extensions-main-is-branch-protected-a-89de` (local): `main` is branch-protected — PRs + human approval required for any change, including docs.

## Objective

Ship a per-project, disk-backed, HMAC-signed trust store + reader that (a) supplies a default terminal backend name when `--backend` is omitted, and (b) binds a background-agent run's authority to a project-scoped trust root (unblocking P4R-PROJ). The reader composes with the existing P4R MAC key lifecycle and P5-NL-bg `projectTrusted` snapshot rather than introducing a parallel signing scheme.

## Why

Two deferred roadmap items share one blocker, and removing it unblocks both:

1. **Persistent per-project default backend.** P5E1 shipped `--backend <name>` as a *per-launch* selector. Without a persisted default, every `/agents bg` call that omits `--backend` falls back to `selectBgTerminalBackend()`'s preference-ordered probe — which picks whichever backend is installed, not whichever the user *trusted* for this project. A user who has both tmux and cmux installed gets a non-deterministic default. Persisting a per-project trusted default backend requires a store that can't be silently inherited, symlink-spoofed, or forged by another project.
2. **P4R-PROJ Project Background Agents.** Today the authority root is **global** (`resolveTrustedHome()`; `assertManifestIdentityMatchesRuntime` compares `homeDir` only, N1; `cwd` is advisory and **not compared**, N6). P5-NL-bg added a `projectTrusted` *snapshot* to the manifest (so a detached worker honors preflight-time trust), but it is threaded through the global MAC key — there is no on-disk per-project trust root to *source* it from or to *bind* a project agent's authority to. P4R-PROJ needs that binding.

Both are read-by-the-launch path, so the reader must be fast, offline, and tamper-evident. It is a single shared primitive, not two features.

## Requirements (Ground Truth)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `readProjectTrustStore(projectDir)` reads `<projectDir>/.pi/trust/default-backend.json` and returns a typed `ProjectTrustStore` (fields: `schemaVersion`, `projectRootSha256`, `defaultBackend`, `grantedAtMs`, `keyGenId`, `mac`) or `null` when absent. | `testReadTrustStore_parsesValidFile`, `testReadTrustStore_returnsNullWhenAbsent` | MUST | Path is under `.pi/` (already gitignored convention for pi-agent state); not under `.episodic-memory/` (which is for the global substrate). |
| REQ-2 | `readProjectTrustStore` rejects symlinks at the trust file path by throwing `TRUST_FILE_IS_SYMLINK` (reuse `assertNoSymlink`). | `testReadTrustStore_rejectsSymlink` with red-then-green control | MUST | Same TOCTOU/symlink class as the session MAC key (bg-state.ts:199). Negative control: break by replacing the file with a symlink → must throw. |
| REQ-3 | `readProjectTrustStore` verifies the file's `mac` against the **project MAC key** (REQ-7) using `verifyBgPayloadMac` and rejects on mismatch / malformed mac (`/^[0-9a-f]{64}$/`) by returning `null` (not throwing) — a forged trust file is treated as untrusted, falling back to default behavior. | `testReadTrustStore_rejectsTamperedMac`, `testReadTrustStore_rejectsMalformedMac` | MUST | FAIL-CLOSED to the existing `selectBgTerminalBackend()` probe — a corrupt/forged file never escalates privilege; it silently degrades to "no default". |
| REQ-4 | The `projectRootSha256` in the trust store MUST equal `sha256(resolveProjectRoot(projectDir))`; mismatch → return `null`. This is the per-project authority-root binding (replaces the global homeDir comparison for project-scoped trust). | `testReadTrustStore_rejectsForeignProjectRoot_withSentinel` | MUST | Defeats a trust file copied between projects. Sentinel: two temp projects with distinct roots; a file minted for project A must return `null` when read under project B. |
| REQ-5 | `resolveDefaultBackend(projectDir)` returns `store.defaultBackend` ONLY when `readProjectTrustStore` returns a valid store AND `getBgTerminalBackendByName(name)` resolves; otherwise returns `null` (caller falls back to preference probe). | `testResolveDefaultBackend_returnsTrustedName`, `testResolveDefaultBackend_fallsBackWhenBackendUnregistered`, `testResolveDefaultBackend_fallsBackWhenStoreForged` | MUST | Three-state: trusted+registered → name; trusted+unregistered → null; forged/absent → null. The forged case is the negative control for REQ-3. |
| REQ-6 | `writeProjectTrustStore(projectDir, { defaultBackend })` is the ONLY writer. It mints the store: computes `projectRootSha256`, sets `grantedAtMs=Date.now()`, reads the project MAC key (REQ-7), signs with `signBgPayload`, writes atomically (temp + rename, 0600). | `testWriteThenRead_roundtrip`, `testWrite_atomicTempRename` (assert no `.tmp` survives on success, no direct write to final path) | MUST | Granting a default backend is a trust grant — single writer prevents scattered mint sites. |
| REQ-7 | `readOrCreateProjectTrustKey(projectDir)` mirrors `readOrCreateSessionMacKey`: 32 random bytes at `<projectDir>/.pi/trust/.trust.mac`, 0600, symlink-guarded (O_NOFOLLOW read). **Distinct key from the global session MAC** — never reads/writes `~/.episodic-memory/.session.mac`. | `testProjectTrustKey_isDistinctFromSessionMac`, `testProjectTrustKey_symlinkGuard` (red-then-green: symlinked key → throws) | MUST | Per-project key = per-project authority root. Sharing the global key would let a project forge another project's trust. |
| REQ-8 | When `--backend <name>` is omitted, the `/agents bg` path calls `resolveDefaultBackend(projectDir)`; if non-null, uses that backend via `getBgTerminalBackendByName`; otherwise falls back to `selectBgTerminalBackend()` (current behavior unchanged). | `testBgCommand_usesDefaultBackendWhenAbsent`, `testBgCommand_explicitBackendOverridesDefault` | MUST | P5E1 explicit `--backend` always wins — this is the precedence contract. Both must be asserted; the explicit-override one is the regression guard for "default silently won over explicit". |
| REQ-9 | `preflightBgAgent` records `projectTrusted` in the manifest by calling `readProjectTrustStore(ctx.cwd)` and storing the resolved `projectRootSha256` + `keyGenId` (project key, not session key) when present, else `null`. The worker's existing `projectTrusted` snapshot logic is **unchanged** in shape; it now has a real disk source. | `testPreflight_recordsProjectTrustSnapshot_whenPresent`, `testPreflight_recordsNull_whenAbsentOrForged` | MUST | Composes with P5-NL-bg's existing snapshot field (bg-state.ts:51-52) rather than adding a new field. Forged-store case is the negative control. |
| REQ-10 | A constant-time MAC compare is used (`verifyBgPayloadMac` already uses `timingSafeEqual`); `readProjectTrustStore` MUST NOT short-circuit on `projectRootSha256` before the MAC check — MAC verifies first, root compares after. | `testReadTrustStore_macCheckedBeforeRootCompare` (assert ordering via injected mock comparator) or `UNGUARDED-IN-CI` + manual review note | SHOULD | Prevents a timing oracle on `projectRootSha256` mismatch. If an injectable ordering assertion is awkward, tag `UNGUARDED-IN-CI` with the manual step `grep -n "assertNoSymlink\|verifyBgPayloadMac\|projectRootSha256" lib/bg-trust.ts` and require MAC-before-root in code review. |
| REQ-11 | No new runtime dependencies; the trust module imports only `node:crypto`, `node:fs`, `node:path`, and the existing `bg-state.ts` primitives (`signBgPayload`, `verifyBgPayloadMac`, `assertNoSymlink`, `readUtf8FileNoSymlink`-style helpers). | `static: grep -E "from ['\"](node:|\\./bg-state)" lib/bg-trust.ts` and `static: grep -vE "from ['\"][^n.]" lib/bg-trust.ts` (no third-party imports) | MUST | Mirrors the P5c-2 dependency invariant (typebox provided by pi's jiti). `UNGUARDED-IN-CI` is not acceptable here — the grep is the assertion and is fully automated. |

**Priority legend:** MUST = blocker for first slice merge; SHOULD = required before feature complete (one slice may defer with named fallback); MAY = nice-to-have.

## Non-Goals

- **No trust-granting UX in this plan.** How a user grants a default backend (CLI `pi agents trust --backend cmux`, a slash command, an interactive prompt) is a *separate* follow-up. This plan ships the **reader + writer primitives** and the **read-side wiring** (REQ-8, REQ-9). The writer (REQ-6) is exercised only by tests, not by any command, in scope.
- **No P4R-PROJ full launch path.** This plan ships the trust root + manifest binding (REQ-9); the worker-side enforcement of project-scoped bg authority (kill-on-trust-revoke, project-scoped reservation quotas) is P4R-PROJ's job. The trust reader is the prerequisite, not P4R-PROJ itself.
- **No per-project MAC for the global session manifest.** The existing `~/.episodic-memory/.session.mac` and global bg-state are untouched. The project key is **additive**.
- **No trust revocation lifecycle.** Revoking a trusted default (deleting the trust file by hand works; an explicit command doesn't exist yet — see Non-Goal 1).
- **No network/cloud sync of trust files.** Trust is local, per-machine, per-project — consistent with the global MAC key model.

## Safety / Security

This feature **is** a security primitive (it seeds "which backend can launch external processes for this project" and binds bg-authority). The mitigations are themselves MUST requirements above; the matrix below names the falsifiable test for each.

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Symlink/TOCTOU on trust file or key | High | `assertNoSymlink` reuse (bg-state.ts:199 pattern); O_NOFOLLOW read path. | `testReadTrustStore_rejectsSymlink` (REQ-2), `testProjectTrustKey_symlinkGuard` (REQ-7) — both red-then-green. |
| Forge a trust file to elevate a backend | High | HMAC verify with project MAC key; mismatch/malformed → `null` (fail-closed to preference probe, never escalate). | `testReadTrustStore_rejectsTamperedMac`, `testReadTrustStore_rejectsMalformedMac` (REQ-3). |
| Copy a trust file between projects to claim another project's authority | High | `projectRootSha256` binding (REQ-4); mismatch → `null`. | `testReadTrustStore_rejectsForeignProjectRoot_withSentinel` (REQ-4). |
| Use project key to forge another project (cross-project forgery) | High | Project MAC key is per-project, symlink-guarded, 0600, never written to the global path. | `testProjectTrustKey_isDistinctFromSessionMac` (REQ-7). |
| Timing oracle on root comparison | Medium | MAC verified before root compare; constant-time compare already in `verifyBgPayloadMac`. | REQ-10 (SHOULD; `UNGUARDED-IN-CI` + manual grep if injection infeasible). |
| Forged file degrading loudly vs silently | Medium | REQ-3 returns `null` (silent degrade) — escalation-by-failure is the wrong direction. | Negative-control assertions in REQ-3/REQ-5 cover "forged → falls back, never escalates". |
| Atomic write torn half-way | Medium | `writeProjectTrustStore` uses temp + rename (0600); no `.tmp` survives on success. | `testWrite_atomicTempRename` (REQ-6). |

## Design

### Key types

```ts
// lib/bg-trust.ts
export const PROJECT_TRUST_SCHEMA_VERSION = 1;
export const PROJECT_TRUST_DIR = ".pi/trust";
export const PROJECT_TRUST_FILE = "default-backend.json";
export const PROJECT_TRUST_MAC_FILE = ".trust.mac";
export const PROJECT_TRUST_MAC_BYTES = 32;

export type ProjectTrustStore = {
  schemaVersion: 1;
  projectRootSha256: string;   // sha256(resolveProjectRoot(projectDir))
  defaultBackend: string;       // a backend name registered via registerBgTerminalBackend
  grantedAtMs: number;
  keyGenId: string;             // keyGenIdFromKey(projectKey) — links to the signing key
  mac: string;                  // HMAC-SHA256 hex over the store minus `mac`
};

export type ProjectTrustReadResult =
  | { ok: true; store: ProjectTrustStore }
  | { ok: false; reason: "absent" | "forged" | "malformed" | "symlink" };

export function readProjectTrustStore(projectDir: string): Promise<ProjectTrustReadResult>;
export function resolveDefaultBackend(projectDir: string): Promise<string | null>;
export function writeProjectTrustStore(
  projectDir: string,
  grant: { defaultBackend: string },
): Promise<ProjectTrustStore>;
export function readOrCreateProjectTrustKey(projectDir: string): Promise<Buffer>;
```

### Key invariants

- **INV-1 (per-project authority root):** every trust store's `projectRootSha256` MUST equal the sha256 of its reader's resolved project root. A trust file is only valid in the project that minted it.
- **INV-2 (key isolation):** the project trust MAC key lives at `<project>/.pi/trust/.trust.mac` and is **never** the global session MAC key at `~/.episodic-memory/.session.mac`. Code paths that could mix them are a planning bug.
- **INV-3 (fail-closed to preference probe):** any read failure (absent/forged/malformed/symlink) resolves to "no default backend" → `selectBgTerminalBackend()` preference probe (current behavior). The reader never escalates trust it cannot verify.
- **INV-4 (explicit overrides default):** `--backend <name>` (P5E1) always wins over a persisted default. The default is only consulted when the flag is absent.
- **INV-5 (signing primitive reuse):** `signBgPayload` / `verifyBgPayloadMac` / `keyGenIdFromKey` from `bg-state.ts` are reused — no second HMAC scheme.
- **INV-6 (no cwd comparison):** `cwd` remains advisory-only (N6); the project root for `projectRootSha256` is `resolveProjectRoot(cwd)` (a real resolved absolute path), not `cwd` string equality.

### Resolution / flow

```text
/agents bg [agent] [task]   (no --backend)
        │
        ▼
parseBgArgs → state A (no --backend, no --profile)
        │
        ▼
resolveDefaultBackend(projectDir=ctx.cwd)
        │
        ├── readProjectTrustStore(cwd)
        │       │
        │       ├── file absent ──► { ok:false, reason:"absent" }
        │       ├── symlink ────► { ok:false, reason:"symlink" }
        │       ├── MAC bad ───► { ok:false, reason:"forged"/"malformed" }
        │       └── root mismatch ► { ok:false, reason:"forged" }
        │       │
        │       └── ok + getBgTerminalBackendByName(name) resolves ──► name
        │
        ├── name non-null ──► getBgTerminalBackendByName(name)
        └── null          ──► selectBgTerminalBackend()   [current behavior]
```

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/lib/bg-args.ts` | L9–L40 | `parseBgArgs` first-token `--backend`/`--profile`. | No edit needed for REQ-8; the "no `--backend`" branch (State A) is where `resolveDefaultBackend` is called by the caller. The flag's absence is the trigger. |
| `agents/lib/bg-terminal.ts` | L157 `getBgTerminalBackendByName`, L175 `selectBgTerminalBackend` | Backend registry lookup + preference probe. | `resolveDefaultBackend` calls these; no edit. |
| `agents/index.ts` | L685–L691 | `/agents bg` handler: parse, then `selectBgTerminalBackend` today. | Add the `resolveDefaultBackend` call between parse and probe (REQ-8). **Focused review before build** — argv/dispatch hot path. |
| `agents/lib/bg-preflight.ts` | L75 `effectiveProfile`, L86 `cwd: ctx.cwd`, L78 `options.profileOverride` | Manifest construction; `projectTrusted` field is set here today? (verify — likely threaded from P5-NL-bg). | REQ-9: call `readProjectTrustStore(ctx.cwd)` here and populate `projectTrusted` snapshot. |
| `agents/lib/bg-state.ts` | L51–L52 `projectTrusted` manifest field; L25 `assertManifestIdentityMatchesRuntime`; L167 `readOrCreateSessionMacKey`; L199 `assertNoSymlink`; L203 `signBgPayload`; L207 `verifyBgPayloadMac` | P4R root + MAC primitives. | Read-only reuse. No edits in scope (the global homeDir root stays global; project root is additive). |
| `agents/lib/bg-worker.ts` | L123 homeDir check (N1); L213 `readProjectRegistry(cwd, …)` | Worker reads the `projectTrusted` snapshot. | No edit in scope — P4R-PROJ (out of scope) will add worker enforcement. |
| `agents/lib/resolveProjectRoot` (NEW helper or reuse) | — | Resolves the canonical project root for `projectRootSha256`. | If a `resolveProjectRoot`-equivalent doesn't exist, create it in `bg-trust.ts` (walk up to `.pi/` or `.git/`). Decide in Step 1 below. |

## Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P5F-1` | Pure extraction: project MAC key + read primitives (no writers, no wiring). Zero behavior change. | `agents/lib/bg-trust.ts` (new), `agents/test/test-bg-trust.mjs` (new) | `readOrCreateProjectTrustKey`, `readProjectTrustStore` (REQ-1/2/3/4/7/10/11). | 8 unit tests. | No production caller; existing suite green. |
| `P5F-2` | Writer + default-backend resolver. | `agents/lib/bg-trust.ts` (APPEND writer + resolver), `agents/test/test-bg-trust.mjs` (APPEND tests) | `writeProjectTrustStore` (REQ-6), `resolveDefaultBackend` (REQ-5/8). | 5 unit tests. | Writer invoked only by tests; no command path yet. |
| `P5F-3` | `/agents bg` read-side wiring + preflight snapshot source. | `agents/index.ts` (EDIT), `agents/lib/bg-preflight.ts` (EDIT), `agents/test/test-bg-preflight.mjs` (APPEND) | REQ-8 (default backend consulted), REQ-9 (`projectTrusted` sourced from disk). | 4 unit tests + 1 smoke. | Explicit `--backend` still wins (regression guard). |

### Dependency graph

```text
P5F-1 (pure extraction, no callers) ── P5F-2 (writer + resolver) ── P5F-3 (wiring)
```

Serial: P5F-2 imports P5F-1's reader; P5F-3 imports P5F-2's resolver. Each slice leaves the build green on its own.

## Cut Order

If context/scope grows, cut in this order:

1. **REQ-10 (MAC-before-root timing guard) → `UNGUARDED-IN-CI` first.** The correctness contract still holds (fail-closed); only the *automated proof of ordering* is deferred, with a manual grep named.
2. **REQ-9 (preflight `projectTrusted` source) to P4R-PROJ, not P5F.** Ship the disk reader + default-backend wiring (REQ-1–8) first; P4R-PROJ can consume `readProjectTrustStore` itself once the writer exists.

Do not cut:

- **REQ-3 (fail-closed on forged/tampered MAC).** This is the entire security premise; cutting it makes the feature net-negative.
- **REQ-7 (per-project key isolation).** Sharing the global key enables cross-project forgery (Safety matrix).
- **REQ-8 negative control (`testBgCommand_explicitBackendOverridesDefault`).** Without it, a regression where the default silently wins over `--backend` is invisible.

## Contracts

### `readProjectTrustStore(projectDir: string): Promise<ProjectTrustReadResult>`

**Input contract:** `projectDir` is an absolute path (caller resolves via `path.resolve`). Relative paths are rejected with `TypeError`.

**Output contract:** discriminated union `ProjectTrustReadResult`; never throws for trust-content failures (absent/forged/malformed/symlink) — returns `{ ok:false, reason }`. Throws only for programmer errors (non-string input, non-absolute path).

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Absent | trust file does not exist | `{ ok:false, reason:"absent" }` |
| B. Symlink | trust file is a symlink (lstat) | `{ ok:false, reason:"symlink" }` |
| C. Malformed | file exists, not a symlink, JSON parse fails | `{ ok:false, reason:"malformed" }` |
| D. Schema-invalid | parses but `schemaVersion !== 1` or required fields missing/wrong-type | `{ ok:false, reason:"malformed" }` |
| E. Key-absent | project MAC key file absent → cannot verify | `{ ok:false, reason:"forged" }` (treat as untrusted) |
| F. MAC malformed | `mac` does not match `/^[0-9a-f]{64}$/i` | `{ ok:false, reason:"malformed" }` |
| G. MAC mismatch | `verifyBgPayloadMac(store-minus-mac, projectKey, mac) === false` | `{ ok:false, reason:"forged" }` |
| H. Root mismatch | MAC ok but `projectRootSha256 !== sha256(resolveProjectRoot(projectDir))` | `{ ok:false, reason:"forged" }` |
| I. Valid | MAC ok + root matches + (SHOULD) MAC checked before root | `{ ok:true, store }` |

**Error codes:**

| Code | Field | Trigger |
|---|---|---|
| `TRUST_FILE_IS_SYMLINK` | `reason:"symlink"` | lstat detects a symlink at the trust file path |
| `TRUST_KEY_IS_SYMLINK` | thrown Error | lstat detects a symlink at the MAC key path (reuses `assertNoSymlink` throw semantics from bg-state.ts:199) |

### `resolveDefaultBackend(projectDir: string): Promise<string | null>`

**Input contract:** as above.

**Output contract:** `string` (a registered backend name) or `null` (caller falls back to `selectBgTerminalBackend()`).

| State | Condition | Output |
|---|---|---|
| A. Store valid + backend registered | `readProjectTrustStore` ok AND `getBgTerminalBackendByName(name)` defined | `name` |
| B. Store valid + backend NOT registered | ok store but name not in registry (e.g. backend uninstalled) | `null` |
| C. Store absent/forged/malformed (any) | `readProjectTrustStore` returns `{ ok:false, … }` | `null` |
| D. Explicit `--backend` at the caller | caller short-circuits before calling this | n/a — called only in the flag-absent branch |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | Trust file exists but `.pi/trust/.trust.mac` deleted by hand | `{ ok:false, reason:"forged" }` → null → preference probe | `testReadTrustStore_keyAbsentTreatedAsForged` |
| EC2 | Two projects, trust file copied A→B | Root mismatch (B's root ≠ A's hash) → forged → null | `testReadTrustStore_rejectsForeignProjectRoot_withSentinel` |
| EC3 | Backend uninstalled after grant | Store valid but `getBgTerminalBackendByName` undefined → null → probe | `testResolveDefaultBackend_fallsBackWhenBackendUnregistered` |
| EC4 | `--backend cmux` passed AND default is `tmux` | Explicit wins (INV-4) → cmux | `testBgCommand_explicitBackendOverridesDefault` |
| EC5 | Trust file written, then `.trust.mac` rotated (new key) | `keyGenId` in store ≠ new key's `keyGenIdFromKey` → MAC verify fails → forged → null | `testReadTrustStore_rejectsAfterKeyRotation` |
| EC6 | Concurrent `writeProjectTrustStore` from two processes | Atomic temp+rename; loser's temp is orphaned (0600 tmpfile, no final-path corruption). Not a correctness risk for the *reader* (reads see either old-or-new, never torn). | `testWrite_atomicTempRename` + note (full concurrency test is MAY) |
| EC7 | `projectDir` is inside a symlinked path (e.g. `/tmp/proj → /Users/.../proj`) | `resolveProjectRoot` uses `fs.realpath` before hashing so symlinked-into-the-same-project works; **cross-project** copy still fails (different real root). | `testReadTrustStore_acceptsSymlinkedProjectDirInsideSameRoot` (MAY) |
| EC8 | Corrupt JSON (truncated by kill mid-write) | JSON.parse throws → `{ ok:false, reason:"malformed" }` → null → probe | `testReadTrustStore_rejectsCorruptJson` |

## Test Case Catalog

```text
Group 1: readProjectTrustStore (6 tests)
  testReadTrustStore_parsesValidFile
  testReadTrustStore_returnsNullWhenAbsent
  testReadTrustStore_rejectsSymlink                  (red-then-green)
  testReadTrustStore_rejectsTamperedMac
  testReadTrustStore_rejectsMalformedMac
  testReadTrustStore_rejectsForeignProjectRoot_withSentinel

Group 2: project MAC key (2 tests)
  testProjectTrustKey_isDistinctFromSessionMac
  testProjectTrustKey_symlinkGuard                  (red-then-green)

Group 3: writeProjectTrustStore (3 tests)
  testWriteThenRead_roundtrip
  testWrite_atomicTempRename
  testReadTrustStore_rejectsAfterKeyRotation        (EC5)

Group 4: resolveDefaultBackend (3 tests)
  testResolveDefaultBackend_returnsTrustedName
  testResolveDefaultBackend_fallsBackWhenBackendUnregistered
  testResolveDefaultBackend_fallsBackWhenStoreForged

Group 5: /agents bg wiring (3 tests + 1 smoke)
  testBgCommand_usesDefaultBackendWhenAbsent
  testBgCommand_explicitBackendOverridesDefault
  testPreflight_recordsProjectTrustSnapshot_whenPresent
  testPreflight_recordsNull_whenAbsentOrForged
  smoke: manual: /agents bg with a minted trust file → confirmed backend used   (UNGUARDED-IN-CI)

Group 6: invariants (2 static)
  static: grep — no third-party imports in bg-trust.ts (REQ-11)
  static: grep — project MAC path never equals global session MAC path (INV-2)

Total: 16 unit tests + 2 static + 1 UNGUARDED-IN-CI smoke.
```

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Read path slows `/agents bg` launch (disk read on every launch) | Medium | Trust file is small (<1KB); `fs.realpath` + one read + one HMAC. Cache not needed for v0.1; if profiling shows cost, cache keyed by `(projectRootSha256, mtime)`. |
| `resolveProjectRoot` diverges from what the user considers "the project" (monorepo workspace dirs) | Medium | Decide root-resolution rule explicitly in P5F-1 Step 1 (probable: nearest ancestor containing `.pi/` or `.git/`). Document as a known limit; MAY add `--trust-root` override later. |
| Trust file committed to git by a confused user | Low | `.pi/` is the pi-agent state dir convention; advise `gitignore` of `.pi/trust/`. The MAC key (`.trust.mac`) MUST never be committed — single-line `.gitignore` add. |
| Two backends both claim the same `name` | Low | `registerBgTerminalBackend` dedup is P4-4's concern; `resolveDefaultBackend` trusts whatever `getBgTerminalBackendByName` returns. Out of scope. |
| P4R-PROJ worker enforcement built on this reader diverges from P5-NL-bg snapshot semantics | Medium | REQ-9 fills the existing `projectTrusted` shape rather than adding a field — keeps the two surfaces aligned by construction. |

## Open Decisions

- **OD-1: `resolveProjectRoot` rule.** Nearest ancestor containing `.pi/`? Or `.git/`? Or both (prefer `.pi/`)? Deferred to P5F-1 Step 1 — must be a concrete rule, not "as appropriate". Working assumption: nearest ancestor containing `.pi/` OR `.git/`, whichever is closer; documented in the function JSDoc.
- **OD-2: Trust-grant UX.** Out of scope (Non-Goal 1). Decision deferred to a follow-up plan `P5F-GRANT` once this reader lands.
- **OD-3: Whether to also write a `.gitignore` entry for `.pi/trust/` automatically.** Defer — writer can `console.warn` if `.pi/trust/` is inside a git repo and not gitignored; auto-editing `.gitignore` is a side effect beyond "reader+writer primitives".

## Done Criteria

- [ ] All MUST requirements (REQ-1–9, REQ-11) passing = done for P5F-1+P5F-2+P5F-3.
- [ ] REQ-10 (SHOULD) either has an automated ordering test OR is tagged `UNGUARDED-IN-CI` with the named manual grep in the plan body.
- [ ] Existing P4R / P5 / P5E1 / P5-NL-bg suite still green (the new reader is additive; the only production edits are index.ts L685–691 probe-call site and bg-preflight.ts snapshot source).
- [ ] `grep -n "resolveTrustedHome\|readOrCreateSessionMacKey" agents/lib/bg-trust.ts` returns **nothing** (INV-2: project reader never touches the global substrate).

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | _(this plan produced for review; not yet reviewed)_ | — | — | pending |

### Resolved blockers

_(none yet — to be filled by plan review + adversarial review)_

## Appendix: Implementation Plan

### Files to create

1. `agents/lib/bg-trust.ts` — trust store types, project MAC key, reader, writer, resolver (REQ-1–11). P5F-1 creates primitives; P5F-2 APPENDs writer + resolver.
2. `agents/test/test-bg-trust.mjs` — Groups 1–6 (16 tests + 2 static).
3. `agents/test/run-bg-trust-tests.sh` — slice test runner (mirrors `tmux-control/test-fixtures/run-control-tests.sh` pattern).

### Files to modify

| File | Change |
|---|---|
| `agents/index.ts` (L685–691 region) | In the no-`--backend` branch, call `resolveDefaultBackend(ctx.cwd)` before `selectBgTerminalBackend()`; use the resolved name via `getBgTerminalBackendByName` if non-null. Explicit `--backend` path unchanged. |
| `agents/lib/bg-preflight.ts` (manifest construction, ~L78–L113) | Populate `projectTrusted` from `readProjectTrustStore(ctx.cwd)` (REQ-9). Thread `projectRootSha256` + project `keyGenId` into the snapshot when present; `null` otherwise. |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 (P5F-1) | Decide `resolveProjectRoot` rule (OD-1) and implement it + project MAC key + `readProjectTrustStore` + 8 Group-1/2 tests. | `bash agents/test/run-bg-trust-tests.sh` → 8 green; existing suite green; `grep -n "resolveTrustedHome" agents/lib/bg-trust.ts` empty. |
| 2 (P5F-2) | APPEND `writeProjectTrustStore` + `resolveDefaultBackend` + 8 Group-3/4 tests (incl. EC5 rotation). | Slice runner → 16 green. |
| 3 (P5F-3) | EDIT `index.ts` (default-backend consultation) + EDIT `bg-preflight.ts` (snapshot source) + 4 Group-5 tests + approve the `UNGUARDED-IN-CI` smoke. | Full `agents` test suite green; explicit-overrides-default regression green. |

### Risks (impl)

| Risk | Mitigation |
|---|---|
| `index.ts` edit is on the `/agents bg` dispatch hot path | P5F-3 marked **focused review before build**; the edit is a single `resolveDefaultBackend` call + conditional, smallest-diff anchored on the current `selectBgTerminalBackend()` call. |
| `bg-preflight.ts` snapshot threading may interact with P5-NL-bg intent-gate | P5F-3 only *fills* the existing `projectTrusted` field; no new field. P5-NL-bg tests are the regression guard — if any turn red, the field shape drifted (planning bug, not a code bug). |

## Appendix B: Mechanical Execution Spec (for a low-capability executor)

**Executor contract** — copy verbatim into the plan.

1. Do the steps **in numeric order**. Do not skip, reorder, or batch.
2. Each step names exactly one file, what to add/change, and how to verify.
3. **Make no design decisions.** If a step is ambiguous or an anchor isn't found verbatim, **STOP and ask**.
4. Run the verify command after each step. If it fails, fix only that step; do not proceed until green.
5. Slice test command: `bash agents/test/run-bg-trust-tests.sh` (P5F-1, P5F-2) / `bash agents/test/run-bg-preflight-tests.sh` (P5F-3).
6. **Edit exactly ONE file per step.** Read-only references (look but never edit): `agents/lib/bg-state.ts`, `agents/lib/bg-terminal.ts`, `agents/lib/bg-worker.ts`, `agents/lib/bg-args.ts`.
7. **Surgical edits only.** CREATE (whole-file, new file), EDIT (anchored `ANCHOR → REPLACE`, smallest diff), or APPEND (add at end of a file you created earlier in this slice). No `Write`-overwrite of an existing file.
8. One slice = one commit, message `P5F-<n>: <title>`, with the required `Co-Authored-By` trailer. Each slice leaves the build green on its own.
9. **No aspirational output.** Every `echo`/`log`/comment that *describes* a check MUST be backed by a real assertion whose operands include captured stdout/exit/written-file/imported-return.

**Executor-ready gate:** every step's `File` column names exactly one file; every EDIT step quotes a verbatim `ANCHOR` and exact `REPLACE`; whole-file `Write` only for new-file CREATE steps; no step text contains "decide"/"choose"/"figure out"/"as appropriate"/"if needed"/"etc."/"e.g."/as-intent-"assert that"/"verify that"; every constant, error string, regex, and signature appears verbatim below.

### Shared constants / types (add once)

```ts
// lib/bg-trust.ts — exact values
export const PROJECT_TRUST_SCHEMA_VERSION = 1;
export const PROJECT_TRUST_DIR = ".pi/trust";
export const PROJECT_TRUST_FILE = "default-backend.json";
export const PROJECT_TRUST_MAC_FILE = ".trust.mac";
export const PROJECT_TRUST_MAC_BYTES = 32;
const MAC_HEX_RE = /^[0-9a-f]{64}$/i;
const FOREIGN_ROOT_ERR = "TRUST_FILE_IS_SYMLINK";   // reused throw tag name
```

### `P5F-1` — read primitives (REQ-1/2/3/4/7/10/11)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 1.1 | `agents/lib/bg-trust.ts` | **CREATE**. Full source: the typed `ProjectTrustStore`, `ProjectTrustReadResult`, the 5 constants above, `resolveProjectRoot(dir)` (= nearest ancestor of `fs.realpath(dir)` containing `.pi/` or `.git`, whichever is nearer; throw `Error("resolveProjectRoot: no .pi or .git ancestor for " + dir)` otherwise), `readOrCreateProjectTrustKey(projectDir)` (mirrors `readOrCreateSessionMacKey` body; key path `path.join(projectDir, PROJECT_TRUST_DIR, PROJECT_TRUST_MAC_FILE)`; symlink-guard via `assertNoSymlink` imported from `./bg-state.ts`; never reads `~/.episodic-memory`), `readProjectTrustStore(projectDir)` implementing the 9-state table (read file via `readUtf8FileNoSymlink`-style helper; MAC verified before root compare; every failure returns `{ok:false,reason}`, never throws for content failures). | `node -e "import('./agents/lib/bg-trust.ts').then(m=>console.log(Object.keys(m).join(',')))"` prints a list containing `readProjectTrustStore,readOrCreateProjectTrustKey,resolveProjectRoot` AND `grep -n "resolveTrustedHome\|readOrCreateSessionMacKey" agents/lib/bg-trust.ts` returns **empty** (INV-2). |
| 1.2 | `agents/lib/bg-trust.ts` | **APPEND**. Add `function sha256Hex(s: string): string { return createHash("sha256").update(s).digest("hex"); }` (import `createHash` from `node:crypto`) and `export function projectRootSha256(projectDir: string): string { return sha256Hex(resolveProjectRoot(projectDir)); }`. | `grep -n "export function projectRootSha256" agents/lib/bg-trust.ts` prints the line. |
| 1.3 | `agents/test/test-bg-trust.mjs` | **CREATE**. Full verbatim test file: Groups 1–2 (6 tests). Each test creates a temp project dir via `fs.mkdtempSync`, mints a store by importing `readOrCreateProjectTrustKey` + `signBgPayload` (from `./bg-state.ts`) + writing the trust JSON, then asserts on `readProjectTrustStore`'s returned `ok`/`reason`. The symlink test creates a symlink at the trust path and asserts `reason:"symlink"` (red-then-green: the same fixture with a real file must return `ok:true` — proving the guard catches the symlink, not incidental failure). The foreign-root test mints in project A then reads under project B (distinct `projectRootSha256`) and asserts `reason:"forged"`; the sentinel value asserted is the resolved `projectRootSha256` of each temp dir (asserted unequal before the read). The `distinctFromSessionMac` test asserts `readOrCreateProjectTrustKey(tmpA)` (hex) !== `readOrCreateSessionMacKey()` (hex) using `assert.notStrictEqual`. The `symlinkGuard` test symlinks `.trust.mac` and asserts the reader throws (red-then-green with a real key). No "assert that …" prose; every assert operates on captured return values. | `node agents/test/test-bg-trust.mjs` → prints `6/6 passing` AND `BREAK=1 node agents/test/test-bg-trust.mjs` (env that, when set, makes a test replace trust content with tampered mac) exits non-zero → proves negative control reaches the assertions. |
| 1.4 | `agents/test/run-bg-trust-tests.sh` | **CREATE**. Verbatim runner: `node agents/test/test-bg-trust.mjs`; exit on its code. | `bash agents/test/run-bg-trust-tests.sh; echo "EXIT=$?"` → `EXIT=0`. |

**(P5F-1 commits here. P5F-2 and P5F-3 step-tables authored after P5F-1 review — the writer/resolver signatures depend on the reader holding up under the P5F-1 tests, and anchoring their EDITs against reviewed-stable code is safer than pre-anchoring against a file that may shift in review.)**

### Blast-radius patterns applied

- **Pure-extraction slice first (P5F-1):** the reader is extracted as its own slice with zero production callers. Existing P4R/P5/P5E1/P5-NL-bg suite stays green untouched — the trust module is imported only by tests until P5F-3.
- **Test-preserving seam (P5F-3):** `index.ts` gets one `resolveDefaultBackend` call in the flag-absent branch — existing `--backend <name>` tests bypass it (they take the explicit-flag branch), so P5E1 tests pass unchanged.
- **Red-then-green guard (every security mitigation):** REQ-2/REQ-7 symlink guards, REQ-3 MAC-tamper guards, and REQ-4 foreign-root guard all include a negative control (the broken input must make the test fail) via `BREAK=1` env or an inline symlink — never a separately-committed broken fixture.
- **Discriminating fixture (REQ-4):** the foreign-root test asserts the actual `projectRootSha256` of two distinct temp projects are unequal *before* asserting the cross-read fails — proving the failure is the root-binding, not incidental.
- **Deterministic signal:** every test asserts on captured return values / file contents / exit codes — no LLM/network/non-determinism. The one `UNGUARDED-IN-CI` row (the `/agents bg` end-to-end smoke) is tagged with the manual step and is not on the MUST path.

### Definition of done (whole plan)

`bash agents/test/run-bg-trust-tests.sh` prints all 16 tests passing; `grep -n "resolveTrustedHome\|readOrCreateSessionMacKey" agents/lib/bg-trust.ts` returns empty (INV-2 invariant grep); the existing `agents`/`tmux-control`/`tmux-terminal`/`agents`-preflight suites all green; and the `testBgCommand_explicitBackendOverridesDefault` regression test green (P5E1 contract preserved).
