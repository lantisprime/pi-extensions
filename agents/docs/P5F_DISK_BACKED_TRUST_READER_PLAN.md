# P5F Disk-Backed Per-Project Trust Reader Plan

## Status

Planning + execution tracking. **Plan review consensus REACHED (codex APPROVE, Pass 5)**; plan ACCEPTED. **P5F-1 MERGED** (#145, `08a9be6`). **P5F-2 step-tables AUTHORED below** (post-P5F-1-merge, anchored against the shipped reader at `agents/lib/bg-trust.ts`). **P5F-3** step-tables still deferred (authored after P5F-2 review).

## Episode Search Summary

Searched episodic memory for `trust`, `authority-root`, `Mac key`, `default backend`, `project-trusted`, `P4R-PROJ` in project `pi-extensions`.

Key active memories:

- `20260704-122521-post-merge-sync-p5-nl-agents-bg-intent-g-d94b` (canonical-workplan chain head): P5 NL→`/agents bg` intent-gate COMPLETE; lists the two deferred items this plan addresses ("persistent per-project default backend — needs trust reader" and "P4R-PROJ — needs disk-backed trust reader").
- `20260628-115957-handoff-p5b-1-s1-complete-p5b-1-s2-is-ne-be85` (canonical-workplan, superseded chain member): P5b-1-S1 cmux-terminal backend merged; documents the `TermBgBackend` `preference`-ordered registry the default-backend resolver will query.
- `20260627-083228-pi-extensions-main-is-branch-protected-a-89de` (local): `main` is branch-protected — PRs + human approval required for any change, including docs.

## Objective

Ship a per-project, disk-backed, HMAC-signed trust store + reader that (a) supplies a default terminal backend name when `--backend` is omitted, and (b) binds a background-agent run's authority to a project-scoped trust root (unblocking P4R-PROJ). The reader composes with the existing P4R MAC key lifecycle and the P5-NL-bg `projectTrusted` manifest field rather than introducing a parallel signing scheme.

## Why

Two deferred roadmap items share one blocker, and removing it unblocks both:

1. **Persistent per-project default backend.** P5E1 shipped `--backend <name>` as a *per-launch* selector. Without a persisted default, every `/agents bg` call that omits `--backend` falls back to `selectBgTerminalBackend()`'s preference-ordered probe — which picks whichever backend is installed, not whichever the user *trusted* for this project. A user who has both tmux and cmux installed gets a non-deterministic default. Persisting a per-project trusted default backend requires a store that can't be silently inherited, symlink-spoofed, or forged by another project.
2. **P4R-PROJ Project Background Agents.** Today the authority root is **global** (`resolveTrustedHome()`; `assertManifestIdentityMatchesRuntime` compares `homeDir` only, N1; `cwd` is advisory and **not compared**, N6). P5-NL-bg added a `projectTrusted: boolean` field to the manifest (so a detached worker honors preflight-time trust), but it is threaded through the global MAC key — there is no on-disk per-project trust root to *source* it from or to *bind* a project agent's authority to. P4R-PROJ needs that binding.

Both are read-by-the-launch path, so the reader must be fast, offline, and tamper-evident. It is a single shared primitive, not two features.

## Requirements (Ground Truth)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | `readProjectTrustStore(projectDir)` reads `<projectDir>/.pi/trust/default-backend.json` and returns a `ProjectTrustReadResult` discriminated union: `{ok:true, store}` on valid (States I); `{ok:false, reason:"absent"|"forged"|"malformed"|"symlink"}` on any failure (States A-H). Never throws for trust-content failures; throws only for programmer errors (non-string/non-absolute `projectDir`). | `testReadTrustStore_parsesValidFile` (I), `testReadTrustStore_returnsNullWhenAbsent` (A), `testReadTrustStore_rejectsCorruptJson` (C), `testReadTrustStore_rejectsSchemaInvalid` (D) | MUST | Trust STORE path is under `.pi/trust/` (the pi-extensions `agents` extension's own state dir convention), NOT under `.episodic-memory/` (which belongs to the separate episodic-memory package's substrate). |
| REQ-2 | `readProjectTrustStore` rejects symlinks at the **trust file** path by returning `{ok:false, reason:"symlink"}` (via `lstat`; does NOT throw — content failures are union values per REQ-1). Symlinks at the `.trust.mac` **key** path DO throw (via `assertNoSymlink`, bg-state.ts:619/199 precedent — the key-path guard is distinct from the trust-file read path). | `testReadTrustStore_rejectsSymlink` (red-then-green) | MUST | Same TOCTOU/symlink class as the session MAC key. Negative control: replace the file with a symlink → must return `{ok:false, reason:"symlink"}` (the green case with a real file returns `{ok:true}`). |
| REQ-3 | `readProjectTrustStore` verifies the file's `mac` against the **project MAC key** (REQ-7) using `verifyBgPayloadMac` and returns `{ok:false, reason:"malformed"}` for malformed mac (`/^[0-9a-f]{64}$/i`, State F) or `{ok:false, reason:"forged"}` for MAC mismatch (State G) or key-absent (State E, treated as untrusted). Never throws; fail-closed to the union. | `testReadTrustStore_rejectsTamperedMac` (G), `testReadTrustStore_rejectsMalformedMac` (F), `testReadTrustStore_keyAbsentTreatedAsForged` (E) | MUST | FAIL-CLOSED to the eventual preference probe — a corrupt/forged file never escalates privilege; it silently degrades to "no default". |
| REQ-4 | The `projectRootSha256` in the trust store MUST equal `sha256(resolveProjectRoot(projectDir))`; mismatch → return `{ok:false, reason:"forged"}` (State H). This is the per-project authority-root binding. | `testReadTrustStore_rejectsForeignProjectRoot_withSharedKeySentinel` | MUST | Defeats a trust file copied between projects. The fixture injects project A's `.trust.mac` into project B so MAC verifies (isolating root-binding from MAC failure), asserts A/B `projectRootSha256` differ first, THEN asserts the cross-read returns `{ok:false, reason:"forged"}` — proving the failure is root-binding, not incidental MAC failure. |
| REQ-5 | `resolveDefaultBackend(projectDir)` returns `store.defaultBackend` ONLY when `readProjectTrustStore` returns `{ok:true}` AND `getBgTerminalBackendByName(name)` resolves; otherwise returns `null` (caller falls back to preference probe). | `testResolveDefaultBackend_returnsTrustedName`, `testResolveDefaultBackend_fallsBackWhenBackendUnregistered`, `testResolveDefaultBackend_fallsBackWhenStoreForged` | MUST | Three-state: trusted+registered → name; trusted+unregistered → null; forged/absent → null. The forged case is the negative control for REQ-3. |
| REQ-6 | `writeProjectTrustStore(projectDir, { defaultBackend })` is the ONLY writer. It mints the store: computes `projectRootSha256`, sets `grantedAtMs=Date.now()`, reads the project MAC key (REQ-7), signs with `signBgPayload`, writes atomically (temp + rename, 0600). On any mid-write failure the prior final file is left unchanged; an orphaned 0600 temp file is acceptable but documented. | `testWriteThenRead_roundtrip`, `testWrite_atomicTempRename`, `testWrite_atomicFailureLeavesFinalUntouched` | MUST | Granting a default backend is a trust grant — single writer prevents scattered mint sites. |
| REQ-7 | `readOrCreateProjectTrustKey(projectDir)` mirrors `readOrCreateSessionMacKey` body verbatim (bg-state.ts:167-189): 32 random bytes at `<projectDir>/.pi/trust/.trust.mac`, 0600 (`mode: 0o600` with `flag: "wx"`), symlink-guarded via `assertNoSymlink` (throws, bg-state.ts:199). **Distinct key from the global session MAC** — never reads/writes `~/.pi/agent/bg/.session.mac` (bg-state.ts:138) and never imports `resolveTrustedHome`/`readOrCreateSessionMacKey`/`getBgStateDir`/`getBgSessionMacPath` from `bg-state.ts`. | `testProjectTrustKey_isDistinctFromSessionMac`, `testProjectTrustKey_symlinkGuard` (red-then-green: symlinked key → throws) | MUST | Per-project key = per-project authority root. Sharing the global key would let a project forge another project's trust. |
| REQ-8 | When `--backend <name>` is omitted, the `/agents bg` path (`handleBgCommand`, index.ts:713 region) calls `resolveDefaultBackend(ctx.cwd)`; if non-null, uses that backend via `getBgTerminalBackendByName`; otherwise falls back to `selectBgTerminalBackend()` (current behavior). The explicit `--backend` branch (index.ts:695) is unchanged. | `testBgCommand_usesDefaultBackendWhenAbsent`, `testBgCommand_explicitBackendOverridesDefault_discriminating` | MUST | P5E1 explicit `--backend` always wins — this is the precedence contract. The discriminating fixture: default=`tmux`, explicit `--backend cmux`, BOTH registered/available, assert the cmux launch path is used (not the tmux default). |
| REQ-9 | `preflightBgAgent` sets the existing `projectTrusted: boolean` manifest field (bg-state.ts:55 — confirmed `boolean`, not a snapshot struct) to `true` when `readProjectTrustStore(ctx.cwd)` returns `{ok:true, store}` (valid + root-bound), else `false`. The worker's existing boolean-snapshot logic (bg-worker.ts:202, :225) is **unchanged in shape**. Threading `projectRootSha256` + project `keyGenId` into the manifest snapshot is DEFERRED to P4R-PROJ (Non-Goal 2). | `testPreflight_recordsProjectTrustSnapshot_whenPresent` (true on valid), `testPreflight_recordsNull_whenAbsentOrForged` (false on forged/absent) | MUST | Composes with P5-NL-bg's existing `projectTrusted: boolean` field (bg-state.ts:51-55) — this feature only *sources the boolean from disk*. Forged-store case is the negative control. |
| REQ-10 | A constant-time MAC compare is used (`verifyBgPayloadMac` already uses `timingSafeEqual`); `readProjectTrustStore` MUST verify MAC (State G) BEFORE root compare (State H) — source-order enforced in `bg-trust.ts`. | (1) `testReadTrustStore_macAndRootBothChecked` — automated: asserts a store with VALID mac + WRONG root → `{ok:false,reason:"forged"}` (State H) AND a store with WRONG mac + VALID root → `{ok:false,reason:"forged"}` (State G), proving BOTH checks execute. (2) `UNGUARDED-IN-CI` manual grep: `grep -n 'verifyBgPayloadMac\|projectRootSha256' agents/lib/bg-trust.ts` — assert the `verifyBgPayloadMac` call line number < the root-compare line number (source-order proof). | SHOULD | ORDERING (G-before-H) is mechanically unverifiable in plain ESM without a mock library, and REQ-11 forbids new runtime deps (so no mock framework). The automated test proves the weaker but honest "both checks execute" property; ORDERING itself is `UNGUARDED-IN-CI` via the named manual grep. |
| REQ-11 | No new runtime dependencies; the trust module imports only `node:crypto`, `node:fs`, `node:path`, and the existing `bg-state.ts` primitives (`signBgPayload`, `verifyBgPayloadMac`, `keyGenIdFromKey`, `assertNoSymlink`, `readUtf8FileNoSymlink`). | `static: grep -nE "from ['\"](node:|\\./bg-state)" agents/lib/bg-trust.ts` returns ONLY those import sources (no third-party) | MUST | Mirrors the P5c-2 dependency invariant (typebox provided by pi's jiti). `UNGUARDED-IN-CI` is not acceptable here — the grep is the assertion and is fully automated. |

**Priority legend:** MUST = blocker for first slice merge; SHOULD = required before feature complete (one slice may defer with named fallback); MAY = nice-to-have.

## Non-Goals

- **No trust-granting UX in this plan.** How a user grants a default backend (CLI `pi agents trust --backend cmux`, a slash command, an interactive prompt) is a *separate* follow-up. This plan ships the **reader + writer primitives** and the **read-side wiring** (REQ-8, REQ-9). The writer (REQ-6) is exercised only by tests, not by any command, in scope.
- **No P4R-PROJ full launch path.** This plan ships the trust root + the boolean `projectTrusted` disk source (REQ-9); the worker-side enforcement of project-scoped bg authority (kill-on-trust-revoke, project-scoped reservation quotas, and the `projectRootSha256`/`keyGenId` snapshot enrichment) is P4R-PROJ's job. The trust reader is the prerequisite, not P4R-PROJ itself.
- **No per-project MAC for the global session manifest.** The existing `~/.pi/agent/bg/.session.mac` (pi-extensions `agents` bg-state, bg-state.ts:138) and global bg-state are untouched. The project key (`<project>/.pi/trust/.trust.mac`) is **additive**.
- **No trust revocation lifecycle.** Revoking a trusted default (deleting the trust file by hand works; an explicit command doesn't exist yet — see Non-Goal 1).
- **No network/cloud sync of trust files.** Trust is local, per-machine, per-project — consistent with the global MAC key model.

## Safety / Security

This feature **is** a security primitive (it seeds "which backend can launch external processes for this project" and binds bg-authority). The mitigations are themselves MUST requirements above; the matrix below names the falsifiable test for each.

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Symlink/TOCTOU on trust file | High | `lstat` before read; symlink → `{ok:false, reason:"symlink"}` (union, not throw). | `testReadTrustStore_rejectsSymlink` (REQ-2) — red-then-green. |
| Symlink/TOCTOU on project MAC key | High | `assertNoSymlink` (throws, bg-state.ts:619/199); `readUtf8FileNoSymlink` with `requirePrivate:true`. | `testProjectTrustKey_symlinkGuard` (REQ-7) — red-then-green. |
| Forge a trust file to elevate a backend | High | HMAC verify with project MAC key; mismatch/malformed → `{ok:false, reason:"forged"|"malformed"}` (fail-closed to preference probe, never escalate). | `testReadTrustStore_rejectsTamperedMac`, `testReadTrustStore_rejectsMalformedMac`, `testReadTrustStore_keyAbsentTreatedAsForged` (REQ-3). |
| Copy a trust file between projects to claim another project's authority | High | `projectRootSha256` binding (REQ-4); mismatch → `{ok:false, reason:"forged"}`. | `testReadTrustStore_rejectsForeignProjectRoot_withSharedKeySentinel` (REQ-4) — injects A's key into B so MAC passes, isolating root-binding failure. |
| Use project key to forge another project (cross-project forgery) | High | Project MAC key is per-project, symlink-guarded, 0600, never written to the global path, never imported from `bg-state.ts`. | `testProjectTrustKey_isDistinctFromSessionMac` (REQ-7) + static grep `resolveTrustedHome|readOrCreateSessionMacKey|getBgStateDir|getBgSessionMacPath` MUST be empty in `bg-trust.ts`. |
| Timing oracle on root comparison | Medium | MAC verified (State G) before root compare (State H); constant-time compare in `verifyBgPayloadMac` (`timingSafeEqual`). | `testReadTrustStore_macAndRootBothChecked` (REQ-10, automated both-checks) + `UNGUARDED-IN-CI` manual grep for source ordering. |
| Forged file degrading loudly vs silently | Medium | REQ-3 returns the union `{ok:false,…}` (silent degrade) — escalation-by-failure is the wrong direction. | Negative-control assertions in REQ-3/REQ-5 cover "forged → falls back, never escalates". |
| Atomic write torn half-way | Medium | `writeProjectTrustStore` uses temp + rename (0600); prior final file preserved on failure. | `testWrite_atomicTempRename`, `testWrite_atomicFailureLeavesFinalUntouched` (REQ-6). |

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
export function resolveProjectRoot(dir: string): string;
export function projectRootSha256(projectDir: string): string;
```

### Key invariants

- **INV-1 (per-project authority root):** every trust store's `projectRootSha256` MUST equal the sha256 of its reader's resolved project root. A trust file is only valid in the project that minted it. (PLAN-ONLY — proposes a new invariant; not currently enforced anywhere.)
- **INV-2 (key isolation):** the project trust MAC key lives at `<project>/.pi/trust/.trust.mac` and is **never** the global session MAC key at `~/.pi/agent/bg/.session.mac` (the pi-extensions `agents` extension's bg-state dir — `getBgStateDir`/`getBgSessionMacPath` at bg-state.ts:134/138. NOT the episodic-memory package's `~/.episodic-memory/` substrate). The trust module (`bg-trust.ts`) MUST NOT import `resolveTrustedHome`, `readOrCreateSessionMacKey`, `getBgStateDir`, or `getBgSessionMacPath` from `bg-state.ts`. Code paths that could mix them are a planning bug.
- **INV-3 (fail-closed to preference probe):** any read failure (absent/forged/malformed/symlink) resolves to "no default backend" → `selectBgTerminalBackend()` preference probe (current behavior at bg-terminal.ts:175). The reader never escalates trust it cannot verify.
- **INV-4 (explicit overrides default):** `--backend <name>` (P5E1, index.ts:695 explicit branch) always wins over a persisted default. The default is only consulted when the flag is absent (index.ts:713 fallback branch).
- **INV-5 (signing primitive reuse):** `signBgPayload` / `verifyBgPayloadMac` / `keyGenIdFromKey` from `bg-state.ts` (bg-state.ts:203/207/214) are reused — no second HMAC scheme.
- **INV-6 (no cwd comparison):** `cwd` remains advisory-only (N6, bg-state.ts:25); the project root for `projectRootSha256` is `resolveProjectRoot(cwd)` (a real resolved absolute path), not `cwd` string equality.

### Resolution / flow

```text
/agents bg [agent] [task]   (no --backend)
        │
        ▼  (index.ts handleBgCommand, parse at L685)
parseBgArgs → state A (no --backend, no --profile)
        │
        ▼  (fallback branch, ~L713)
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
| `agents/lib/bg-args.ts` | L9 `parseBgArgs`; L12/L20/L30 first-token `--backend`/`--profile` | `parseBgArgs` first-token flags. | No edit needed for REQ-8; the "no `--backend`" branch (State A) is where `resolveDefaultBackend` is called by the caller. The flag's absence is the trigger. |
| `agents/lib/bg-terminal.ts` | L157 `getBgTerminalBackendByName`; L175 `selectBgTerminalBackend` | Backend registry lookup + preference probe. | `resolveDefaultBackend` calls these; no edit. |
| `agents/index.ts` | L685 `parseBgArgs(args)`; L695 explicit `getBgTerminalBackendByName(parse.backendName)`; L713 `selectBgTerminalBackend()` fallback | `handleBgCommand`: parse (L685), explicit-`--backend` branch (L695), preference-probe fallback (L713). The explicit branch already wins (INV-4). | Insert `resolveDefaultBackend(ctx.cwd)` in the flag-absent branch between L685 and L713 (REQ-8). **Focused review before build** — argv/dispatch hot path. |
| `agents/lib/bg-preflight.ts` | L86 `cwd: ctx.cwd`; ~L100 `projectTrusted` set | Manifest construction; `projectTrusted: boolean` is written here today. | REQ-9: source `projectTrusted` from `readProjectTrustStore(ctx.cwd)` — `true` on `{ok:true}`, `false` otherwise. No new field; existing `boolean` shape. |
| `agents/lib/bg-state.ts` | L51-55 `projectTrusted: boolean` field; L25 `assertManifestIdentityMatchesRuntime`; L134 `getBgStateDir`; L138 `getBgSessionMacPath`; L167 `readOrCreateSessionMacKey`; L199 `assertNoSymlink`; L203 `signBgPayload`; L207 `verifyBgPayloadMac`; L214 `keyGenIdFromKey`; L619 `assertNoSymlink` def | P4R root + MAC primitives. Global session MAC at `~/.pi/agent/bg/.session.mac` (NOT `~/.episodic-memory/.session.mac`). | Read-only reuse. No edits in scope (the global homeDir root stays global; project root is additive). |
| `agents/lib/bg-worker.ts` | L123 homeDir check (N1); L202/L225 `projectTrusted` consumed as boolean; L213 `readProjectRegistry(cwd, …)` | Worker reads the `projectTrusted` snapshot. | No edit in scope — P4R-PROJ (out of scope) will add worker enforcement + snapshot enrichment. |
| `agents/lib/bg-trust.ts` (CREATED, `resolveProjectRoot` exported fn) | — | Resolves the canonical project root for `projectRootSha256`. | New, not a reuse. Rule resolved as OD-1: nearest ancestor of `fs.realpathSync(dir)` containing `.pi/` OR `.git/`, whichever is nearer; throw otherwise. |

## Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P5F-1` | Pure extraction: project MAC key + read primitives (no writers, no wiring). Zero behavior change. | `agents/lib/bg-trust.ts` (new), `agents/test/test-bg-trust.mjs` (new), `agents/test/run-bg-trust-tests.sh` (new) | `resolveProjectRoot`, `projectRootSha256`, `sha256Hex`, `readOrCreateProjectTrustKey`, `readProjectTrustStore` (REQ-1/2/3/4/7/10/11). | 13 unit tests (Group 1 = 11 incl. C/D/E + mac-ordering + malformed-key guard from R1; Group 2 = 2). | No production caller; existing suite green. |
| `P5F-2` | Writer + default-backend resolver. | `agents/lib/bg-trust.ts` (APPEND writer + resolver), `agents/test/test-bg-trust.mjs` (APPEND tests) | `writeProjectTrustStore` (REQ-6), `resolveDefaultBackend` (REQ-5/8). | 7 unit tests (Group 3 = 4 incl. atomic-failure; Group 4 = 3). | Writer invoked only by tests; no command path yet. |
| `P5F-3` | `/agents bg` read-side wiring + preflight snapshot source. | `agents/index.ts` (EDIT), `agents/lib/bg-preflight.ts` (EDIT), `agents/test/test-bg-preflight.mjs` (APPEND) | REQ-8 (default backend consulted), REQ-9 (`projectTrusted` sourced from disk). | 4 unit tests (Group 5) + 1 smoke (UNGUARDED-IN-CI). | Explicit `--backend` still wins (regression guard). |

### Dependency graph

```text
P5F-1 (pure extraction, no callers) ── P5F-2 (writer + resolver) ── P5F-3 (wiring)
```

Serial: P5F-2 imports P5F-1's reader; P5F-3 imports P5F-2's resolver. Each slice leaves the build green on its own.

## Cut Order

If context/scope grows, cut in this order:

1. **REQ-9 (preflight `projectTrusted` boolean source) to P4R-PROJ, not P5F.** Ship the disk reader + default-backend wiring (REQ-1–8) first; P4R-PROJ can consume `readProjectTrustStore` + own the manifest snapshot enrichment.

Do not cut:

- **REQ-3 (fail-closed on forged/tampered MAC).** This is the entire security premise; cutting it makes the feature net-negative.
- **REQ-7 (per-project key isolation).** Sharing the global key enables cross-project forgery (Safety matrix).
- **REQ-8 negative control (`testBgCommand_explicitBackendOverridesDefault_discriminating`).** Without it, a regression where the default silently wins over `--backend` is invisible.

## Contracts

### `readProjectTrustStore(projectDir: string): Promise<ProjectTrustReadResult>`

**Input contract:** `projectDir` is an absolute path (caller resolves via `path.resolve`). Relative paths are rejected with `TypeError`.

**Output contract:** discriminated union `ProjectTrustReadResult`; never throws for trust-content failures (absent/forged/malformed/symlink) — returns `{ ok:false, reason }`. Throws only for programmer errors (non-string input, non-absolute path) and for a symlinked **key** file (`assertNoSymlink` on `.trust.mac`, distinct from the trust-file symlink case).

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Absent | trust file does not exist | `{ ok:false, reason:"absent" }` |
| B. Symlink (trust file) | trust file is a symlink (lstat) | `{ ok:false, reason:"symlink" }` |
| C. Malformed | file exists, not a symlink, JSON parse fails | `{ ok:false, reason:"malformed" }` |
| D. Schema-invalid | parses but `schemaVersion !== 1` or required fields missing/wrong-type | `{ ok:false, reason:"malformed" }` |
| E. Key-absent | project MAC key file absent → cannot verify | `{ ok:false, reason:"forged" }` (treat as untrusted) |
| F. MAC malformed | `mac` does not match `/^[0-9a-f]{64}$/i` | `{ ok:false, reason:"malformed" }` |
| G. MAC mismatch | `verifyBgPayloadMac(store-minus-mac, projectKey, mac) === false` | `{ ok:false, reason:"forged" }` |
| H. Root mismatch | MAC ok but `projectRootSha256 !== sha256(resolveProjectRoot(projectDir))` | `{ ok:false, reason:"forged" }` |
| I. Valid | MAC ok + root matches + (SHOULD) MAC checked before root (REQ-10) | `{ ok:true, store }` |

**Error codes / throw surface:**

| Code/Surface | Where | Trigger |
|---|---|---|
| `reason:"symlink"` | trust file read (union value, NOT a throw) | `lstat` detects a symlink at the trust **file** path |
| `assertNoSymlink` throw | `.trust.mac` key read (`readOrCreateProjectTrustKey`) | `lstat` detects a symlink at the MAC **key** path (mirrors bg-state.ts:199 throw on the session key) |
| `TypeError` | input validation | `projectDir` is non-string or non-absolute |
| `Error("resolveProjectRoot: no .pi or .git ancestor for " + dir)` | `resolveProjectRoot` | neither `.pi/` nor `.git/` found walking up from `fs.realpathSync(dir)` |

### `resolveDefaultBackend(projectDir: string): Promise<string | null>`

**Input contract:** as above.

**Output contract:** `string` (a registered backend name) or `null` (caller falls back to `selectBgTerminalBackend()`).

| State | Condition | Output |
|---|---|---|
| A. Store valid + backend registered | `readProjectTrustStore` `ok:true` AND `getBgTerminalBackendByName(name)` defined | `name` |
| B. Store valid + backend NOT registered | ok store but name not in registry (e.g. backend uninstalled) | `null` |
| C. Store absent/forged/malformed (any) | `readProjectTrustStore` returns `{ ok:false, … }` | `null` |
| D. Explicit `--backend` at the caller | caller short-circuits before calling this | n/a — called only in the flag-absent branch |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | Trust file exists but `.pi/trust/.trust.mac` deleted by hand | `{ ok:false, reason:"forged" }` (State E) → null → preference probe | `testReadTrustStore_keyAbsentTreatedAsForged` |
| EC2 | Two projects, trust file copied A→B (A's `.trust.mac` injected into B so MAC passes) | Root mismatch (B's root ≠ A's hash) → `{ok:false, reason:"forged"}` (State H) — provably root-binding, not MAC failure | `testReadTrustStore_rejectsForeignProjectRoot_withSharedKeySentinel` |
| EC3 | Backend uninstalled after grant | Store valid but `getBgTerminalBackendByName` undefined → null → probe | `testResolveDefaultBackend_fallsBackWhenBackendUnregistered` |
| EC4 | `--backend cmux` passed AND default is `tmux` (both registered) | Explicit wins (INV-4) → cmux; discriminating fixture asserts the cmux launch path is used | `testBgCommand_explicitBackendOverridesDefault_discriminating` |
| EC5 | Trust file written, then `.trust.mac` rotated (new key) | `keyGenId` in store ≠ new key's `keyGenIdFromKey` → MAC verify fails → forged → null | `testReadTrustStore_rejectsAfterKeyRotation` |
| EC6 | Concurrent `writeProjectTrustStore` from two processes | Atomic temp+rename; loser's temp is orphaned (0600 tmpfile, no final-path corruption). Not a correctness risk for the *reader* (reads see either old-or-new, never torn). | `testWrite_atomicTempRename` + `testWrite_atomicFailureLeavesFinalUntouched` |
| EC7 | `projectDir` is inside a symlinked path (e.g. `/tmp/proj → /Users/.../proj`) | `resolveProjectRoot` uses `fs.realpathSync` before walking up so symlinked-into-the-same-project works; **cross-project** copy still fails (different real root). | (MAY — `testReadTrustStore_acceptsSymlinkedProjectDirInsideSameRoot`; not in MUST catalog) |
| EC8 | Corrupt JSON (truncated by kill mid-write) | JSON.parse throws → `{ ok:false, reason:"malformed" }` (State C) → null → probe | `testReadTrustStore_rejectsCorruptJson` |

## Test Case Catalog

```text
Group 1: readProjectTrustStore (10 tests)
  testReadTrustStore_parsesValidFile                          (State I)
  testReadTrustStore_returnsNullWhenAbsent                    (State A)
  testReadTrustStore_rejectsSymlink                           (State B, red-then-green)
  testReadTrustStore_rejectsCorruptJson                       (State C)
  testReadTrustStore_rejectsSchemaInvalid                     (State D)
  testReadTrustStore_keyAbsentTreatedAsForged                 (State E)
  testReadTrustStore_rejectsMalformedMac                      (State F)
  testReadTrustStore_rejectsTamperedMac                       (State G)
  testReadTrustStore_rejectsForeignProjectRoot_withSharedKeySentinel  (State H, discriminating)
  testReadTrustStore_macAndRootBothChecked                    (REQ-10, both-checks G+H; ordering = UNGUARDED-IN-CI grep)

Group 2: project MAC key (2 tests)
  testProjectTrustKey_isDistinctFromSessionMac
  testProjectTrustKey_symlinkGuard                           (red-then-green)

Group 3: writeProjectTrustStore (4 tests)
  testWriteThenRead_roundtrip
  testWrite_atomicTempRename
  testWrite_atomicFailureLeavesFinalUntouched
  testReadTrustStore_rejectsAfterKeyRotation                  (EC5)

Group 4: resolveDefaultBackend (3 tests)
  testResolveDefaultBackend_returnsTrustedName
  testResolveDefaultBackend_fallsBackWhenBackendUnregistered
  testResolveDefaultBackend_fallsBackWhenStoreForged

Group 5: /agents bg + preflight wiring (4 tests + 1 smoke)
  testBgCommand_usesDefaultBackendWhenAbsent
  testBgCommand_explicitBackendOverridesDefault_discriminating
  testPreflight_recordsProjectTrustSnapshot_whenPresent
  testPreflight_recordsNull_whenAbsentOrForged
  smoke: manual: /agents bg with a minted trust file → confirmed backend used   (UNGUARDED-IN-CI)

Group 6: invariants (2 static + 1 UNGUARDED-IN-CI manual)
  static: grep — no third-party imports in bg-trust.ts (REQ-11)
  static: grep — bg-trust.ts never imports resolveTrustedHome|readOrCreateSessionMacKey|getBgStateDir|getBgSessionMacPath (INV-2)
  manual: grep — verifyBgPayloadMac call line < projectRootSha256 compare line in bg-trust.ts (REQ-10 ordering, UNGUARDED-IN-CI)

Total: 24 unit tests + 2 static + 1 UNGUARDED-IN-CI manual grep (REQ-10) + 1 UNGUARDED-IN-CI smoke.  (P5F-1 shipped 13, not 12 — the R1 fix added `testReadTrustStore_rejectsMalformedKey`; 13 + P5F-2's 7 + P5F-3's 4 = 24.)
```

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Read path slows `/agents bg` launch (disk read on every launch) | Medium | Trust file is small (<1KB); `fs.realpathSync` + one read + one HMAC. Cache not needed for v0.1; if profiling shows cost, cache keyed by `(projectRootSha256, mtime)`. |
| `resolveProjectRoot` diverges from what the user considers "the project" (monorepo workspace dirs) | Medium | Rule resolved in OD-1 (nearest ancestor of `fs.realpathSync(dir)` containing `.pi/` OR `.git/`). Documented as a known limit; MAY add `--trust-root` override later. |
| Trust file committed to git by a confused user | Low | `.pi/` is the pi-agent state dir convention; advise `gitignore` of `.pi/trust/`. The MAC key (`.trust.mac`) MUST never be committed — single-line `.gitignore` add. |
| Two backends both claim the same `name` | Low | `registerBgTerminalBackend` dedup is P4-4's concern; `resolveDefaultBackend` trusts whatever `getBgTerminalBackendByName` returns. Out of scope. |
| P4R-PROJ worker enforcement built on this reader diverges from P5-NL-bg snapshot semantics | Low | REQ-9 sources only the existing `projectTrusted: boolean` — no shape change today. P4R-PROJ owns the snapshot enrichment (`projectRootSha256`/`keyGenId`), decoupled from this reader's contract. |

## Open Decisions

- **OD-1: `resolveProjectRoot` rule — RESOLVED.** Rule: nearest ancestor of `fs.realpathSync(projectDir)` containing `.pi/` OR `.git/` (whichever is encountered first walking upward). Throw `Error("resolveProjectRoot: no .pi or .git ancestor for " + dir)` if neither is found up to the filesystem root. Documented in the function's JSDoc. No longer deferred to a slice.
- **OD-2: Trust-grant UX.** Out of scope (Non-Goal 1). Decision deferred to a follow-up plan `P5F-GRANT` once this reader lands.
- **OD-3: Whether to also write a `.gitignore` entry for `.pi/trust/` automatically.** Defer — writer can `console.warn` if `.pi/trust/` is inside a git repo and not gitignored; auto-editing `.gitignore` is a side effect beyond "reader+writer primitives".

## Done Criteria

- [ ] All MUST requirements (REQ-1–9, REQ-11) passing = done for P5F-1+P5F-2+P5F-3.
- [ ] REQ-10 (SHOULD) `testReadTrustStore_macAndRootBothChecked` passing (both-checks) + ordering `UNGUARDED-IN-CI` manual grep verified.
- [ ] Existing P4R / P5 / P5E1 / P5-NL-bg suite still green (the new reader is additive; the only production edits are index.ts L713 preference-probe insertion site and bg-preflight.ts snapshot source).
- [ ] `grep -n "resolveTrustedHome\|readOrCreateSessionMacKey\|getBgStateDir\|getBgSessionMacPath" agents/lib/bg-trust.ts` returns **nothing** (INV-2: project reader never touches the global substrate).

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | codex (cmux surface:48) | gpt-5.5 high | 6 | `changes-requested` — see `agents/docs/P5F_REVIEW.md`; all 6 addressed in revision 1 (see Resolved blockers below) |
| 2 | codex (cmux surface:49) | gpt-5.5 high | 5 new-surface | `changes-requested` — Pass-1 blockers 1–5 + audit RESOLVED; verifier-only defects in the verbatim Appendix B source (private-helper imports, missing `await`, State-E create-during-read, key-symlink throw not propagated, test import/async) addressed in revision 2 |
| 3 | codex (cmux surface:49) | gpt-5.5 high | 1 (excerpt-completeness) | `changes-requested` — all 5 Pass-2 defects RESOLVED; only remaining: test block was an excerpt, not full verbatim 12-test source as the (false) header claimed. Revision 3 re-scopes step 1.2 to high-capability-executor scope (PLAN_TEMPLATE-sanctioned) with an explicit 8-test contract table, dropping the false "Full verbatim" claim |
| 4 | codex (cmux surface:49) | gpt-5.5 high | 2 (Q3 REQ-10 contradiction + Q4 residual comments) | `changes-requested` — re-scope Q1+Q2 RESOLVED; Q3 NOT-RESOLVED (contract row for macCheckedBeforeRootCompare "punts ordering to manual grep" contradicted REQ-10's "automated mock-injection" claim); Q4 NOT-RESOLVED (residual "6 follow skeleton"/"8 more tests" comments inside the verbatim block). Revision 4 makes REQ-10 honest+consistent: renamed `macCheckedBeforeRootCompare` → `macAndRootBothChecked` (automated both-checks G+H); ORDERING → `UNGUARDED-IN-CI` manual grep consistently across REQ-10 row / Safety / catalog / contract table / Done Criteria / Group 6 (REQ-11 forbids mock deps, so no mock framework); residual verbatim-block comments fixed. |
| 5 | codex (cmux surface:49) | gpt-5.5 high | 0 | **`approve`** — CONSENSUS. All 4 audit questions RESOLVED. Plan ACCEPTED for slicing P5F-1 by a high-capability executor. |

### Resolved blockers (Pass 1 → revision 1)

| # | Pass-1 blocker | Resolution in revision 1 |
|---|---|---|
| 1 | REQ-9 claimed to fill `projectTrusted` with `projectRootSha256` + `keyGenId`, but code shows `projectTrusted?: boolean` (bg-state.ts:55) | REQ-9 rewritten: source only the existing `boolean` (`true` on `{ok:true}`, `false` otherwise). Snapshot enrichment (`projectRootSha256`/`keyGenId`) explicitly deferred to P4R-PROJ (Non-Goal 2). |
| 2 | REQ-4/EC2 foreign-root fixture not discriminating (MAC fails before root compare) | Fixture rewritten: inject A's `.trust.mac` into B so MAC passes, assert A/B roots differ first, then assert cross-read returns `{ok:false, reason:"forged"}`. Test renamed `...withSharedKeySentinel`. |
| 3 | REQ-1/2/3 contract inconsistent (return type + throw semantics) | Picked the union `ProjectTrustReadResult` everywhere. REQ-1 returns the union; REQ-2 trust-file symlink → `{ok:false, reason:"symlink"}` (NOT a throw); only the `.trust.mac` KEY symlink throws via `assertNoSymlink` (now explicit in Contract error-codes table). |
| 4 | INV-2 cited wrong global MAC path (`~/.episodic-memory/.session.mac`) | Corrected: actual global path is `~/.pi/agent/bg/.session.mac` (bg-state.ts:134/138). INV-2, REQ-7, Non-Goal 3, hook-points table all updated. INV-2 grep guard now also blocks `getBgStateDir`/`getBgSessionMacPath` imports. |
| 5 | 9-state read table not fully tested (C/D/E missing from catalog) | Group 1 expanded from 6 → 10 tests: added `rejectsCorruptJson` (C), `rejectsSchemaInvalid` (D), `keyAbsentTreatedAsForged` (E), `macAndRootBothChecked` (REQ-10 both-checks; ordering UNGUARDED-IN-CI grep), `rejectsForeignProjectRoot_withSharedKeySentinel` (renamed, H). |
| 6 | Appendix B P5F-1 not executor-ready (prose "Full source", "Decide resolveProjectRoot rule", wrong import path) | OD-1 resolved in-plan (no "Decide"). Step 1.1 now provides verbatim `bg-trust.ts` source. Step 1.3 test import path fixed to `../lib/bg-state.ts`. (P5F-2/P5F-3 step tables still deferred by design — noted as a deferred gate, not a blocker.) |
| (audit) | Hook table cited `index.ts L685–691` for the bg handler; real `selectBgTerminalBackend` call is L713 | Hook table corrected: L685 `parseBgArgs`, L695 explicit `getBgTerminalBackendByName`, L713 `selectBgTerminalBackend` fallback. Done Criteria + Files-to-modify + Implementation sequence line refs updated. |

### Resolved blockers (Pass 2 → revision 2)

| # | Pass-2 new-surface defect | Resolution in revision 2 |
|---|---|---|
| 2.1 | Verbatim `bg-trust.ts` imported PRIVATE `assertNoSymlink`/`readUtf8FileNoSymlink` (bg-state.ts:619, L742 — not exported) | Inlined local equivalents `assertNoSymlinkLocal` + `readUtf8FileNoSymlinkLocal` in `bg-trust.ts` (mirrors of the private originals). Import block now imports ONLY exported `signBgPayload`/`verifyBgPayloadMac`/`keyGenIdFromKey`. Req-11 + INV-2 grep guards unchanged (still pass — the new helpers are local, not imported). |
| 2.2 | Missing `await` on `readUtf8FileNoSymlink` (async) → States D–I bypassed (raw was a Promise) | Added `await` in `readProjectTrustStore`: `const raw = await readUtf8FileNoSymlinkLocal(...)`. States C–I now execute correctly. |
| 2.3 | `readProjectTrustStore` called `readOrCreateProjectTrustKey` → absent key was CREATED (State E wrong side-effect; contradicts EC1 "forged") | Added read-only `readProjectTrustKey` (does NOT create). `readProjectTrustStore` now calls `readProjectTrustKey`; `readOrCreateProjectTrustKey` is reserved for the P5F-2 writer and delegates to `readProjectTrustKey`. State E: ENOENT → `{ok:false, reason:"forged"}`. |
| 2.4 | Key-symlink throw contract not implemented (reader caught all key errors → `forged`, contradicting the Contract error-codes table that says `.trust.mac` symlink THROWS) | `readProjectTrustStore` now catches ONLY `ENOENT` (→ `forged`); all other errors (including the symlink throw from `assertNoSymlinkLocal`) propagate. Key-symlink throw is now honored. |
| 2.5 | Test excerpt: missing `mkdirSync`/`readFileSync` imports; `mintStore` called async `readOrCreateProjectTrustKey` without `await` | Imports fixed (`mkdirSync`, `readFileSync` added). `mintStore` is now `async` + `await readOrCreateProjectTrustKey(...)`; all 3 call sites now `await mintStore(...)`. |

## Appendix: Implementation Plan

### Files to create

1. `agents/lib/bg-trust.ts` — trust store types, project MAC key, reader, writer, resolver (REQ-1–11). P5F-1 creates primitives; P5F-2 APPENDs writer + resolver.
2. `agents/test/test-bg-trust.mjs` — Groups 1–4 (20 unit tests + 2 static)  (P5F-1's 13 + P5F-2's 7 = 20).
3. `agents/test/run-bg-trust-tests.sh` — slice test runner (mirrors `tmux-control/test-fixtures/run-control-tests.sh` pattern).

### Files to modify

| File | Change |
|---|---|
| `agents/index.ts` (L713 region, `handleBgCommand` no-`--backend` branch) | Call `resolveDefaultBackend(ctx.cwd)` before `selectBgTerminalBackend()` (L713); use the resolved name via `getBgTerminalBackendByName` if non-null. Explicit `--backend` path (L695) unchanged. |
| `agents/lib/bg-preflight.ts` (manifest construction, ~L86–L102) | Source `projectTrusted` (existing `boolean` field, bg-state.ts:55) from `readProjectTrustStore(ctx.cwd)`: `true` on `{ok:true}`, `false` otherwise. No new field. |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 (P5F-1) | Implement `resolveProjectRoot` (rule resolved in OD-1) + `sha256Hex` + `projectRootSha256` + `readOrCreateProjectTrustKey` + `readProjectTrustStore` + 13 Group-1/2 tests (incl. C/D/E + mac-ordering + malformed-key guard from R1). | `bash agents/test/run-bg-trust-tests.sh` → 13 green; existing suite green; `grep -n "resolveTrustedHome\|readOrCreateSessionMacKey\|getBgStateDir\|getBgSessionMacPath" agents/lib/bg-trust.ts` empty. |
| 2 (P5F-2) | APPEND `writeProjectTrustStore` + `resolveDefaultBackend` + the atomic-write helper + 7 Group-3/4 tests (incl. EC5 rotation + atomic-failure). | Slice runner → **20 green** (P5F-1 shipped 13, not 12 — the R1 fix added `testReadTrustStore_rejectsMalformedKey`). |
| 3 (P5F-3) | EDIT `index.ts` (default-backend consultation, L713 region) + EDIT `bg-preflight.ts` (boolean source) + 4 Group-5 tests + approve the `UNGUARDED-IN-CI` smoke. | Full `agents` test suite green; explicit-overrides-default discriminating regression green. |

### Risks (impl)

| Risk | Mitigation |
|---|---|
| `index.ts` edit is on the `/agents bg` dispatch hot path | P5F-3 marked **focused review before build**; the edit is a single `resolveDefaultBackend` call + conditional, smallest-diff anchored on the current `selectBgTerminalBackend()` call at L713. |
| `bg-preflight.ts` boolean threading may interact with P5-NL-bg intent-gate | P5F-3 only *sources* the existing `projectTrusted: boolean` field; no new field, no shape change. P5-NL-bg tests are the regression guard — if any turn red, the field shape drifted (planning bug, not a code bug). |

## Appendix B: Mechanical Execution Spec (for a low-capability executor)

**Executor contract** — copy verbatim into the plan.

1. Do the steps **in numeric order**. Do not skip, reorder, or batch.
2. Each step names exactly one file, what to add/change, and how to verify.
3. **Make no design decisions.** If a step is ambiguous or an anchor isn't found verbatim, **STOP and ask**.
4. Run the verify command after each step. If it fails, fix only that step; do not proceed until green.
5. Slice test command: `bash agents/test/run-bg-trust-tests.sh` (P5F-1, P5F-2) / `bash agents/test/run-bg-preflight-tests.sh` (P5F-3).
6. **Edit exactly ONE file per step.** Read-only references (look but never edit): `agents/lib/bg-state.ts`, `agents/lib/bg-terminal.ts`, `agents/lib/bg-worker.ts`, `agents/lib/bg-args.ts`, `agents/index.ts` (P5F-1/2 only; P5F-3 edits it).
7. **Surgical edits only.** CREATE (whole-file, new file), EDIT (anchored `ANCHOR → REPLACE`, smallest diff), or APPEND (add at end of a file you created earlier in this slice). No `Write`-overwrite of an existing file.
8. One slice = one commit, message `P5F-<n>: <title>`, with the required `Co-Authored-By` trailer. Each slice leaves the build green on its own.
9. **No aspirational output.** Every `echo`/`log`/comment that *describes* a check MUST be backed by a real assertion whose operands include captured stdout/exit/written-file/imported-return.

**Executor-ready gate:** every step's `File` column names exactly one file; every EDIT step quotes a verbatim `ANCHOR` and exact `REPLACE`; whole-file `Write` only for new-file CREATE steps; no step text contains "decide"/"choose"/"figure out"/"as appropriate"/"if needed"/"etc."/"e.g."/as-intent-"assert that"/"verify that"; every constant, error string, regex, and signature appears verbatim below.

**Scope clause (P5F-1 step 1.2 — high-capability executor):** the test file targets a **high-capability executor** (the orchestrator's default pi model — e.g. `minimax/MiniMax-M3` per the `cmux-orchestrator` skill — NOT a low-capability sub-agent). Per the `PLAN_TEMPLATE`, Appendix B's executor-ready gate may be scoped to high-capability-only when the plan will not be implemented by a low-capability model. P5F-1 step 1.2 therefore provides 4 load-bearing verbatim test bodies + an explicit 8-test contract (name, asserted read-state, red-then-green/discriminating flag) for the remaining tests; it is NOT a full 12-test verbatim file. P5F-1 step 1.1 (`bg-trust.ts` source) IS full verbatim and IS executor-ready for a low-capability model. **P5F-2 step-tables are now authored** in the `### P5F-2` section below (post-P5F-1-merge); P5F-3 step tables remain deferred by design (noted at the end of step 1.3).

### Shared constants / types (add once)

```ts
// lib/bg-trust.ts — exact values
export const PROJECT_TRUST_SCHEMA_VERSION = 1;
export const PROJECT_TRUST_DIR = ".pi/trust";
export const PROJECT_TRUST_FILE = "default-backend.json";
export const PROJECT_TRUST_MAC_FILE = ".trust.mac";
export const PROJECT_TRUST_MAC_BYTES = 32;
const MAC_HEX_RE = /^[0-9a-f]{64}$/i;
const RESOLVE_ROOT_ERR = "resolveProjectRoot: no .pi or .git ancestor for ";
```

### `P5F-1` — read primitives (REQ-1/2/3/4/7/10/11)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 1.1 | `agents/lib/bg-trust.ts` | **CREATE** (whole-file Write). Full verbatim source: see `### P5F-1 step 1.1 — verbatim bg-trust.ts source` block below. | `node -e "import('./agents/lib/bg-trust.ts').then(m=>console.log(Object.keys(m).join(',')))"` prints a list containing `readProjectTrustStore,readOrCreateProjectTrustKey,resolveProjectRoot,projectRootSha256` AND `grep -nE "resolveTrustedHome\|readOrCreateSessionMacKey\|getBgStateDir\|getBgSessionMacPath" agents/lib/bg-trust.ts` returns **empty** (INV-2). |
| 1.2 | `agents/test/test-bg-trust.mjs` | **CREATE** (whole-file Write). Test source: 4 load-bearing verbatim tests + 8 named-test contracts. P5F-1 step 1.2 targets a **high-capability executor** per the Appendix B scope clause (NOT the low-capability executor-ready gate). Imports `readOrCreateProjectTrustKey`, `readProjectTrustStore`, `projectRootSha256`, `resolveProjectRoot` from `../lib/bg-trust.ts`; imports `signBgPayload`, `readOrCreateSessionMacKey` from `../lib/bg-state.ts` (the correct relative path from `agents/test/` to `agents/lib/`). | `node agents/test/test-bg-trust.mjs` → prints `12/12 passing` AND `BREAK=1 node agents/test/test-bg-trust.mjs` exits non-zero (proves negative controls reach real assertions: when `BREAK=1` the foreign-root test uses identical roots, so the `assert.notStrictEqual` fails → non-zero exit). |
| 1.3 | `agents/test/run-bg-trust-tests.sh` | **CREATE** (whole-file Write). Verbatim contents: `#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")/../.."\nnode agents/test/test-bg-trust.mjs\n` (executable bit: `chmod +x` after create). | `bash agents/test/run-bg-trust-tests.sh; echo "EXIT=$?"` → `EXIT=0`. |

**(P5F-1 commits here. P5F-1 review COMPLETE — PR #145 merged (`08a9be6`); reader held up under 13 tests incl. the R1 fix `testReadTrustStore_rejectsMalformedKey`. P5F-2 step-tables are now authored in the `### P5F-2` section below, anchored against the shipped `bg-trust.ts` (no P5F-1 edits beyond additive imports + append). P5F-3 step-tables remain deferred — authored after P5F-2 review.)**

### P5F-1 step 1.1 — verbatim `bg-trust.ts` source

```ts
// agents/lib/bg-trust.ts
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
// NOTE: assertNoSymlink + readUtf8FileNoSymlink are PRIVATE in bg-state.ts (L619, L742) and
// NOT exported. bg-trust.ts inlines local equivalents (assertNoSymlinkLocal / readUtf8FileNoSymlinkLocal)
// below — INV-2 forbids importing the private helpers. Only the EXPORTED signing primitives
// (signBgPayload/verifyBgPayloadMac/keyGenIdFromKey, bg-state.ts:203/207/214) are imported.
import { signBgPayload, verifyBgPayloadMac, keyGenIdFromKey } from "./bg-state.ts";

export const PROJECT_TRUST_SCHEMA_VERSION = 1;
export const PROJECT_TRUST_DIR = ".pi/trust";
export const PROJECT_TRUST_FILE = "default-backend.json";
export const PROJECT_TRUST_MAC_FILE = ".trust.mac";
export const PROJECT_TRUST_MAC_BYTES = 32;

const MAC_HEX_RE = /^[0-9a-f]{64}$/i;
const RESOLVE_ROOT_ERR = "resolveProjectRoot: no .pi or .git ancestor for ";

export type ProjectTrustStore = {
  schemaVersion: 1;
  projectRootSha256: string;
  defaultBackend: string;
  grantedAtMs: number;
  keyGenId: string;
  mac: string;
};

export type ProjectTrustReadResult =
  | { ok: true; store: ProjectTrustStore }
  | { ok: false; reason: "absent" | "forged" | "malformed" | "symlink" };

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function resolveProjectRoot(dir: string): string {
  // OD-1 resolved: nearest ancestor of fs.realpathSync(dir) containing .pi/ OR .git/ (whichever first walking up).
  let current = realpathSync(dir);
  while (true) {
    if (existsSync(path.join(current, ".pi"))) return current;
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(RESOLVE_ROOT_ERR + dir);
    current = parent;
  }
}

export function projectRootSha256(projectDir: string): string {
  return sha256Hex(resolveProjectRoot(projectDir));
}

function trustFilePath(projectDir: string): string {
  return path.join(projectDir, PROJECT_TRUST_DIR, PROJECT_TRUST_FILE);
}

function projectTrustMacPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_TRUST_DIR, PROJECT_TRUST_MAC_FILE);
}

function ensureProjectTrustDir(projectDir: string): string {
  const dir = path.join(projectDir, PROJECT_TRUST_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Local no-follow helpers — mirrors of the PRIVATE assertNoSymlink (bg-state.ts:619-625)
// and readUtf8FileNoSymlink (bg-state.ts:742-754). Inlined here because the originals
// are module-private in bg-state.ts (NOT exported) and INV-2 forbids importing private
// state. assertNoSymlinkLocal throws on symlink, no-ops on ENOENT. readUtf8FileNoSymlinkLocal
// opens with O_NOFOLLOW and optionally enforces 0o077 perms (requirePrivate).
async function assertNoSymlinkLocal(targetPath: string, label: string): Promise<void> {
  try {
    const s = await lstat(targetPath);
    if (s.isSymbolicLink()) throw new Error(`refusing symlinked ${label}: ${targetPath}`);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

async function readUtf8FileNoSymlinkLocal(
  filePath: string,
  label: string,
  options: { requirePrivate?: boolean } = {},
): Promise<string> {
  const handle = await open(filePath, constants.O_NOFOLLOW | constants.O_RDONLY);
  try {
    const s = await handle.stat();
    if (!s.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
    if (options.requirePrivate && (s.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be readable by group or others: ${filePath}`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

// READ-ONLY key read — used by readProjectTrustStore. Does NOT create (State E: absent
// key → ENOENT → caller maps to "forged"). Symlinked key → throws (propagates per the
// Contract error-codes table; distinct from the trust-file symlink → union value).
export async function readProjectTrustKey(projectDir: string): Promise<Buffer> {
  const keyPath = projectTrustMacPath(projectDir);
  await assertNoSymlinkLocal(keyPath, "project trust MAC key");
  const text = await readUtf8FileNoSymlinkLocal(keyPath, "project trust MAC key", { requirePrivate: true });
  return parseTrustMac(text, keyPath);
}

// readOrCreateProjectTrustKey is the WRITER-side (P5F-2 writeProjectTrustStore). Mirrors
// readOrCreateSessionMacKey (bg-state.ts:167-189) but delegates the READ path to
// readProjectTrustKey above; on ENOENT it mints a new key (0600, flag wx). Declared here
// for type-completeness — the READER never calls it.
export async function readOrCreateProjectTrustKey(
  projectDir: string,
  randomBytes: (size: number) => Buffer = cryptoRandomBytes,
): Promise<Buffer> {
  ensureProjectTrustDir(projectDir);
  try {
    return await readProjectTrustKey(projectDir);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const key = randomBytes(PROJECT_TRUST_MAC_BYTES);
  const text = `${key.toString("hex")}\n`;
  try {
    writeFileSync(projectTrustMacPath(projectDir), text, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return await readProjectTrustKey(projectDir);
    throw error;
  }
}

function parseTrustMac(text: string, keyPath: string): Buffer {
  const hex = text.trim();
  if (hex.length !== PROJECT_TRUST_MAC_BYTES * 2 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`project trust MAC key at ${keyPath} is malformed (expected ${PROJECT_TRUST_MAC_BYTES * 2} hex chars)`);
  }
  return Buffer.from(hex, "hex");
}

export async function readProjectTrustStore(projectDir: string): Promise<ProjectTrustReadResult> {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) {
    throw new TypeError("readProjectTrustStore: projectDir must be an absolute path");
  }
  const filePath = trustFilePath(projectDir);
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { ok: false, reason: "absent" };
    throw error;
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: "symlink" };
  let parsed: unknown;
  try {
    const raw = await readUtf8FileNoSymlinkLocal(filePath, "project trust store");
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isValidTrustStoreShape(parsed)) return { ok: false, reason: "malformed" };
  const store = parsed as ProjectTrustStore;
  // REQ-10: MAC verified BEFORE root compare (timing-oracle mitigation).
  if (!MAC_HEX_RE.test(store.mac)) return { ok: false, reason: "malformed" };
  let projectKey: Buffer;
  try {
    // READ-ONLY key read (does NOT create — State E: absent key → ENOENT → "forged").
    // A symlinked key THROWS via assertNoSymlinkLocal (propagates; NOT caught here) per
    // the Contract error-codes table (distinct from trust-file symlink → union).
    projectKey = await readProjectTrustKey(projectDir);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { ok: false, reason: "forged" };
    throw error;
  }
  const { mac, ...storeWithoutMac } = store;
  if (!verifyBgPayloadMac(storeWithoutMac, projectKey, mac)) {
    return { ok: false, reason: "forged" };
  }
  if (store.projectRootSha256 !== projectRootSha256(projectDir)) {
    return { ok: false, reason: "forged" };
  }
  return { ok: true, store };
}

function isValidTrustStoreShape(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.schemaVersion === PROJECT_TRUST_SCHEMA_VERSION &&
    typeof o.projectRootSha256 === "string" &&
    typeof o.defaultBackend === "string" &&
    typeof o.grantedAtMs === "number" &&
    typeof o.keyGenId === "string" &&
    typeof o.mac === "string"
  );
}
```

### P5F-1 step 1.2 — `test-bg-trust.mjs` source (4 verbatim load-bearing tests + 8 named-test contracts; high-capability executor scope — see Appendix B scope clause)

> Per the Appendix B scope clause, P5F-1 step 1.2 targets a **high-capability executor** (default pi model, not a low-capability sub-agent). Four load-bearing test bodies are given verbatim below; the eight remaining tests are specified by contract (name, asserted read-state, red-then-green/discriminating flag) in the table at the end of this block. The executor creates ONE file with all 12 tests registered, authoring the 8 contracted tests to match their named state + flag exactly.

```js
// agents/test/test-bg-trust.mjs
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";
import { readOrCreateProjectTrustKey, readProjectTrustStore, projectRootSha256 } from "../lib/bg-trust.ts";
import { signBgPayload, readOrCreateSessionMacKey } from "../lib/bg-state.ts";

let passed = 0, failed = 0;
function test(name, fn) { Promise.resolve(fn()).then(() => { passed++; console.log("ok " + name); }, (e) => { failed++; console.log("not ok " + name + ": " + (e?.message || e)); }); }
function tmpProject() { const d = mkdtempSync(path.join(tmpdir(), "p5f-")); writeFileSync(path.join(d, ".git"), "", { mode: 0o644 }); return d; }
async function mintStore(projectDir, defaultBackend) {
  // mintStore must be async + await readOrCreateProjectTrustKey (it is async — bg-state.ts:167 pattern mirrored).
  const key = await readOrCreateProjectTrustKey(projectDir);
  const storeWithoutMac = {
    schemaVersion: 1,
    projectRootSha256: projectRootSha256(projectDir),
    defaultBackend,
    grantedAtMs: Date.now(),
    keyGenId: "UNUSED_IN_FIXTURE", // placeholder; real keyGenId is derived but tests sign directly
  };
  const mac = signBgPayload(storeWithoutMac, key);
  return { ...storeWithoutMac, mac };
}
function writeStore(projectDir, store) {
  const dir = path.join(projectDir, ".pi/trust"); if (!existsSync(dir)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  writeFileSync(path.join(dir, "default-backend.json"), JSON.stringify(store), { mode: 0o600 });
}

// --- Group 1 (10 tests; 3 verbatim shown below + 7 contracted per the 8-test contract table at end of block) ---

test("testReadTrustStore_parsesValidFile", async () => {
  const d = tmpProject(); const s = await mintStore(d, "tmux"); writeStore(d, s);
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.ok && r.store.defaultBackend, "tmux");
});

test("testReadTrustStore_rejectsSymlink", async () => {
  const d = tmpProject(); const real = path.join(d, ".pi/trust/default-backend.json");
  writeStore(d, await mintStore(d, "tmux"));
  const link = real + ".lnk"; if (existsSync(link)) rmSync(link);
  symlinkSync(real, link); // NOTE: plan declares symlink→{ok:false,reason:"symlink"}; this proves RED-when-symlink.
  // Replace the trust file with a symlink to prove the guard catches it.
  rmSync(real); symlinkSync(path.join(d, ".pi/trust/default-backend.json.bak"), real);
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, false); if (!r.ok) assert.strictEqual(r.reason, "symlink");
  // GREEN control: replace with the real file and it returns ok:true (proves the failure was the symlink, not incidental).
  rmSync(real); writeStore(d, await mintStore(d, "tmux"));
  const r2 = await readProjectTrustStore(d);
  assert.strictEqual(r2.ok, true);
});

test("testReadTrustStore_rejectsForeignProjectRoot_withSharedKeySentinel", async () => {
  // DISCRIMINATING FIXTURE (Blocker-2 fix): inject A's key into B so MAC verifies, isolating root-binding.
  const A = tmpProject(); const B = tmpProject();
  // Assert sentinel: A and B have distinct projectRootSha256 before the cross-read.
  const rootA = projectRootSha256(A); const rootB = projectRootSha256(B);
  assert.notStrictEqual(rootA, rootB, "sentinel: A/B roots must differ or the fixture is non-discriminating");
  if (process.env.BREAK === "1") { assert.strictEqual(rootA, rootB, "BREAK mode forces identical roots to prove the test fails"); }
  // Mint store in A, then read under B (B has NO trust file). To isolate root-binding from MAC failure, copy A's key into B.
  const storeA = await mintStore(A, "tmux"); writeStore(A, storeA);
  const keyDirB = path.join(B, ".pi/trust"); if (!existsSync(keyDirB)) { mkdirSync(keyDirB, { recursive: true, mode: 0o700 }); }
  writeFileSync(path.join(keyDirB, ".trust.mac"), readFileSync(path.join(A, ".pi/trust/.trust.mac")), { mode: 0o600 });
  writeFileSync(path.join(keyDirB, "default-backend.json"), JSON.stringify(storeA), { mode: 0o600 });
  const r = await readProjectTrustStore(B);
  assert.strictEqual(r.ok, false); if (!r.ok) assert.strictEqual(r.reason, "forged"); // root mismatch → forged (State H), MAC passed
});

// ... 8 contracted tests (see the 8-test contract table at end of block for name + asserted state + flag):
//     returnsNullWhenAbsent / rejectsCorruptJson / rejectsSchemaInvalid / keyAbsentTreatedAsForged /
//     rejectsMalformedMac / rejectsTamperedMac / macAndRootBothChecked (Group 1, 7) +
//     testProjectTrustKey_symlinkGuard (Group 2, 1). testProjectTrustKey_isDistinctFromSessionMac above is verbatim.
// Each authored assert operates on captured {ok, reason} / captured hex / thrown error — no self-fulfilling prose.
// BREAK=1 forces the foreign-root fixture to non-discriminating (identical roots) → assert.notStrictEqual fails → non-zero exit.

// --- Group 2 (2 tests) ---

test("testProjectTrustKey_isDistinctFromSessionMac", async () => {
  const d = tmpProject();
  const projectKey = await readOrCreateProjectTrustKey(d);
  const sessionKey = await readOrCreateSessionMacKey();
  assert.notStrictEqual(projectKey.toString("hex"), sessionKey.toString("hex"));
});

// Run summary:
await new Promise((r) => setTimeout(r, 0));
process.on("exit", () => { console.log(`${passed}/${passed+failed} passing`); if (failed > 0 || process.env.BREAK === "1" && passed > 0) process.exit(1); });
```

> **8-test contract (the executor authors these to match name + state + flag exactly):**
>
> | Test name | Asserted state | Flag |
> |---|---|---|
> | `testReadTrustStore_returnsNullWhenAbsent` | A — no trust file → `{ok:false, reason:"absent"}` | — |
> | `testReadTrustStore_rejectsCorruptJson` | C — invalid JSON → `{ok:false, reason:"malformed"}` | — |
> | `testReadTrustStore_rejectsSchemaInvalid` | D — JSON parses but missing/wrong-type field → `{ok:false, reason:"malformed"}` | — |
> | `testReadTrustStore_keyAbsentTreatedAsForged` | E — trust file present, `.trust.mac` deleted → `{ok:false, reason:"forged"}` (NO key creation during read) | — |
> | `testReadTrustStore_rejectsMalformedMac` | F — `mac` not `/^[0-9a-f]{64}$/i` → `{ok:false, reason:"malformed"}` | — |
> | `testReadTrustStore_rejectsTamperedMac` | G — valid-hex MAC that fails `verifyBgPayloadMac` → `{ok:false, reason:"forged"}` | — |
> | `testReadTrustStore_macAndRootBothChecked` | G + H — wrong-MAC-valid-root → `{ok:false,reason:"forged"}` AND valid-MAC-wrong-root → `{ok:false,reason:"forged"}` (proves BOTH checks execute; ORDERING G-before-H is `UNGUARDED-IN-CI` via Group 6 manual grep — mechanically unverifiable in plain ESM without a mock library, which REQ-11 forbids) | — |
> | `testProjectTrustKey_symlinkGuard` | symlinked `.trust.mac` → `readProjectTrustKey` THROWS (propagates; red-then-green: a real key file does NOT throw) | red-then-green |
>
> Each authored `assert` operates on captured return values / file contents / thrown errors — never on constants the test itself wrote (the foreign-root `rootA !== rootB` assertion is the model: captured values from `projectRootSha256(A)`/`projectRootSha256(B)`). `BREAK=1` env forces the foreign-root fixture to non-discriminating (identical roots) so its `assert.notStrictEqual` fails → non-zero exit, proving the negative control reaches a real assertion. Every test name matches the Test Case Catalog exactly.

### Blast-radius patterns applied

- **Pure-extraction slice first (P5F-1):** the reader is extracted as its own slice with zero production callers. Existing P4R/P5/P5E1/P5-NL-bg suite stays green untouched — the trust module is imported only by tests until P5F-3.
- **Test-preserving seam (P5F-3):** `index.ts` gets one `resolveDefaultBackend` call in the flag-absent branch (L713 region) — existing `--backend <name>` tests bypass it (they take the L695 explicit-flag branch), so P5E1 tests pass unchanged.
- **Red-then-green guard (every security mitigation):** REQ-2/REQ-7 symlink guards, REQ-3 MAC-tamper guards, and REQ-4 foreign-root guard all include a negative control (the broken input must make the test fail) via `BREAK=1` env or an inline symlink — never a separately-committed broken fixture.
- **Discriminating fixture (REQ-4):** the foreign-root test asserts the actual `projectRootSha256` of two distinct temp projects are unequal *before* asserting the cross-read fails — proving the failure is the root-binding, not incidental MAC failure (the shared-key injection isolates the two).
- **Deterministic signal:** every test asserts on captured return values / file contents / exit codes — no LLM/network/non-determinism. The one `UNGUARDED-IN-CI` row (the `/agents bg` end-to-end smoke) is tagged with the manual step and is not on the MUST path.

### Definition of done (whole plan)

`bash agents/test/run-bg-trust-tests.sh` prints all 24 unit tests + 2 static passing; `grep -nE "resolveTrustedHome\|readOrCreateSessionMacKey\|getBgStateDir\|getBgSessionMacPath" agents/lib/bg-trust.ts` returns empty (INV-2 invariant grep); the existing `agents`/`tmux-control`/`tmux-terminal`/`agents`-preflight suites all green; and the `testBgCommand_explicitBackendOverridesDefault_discriminating` regression test green (P5E1 contract preserved).

---

## Appendix B (P5F-2): Writer + Default-Backend Resolver — mechanical execution spec

**Authored post-P5F-1-merge** (anchored against the shipped `agents/lib/bg-trust.ts` at commit `08a9be6`, NOT the pre-review verbatim block above). P5F-1 review confirmed the reader holds up under 13 tests; the writer/resolver signatures below compose with the shipped reader's exported + module-private primitives. **Additive only:** P5F-2 makes three targeted edits to `bg-trust.ts` (two import edits + one append) and appends tests to `test-bg-trust.mjs`. No P5F-1 body code is rewritten.

**Executor:** high-capability (orchestrator's default pi model, e.g. `minimax/MiniMax-M3` per the `cmux-orchestrator` skill). Step 2.1 source is full-verbatim, copy-pasteable; step 2.2 is a contract table (author tests to match name + asserted property + flag).

**Load-bearing KEY TYPES (already exported by P5F-1, reused unchanged):** `ProjectTrustStore`, `ProjectTrustReadResult`. **Load-bearing MODULE-PRIVATE primitives (in-scope, same file):** `trustFilePath`, `ensureProjectTrustDir`, `readProjectTrustKey`, `readOrCreateProjectTrustKey`, `projectRootSha256`, and the constants `PROJECT_TRUST_SCHEMA_VERSION`/`PROJECT_TRUST_DIR`/`PROJECT_TRUST_FILE`/`PROJECT_TRUST_MAC_BYTES`. **Load-bearing IMPORTED primitives:** `signBgPayload`, `keyGenIdFromKey` from `./bg-state.ts` (INV-5 — no second HMAC scheme; `verifyBgPayloadMac` not needed by the writer), and a NEW import `getBgTerminalBackendByName` from `./bg-terminal.ts` (REQ-5).

### REQ-11 EXTENSION (P5F-2)

REQ-11 was a P5F-1 invariant scoped to the **reader** (`node:crypto`, `node:fs`, `node:path`, `./bg-state.ts`). P5F-2 EXTENDS the allowed import set to include `./bg-terminal.ts` (the resolver's `getBgTerminalBackendByName`, REQ-5). The INV-2 grep (`resolveTrustedHome|readOrCreateSessionMacKey|getBgStateDir|getBgSessionMacPath`) still MUST return empty — `./bg-terminal.ts` does not export those (confirmed: it exports `registerBgTerminalBackend`, `getBgTerminalBackend`, `getBgTerminalBackendByName`, `selectBgTerminalBackend`, `__resetBgTerminalBackend`). The updated static grep for P5F-2 is:

```bash
grep -nE '^import .* from (node:|\./bg-state|\./bg-terminal)' agents/lib/bg-trust.ts
# EXPECTED: exactly node:crypto, node:fs, node:fs/promises, node:path, ./bg-state.ts, ./bg-terminal.ts — nothing third-party.
```

### Step 2.1 — APPEND writer + atomic-write helper + resolver to `agents/lib/bg-trust.ts`

Three edits to ONE file. Apply (a), (b), (c) in order.

**(a) EDIT — add `renameSync` to the `node:fs` import.**

`ANCHOR` (exact, verbatim, in `bg-trust.ts`):
```ts
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
```
`REPLACE` (same line, `renameSync` inserted in alphabetical position):
```ts
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
```

**(b) EDIT — add the `./bg-terminal.ts` import after the `./bg-state.ts` import.**

`ANCHOR` (exact, verbatim):
```ts
import { signBgPayload, verifyBgPayloadMac, keyGenIdFromKey } from "./bg-state.ts";
```
`REPLACE` (the anchor line + the new import line beneath it):
```ts
import { signBgPayload, verifyBgPayloadMac, keyGenIdFromKey } from "./bg-state.ts";
// P5F-2 (REQ-5/INV-3): resolveDefaultBackend consults the term-backend registry. INV-2
// still holds — bg-terminal.ts exports only the registry fns, never resolveTrustedHome /
// readOrCreateSessionMacKey / getBgStateDir / getBgSessionMacPath.
import { getBgTerminalBackendByName } from "./bg-terminal.ts";
```

**(c) APPEND — writer + atomic-write helper + resolver, appended after `isValidTrustStoreShape` (the last function in the shipped file).**

`ANCHOR` (exact, verbatim — the file's terminal function; the new source is appended immediately after its closing brace):
```ts
function isValidTrustStoreShape(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.schemaVersion === PROJECT_TRUST_SCHEMA_VERSION &&
    typeof o.projectRootSha256 === "string" &&
    typeof o.defaultBackend === "string" &&
    typeof o.grantedAtMs === "number" &&
    typeof o.keyGenId === "string" &&
    typeof o.mac === "string"
  );
}
```
`APPEND` (verbatim source — copy verbatim after the anchor's closing brace):
```ts

// ─── P5F-2: writer + default-backend resolver (REQ-5/6/8) ───────────────────
// Atomic write + the sole trust-store writer + the read-side default-backend
// resolver. All compose with the shipped P5F-1 reader primitives (same module).
// The writer IS the sole key-creator (readOrCreateProjectTrustKey mints on ENOENT);
// the reader never creates. INV-2/INV-3/INV-5 all hold — see REQ-11 EXTENSION above.

function tempTrustFilePath(projectDir: string): string {
  // Per-process, per-write unique temp-name suffix (6 random bytes hex). Collisions
  // between concurrent writers for the same project are negligible; on the off chance
  // of a collision, writeFileSync's {flag:"wx"} semantics are NOT used here (the temp
  // path includes randomness, so the orphaned-temp contract (REQ-6) tolerates any
  // leftover 0600 tmpfile — the reader never reads the temp, only the renamed final).
  const suffix = cryptoRandomBytes(6).toString("hex");
  return path.join(projectDir, PROJECT_TRUST_DIR, `${PROJECT_TRUST_FILE}.tmp.${suffix}`);
}

// REQ-6 atomic write: temp file (0600) → renameSync. On any failure (writeFileSync
// throws, renameSync throws, disk full, ENOSPC mid-write) the prior FINAL file is
// left unchanged because the final path is only ever mutated by the atomic rename.
// An orphaned 0600 temp file is acceptable per REQ-6 — the reader ignores temps
// (it reads trustFilePath, which never matches the `*.tmp.<hex>` suffix).
// Exported (testable directly) but not part of the public P5F surface outside this module.
export function atomicWriteTrustStoreSync(projectDir: string, store: ProjectTrustStore): void {
  ensureProjectTrustDir(projectDir);
  const finalPath = trustFilePath(projectDir);
  const tmpPath = tempTrustFilePath(projectDir);
  writeFileSync(tmpPath, JSON.stringify(store), { mode: 0o600 });
  renameSync(tmpPath, finalPath);
}

// REQ-6: the ONLY writer. Mints a trust grant: computes projectRootSha256, stamps
// grantedAtMs, reads-or-mints the project MAC key, signs the store-minus-mac with
// signBgPayload (canonicalJson — key-order-independent, so the reader's
// verifyBgPayloadMac over the parsed JSON reproduces the same MAC), writes
// atomically (temp + rename, 0600). options.randomBytes / options.now are TEST
// injection seams mirroring readOrCreateProjectTrustKey's existing randomBytes param
// (the codebase's DI convention); they default to the real crypto and Date.now().
export async function writeProjectTrustStore(
  projectDir: string,
  grant: { defaultBackend: string },
  options: { randomBytes?: (size: number) => Buffer; now?: () => number } = {},
): Promise<ProjectTrustStore> {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) {
    throw new TypeError("writeProjectTrustStore: projectDir must be an absolute path");
  }
  if (typeof grant?.defaultBackend !== "string" || grant.defaultBackend.length === 0) {
    throw new TypeError("writeProjectTrustStore: grant.defaultBackend must be a non-empty string");
  }
  // Compute the FULL store BEFORE any write. A failure here (no .pi/.git ancestor in
  // projectRootSha256, an injected-throwing now()/randomBytes on key mint) leaves the
  // prior final file untouched and creates NO temp file — the atomic-rename contract.
  const rootSha = projectRootSha256(projectDir);
  const projectKey = await readOrCreateProjectTrustKey(projectDir, options.randomBytes);
  const storeWithoutMac = {
    schemaVersion: PROJECT_TRUST_SCHEMA_VERSION,
    projectRootSha256: rootSha,
    defaultBackend: grant.defaultBackend,
    grantedAtMs: options.now ? options.now() : Date.now(),
    keyGenId: keyGenIdFromKey(projectKey),
  };
  const mac = signBgPayload(storeWithoutMac, projectKey);
  const store: ProjectTrustStore = { ...storeWithoutMac, mac };
  atomicWriteTrustStoreSync(projectDir, store);
  return store;
}

// REQ-5 / INV-3: read-side resolver. Returns a registered backend name ONLY when
// readProjectTrustStore returns ok:true (valid + MAC + root-bound) AND the named
// backend is currently registered. Any read failure (absent/forged/malformed/
// symlink) OR an unregistered backend name → null; the caller falls back to
// selectBgTerminalBackend() (the preference probe, current behavior at
// bg-terminal.ts:175). INV-4 (explicit overrides default) is enforced by the CALLER
// (index.ts L695 explicit --backend branch short-circuits before calling this);
// resolveDefaultBackend is consulted only in the flag-absent branch (index.ts L713).
// (P5F-3 wires the caller — P5F-2 ships the primitive + tests, zero production callers.)
export async function resolveDefaultBackend(projectDir: string): Promise<string | null> {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) {
    throw new TypeError("resolveDefaultBackend: projectDir must be an absolute path");
  }
  const read = await readProjectTrustStore(projectDir);
  if (!read.ok) return null;                            // INV-3 fail-closed → preference probe
  const backend = getBgTerminalBackendByName(read.store.defaultBackend);
  return backend ? read.store.defaultBackend : null;    // EC3: unregistered → null
}
```

**Verify (step 2.1):**
```bash
node -e "import('./agents/lib/bg-trust.ts').then(m=>console.log(Object.keys(m).join(',')))"
# EXPECTED keys include: writeProjectTrustStore, resolveDefaultBackend, atomicWriteTrustStoreSync
#   (plus the P5F-1 exports readProjectTrustStore, readOrCreateProjectTrustKey,
#    readProjectTrustKey, sha256Hex, resolveProjectRoot, projectRootSha256, + constants)
grep -nE "resolveTrustedHome|readOrCreateSessionMacKey|getBgStateDir|getBgSessionMacPath" agents/lib/bg-trust.ts
# EXPECTED: empty (INV-2 still holds after the new ./bg-terminal.ts import).
grep -nE '^import .* from (node:|\./bg-state|\./bg-terminal)' agents/lib/bg-trust.ts
# EXPECTED: node:crypto, node:fs, node:fs/promises, node:path, ./bg-state.ts, ./bg-terminal.ts ONLY.
```
(The slice runner is NOT yet green after step 2.1 alone — the new exports are unused until step 2.2's tests are appended. That is expected; the existing 13 tests still pass.)

### Step 2.2 — APPEND Group 3 + Group 4 tests to `agents/test/test-bg-trust.mjs`

The new tests are appended to the SAME test file, mirroring P5F-1 step 1.2's precedent (high-capability executor scope): **4 verbatim load-bearing bodies** are given below — the 2 discriminating / red-then-green Group-3 cases (`testWrite_atomicFailureLeavesFinalUntouched`, `testReadTrustStore_rejectsAfterKeyRotation`) and the 2 discriminating Group-4 cases (`testResolveDefaultBackend_fallsBackWhenBackendUnregistered` for the unregistered-backend negative control, `testResolveDefaultBackend_fallsBackWhenStoreForged` for the forged-store fail-closed negative control — absent-vs-forged must NOT collapse); the remaining 3 are authored per the Group-3/4 contract tables below. **Three edits to ONE file:** two import edits (a.1 node:fs + a.2 bg-trust/bg-terminal) + one insert immediately ABOVE the `// Run summary:` block (b).

**(a.1) EDIT — add `lstatSync`, `readdirSync` to the `node:fs` import.** Needed by `testWrite_atomicTempRename` (final-file `lstatSync` for isFile + 0600-mode check) and `testWrite_atomicTempRename` + `testWrite_atomicFailureLeavesFinalUntouched` (`readdirSync` for the orphaned-temp glob).

`ANCHOR` (exact, verbatim — line 2 of the shipped test file):
```js
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
```
`REPLACE` (add the two missing fs helpers):
```js
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
```

**(a.2) EDIT — add `writeProjectTrustStore` + `resolveDefaultBackend` to the bg-trust import, and add `__resetBgTerminalBackend` + `registerBgTerminalBackend` to a NEW bg-terminal import.**

`ANCHOR` (exact, verbatim — the bg-trust import line of the test file):
```js
import { readOrCreateProjectTrustKey, readProjectTrustStore, projectRootSha256, readProjectTrustKey, sha256Hex } from "../lib/bg-trust.ts";
```
`REPLACE` (extend that import + add the bg-terminal import beneath it):
```js
import { readOrCreateProjectTrustKey, readProjectTrustStore, projectRootSha256, readProjectTrustKey, sha256Hex, writeProjectTrustStore, resolveDefaultBackend } from "../lib/bg-trust.ts";
import { registerBgTerminalBackend, __resetBgTerminalBackend } from "../lib/bg-terminal.ts";
```

**(b) APPEND — insert the 7 new tests immediately BEFORE the `// Run summary:` line.**

`ANCHOR` (exact, verbatim — the run-summary sentinel in the shipped test file):
```js
// Run summary:
await new Promise((r) => setTimeout(r, 0));
```
`REPLACE` (the 7 new tests + the original anchor, so the run summary remains LAST):
```js
// Shared serial lock for the 2 registry-mutating resolver tests
// (testResolveDefaultBackend_returnsTrustedName + testResolveDefaultBackend_fallsBackWhenStoreForged).
// The fire-and-forget test() shim runs all tests concurrently; without serialization, one test's
// __resetBgTerminalBackend() (which wipes the WHOLE registry — backends=[]) can clear another's
// stub mid-resolve, flaking returnsTrustedName. The lock runs the critical sections back-to-back;
// then(fn, fn) runs fn regardless of the prior run's outcome, and re-assigning registryLock to a
// settled promise keeps the chain unbroken even if an assertion rejects. Each test still owns its
// cleanup via try/finally INSIDE the lock.
let registryLock = Promise.resolve();
function withRegistryLock(fn) {
  const run = registryLock.then(fn, fn);
  registryLock = run.then(() => undefined, () => undefined);
  return run;
}

// --- Group 3: writeProjectTrustStore (4 tests) ---
// VERBATIM (2 load-bearing): testWrite_atomicFailureLeavesFinalUntouched (discriminating),
//   testReadTrustStore_rejectsAfterKeyRotation (red-then-green).
// Contract-driven (author per Group-3 table): testWriteThenRead_roundtrip, testWrite_atomicTempRename.
// NOTE: the shared `mintStore()` helper hardcodes keyGenId="UNUSED_IN_FIXTURE" — use it ONLY for
// forged-negative fixtures; `testWriteThenRead_roundtrip` MUST call `writeProjectTrustStore` so
// that `keyGenId` is the real 8-hex derived id (asserted by that test's contract).

test("testWrite_atomicFailureLeavesFinalUntouched", async () => {
  const d = tmpProject();
  await writeProjectTrustStore(d, { defaultBackend: "tmux" });
  let r = await readProjectTrustStore(d);
  assert.ok(r.ok, "pre-write v1 must read ok");
  assert.strictEqual(r.ok && r.store.defaultBackend, "tmux");
  // Inject a throwing now() during store assembly — BEFORE any write. A streaming-to-final
  // impl would leave a torn final; the temp+rename contract MUST leave the prior final
  // untouched and create no temp file.
  await assert.rejects(
    writeProjectTrustStore(d, { defaultBackend: "cmux" }, { now: () => { throw new Error("inject-now"); } }),
    /inject-now/,
  );
  r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, true, "after failed write the prior final must still read ok");
  assert.strictEqual(r.ok && r.store.defaultBackend, "tmux");
  const leftovers = readdirSync(path.join(d, ".pi/trust")).filter((n) => /\.tmp\./.test(n));
  assert.deepStrictEqual(leftovers, [], "no orphaned temp file must remain");
});

test("testReadTrustStore_rejectsAfterKeyRotation", async () => {
  const d = tmpProject();
  await writeProjectTrustStore(d, { defaultBackend: "tmux" });
  let r = await readProjectTrustStore(d);
  assert.ok(r.ok, "post-write read must be ok");
  const keyPath = path.join(d, ".pi/trust/.trust.mac");
  const key1Hex = readFileSync(keyPath, "utf8");
  // Rotate: delete .trust.mac + mint a fresh key. The store's MAC was signed with key1,
  // so under key2 it MUST read forged (State G MAC mismatch). Then restore key1 → ok (green).
  rmSync(keyPath);
  const key2 = await readOrCreateProjectTrustKey(d);
  assert.notStrictEqual(key2.toString("hex"), key1Hex.trim(), "rotation must mint a distinct key");
  r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ok && r.reason === "forged", "rotated key must invalidate the MAC");
  // RED-then-GREEN: restore key1 → MAC recomputes valid → ok:true.
  writeFileSync(keyPath, key1Hex, { mode: 0o600 });
  r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ok && r.store.defaultBackend, "tmux");
});

// --- Group 4: resolveDefaultBackend (3 tests) ---
// VERBATIM (2 discriminating load-bearing): testResolveDefaultBackend_fallsBackWhenBackendUnregistered
//   (unregistered-backend → null) + testResolveDefaultBackend_fallsBackWhenStoreForged (forged-store → null).
//   Together they isolate the two independent null paths; absent-vs-forged must NOT collapse.
// Contract-driven (author per Group-4 table): testResolveDefaultBackend_returnsTrustedName.

test("testResolveDefaultBackend_fallsBackWhenBackendUnregistered", async () => {
  const d = tmpProject();
  await writeProjectTrustStore(d, { defaultBackend: "__nonexistent-xyz" });
  // Store reads ok:true (valid MAC + root-bound) and the name is syntactically fine, BUT
  // getBgTerminalBackendByName("__nonexistent-xyz") is undefined (never registered).
  // resolveDefaultBackend MUST return null (EC3 fallback), NOT the stored name.
  const resolved = await resolveDefaultBackend(d);
  assert.strictEqual(resolved, null);
});

test("testResolveDefaultBackend_fallsBackWhenStoreForged", async () => {
  // Discriminating fail-closed control: a store that is FORGED (MAC invalid via key rotation)
  // MUST resolve to null EVEN WHEN its named backend IS currently registered. A fail-open bug
  // (returning the stored name on read failure) would hand back "__p5f-stub" here; the correct
  // fail-closed path returns null BEFORE consulting the registry, because readProjectTrustStore
  // returns {ok:false, reason:"forged"} (State G MAC mismatch). Distinct from the absent path —
  // this fixture creates a valid store and forges it, so null here can ONLY come from !read.ok.
  // Serialized via withRegistryLock + try/finally — this test and returnsTrustedName both mutate the
  // global backend registry; under the concurrent test() shim, an unsynchronized reset would wipe
  // the other's stub mid-resolve (flake). tmpProject() is outside the lock (isolated file state).
  const d = tmpProject();
  await withRegistryLock(async () => {
    try {
      __resetBgTerminalBackend();
      registerBgTerminalBackend({ name: "__p5f-stub", preference: 0, isAvailable: async () => true });
      await writeProjectTrustStore(d, { defaultBackend: "__p5f-stub" });
      // Rotate the key so the store's MAC (signed with key1) no longer verifies under key2 → forged.
      rmSync(path.join(d, ".pi/trust/.trust.mac"));
      const key2 = await readOrCreateProjectTrustKey(d);
      assert.ok(key2, "rotated key must mint");
      const read = await readProjectTrustStore(d);
      assert.strictEqual(read.ok, false);
      assert.ok(!read.ok && read.reason === "forged", "store must read forged after key rotation");
      const resolved = await resolveDefaultBackend(d);
      assert.strictEqual(resolved, null, "forged store resolves to null even with backend registered");
    } finally {
      __resetBgTerminalBackend();
    }
  });
});

// Run summary:
await new Promise((r) => setTimeout(r, 0));
```
> **Executor note:** the 4 verbatim bodies above implement their contract-table rows directly; author the remaining 3 (`testWriteThenRead_roundtrip`, `testWrite_atomicTempRename`, `testResolveDefaultBackend_returnsTrustedName`) per the Group-3/4 tables below, then leave `// Run summary:` LAST so trailing async tests settle before the exit handler prints `passed/failed`. Tests run concurrently (the `test()` shim fires-and-forgets each `Promise`); each fixture must use its own `tmpProject()` dir to avoid shared-state races. The two Group-4 resolver tests that touch the global backend registry (`testResolveDefaultBackend_returnsTrustedName`, `testResolveDefaultBackend_fallsBackWhenStoreForged`) MUST serialize on the shared `withRegistryLock` + `try { … } finally { __resetBgTerminalBackend(); }` (defined at the top of the appended block) — the `test()` shim is concurrent and `__resetBgTerminalBackend()` wipes the whole registry, so unsynchronized before/after resets flake `returnsTrustedName`.

#### Group-3 contract — `writeProjectTrustStore` (4 tests)

| Test name | Asserted property | Flag |
|---|---|---|
| `testWriteThenRead_roundtrip` | `writeProjectTrustStore(d, {defaultBackend:"tmux"})` resolves to a `ProjectTrustStore`; `readProjectTrustStore(d)` returns `{ok:true, store}` with `store.defaultBackend==="tmux"`, `store.schemaVersion===1`, `store.mac` matches `/^[0-9a-f]{64}$/i`, `store.projectRootSha256===projectRootSha256(d)`, `store.keyGenId` is 8 hex chars. | — |
| `testWrite_atomicTempRename` | After `writeProjectTrustStore(d,{defaultBackend:"cmux"})`: `const final = path.join(d,".pi/trust/default-backend.json")`; `lstatSync(final).isFile()===true` AND `.isSymbolicLink()===false`; `(lstatSync(final).mode & 0o077) === 0` (0600); `readdirSync(path.join(d,".pi/trust")).filter(n => /default-backend\.json\.tmp\./.test(n))` is empty (leftover temp absent — proves temp was renamed away); re-`readProjectTrustStore(d)` → `{ok:true,"cmux"}`. NB `trustFilePath` is module-private/unexported — spell the path literal (P2 fix). | — |
| `testWrite_atomicFailureLeavesFinalUntouched` | Pre-write v1 (`defaultBackend:"tmux"`) → read `{ok:true,"tmux"}`. Call `writeProjectTrustStore(d,{defaultBackend:"cmux"},{now:()=>{throw new Error("inject-now")}})` inside `try/catch` — it MUST throw. THEN re-`readProjectTrustStore(d)` → STILL `{ok:true,"tmux"}` (prior final unchanged). AND `readdirSync(.pi/trust)` has NO `*.tmp.*` entry (no orphaned temp). | discriminating (failing `now` proves the writer computes the FULL store BEFORE any write — a streaming-to-final impl would leave a torn final here) |
| `testReadTrustStore_rejectsAfterKeyRotation` | `writeProjectTrustStore(d,{defaultBackend:"tmux"})` → read `{ok:true}`. Save `key1Hex = readFileSync(.trust.mac)`. Delete `.trust.mac`; mint a fresh key (e.g. another `readOrCreateProjectTrustKey(d)` → `key2`), assert `key2.toString("hex") !== key1Hex.trim()` (rotation actually happened). Read → `{ok:false, reason:"forged"}` (State G — MAC signed w/ key1 fails under key2). **Red-then-green:** restore key1 (write `key1Hex` back to `.trust.mac`, 0600) → read → `{ok:true,"tmux"}`. | red-then-green |

#### Group-4 contract — `resolveDefaultBackend` (3 tests)

| Test name | Asserted property | Flag |
|---|---|---|
| `testResolveDefaultBackend_returnsTrustedName` | Wrap the body in `await withRegistryLock(async () => { try { … } finally { __resetBgTerminalBackend(); } })` (serialize vs `testResolveDefaultBackend_fallsBackWhenStoreForged` — both mutate the global registry under the concurrent `test()` shim). Inside the lock: `__resetBgTerminalBackend()`; register stub `{ name: "__p5f-stub", preference: 0, isAvailable: async()=>true }`; `writeProjectTrustStore(d,{defaultBackend:"__p5f-stub"})`; `await resolveDefaultBackend(d)` → `"__p5f-stub"` (store valid + name registered). The `finally` reset guarantees the registry is clean for the next test even if an assertion rejects. | — |
| `testResolveDefaultBackend_fallsBackWhenBackendUnregistered` | `writeProjectTrustStore(d,{defaultBackend:"__nonexistent-xyz"})`; `await resolveDefaultBackend(d)` → `null` (store `{ok:true}` and MAC+root valid, but `getBgTerminalBackendByName("__nonexistent-xyz")` is undefined → EC3 fallback). NB: no registry mutation needed. | discriminating (proves non-null REQUIRES a registered backend, not merely a valid store) |
| `testResolveDefaultBackend_fallsBackWhenStoreForged` | **VERBATIM body above** (discriminating). Register stub `{name:"__p5f-stub",...}`; `writeProjectTrustStore(d,{defaultBackend:"__p5f-stub"})` (valid store); key-rotate (rm `.trust.mac` + `readOrCreateProjectTrustKey(d)` → key2) so `readProjectTrustStore(d)` → `{ok:false, reason:"forged"}` (State G MAC mismatch); `await resolveDefaultBackend(d)` → `null` (INV-3 fail-closed — null EVEN THOUGH the backend is registered; a fail-open bug would return the name). Reset registry at end. | discriminating (registered+forged→null proves fail-closed keys on `read.ok`, not on registry presence — absent-vs-forged must NOT collapse) |

> The two resolver tests that register a stub (`testResolveDefaultBackend_returnsTrustedName` + `testResolveDefaultBackend_fallsBackWhenStoreForged`) both mutate the **process-global** backend registry via `__resetBgTerminalBackend()` (bg-terminal.ts — test-only; wipes `backends=[]`). Because the `test()` shim is fire-and-forget (concurrent), they MUST serialize on the shared `withRegistryLock` (defined at the top of the appended block) and own cleanup via `try { … } finally { __resetBgTerminalBackend(); }`; otherwise one test's reset wipes the other's `__p5f-stub` mid-resolve and `returnsTrustedName` flakes. The test process registers no real backends, and `__p5f-stub` is deliberately non-colliding with `tmux`/`cmux`/`zellij`.

**Verify (step 2.2 — whole slice green):**
```bash
bash agents/test/run-bg-trust-tests.sh
# EXPECTED: prints "20/20 passing" (P5F-1 shipped 13; P5F-2 appends Group 3 (4) + Group 4 (3) = 7), EXIT=0.
grep -nE 'refusing symlinked|writeFileSync' agents/lib/bg-trust.ts | head   # sanity (optional)
```

### P5F-2 UNGUARDED-IN-CI manual grep (atomicity)

Per the same honesty convention as REQ-10 ordering, the atomic temp+rename implementation is verified by a named manual grep (mechanically unverifiable in plain ESM without a mock library, which REQ-11 forbids — a thrown-between-writeFileSync-and-renameSync fault cannot be injected without a banned mock or a third dependency-injected `renameSync` seam that would violate the keep-it-minimal DI convention):
```bash
grep -nE 'tmp\.|renameSync|writeFileSync' agents/lib/bg-trust.ts
# EXPECTED: tempTrustFilePath produces a `${PROJECT_TRUST_FILE}.tmp.<hex>` path; atomicWriteTrustStoreSync
# does writeFileSync(tmpPath,…,{mode:0o600}) THEN renameSync(tmpPath, finalPath). Both present in source.
```
The mechanically-verifiable atomicity signals are `testWriteThenRead_roundtrip` (happy-path complete + correct), `testWrite_atomicTempRename` (final is a regular 0600 file, no orphaned temp, reads back ok:true), and `testWrite_atomicFailureLeavesFinalUntouched` (a pre-write failure via injected throwing `now()` leaves the prior final unchanged + creates no temp). The source-order temp-then-rename is the manual-grep row.

### P5F-2 done gate

- `bash agents/test/run-bg-trust-tests.sh` → `20/20 passing`, EXIT=0.
- INV-2 grep empty; REQ-11 (extended) grep shows only the 6 allowed import sources.
- `grep -rln 'from.*bg-trust' agents/lib/ agents/index.ts` → STILL no matches (P5F-2 ships **zero production callers**; the resolver is wired by P5F-3, the writer by a future `P5F-GRANT` UX — both out of this slice's scope, per Non-Goals 1 & the INV-4 caller note).
- Existing P5F-1 tests (13) untouched; existing `agents`/`tmux-control`/`tmux-terminal`/`agents`-preflight suites still green.
