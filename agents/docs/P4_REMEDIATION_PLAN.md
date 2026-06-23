# P4R Background-Agent Remediation Plan (v3)

## Status

**v3 — GO. Cross-model external consensus reached (passes 6 + 7: Codex + Claude
both GO) → awaiting human approval (Rule 18 step 4).** Seven review passes across
v1→v3; the two criticals (`os.userInfo().homedir` `$HOME`-independence, no-kill
reaper) were re-verified live by the main session and by both reviewers.

P4-1 (`agents/lib/bg-state.ts`, PR #44 `e55bb04`) is merged; this plan remediates
findings against it **before** P4-2 (preflight) and P4-3 (worker) are built.

**v3 changes** (after v2 NO-GO — both passes converged on N1/N3):
- **N1:** trusted root is `os.userInfo().homedir` (getpwuid, ignores `$HOME`),
  **not** `os.homedir()`; the backend pins/strips `HOME` at worker launch.
- **N3:** **no-kill-on-reap** — the reaper only frees the slot; actual killing is
  delegated to the P5 backend's window/pgid handle via `bg-stop`. The tautological
  `ownerNonce` signal is removed. `bg-state` stays backend-agnostic via an injected
  `isAlive` callback.
- **Threat model fixed to single-user / malicious-agent** (see new section). N2
  (same-uid registry/store forgery) is an **accepted residual**, not a fix.
- N4/N5/N6 specified; Appendix B re-sequenced to compile in numeric order.

**v2 changes** (carried forward):
- New foundational slice **P4R-0 — Authority-Root Binding**.
- **First cut scoped to USER agents only** (no project trust needed).

## Threat Model & Accepted Residuals

**In scope:** a malicious **agent spec** or **project** that influences values
through the legitimate flow (manifest fields, spec bytes, registry entries it can
legitimately propose), attempting to run code or escalate beyond P3 read-only
limits in a background worker.

**Out of scope (accepted residuals):** an attacker running as the **same uid** on
the same machine (co-tenant, or a sibling process already executing as the user).
Such an attacker can already write `~/.pi/...`, set the launch environment, and
read the MAC key — they have the user's privileges. Specifically accepted:

- **N2** — same-uid forgery of `~/.pi/agent/agents/registry.json` (mode `0644`).
  The `0700`/`0600` directory-mode checks are the boundary; we do **not** add
  `stat.uid===geteuid()` ownership checks. Documented, not fixed.

This scoping is why N1's fix targets `$HOME` *misdirection* (a cheap, env-level
influence vector reachable without same-uid write) but not same-uid store forgery.

## Episode Search Summary

Searched episodic memory for `p4`, `p4r`, `background-agents`, `bg-state`,
`authority-root`, `review-consensus`.

Key active memories:

- `20260619-153212-p4r-plan-review-consensus-...`: Review consensus — NO-GO on v1 until authority-root binding fixed; B1–B9 classification.
- `20260619-151808-p4-review-grounded-...`: Grounded review — trust persisted at `~/.pi/agent/trust.json`; F1 fixable via disk reader (now deferred with project agents).
- `20260619-150638-canonical-workplan-p4-1-merged-...`: P4-1 merged; P4-2 next.

## Objective

Make the P4 background-agent foundation sound enough to build P4-2/P4-3 on, for
**user-registered agents**. The central fix (P4R-0) is that the worker derives
every state root — bg state, registry, MAC key, results — from its **own trusted
runtime** (`resolveTrustedHome()` = `os.userInfo().homedir`, NOT `os.homedir()`,
which follows `$HOME` — N1) and the backend-provided manifest *path*, never from
manifest-carried `cwd`/`homeDir`. Adjacent fixes remove a self-DoS, a status-
hiding listing gap, a weak reaping key, and a manifest canonicalization hole.

## Why

The P4 security premise is that the worker re-derives all authority from trusted
disk sources, so the manifest carries identity only. The adversarial review
showed the manifest carried **authority roots** (`homeDir`/`cwd`): since the
registry and the MAC key are both located via `homeDir` (`can-run-agent.ts:89,109`;
`getBgSessionMacPath`), a worker trusting `manifest.options.homeDir` makes the MAC
**circular** — the verifying key sits in the store the attacker pointed at. P4R-0
closes that. Scoping the first cut to user agents removes project-trust
re-derivation (the other hard problem) from this milestone entirely.

## Grounding: Pi extension execution model

| Fact | Source | Consequence |
|---|---|---|
| User agents gate on registry exact path+hash; **no project trust** | `can-run-agent.ts:85-99` (`canRunRegisteredUser`) | User-agent worker needs no `trust.json` — F1 defers with project agents |
| Project trust persisted at `~/.pi/agent/trust.json` (`{abs:true}`, folder-or-parent) | Pi docs; verified on disk | Needed only for the deferred project-agents milestone |
| `ctx.isProjectTrusted()` is a per-process host callback | Pi docs (ExtensionContext) | Detached worker lacks it; irrelevant for user-agents cut |
| Registry + MAC key located via `homeDir` | `can-run-agent.ts:89,109`; `bg-state.ts:88` | **B1**: manifest `homeDir` must never be the lookup root |
| `os.homedir()` follows `$HOME`; `os.userInfo().homedir` uses getpwuid | proven live in review (N1) | **N1**: trusted root MUST be `os.userInfo().homedir` |
| `child-runner.ts:157,275` forwards `options.env` unsanitized to children | review N1 | Backend MUST pin/strip `HOME` when launching the worker |
| Children spawn as `pi --no-extensions` subprocesses | `child-args.ts:32-33` | Worker is a separate process; uses `resolveTrustedHome()` |
| `session_shutdown` fires before runtime teardown | Pi docs | Where MAC-key retirement is wired (B2/F2) |
| "Avoid long-lived processes from the factory function" | Pi docs | Worker launched on demand by P5 backend, not at load |

## Requirements (Ground Truth)

### First cut (user agents)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-AR1 | The worker derives **all** state roots (bg dir, `.session.mac`, user registry, results, events) from `resolveTrustedHome()` = `os.userInfo().homedir` (getpwuid; ignores `$HOME`) and the backend-provided manifest path — never from `os.homedir()`/`$HOME` or manifest-carried `homeDir`/`cwd` | `testWorkerRootIgnoresHomeEnv`, `testStateRootsShareTrustedHome` | MUST | N1. The single most important fix. Test MUST poison `process.env.HOME` and assert the root is unchanged |
| REQ-AR2 | The worker reads `manifest.options.homeDir` as **identity**, compares against `resolveTrustedHome()`, and hard-fails on mismatch. `cwd` is advisory identity only (not gated — launch cwd may legitimately differ from agent cwd) | `testManifestHomeDirMismatchRejected` | MUST | N1/N6. cwd not compared |
| REQ-AR3 | A manifest signed under a fake-`$HOME` store does not verify against the `resolveTrustedHome()` key | `testFakeHomeManifestRejected` | MUST | N1 attack closure |
| REQ-4 | Reserved-not-done runs are reclaimed (slot freed, **never signalled**) when age exceeds `effectiveTimeoutSec + grace`, OR an injected `isAlive(handle)` callback returns `false`. Killing is delegated to the backend handle via `bg-stop`, not done by the reaper | `testReapExpiredFreesSlotNoSignal`, `testReapUsesInjectedIsAlive`, `testActiveExcludesStale` | MUST | F3/N3. No-kill-on-reap |
| REQ-5 | Each reservation records `pid` (diagnostic only), optional opaque `ownerHandle` (backend window/pgid, for `bg-stop`), `startedAtMs`, `effectiveTimeoutSec` (supplied by preflight; **defaulted to `BG_MAX_DURATION_SEC` when absent or non-positive-integer on read**), and `keyGenId`. Corrupt reservation metadata **fails toward keeping the slot, never toward freeing a possibly-live worker** (N4): a future/non-finite `startedAtMs` ⇒ age 0; a missing/invalid `effectiveTimeoutSec` ⇒ `BG_MAX_DURATION_SEC` (run stays active but is still bounded — it ages out); a whole-line JSON parse failure ⇒ same normalization (kept active, ages out). `reapStaleBgRuns` frees such a run early only when an injected `isAlive` proves it dead. There is **no immediate-free path** for malformed metadata (resolves the v2 `{stale:true}` ↔ REQ-5 contradiction) | `testReservationMetadata`, `testFutureStartedAtKeptActive`, `testBadTimeoutKeptActiveBounded` | MUST | N4. Fail toward keeping the slot |
| REQ-6 | The reaper never calls `process.kill`. A reaped run is marked `timed-out` (age) or `stopped` (isAlive=false) and the slot freed; a still-live worker writes only to its own unique run dir, so freeing the count cannot corrupt it | `testReaperNeverSignals` | MUST | N3. bg-state has no `process.kill` |
| REQ-7 | `listBgRuns` returns malformed/symlinked/non-canonical entries as `quarantined` summaries (does not throw on the read path); quarantined entries are shown by `bg-status` and counted as **active-unless-proven-dead** | `testListQuarantinesNotOmits`, `testQuarantinedCountsActive`, `testWritePathStillRefuses` | MUST | B5/F4 |
| REQ-8 | `signBgManifest`/`verifyBgManifest` canonicalize the exact mac-excluded view; the canonicalizer **rejects non-finite numbers and unsupported types** | `testManifestSignRoundTrip`, `testCanonicalRejectsNonFinite`, `testManifestTamperFails`, `testManifestWrongKeyFails` | MUST | F6/B4 |
| REQ-9 | `readBgManifest` exact-schema validates every field (rejects unknown fields, non-integer/out-of-range/`null` `maxDurationSec`, oversize `task`, version mismatch) and returns the **same object** the signer signed and the worker uses | `testReadManifestValid`, `testReadManifestRejectsUnknownField`, `testReadManifestTaskTooLarge`, `testReadManifestBadTimeout` | MUST | B4/F9 |
| REQ-10 | The MAC key (located via the trusted root) is retired **only at session-start cleanup** (the single-threaded path), and only when zero active, reserved, AND quarantined runs exist — never at `session_shutdown` (avoids the concurrent count→delete race, N5). `.session.mac` is machine-global; a `keyGenId` ties each manifest+reservation to a key generation so a rotated key fails verification loudly | `testMacKeyRetainedWhileAnyRun`, `testMacKeyRetiredOnlyWhenFullyIdle`, `testKeyGenMismatchRejected` | MUST | F2/B2/N5 |
| REQ-11 | Concurrency limit documented as best-effort; a concurrent-create test asserts it never over-admits, including racing a stale-reap | `testConcurrentCreateNeverOverAdmits` | SHOULD | F5/B3 |
| REQ-12 | Run ordering never depends on `birthtimeMs` | `testOrderingUsesMtimeNotBirthtime` | SHOULD | F8 |
| REQ-13 | `events.jsonl` retention policy is explicit and tested | `testEventsRetentionPolicy` | SHOULD | F7 |

### Deferred (project-agents milestone — not this cut)

| ID | Requirement | Notes |
|---|---|---|
| REQ-P1 | Disk-backed project-trust reader over `~/.pi/agent/trust.json` (parent-walk, fail-closed) | Former F1/P4R-4. Only needed for `source:"project"` agents |
| REQ-P2 | Trust resolved as the **last gate** immediately before each `runChildAgent`; residual TOCTOU documented | B6 |
| REQ-P3 | F1 documented as **persisted-host parity**, not full host parity (session-only + CLI/temporary overrides diverge) | B7; reconcile with `agents/SECURITY_MODEL.md:169` |

## Non-Goals

- **Project (`source:"project"`) background agents** — deferred to a follow-up
  milestone (needs the disk-trust reader + the divergence documentation). User
  agents have no project-trust dependency.
- The worker process (P4-3) and preflight (P4-2) themselves — this plan makes
  them buildable.
- The tmux/terminal backend (P5).
- Any new interactive trust-granting UX.

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Worker locates registry/MAC/state via attacker-influenced `homeDir` → circular MAC, false grant | Critical | P4R-0: trusted-runtime root only; manifest `homeDir`/`cwd` identity-only, reject-on-mismatch | `testWorkerRootIgnoresHomeEnv`, `testManifestHomeDirMismatchRejected`, `testFakeHomeManifestRejected` |
| Stale reservation exhausts the 5-slot cap (self-DoS) | High | age + injected `isAlive` reaping frees the slot | `testReapExpiredFreesSlotNoSignal`, `testActiveExcludesStale` |
| Reaper signals a reused pid (kills unrelated process) | High | **No-kill-on-reap** — reaper never calls `process.kill`; killing is the backend handle's job via `bg-stop` (N3) | `testReaperNeverSignals` |
| Corrupting a live run's dir drops it from cap accounting + status | High | Quarantine = returned + active-unless-proven-dead | `testQuarantinedCountsActive` |
| Tampered/forged manifest verifies | High | mac-excluded canonical view, non-finite rejection, exact-schema validation, `keyGenId` | `testManifestTamperFails`, `testCanonicalRejectsNonFinite` |
| MAC key rotated under a running worker / leaked forever | Medium | Retain while active-post-reaping; guaranteed retirement; `keyGenId` | `testMacKeyRetainedWhileAnyRun`, `testMacKeyRetiredOnlyWhenFullyIdle`, `testKeyGenMismatchRejected` |

## Design

### Authority roots (the P4R-0 contract)

Every surface below MUST root in trusted runtime, never in manifest task data:

| Surface | Trusted root | Never |
|---|---|---|
| bg state dir, `.reserved`, `.session.mac` | `resolveTrustedHome()` = `os.userInfo().homedir` | `os.homedir()`/`$HOME`, `manifest.options.homeDir` |
| user registry | `resolveTrustedHome()` (`getAgentsHomeDir`) | manifest field |
| result/events writes | same trusted bg root | manifest field |
| run dir identity | backend-provided manifest **path** (canonical) | runId from manifest body alone |
| child process cwd | trusted launch context (backend) | sourced from `manifest.options.cwd` |

`manifest.options.homeDir` remains in the signed manifest as **identity to
verify**: the worker computes `resolveTrustedHome()` and rejects the run if the
manifest disagrees (verify-and-reject, loud failure). `cwd` is advisory only.
`os.userInfo().homedir` is used because `os.homedir()` honors `$HOME`, which the
worker launch environment can influence (N1).

### Key types

```ts
// agents/lib/bg-state.ts  (MODIFY)

export function resolveTrustedHome(): string { return os.userInfo().homedir; } // N1: NOT os.homedir()

type BgReservation = {
  pid: number;               // diagnostic only — never used to signal (N3)
  ownerHandle?: string;      // opaque backend window/pgid id, for bg-stop later
  startedAtMs: number;       // future/unparseable ⇒ treated as age 0 (N4)
  effectiveTimeoutSec: number; // preflight supplies it; missing/invalid on read ⇒ BG_MAX_DURATION_SEC (REQ-5)
  keyGenId: string;          // MAC key generation (REQ-10)
};

export function signBgManifest(m: Omit<BgRunManifest, "mac">, key: Buffer): string;
export function verifyBgManifest(m: BgRunManifest, key: Buffer): boolean;
export async function readBgManifest(paths: BgRunPaths): Promise<BgRunManifest>; // exact-schema

// reapStaleBgRuns frees slots; it NEVER calls process.kill (N3). isAlive is injected
// so bg-state stays backend-agnostic; killing is the backend's job via bg-stop.
export async function reapStaleBgRuns(
  homeDir: string, opts?: { isAlive?: (h: string) => boolean },
): Promise<{ reapedRunIds: string[] }>;

// canonicalJson hardened to throw on non-finite numbers / unsupported types.
// listBgRuns: BgRunSummary gains `quarantined?: boolean`; never throws on read path.
export function assertManifestIdentityMatchesRuntime(
  m: BgRunManifest, trusted: { homeDir: string },
): void;  // throws iff m.options.homeDir !== trusted.homeDir (REQ-AR2); cwd not compared
```

### Key invariants

- **One trusted root.** Trust/registry/MAC/state/results all resolve from
  `resolveTrustedHome()` (`os.userInfo().homedir`); never `$HOME`/`os.homedir()`,
  never a manifest field.
- **Identity is verified, not trusted.** Manifest `homeDir` mismatch ⇒ reject.
- **A reservation is "active"** iff not done AND not (age > `effectiveTimeoutSec +
  grace`) AND not (`isAlive` injected and returns false). **Admission vs reaping
  split** (resolves the dead-`isAlive`-arg gap): the admission counter
  `countActiveBgRuns` has **no access to a backend handle**, so it excludes only
  by **age** — `isAlive` is consulted **solely** by `reapStaleBgRuns`, which the
  host/backend invokes with the handle. So admission is age-based; the reaper
  additionally frees `isAlive`-dead runs. Reaping **frees the slot
  only — never signals** (N3). Trade-off (accepted): an expired-but-still-alive
  worker is dropped from the count *before* the backend confirms the kill, so the
  real process count can transiently exceed 5 until the backend handle terminates
  it. This is intentional under the no-kill design — the backend owns termination.
- **Quarantine ⇒ visible + counted active** until proven done/dead.
- **The mac-excluded canonical view is the single signed surface**, shared by
  sign, verify, and the worker's read; non-finite/unknown shapes are rejected.

### Resolution / flow — worker authority binding (P4R-0)

```text
backend launches worker with manifestPath (trusted path) + sanitized env (HOME pinned)
  worker: trustedHome = os.userInfo().homedir       // N1: getpwuid, ignores $HOME
          paths = getBgRunPaths(runIdFromPath, trustedHome)
          manifest = readBgManifest(paths)            // exact-schema
          key = readSessionMacKey(trustedHome)        // located via trusted root
          verifyBgManifest(manifest, key)             // mac over mac-excluded view
          assertManifestIdentityMatchesRuntime(manifest, {homeDir: trustedHome})
            └─ manifest.options.homeDir !== trustedHome → REJECT
          canRunAgent(spec, {homeDir: trustedHome, projectTrusted:false, userRegistry})
            └─ user-agent path: registry exact path+hash from trusted home
```

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/lib/bg-state.ts` | 31-37 | `BgRunManifest.options{cwd,homeDir}` | P4R-0: keep as identity; document non-authority |
| `agents/lib/bg-state.ts` | 188 | reservation writes `${pid}\n` | P4R-1: write `{pid,ownerHandle?,startedAtMs,effectiveTimeoutSec,keyGenId}` |
| `agents/lib/bg-state.ts` | 208-243 | `listBgRuns` throws on bad entry | P4R-2: quarantine-and-return |
| `agents/lib/bg-state.ts` | 245-248 | `countActiveBgRuns` | P4R-1/2: exclude stale, include quarantined |
| `agents/lib/bg-state.ts` | 146-151 | `deleteSessionMacKey` unconditional | P4R-5: retain while active; retire when idle |
| `agents/lib/bg-state.ts` | 525-537 | `canonicalJson` coerces non-finite→null | P4R-3: throw on non-finite/unsupported |
| `agents/lib/can-run-agent.ts` | 85-99 | `canRunRegisteredUser` (no trust) | P4R-0: worker feeds trusted-home registry |
| `agents/lib/registry.ts` | 79-93 | registry rooted at `homeDir` | P4R-0: worker passes trusted home only |
| `agents/index.ts` | 61 (`agentsExtension`), 65 (**existing** `session_shutdown` handler via `eventApi.on?.`), 73 (`ctx.agentsHomeDir ?? os.homedir()`) | lifecycle | P4R-5: **extend** the existing `session_shutdown` handler to reap (free slots); key retirement stays at session-start. The `os.homedir()` at :73 is **host-context** (the extension process, not the detached worker) and is intentionally untouched — N1's trusted-root rule binds the worker, not the host |
| `agents/docs/P4_BACKGROUND_AGENTS_PLAN.md` | 20-47, 211-228 | "manifest is identity, not authority" while carrying cwd/homeDir | P4R-6: correct to the real boundary |

## Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P4R-0` | Authority-root binding (N1/B1) | `bg-state.ts`, `test-bg-state.mjs` | `resolveTrustedHome()`=`os.userInfo().homedir`; `assertManifestIdentityMatchesRuntime`; manifest `homeDir` identity-only | REQ-AR1, AR2, AR3 | Worker never uses `$HOME`/`os.homedir()` or manifest `homeDir`/`cwd` as a lookup root |
| `P4R-1` | Reservation + no-kill reaping (F3/N3/N4) | `bg-state.ts`, `test-bg-state.mjs` | `{pid,ownerHandle?,startedAtMs,effectiveTimeoutSec,keyGenId}`; `reapStaleBgRuns` frees slot via age + injected `isAlive`; **no `process.kill`** | REQ-4,5,6 | bg-state contains no `process.kill`; killing is the backend's job |
| `P4R-2` | Tolerant + honest listing (F4/B5) | `bg-state.ts`, `test-bg-state.mjs` | quarantine-and-return; counted active-unless-proven-dead | REQ-7 | Write/launch path still hard-refuses |
| `P4R-3` | Manifest integrity + schema (F6/F9/B4) | `bg-state.ts`, `test-bg-state.mjs` | `signBgManifest`/`verifyBgManifest`/`readBgManifest`; non-finite rejection; exact-schema | REQ-8,9 | One mac-excluded canonical view for sign/verify/read |
| `P4R-5` | MAC key lifecycle (F2/B2) | `bg-state.ts`, `index.ts`, `test-bg-state.mjs` | retain-while-active-post-reaping; guaranteed retirement; `keyGenId` | REQ-10 | Key located via trusted root only |
| `P4R-6` | Hygiene + parent-plan correction (F5/F7/F8/B7/B8) | `bg-state.ts`, tests, both plan docs | concurrent-create test; events policy; drop birthtime ordering; fix slice-order; correct parent plan's authority claim | REQ-11,12,13 | Docs match code (Rule 14) |

**Deferred slice (project-agents milestone):** `P4R-PROJ` — disk-trust reader
(REQ-P1/P2/P3, former P4R-4). Built only when project background agents are taken on.

### Dependency graph

```text
Build order (Phase 0→6 in Appendix B):
P4R-3 (manifest+keyGenId) ─→ P4R-0 (trusted root+identity) ─→ P4R-1 (reservation+no-kill reaping)
   ─→ P4R-2 (listing) ─→ P4R-5 (MAC lifecycle) ─→ P4R-6 (hygiene/docs)
              │
   P4R-3 + P4R-0 + P4R-1 + P4R-5 ──→ P4-2 (preflight, revised) ──→ P4-3 (worker, revised)
   P4R-PROJ (disk trust) ──→ project-agents milestone (later)
```

All P4R slices edit `bg-state.ts`; **P4R-3 is built first** because `keyGenId` and
`verifyBgManifest` are prerequisites for P4R-0's fake-home test and P4R-1's
reservation. The slice-ID order (0,1,2,3,5,6) is **not** the build order — see
Appendix B Phases for the authoritative sequence.

## Cut Order

If scope grows, cut in this order:

1. P4R-6 hygiene items (fold into other slices' tests).
2. P4R-2 listing tolerance (keep fail-closed throw short-term).

Do not cut:

- **P4R-0** — without it the MAC is circular and trust is forgeable.
- P4R-1 — without it background execution self-bricks after 5 crashes.
- P4R-3 — manifest integrity is a P4 hard stop.

## Contracts

### `assertManifestIdentityMatchesRuntime(manifest, trusted)` (P4R-0)

**Input:** full manifest + `{ homeDir }` computed from `resolveTrustedHome()`.
**Output:** `void` on match; **throws** on home mismatch. `cwd` is **not** compared
(launch cwd may legitimately differ from the agent's cwd — N6).

| State | Condition | Output |
|---|---|---|
| A. Match | `manifest.options.homeDir === trusted.homeDir` | returns |
| B. Home mismatch | differs | throw `manifest homeDir does not match trusted runtime` |

### `verifyBgManifest(manifest, key) → boolean` (P4R-3)

`true` iff `timingSafeEqual(signBgManifest(stripMac(manifest), key), manifest.mac)`
AND `manifest.keyGenId` matches the key's generation. Tampered field, wrong key,
wrong `keyGenId`, malformed mac ⇒ `false`. Non-finite numbers in the signed view ⇒
`signBgManifest` throws (never silently canonicalizes).

## Edge Cases

| # | Scenario | Expected | Test |
|---|---|---|---|
| EC1 | Worker launched with `HOME` pointing at attacker store | `resolveTrustedHome()`=`os.userInfo().homedir` ignores `$HOME`; all roots use the real home; fake-`$HOME` manifest signed with fake key fails verify | `testWorkerRootIgnoresHomeEnv`, `testFakeHomeManifestRejected` |
| EC2 | Manifest `homeDir` ≠ `resolveTrustedHome()` | Reject (REQ-AR2) | `testManifestHomeDirMismatchRejected` |
| EC3 | `.reserved` pid reused by unrelated live process | Reaper never signals any pid; slot freed by age/`isAlive` only | `testReaperNeverSignals` |
| EC4 | Worker exceeds age timeout+grace | Marked `timed-out`, slot freed, **no signal**; killing left to backend `bg-stop` | `testReapExpiredFreesSlotNoSignal` |
| EC5 | Live run's dir corrupted to a symlink mid-run | Quarantined, shown in status, counted active | `testQuarantinedCountsActive` |
| EC6 | Manifest `maxDurationSec: null` / `1e309` / unknown field | `readBgManifest` rejects | `testReadManifestBadTimeout`, `testReadManifestRejectsUnknownField` |
| EC7 | `startedAtMs` in the future (clock skew) while worker live | Treated as age 0 → kept active, not freed (N4) | `testFutureStartedAtKeptActive` |
| EC8 | Session ends (`session_shutdown`) while any run exists | Key **not** touched at shutdown; retired only at next session-start when fully idle | `testMacKeyRetainedWhileAnyRun`, `testMacKeyRetiredOnlyWhenFullyIdle` |

## Test Case Catalog

```text
Group 0: authority-root binding (P4R-0) (4 tests)
  testWorkerRootIgnoresHomeEnv          (poison process.env.HOME, assert root unchanged)
  testStateRootsShareTrustedHome
  testManifestHomeDirMismatchRejected
  testFakeHomeManifestRejected

Group 1: reservation + no-kill reaping (P4R-1) (8 tests)
  testReservationMetadata
  testFutureStartedAtKeptActive
  testBadTimeoutKeptActiveBounded
  testParseFailKeptActive
  testReapExpiredFreesSlotNoSignal
  testReapUsesInjectedIsAlive
  testReaperNeverSignals + testActiveExcludesStale

Group 2: tolerant + honest listing (P4R-2) (3 tests)
  testListQuarantinesNotOmits
  testQuarantinedCountsActive
  testWritePathStillRefuses

Group 3: manifest integrity + schema (P4R-3) (8 tests)
  testManifestSignRoundTrip
  testCanonicalRejectsNonFinite
  testManifestTamperFails
  testManifestWrongKeyFails
  testReadManifestValid + testReadManifestRejectsUnknownField
  testReadManifestTaskTooLarge + testReadManifestBadTimeout

Group 4: MAC key lifecycle (P4R-5) (3 tests)
  testMacKeyRetainedWhileAnyRun
  testMacKeyRetiredOnlyWhenFullyIdle
  testKeyGenMismatchRejected

Group 5: hygiene (P4R-6) (3 tests)
  testConcurrentCreateNeverOverAdmits
  testEventsRetentionPolicy
  testOrderingUsesMtimeNotBirthtime
```

Total: ~29 tests. `testReaperNeverSignals` injects a fake `process.kill` spy and
asserts it is **never** called by `reapStaleBgRuns`.

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Worker still reads a root from the manifest somewhere subtle | Critical | P4R-0 central helper + REQ-AR1 test asserting all roots share trusted home; review every `getBg*`/`read*Registry` call site in the worker |
| Reaper kills a reused pid | None | Eliminated by design — `reapStaleBgRuns` never calls `process.kill` (N3); `git grep process.kill` is a DoD check |
| `keyGenId` bookkeeping drifts from key file | Medium | Single accessor derives `keyGenId` from key bytes (e.g. hash prefix); no separate counter |
| bg-state.ts churn across 6 slices | Low | Serialize in ladder order; each lands with tests |
| Parent plan still claims authority safety it doesn't have | Medium | P4R-6 corrects `P4_BACKGROUND_AGENTS_PLAN.md` (Rule 14) |

## Open Decisions

- **Resolved (this round):** manifest `cwd`/`homeDir` → **verify-and-reject**
  (not dropped); first cut → **user agents only**; re-review → **both passes**.
- **Resolved (adversarial reformat round, 2026-06-23):** corrupt-reservation
  policy unified to **normalize-and-keep-active-bounded** (no `{stale:true}`
  immediate-free) — see REQ-5. This *supersedes* the v2-N4 "`{stale}` + liveness
  check" sketch: instead of an immediate-free path gated by liveness, a malformed
  reservation is normalized (bad `effectiveTimeoutSec` ⇒ `BG_MAX_DURATION_SEC`,
  bad `startedAtMs` ⇒ now) so it stays counted-active and ages out within the
  bound; `reapStaleBgRuns` frees it early only on injected-`isAlive` death. This
  removes the accidental live-worker-drop paths (parse-fail / `undefined` timeout)
  the adversarial pass found, at the cost of a ≤`BG_MAX_DURATION_SEC` slot leak for
  a crash-corrupted reservation (bounded; cap is 5; rare). `effectiveTimeoutSec`
  is therefore **optional-with-default** on `CreateBgRunOptions`, not a hard
  required field — keeping the retained P4-1 suite green without fixture edits.
- **events.jsonl retention (F7):** retain for kept runs vs wipe-on-start. Deferral:
  P4R-6. Proposal: retain for non-pruned runs, wipe on prune.
- **Worker entrypoint / `-e` loader source (B9):** trusted installed path vs
  `pi.exec`. Deferral: P4-3 plan. Hard rule: cwd/env/manifest must not decide
  worker code or loader source.

## Done Criteria

- [ ] ~29 MUST/SHOULD tests pass; P4-1 suite still green.
- [ ] Worker uses only trusted-runtime roots; a fake-HOME manifest is rejected.
- [ ] Manifest `homeDir`/`cwd` mismatch is rejected loudly.
- [ ] Killed/abandoned run's slot is reclaimed; pid-reuse is never signalled.
- [ ] Tampered / non-finite / unknown-field / bad-timeout manifest rejected.
- [ ] `.session.mac` survives session_shutdown while active; retires when idle.
- [ ] `P4_BACKGROUND_AGENTS_PLAN.md` no longer claims manifest authority safety.

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | Codex (second-opinion) | `codex-cli 0.140.0` | 1 REJECT + 5 ACCEPT-WITH-MOD | CONDITIONAL-GO (v1) |
| 2 | Codex (adversarial) | `codex-cli 0.140.0` | 5 new blockers | REJECT / NO-GO (v1) |
| 3 | Codex (second-opinion, v2) | `codex-cli 0.140.0` | 4 REJECT + 1 ACCEPT-WITH-MOD | NO-GO |
| 4 | Claude (adversarial, v2) | `claude-subagent` | N1–N3 critical/high + N4–N6 | NO-GO |
| 5 | Claude (focused, v3) | `claude-subagent` | 3 mechanical blockers (Q1 FAIL, Q2 PASS, Q3 RISK) | CONDITIONAL-GO |
| 6 | Claude (confirmation, v3) | `claude-subagent` | 0 (1 inline-FU nit, fixed) | **GO** |
| 7 | Codex (confirmation, v3) | `codex-cli 0.140.0` | 0 | **GO** |
| 8 | Claude (adversarial reformat, v4) | `claude-subagent` | C1/C2 critical + H1–H3 + M1/M2/L1/L2 | NO-GO → fixed |
| 9 | Codex (second-opinion, v4) | `codex-cli` | 4 ACCEPT-WITH-MOD (H1 design **endorsed**) | NO-GO → fixed |

**v4 (2026-06-23, adversarial reformat + template-compliance).** An adversarial
re-read (pass 8) found executability/contradiction bugs that survived the v3 GO:
the `isAlive` admission arg was unreachable (C1), `readReservation` was awaited
inside `.filter()` (C2, nothing ever counted stale), and REQ-5 ↔ step-3.2
contradicted on corrupt metadata (H1). Resolution: **corrupt-metadata policy unified
to normalize-and-keep-active-bounded** (see Open Decisions); admission count is
age-only; `effectiveTimeoutSec` optional-with-default. Appendix B was reformatted to
the hardened `PLAN_TEMPLATE.md` (labeled CREATE/EDIT/APPEND, verbatim ANCHOR→REPLACE,
falsifiable verifies, complete test bodies). Codex (pass 9) **endorsed the H1 design
as the safer policy** and confirmed C2/M2/`testKeyGenMismatchRejected` correct; its
four ACCEPT-WITH-MOD edits (untested whole-line parse-failure → `testParseFailKeptActive`;
bare `catch` → `catch (error)` + `SyntaxError` narrowing; stale Objective
`os.homedir()` prose; stale `index.ts` file-table row) were all applied. v4 review
episodes: codex req `20260623-034515` / reply `20260623-034908`.

**Cross-model consensus: GO (passes 6 + 7).** Both reviewers independently
confirmed B1/B2/B3 RESOLVED and Appendix B compiles in printed order. Confirmation
episodes: claude req `20260619-211752` / reply `20260619-211919`; codex req
`20260619-211803` / reply `20260619-211921`. The claude pass's lone non-blocking
nit (step 2.2 `??`-form wording at L287) was applied.

v3 review episodes: req `20260619-210707` / reply `20260619-210935`. Codex crashed
3× and full-brief claude-subagent timed out 2× on v3 (large doc + review-ladder
preamble > dispatch window); the lean focused brief completed. v3-N1 (`os.userInfo`)
and v3-N3 (no-kill) **independently re-verified live** by the main session
(`HOME=/tmp/x node -p "os.userInfo().homedir"` → real home; `git grep process.kill`
empty). The 3 CONDITIONAL-GO blockers were applied verbatim (reviewer: "re-review
not required if addressed verbatim"): (1) Phase-2 step 2.2 rebinds all 11
`os.homedir()` defaults → DoD grep now reachable; (2) Phase-0 step 0.1 promotes the
constants to a numbered step; (3) step 3.1 uses `readOrCreateSessionMacKey`. Plus
`BgReservation`/`BgRunSummary.quarantined` type defs and the over-admission note.

Review episodes (v1): req `20260619-152130` / reply `20260619-152543`;
req `20260619-152627` / reply `20260619-153021`; consensus `20260619-153212`.
Review episodes (v2): req `20260619-153823` / reply `20260619-154129`;
req `20260619-154632` / reply `20260619-155207`; consensus `20260619-155310`.
(Codex adversarial v2 crashed twice at high reasoning → ran via `claude-subagent`.)

### v2 NO-GO blockers (convergent across both passes)

| # | Blocker | Sev | Fix |
|---|---|---|---|
| N1 | `os.homedir()` follows `$HOME`; P4R-0 root is env-influenceable → re-opens circular-MAC forgery. Proven live. | Critical | Use `os.userInfo().homedir` (getpwuid, ignores `$HOME`) + backend pins/strips `HOME`; add `$HOME`-independence test |
| N3 | `ownerNonce` is tautological — reaper reads the nonce from the same file; pid carries no nonce → SIGTERMs reused pids (the B3 bug ships) | Critical | Bind reservation to process **start-time** (pid+starttime), OR never signal on cross-session reap (free slot only; kill via backend handle in `bg-stop`) |
| N2 | No uid/ownership checks; registry read unguarded → forged 0644 registry approves a dangerous agent | High | `stat.uid===geteuid()` on private dirs + worker registry read (scope per threat model) |
| N4 | Future/invalid `startedAtMs` → silent free of a live worker | Med | Stale-metadata path must still liveness-check before free |
| N5 | `.session.mac` is machine-global; non-atomic count→delete retire races sessions | Med | Guarded/refcounted retire, or per-session key |
| N6 | `assertManifestIdentityMatchesRuntime` cwd semantics undefined | Low | Define which cwd is compared, or drop if launch≠target |

Confirmed **sound** in v2: `canonicalJson` hardening (Attack 3 = NO), `keyGenId`
sizing. **Executability:** Appendix B not strictly in-order (0.4→P4R-3; `keyGenId`
used in P4R-3 before P4R-5); verify script missing; step 6.2 left a decision in.

**Status: NO-GO (v2) → resolved in v3.** See pass 5 (CONDITIONAL-GO) below; all
three v3 blockers applied verbatim. The v2 blocker table below is historical.

v2 required: fix N1 + N3 (+ threat-model decision on N2) and
re-sequence Appendix B before re-review.

### Blocker dispositions (v1 → v2)

| # | Blocker | Disposition in v2 |
|---|---|---|
| B1 | Manifest authority roots | **P4R-0** new foundational slice; verify-and-reject; user-agents scope removes trust-store from cut |
| B2 | MAC key via untrusted root / never retired | P4R-5: trusted-root lookup, `keyGenId`, guaranteed retirement |
| B3 | Reaping on bare pid; silent cap reclaim | P4R-1: pid+nonce+required-timeout; timed-out+SIGTERM-on-match |
| B4 | canonicalJson non-finite; no schema validation | P4R-3: reject non-finite; exact-schema `readBgManifest` |
| B5 | Quarantine hides live runs | P4R-2: returned + counted active-unless-proven-dead |
| B6 | Trust TOCTOU | Deferred with project agents (REQ-P2) — not in this cut |
| B7 | F1 over-claims host parity | Deferred (REQ-P3) — disk trust not in this cut |
| B8 | Slice-order inconsistency | Single ladder order P4R-0→1→2→3→5→6 |
| B9 | Worker entrypoint unpinned | DEFER → P4-3 (NEEDS-EVIDENCE), hard rule recorded |

## Appendix: Implementation Plan

### Files to create

_(none in the user-agents cut — all changes land in `bg-state.ts` + tests. The
disk-trust `trust-store.ts` is created in the deferred project-agents milestone.)_

### Files to modify

| File | Change |
|---|---|
| `agents/lib/bg-state.ts` | P4R-3 sign/verify/read + non-finite rejection + `keyGenIdFromKey`; P4R-0 `resolveTrustedHome`+identity-assert; P4R-1 reservation `{pid,ownerHandle?,startedAtMs,effectiveTimeoutSec,keyGenId}` + **no-kill** reaping; P4R-2 quarantine listing; P4R-5 retire-at-startup-when-idle; P4R-6 drop birthtime ordering |
| `agents/index.ts` | P4R-5 `session_shutdown` **reap-only** (free slots); key retirement remains **session-start only** (N5) |
| `agents/test-fixtures/test-bg-state.mjs` | Groups 0–5 (~29 tests) |
| `agents/docs/P4_BACKGROUND_AGENTS_PLAN.md` | P4R-6: correct "identity, not authority" to the real boundary; note user-agents-first scope |

### Implementation sequence

Authoritative step-by-step is **Appendix B (Phase 0→6)**. Summary in build order:

| Phase | Action | Validation |
|---|---|---|
| 0 | Create `run-bg-state-tests.sh` runner | existing suite green |
| 1 | P4R-3: canonical non-finite reject + `keyGenIdFromKey` + sign/verify/read + schema | Group 3 green |
| 2 | P4R-0: `resolveTrustedHome` (`os.userInfo().homedir`) + identity-assert | Group 0 green |
| 3 | P4R-1: reservation `{pid,ownerHandle?,...}` + **no-kill** reaping (injected `isAlive`) | Group 1 green; P4-1 suite green |
| 4 | P4R-2: quarantine listing (counted active) | Group 2 green; write-path refusal unchanged |
| 5 | P4R-5: retire-at-startup-when-fully-idle + `session_shutdown` reap-only | Group 4 green |
| 6 | P4R-6: hygiene + parent-plan correction | Group 5 green; doc diff matches code |
| 7 | Hand off to revised P4-2/P4-3 consuming P4R-3/0/1/5 | P4-2/P4-3 plans updated |

### Risks

| Risk | Mitigation |
|---|---|
| A worker root sourced from the manifest slips through | REQ-AR1 asserts all roots share trusted home; audit every root call site |
| keyGenId desyncs from the key file | Derive it deterministically from the key bytes (`keyGenIdFromKey`); no separate counter to drift |

## Appendix B: Mechanical Execution Spec (for a low-capability executor)

This appendix exists so a **lower-capability model with limited reasoning** can
implement each slice without making design decisions. Every decision is already
made above; below are exact signatures, **verbatim `ANCHOR` → `REPLACE` edit
anchors**, full new-function bodies, complete test sources, and a **falsifiable**
verify per step.

Steps are presented as per-step subsections (not a table) so multi-line `ANCHOR`
and `REPLACE` blocks survive byte-for-byte. Each step names exactly one file and
one action kind: **CREATE** (whole new file), **EDIT** (anchored find-and-replace
on existing content), or **APPEND** (add a new export/test at end of file).

### Executor contract (read first)

1. Do the **phases and steps in the exact order printed** (Phase 0 → 6). The phase
   number is the build order, NOT the slice-ID order. Do not skip, reorder, or batch.
2. **Edit exactly ONE file per step** — the file named in the step heading.
   `child-runner.ts`, `can-run-agent.ts`, `registry.ts` are **read-only references**
   — never edit them.
3. **Make no design decisions.** If a step's `ANCHOR` is not found **verbatim**
   (byte-for-byte, including leading tabs), or a step seems to require a choice,
   **STOP and ask** — do not guess, search for a "close enough" location, or invent
   an alternative.
4. **Surgical edits only.** For an `EDIT`, change only the `ANCHOR` span; never
   reformat untouched lines, never `Write`-overwrite an existing file. `APPEND` adds
   at end of file and changes nothing existing.
5. Run the step's Verify after each step. It is written to **fail on a stubbed or
   broken implementation** — if it fails, fix only that step; do not proceed until
   green. The ONLY test command (the runner is created in step 0.2):
   `node --experimental-strip-types agents/test-fixtures/test-bg-state.mjs`.
6. **No aspirational output.** Every assertion in a test step below operates on a
   **real captured value** (a function's return, a written file's bytes, a spy's
   call record) — never on a constant the step author typed. Do not add an `echo`
   or comment describing a check you did not assert.
7. One phase = one commit, message `P4R-<id>: <slice title>`, trailer
   `Co-Authored-By: <tool>` (see README).

This source tree runs under `--experimental-strip-types`, so TypeScript types are
**erased at runtime** — a `required` field in a type does NOT throw if a caller
omits it. Every runtime guarantee below is enforced by a runtime check, never by a
type annotation alone.

### Shared constants / types (exact values the steps reference)

```ts
// Phase 0 adds these to bg-state.ts:
export const BG_REAP_GRACE_MS = 30_000;     // grace added to effectiveTimeoutSec before reap
export const BG_MAX_TASK_BYTES = 64_000;    // manifest.task UTF-8 byte ceiling
export const BG_MAX_DURATION_SEC = 86_400;  // 24h: max + default-on-corrupt timeout

// Phase 3 reservation record (one JSON line in .reserved):
type BgReservation = {
  pid: number;               // diagnostic only — never signalled (N3)
  ownerHandle?: string;      // opaque backend window/pgid id, for bg-stop later
  startedAtMs: number;       // future/non-finite ⇒ normalized to now (age 0, N4)
  effectiveTimeoutSec: number; // missing/invalid ⇒ normalized to BG_MAX_DURATION_SEC (N4)
  keyGenId: string;          // MAC key generation (REQ-10)
};
```

**Corrupt-metadata policy (REQ-5 / N4, single source of truth for Phase 3):**
`readReservation` **always returns a usable `BgReservation`** — it never returns a
"stale" sentinel and never frees a slot. Bad `startedAtMs` → `now`; missing/invalid
`effectiveTimeoutSec` → `BG_MAX_DURATION_SEC`; whole-line JSON parse failure →
`{ pid: 0, startedAtMs: now, effectiveTimeoutSec: BG_MAX_DURATION_SEC, keyGenId: "" }`.
A run thus stays **counted-active** and ages out within the bound; only
`reapStaleBgRuns` frees it — by age, or early when injected `isAlive` proves it dead.
This is why **`effectiveTimeoutSec` is optional-with-default** on `CreateBgRunOptions`.

**Build order: Phase 0 → 1 → 2 → 3 → 4 → 5 → 6.** Each phase is one slice; P4R-3's
manifest helpers are built in Phase 1 because later phases depend on `keyGenId`.

---

### Phase 0 — constants + test runner

#### Step 0.1 — `agents/lib/bg-state.ts` — **EDIT** (anchored)

`ANCHOR` (the existing constant block at the top of the file):
```ts
export const BG_SESSION_MAC_BYTES = 32;
```
`REPLACE`:
```ts
export const BG_SESSION_MAC_BYTES = 32;
export const BG_REAP_GRACE_MS = 30_000;
export const BG_MAX_TASK_BYTES = 64_000;
export const BG_MAX_DURATION_SEC = 86_400;
```
**Verify:** `grep -nE "BG_REAP_GRACE_MS|BG_MAX_TASK_BYTES|BG_MAX_DURATION_SEC" agents/lib/bg-state.ts`
prints **3** matching lines (note: `-E` with bare `|`, no backslashes).

#### Step 0.2 — `agents/test-fixtures/run-bg-state-tests.sh` — **CREATE**

Full contents:
```bash
#!/usr/bin/env bash
exec node --experimental-strip-types "$(dirname "$0")/test-bg-state.mjs"
```
Then `chmod +x agents/test-fixtures/run-bg-state-tests.sh`.
**Verify:** `bash agents/test-fixtures/run-bg-state-tests.sh` exits `0` and its last
line contains `passed` (the existing suite, unchanged, is green).

---

### Phase 1 — P4R-3 manifest integrity + schema + `keyGenId` (REQ-8/9)

Built first: `keyGenId` / `verifyBgManifest` are prerequisites for later phases.

#### Step 1.1 — `agents/lib/bg-state.ts` — **EDIT** (anchored)

`ANCHOR` (the final line of `canonicalJson`, with its leading tab):
```ts
	return JSON.stringify(value);
```
`REPLACE`:
```ts
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite number in signed payload");
		return JSON.stringify(value);
	}
	if (typeof value === "string" || typeof value === "boolean" || value === null) return JSON.stringify(value);
	throw new Error("unsupported type in signed payload: " + typeof value);
```
(There is exactly one `return JSON.stringify(value);` at column-0-plus-one-tab — it
is the `canonicalJson` tail. If two match, STOP.)
**Verify:** `node --experimental-strip-types agents/test-fixtures/test-bg-state.mjs`
— `testCanonicalRejectsNonFinite` passes AND `testSessionMacKeyLifecycleAndSigning`
(the existing round-trip over `{z,a:{b}}`) still passes.

#### Step 1.2 — `agents/lib/bg-state.ts` — **APPEND**

Add at end of file:
```ts
export function keyGenIdFromKey(key: Buffer): string {
	return createHmac("sha256", key).update("keygen").digest("hex").slice(0, 8);
}
```
**Verify:** `node --experimental-strip-types -e 'import("./agents/lib/bg-state.ts").then(m=>{const a=m.keyGenIdFromKey(Buffer.alloc(32,1));const b=m.keyGenIdFromKey(Buffer.alloc(32,2));if(!/^[0-9a-f]{8}$/.test(a)||a===b)process.exit(1)})'`
exits `0` — fails (non-zero) if the body is a stub returning `""` or a constant
(two different keys must yield two different 8-hex ids).

#### Step 1.3 — `agents/lib/bg-state.ts` — **EDIT** (anchored)

`ANCHOR`:
```ts
	options: {
		maxDurationSec?: number;
		cwd: string;
		homeDir: string;
	};
	mac: string;
};
```
`REPLACE`:
```ts
	options: {
		maxDurationSec?: number;
		cwd: string;
		homeDir: string;
	};
	mac: string;
	keyGenId: string;
};
```
**Verify:** `node --experimental-strip-types agents/test-fixtures/test-bg-state.mjs`
still green (type-only change; existing manifests omit `keyGenId` but are written via
`writeBgManifest`, which does not schema-validate — unaffected).

#### Step 1.4 — `agents/lib/bg-state.ts` — **APPEND**

```ts
export function signBgManifest(m: Omit<BgRunManifest, "mac">, key: Buffer): string {
	return signBgPayload(m, key);
}

export function verifyBgManifest(m: BgRunManifest, key: Buffer): boolean {
	const { mac, ...withoutMac } = m;
	return verifyBgPayloadMac(withoutMac, key, mac) && m.keyGenId === keyGenIdFromKey(key);
}
```
(The signed surface is the mac-excluded view, which **includes** `keyGenId`;
`verifyBgManifest` additionally re-derives `keyGenId` from the key. A manifest is
produced — including its `keyGenId` and `mac` — by the **preflight (P4-2)**, not by
this slice; the round-trip test in 1.6 constructs one by hand.)
**Verify:** step 1.6's `testManifestSignRoundTrip`, `testManifestWrongKeyFails`,
`testKeyGenMismatchRejected` pass.

#### Step 1.5 — `agents/lib/bg-state.ts` — **APPEND**

```ts
export async function readBgManifest(paths: BgRunPaths): Promise<BgRunManifest> {
	const raw = await readUtf8FileNoSymlink(paths.manifestPath, "manifest file");
	const m = JSON.parse(raw) as Record<string, unknown>;
	const allowed = new Set(["version", "runId", "identity", "task", "options", "mac", "keyGenId"]);
	for (const k of Object.keys(m)) if (!allowed.has(k)) throw new Error(`unknown manifest key: ${k}`);
	if (m.version !== 1) throw new Error("manifest version must be 1");
	if (m.runId !== paths.runId) throw new Error("manifest runId does not match path");
	const id = m.identity as Record<string, unknown> | undefined;
	if (!id || typeof id !== "object" || Object.keys(id).length !== 3
		|| typeof id.agentName !== "string" || typeof id.canonicalPath !== "string" || typeof id.expectedHash !== "string")
		throw new Error("manifest identity is not {agentName,canonicalPath,expectedHash} strings");
	if (typeof m.task !== "string") throw new Error("manifest task must be a string");
	if (Buffer.byteLength(m.task, "utf8") > BG_MAX_TASK_BYTES) throw new Error("manifest task too large");
	const opts = m.options as Record<string, unknown> | undefined;
	if (!opts || typeof opts !== "object") throw new Error("manifest options missing");
	for (const k of Object.keys(opts)) if (!["cwd", "homeDir", "maxDurationSec"].includes(k)) throw new Error(`unknown options key: ${k}`);
	if (typeof opts.cwd !== "string" || typeof opts.homeDir !== "string") throw new Error("manifest options.cwd/homeDir must be strings");
	if (opts.maxDurationSec !== undefined && (!Number.isInteger(opts.maxDurationSec) || (opts.maxDurationSec as number) < 1 || (opts.maxDurationSec as number) > BG_MAX_DURATION_SEC))
		throw new Error("manifest options.maxDurationSec out of range");
	if (typeof m.mac !== "string" || !/^[0-9a-f]{64}$/.test(m.mac)) throw new Error("manifest mac malformed");
	if (typeof m.keyGenId !== "string" || !/^[0-9a-f]{8}$/.test(m.keyGenId)) throw new Error("manifest keyGenId malformed");
	return m as unknown as BgRunManifest;
}
```
**Verify:** step 1.6's `testReadManifestValid`, `testReadManifestRejectsUnknownField`,
`testReadManifestTaskTooLarge`, `testReadManifestBadTimeout` pass.

#### Step 1.6 — `agents/test-fixtures/test-bg-state.mjs` — **EDIT** (anchored) + **APPEND**

First **EDIT** the import block to pull in the new exports. `ANCHOR`:
```js
  countActiveBgRuns,
  createBgRunState,
```
`REPLACE`:
```js
  countActiveBgRuns,
  createBgRunState,
  keyGenIdFromKey,
  readBgManifest,
  signBgManifest,
  verifyBgManifest,
```
Then **APPEND** these functions (before the `main()` that runs the suite), and add a
`await test("…", …)` line for each inside `main()` (anchor the registration on the
last existing `await test(` line). Group 3 source:
```js
function validManifest(home, key) {
  const m = {
    version: 1,
    runId: "bg-test-m001",
    identity: { agentName: "scout", canonicalPath: "/tmp/scout.md", expectedHash: "a".repeat(64) },
    task: "find issues",
    options: { cwd: "/tmp/project", homeDir: home, maxDurationSec: 120 },
    keyGenId: keyGenIdFromKey(key),
  };
  return { ...m, mac: signBgManifest(m, key) };
}

async function testManifestSignRoundTrip() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const m = validManifest(home, key);
    assert.equal(verifyBgManifest(m, key), true);
  });
}

async function testManifestTamperFails() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const m = validManifest(home, key);
    const tampered = { ...m, task: "rm -rf /" };
    assert.equal(verifyBgManifest(tampered, key), false);
  });
}

async function testManifestWrongKeyFails() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const m = validManifest(home, key);
    const otherKey = Buffer.alloc(32, 9);
    assert.equal(verifyBgManifest(m, otherKey), false);
  });
}

async function testKeyGenMismatchRejected() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const wrongGen = keyGenIdFromKey(Buffer.alloc(32, 9)); // a gen id NOT derivable from `key`
    // Body carries the wrong keyGenId; we then sign a VALID mac over it under the real key.
    const body = {
      version: 1, runId: "bg-test-kg01",
      identity: { agentName: "scout", canonicalPath: "/tmp/scout.md", expectedHash: "a".repeat(64) },
      task: "t", options: { cwd: "/", homeDir: home }, keyGenId: wrongGen,
    };
    const m = { ...body, mac: signBgManifest(body, key) };
    // mac passes (signed over this exact body), but wrongGen !== keyGenIdFromKey(key) ⇒ rejected.
    assert.equal(verifyBgManifest(m, key), false);
  });
}

async function testCanonicalRejectsNonFinite() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    assert.throws(() => signBgManifest({ version: 1, runId: "x", identity: {}, task: "", options: { cwd: "/", homeDir: home, maxDurationSec: Infinity }, keyGenId: keyGenIdFromKey(key) }, key), /non-finite number/);
  });
}

async function testReadManifestValid() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const paths = await createBgRunState({ homeDir: home, runId: "bg-test-m001", effectiveTimeoutSec: 120 });
    const m = validManifest(home, key);
    await writeBgManifest(paths, m);
    assert.deepEqual(await readBgManifest(paths), m);
  });
}

async function testReadManifestRejectsUnknownField() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const paths = await createBgRunState({ homeDir: home, runId: "bg-test-m002", effectiveTimeoutSec: 120 });
    const m = { ...validManifest(home, key), runId: "bg-test-m002", evil: true };
    m.mac = signBgManifest({ ...m, mac: undefined }, key);
    await writeBgManifest(paths, m);
    await assert.rejects(() => readBgManifest(paths), /unknown manifest key: evil/);
  });
}

async function testReadManifestTaskTooLarge() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const paths = await createBgRunState({ homeDir: home, runId: "bg-test-m003", effectiveTimeoutSec: 120 });
    const m = { ...validManifest(home, key), runId: "bg-test-m003", task: "x".repeat(64_001) };
    m.mac = signBgManifest({ ...m, mac: undefined }, key);
    await writeBgManifest(paths, m);
    await assert.rejects(() => readBgManifest(paths), /task too large/);
  });
}

async function testReadManifestBadTimeout() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const paths = await createBgRunState({ homeDir: home, runId: "bg-test-m004", effectiveTimeoutSec: 120 });
    const m = { ...validManifest(home, key), runId: "bg-test-m004", options: { cwd: "/", homeDir: home, maxDurationSec: 0 } };
    m.mac = signBgManifest({ ...m, mac: undefined }, key);
    await writeBgManifest(paths, m);
    await assert.rejects(() => readBgManifest(paths), /maxDurationSec out of range/);
  });
}
```
**Verify:** `node --experimental-strip-types agents/test-fixtures/test-bg-state.mjs`
runs all Group 3 tests green AND the full prior suite stays green.

---

### Phase 2 — P4R-0 authority-root binding (REQ-AR1/2/3)

#### Step 2.1 — `agents/lib/bg-state.ts` — **APPEND**

```ts
// N1: getpwuid-based home — ignores $HOME, unlike os.homedir().
export function resolveTrustedHome(): string {
	return os.userInfo().homedir;
}
```
**Verify:** `HOME=/tmp/fake-home-xyz node --experimental-strip-types -e 'import("./agents/lib/bg-state.ts").then(m=>{if(m.resolveTrustedHome()!==require("os").userInfo().homedir)process.exit(1)})'`
exits `0` even with `HOME` poisoned — fails if the body uses `os.homedir()`.

#### Step 2.2 — `agents/lib/bg-state.ts` — **EDIT** (anchored, 11 sites)

Replace the literal text `os.homedir()` with `resolveTrustedHome()` at **all 11**
occurrences — both the default-parameter form (`homeDir = os.homedir()`) and the
`options.homeDir ?? os.homedir()` expression form. The 11 enclosing sites:
`getBgStateDir`, `getBgSessionMacPath`, `getBgRunPaths`, `ensureBgStateDir`,
`readOrCreateSessionMacKey`, `readSessionMacKey`, `deleteSessionMacKey`,
`createBgRunState` (`??` form), `listBgRuns`, `countActiveBgRuns`,
`cleanupBgStateOnSessionStart` (`??` form). Mechanical rule: every literal
`os.homedir()` in this file becomes `resolveTrustedHome()` — do not stop on the `??`
sites.
**Verify:** `git grep -n "os.homedir()" agents/lib/bg-state.ts` returns **nothing**
(empty output, exit 1) AND the suite stays green.

#### Step 2.3 — `agents/lib/bg-state.ts` — **APPEND**

```ts
export function assertManifestIdentityMatchesRuntime(m: BgRunManifest, trusted: { homeDir: string }): void {
	if (m.options.homeDir !== trusted.homeDir) throw new Error("manifest homeDir does not match trusted runtime");
	// cwd is advisory identity only — NOT compared (N6).
}
```
**Verify:** step 2.5's `testManifestHomeDirMismatchRejected` passes.

#### Step 2.4 — `agents/test-fixtures/test-bg-state.mjs` — **APPEND** + register

Import `resolveTrustedHome`, `assertManifestIdentityMatchesRuntime` (extend the
anchored import block as in 1.6). Add and register:
```js
async function testWorkerRootIgnoresHomeEnv() {
  const before = resolveTrustedHome();
  const saved = process.env.HOME;
  try {
    process.env.HOME = "/tmp/fake-home-xyz";
    assert.equal(resolveTrustedHome(), before);          // $HOME poison does not move the root
    assert.equal(resolveTrustedHome(), os.userInfo().homedir);
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
  }
}
```
**Verify:** suite green; `testWorkerRootIgnoresHomeEnv` fails if `resolveTrustedHome`
reads `$HOME`.

#### Step 2.5 — `agents/test-fixtures/test-bg-state.mjs` — **APPEND** + register

```js
async function testStateRootsShareTrustedHome() {
  await withTempHome(async (home) => {
    const base = path.join(home, ".pi", "agent");
    assert.ok(getBgStateDir(home).startsWith(base));
    assert.ok(getBgSessionMacPath(home).startsWith(base));
    assert.ok(getBgRunPaths("bg-x0001", home).runDir.startsWith(base));
  });
}

async function testManifestHomeDirMismatchRejected() {
  await withTempHome(async (home) => {
    const key = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const m = validManifest(home, key);
    assert.throws(() => assertManifestIdentityMatchesRuntime({ ...m, options: { ...m.options, homeDir: "/tmp/fake" } }, { homeDir: home }), /does not match trusted runtime/);
    assert.doesNotThrow(() => assertManifestIdentityMatchesRuntime(m, { homeDir: home }));
  });
}

async function testFakeHomeManifestRejected() {
  await withTempHome(async (home) => {
    const realKey = await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 3));
    const fakeKey = Buffer.alloc(32, 0xff);                  // a key from an attacker $HOME store
    const fakeSigned = (() => { const m = validManifest(home, fakeKey); return m; })();
    assert.equal(verifyBgManifest(fakeSigned, realKey), false); // fake-home manifest fails real-home key
  });
}
```
**Verify:** suite green. Note: REQ-AR1 *full* wiring (the worker also passes
`resolveTrustedHome()` into `canRunAgent`/registry reads) lands in the **worker**
(P4-3); step 2.2 closes the `bg-state` defaults so a no-arg call can never follow `$HOME`.

---

### Phase 3 — P4R-1 reservation + no-kill reaping (REQ-4/5/6)

#### Step 3.1 — `agents/lib/bg-state.ts` — **EDIT** (anchored, 3 edits in this one file)

(a) Add the reservation type + `ownerHandle`/`effectiveTimeoutSec` to options. `ANCHOR`:
```ts
export type CreateBgRunOptions = {
	homeDir?: string;
	runId?: string;
	generateRunId?: () => string;
	maxConcurrentRuns?: number;
	maxAttempts?: number;
};
```
`REPLACE`:
```ts
export type BgReservation = {
	pid: number;
	ownerHandle?: string;
	startedAtMs: number;
	effectiveTimeoutSec: number;
	keyGenId: string;
};

export type CreateBgRunOptions = {
	homeDir?: string;
	runId?: string;
	generateRunId?: () => string;
	maxConcurrentRuns?: number;
	maxAttempts?: number;
	ownerHandle?: string;
	effectiveTimeoutSec?: number; // optional-with-default: missing ⇒ BG_MAX_DURATION_SEC (REQ-5)
};
```
(b) Write the reservation as a JSON line. `ANCHOR` (with leading tabs):
```ts
			await fs.writeFile(paths.reservationPath, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
```
`REPLACE`:
```ts
			const reservation: BgReservation = {
				pid: process.pid,
				ownerHandle: options.ownerHandle,
				startedAtMs: Date.now(),
				effectiveTimeoutSec: options.effectiveTimeoutSec ?? BG_MAX_DURATION_SEC,
				keyGenId: keyGenIdFromKey(await readOrCreateSessionMacKey(homeDir)),
			};
			await fs.writeFile(paths.reservationPath, `${JSON.stringify(reservation)}\n`, { mode: 0o600, flag: "wx" });
```
(`readOrCreateSessionMacKey` — NOT `readSessionMacKey`, which throws `ENOENT` before
a key exists.)
**Verify:** suite stays green (existing `createBgRunState` callers omit
`effectiveTimeoutSec` → default applies → still counted active;
`testCreateRunStateAndDoneLifecycle`'s `countActiveBgRuns===1` still holds).

#### Step 3.2 — `agents/lib/bg-state.ts` — **APPEND**

```ts
async function readReservation(paths: BgRunPaths): Promise<BgReservation> {
	const fallback: BgReservation = { pid: 0, startedAtMs: Date.now(), effectiveTimeoutSec: BG_MAX_DURATION_SEC, keyGenId: "" };
	let raw: string;
	try {
		raw = await readUtf8FileNoSymlink(paths.reservationPath, "reservation file");
	} catch (error) {
		// Unreadable/missing reservation metadata ⇒ intentionally normalize to
		// active-bounded (N4: fail toward keeping the slot), never free a live worker.
		void error;
		return fallback;
	}
	let r: Record<string, unknown>;
	try {
		r = JSON.parse(raw);
	} catch (error) {
		// JSON.parse throws only SyntaxError; whole-line parse failure ⇒ keep
		// active, bounded (N4). No other error type is expected here.
		if (!(error instanceof SyntaxError)) throw error;
		return fallback;
	}
	const startedAtMs = (typeof r.startedAtMs === "number" && Number.isFinite(r.startedAtMs) && r.startedAtMs <= Date.now())
		? r.startedAtMs : Date.now();                       // future/non-finite ⇒ age 0 (N4)
	const effectiveTimeoutSec = (Number.isInteger(r.effectiveTimeoutSec) && (r.effectiveTimeoutSec as number) > 0)
		? (r.effectiveTimeoutSec as number) : BG_MAX_DURATION_SEC; // missing/invalid ⇒ ceiling (N4)
	return {
		pid: typeof r.pid === "number" ? r.pid : 0,
		ownerHandle: typeof r.ownerHandle === "string" ? r.ownerHandle : undefined,
		startedAtMs,
		effectiveTimeoutSec,
		keyGenId: typeof r.keyGenId === "string" ? r.keyGenId : "",
	};
}

function isReservationExpired(r: BgReservation): boolean {
	return Date.now() - r.startedAtMs > r.effectiveTimeoutSec * 1000 + BG_REAP_GRACE_MS;
}
```
(No `{stale:true}` path — see the Corrupt-metadata policy above. `isReservationExpired`
is age-only; `isAlive` is consulted only by `reapStaleBgRuns`, step 3.4.)
**Verify:** step 3.5's `testFutureStartedAtKeptActive`, `testBadTimeoutKeptActiveBounded`,
`testActiveExcludesStale` pass.

#### Step 3.3 — `agents/lib/bg-state.ts` — **EDIT** (anchored)

Replace `countActiveBgRuns` so it excludes age-expired reservations. `ANCHOR`:
```ts
export async function countActiveBgRuns(homeDir = resolveTrustedHome()): Promise<number> {
	const runs = await listBgRuns(homeDir);
	return runs.filter((run) => run.reserved && !run.done).length;
}
```
`REPLACE`:
```ts
export async function countActiveBgRuns(homeDir = resolveTrustedHome()): Promise<number> {
	const runs = await listBgRuns(homeDir);
	const active = await Promise.all(runs.map(async (run) => {
		if (run.done) return false;
		if (!run.reserved) return false;
		return !isReservationExpired(await readReservation(getBgRunPaths(run.runId, homeDir)));
	}));
	return active.filter(Boolean).length;
}
```
(This is the **async restructure**: `readReservation` is awaited inside a
`Promise.all(map(...))`, never inside `.filter()`. The admission path takes **no**
`isAlive` — liveness is the reaper's job, step 3.4.)
**Verify:** step 3.5's `testActiveExcludesStale` passes (a far-past `startedAtMs`
reservation is excluded) AND `testFutureStartedAtKeptActive` passes (a future one is
kept).

#### Step 3.4 — `agents/lib/bg-state.ts` — **APPEND**

```ts
export async function reapStaleBgRuns(
	homeDir = resolveTrustedHome(),
	opts?: { isAlive?: (h: string) => boolean },
): Promise<{ reapedRunIds: string[] }> {
	const reapedRunIds: string[] = [];
	for (const run of await listBgRuns(homeDir)) {
		if (run.done || !run.reserved) continue;
		const paths = getBgRunPaths(run.runId, homeDir);
		const r = await readReservation(paths);
		const expired = isReservationExpired(r);
		const dead = opts?.isAlive && r.ownerHandle ? !opts.isAlive(r.ownerHandle) : false;
		if (!expired && !dead) continue;
		try {
			await writeBgResult(paths, { version: 1, runId: run.runId, status: expired ? "timed-out" : "stopped" });
			await markBgRunDone(paths);
			reapedRunIds.push(run.runId);
		} catch (error) {
			// Lost a concurrent race (already done / removed) — tolerate and continue (M2).
			const code = (error as { code?: string }).code;
			if (code === "ENOENT" || code === "EEXIST" || /already done|not reserved/.test(String((error as Error).message))) continue;
			throw error;
		}
	}
	return { reapedRunIds };
}
```
Then wire it into session-start cleanup. `ANCHOR` (in `cleanupBgStateOnSessionStart`):
```ts
	const runs = await listBgRuns(homeDir);
	const completed = runs.filter((run) => run.done).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
```
`REPLACE`:
```ts
	await reapStaleBgRuns(homeDir);
	const runs = await listBgRuns(homeDir);
	const completed = runs.filter((run) => run.done).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
```
**Verify:** `git grep -n "process.kill" agents/lib/bg-state.ts` returns **nothing**;
step 3.5's `testReapExpiredFreesSlotNoSignal`, `testReapUsesInjectedIsAlive`,
`testReaperNeverSignals` pass.

#### Step 3.5 — `agents/test-fixtures/test-bg-state.mjs` — **APPEND** + register

Import `reapStaleBgRuns`, `getBgRunPaths` (already imported). Helper writes a
reservation with a chosen age; tests assert count/free behavior and the kill-spy.
```js
async function writeReservationAge(home, runId, { startedAtMs, effectiveTimeoutSec = 60, ownerHandle } = {}) {
  const paths = await createBgRunState({ homeDir: home, runId, effectiveTimeoutSec, ownerHandle });
  // Overwrite startedAtMs to control age (createBgRunState stamps "now").
  const line = JSON.stringify({ pid: 4242, ownerHandle, startedAtMs, effectiveTimeoutSec, keyGenId: "00000000" }) + "\n";
  await fs.writeFile(paths.reservationPath, line, { mode: 0o600 });
  return paths;
}

async function testReservationMetadata() {
  await withTempHome(async (home) => {
    const paths = await createBgRunState({ homeDir: home, runId: "bg-resv-001", effectiveTimeoutSec: 99, ownerHandle: "win-7" });
    const r = JSON.parse((await fs.readFile(paths.reservationPath, "utf8")).trim());
    assert.equal(r.effectiveTimeoutSec, 99);
    assert.equal(r.ownerHandle, "win-7");
    assert.equal(typeof r.startedAtMs, "number");
    assert.match(r.keyGenId, /^[0-9a-f]{8}$/);
  });
}

async function testFutureStartedAtKeptActive() {
  await withTempHome(async (home) => {
    await writeReservationAge(home, "bg-resv-002", { startedAtMs: Date.now() + 3_600_000, effectiveTimeoutSec: 1 });
    assert.equal(await countActiveBgRuns(home), 1); // future stamp ⇒ age 0 ⇒ kept
  });
}

async function testBadTimeoutKeptActiveBounded() {
  await withTempHome(async (home) => {
    const paths = await createBgRunState({ homeDir: home, runId: "bg-resv-003", effectiveTimeoutSec: 60 });
    await fs.writeFile(paths.reservationPath, JSON.stringify({ pid: 1, startedAtMs: Date.now() }) + "\n", { mode: 0o600 });
    assert.equal(await countActiveBgRuns(home), 1); // missing effectiveTimeoutSec ⇒ default ceiling ⇒ kept
  });
}

async function testParseFailKeptActive() {
  await withTempHome(async (home) => {
    const paths = await createBgRunState({ homeDir: home, runId: "bg-resv-008", effectiveTimeoutSec: 60 });
    await fs.writeFile(paths.reservationPath, "this is not json\n", { mode: 0o600 }); // whole-line parse failure
    assert.equal(await countActiveBgRuns(home), 1); // normalized to active-bounded, NOT freed (N4)
    // And it is NOT immediately reapable (normalized startedAtMs=now, 24h ceiling):
    const { reapedRunIds } = await reapStaleBgRuns(home);
    assert.deepEqual(reapedRunIds, []); // a corrupt-but-fresh reservation is kept, not reaped
  });
}

async function testActiveExcludesStale() {
  await withTempHome(async (home) => {
    await writeReservationAge(home, "bg-resv-004", { startedAtMs: Date.now() - 10_000_000, effectiveTimeoutSec: 1 });
    assert.equal(await countActiveBgRuns(home), 0); // far past + short timeout ⇒ age-expired ⇒ excluded
  });
}

async function testReapExpiredFreesSlotNoSignal() {
  await withTempHome(async (home) => {
    const paths = await writeReservationAge(home, "bg-resv-005", { startedAtMs: Date.now() - 10_000_000, effectiveTimeoutSec: 1 });
    const { reapedRunIds } = await reapStaleBgRuns(home);
    assert.deepEqual(reapedRunIds, ["bg-resv-005"]);
    assert.equal(JSON.parse(await fs.readFile(paths.resultPath, "utf8")).status, "timed-out");
    assert.equal(await countActiveBgRuns(home), 0);
  });
}

async function testReapUsesInjectedIsAlive() {
  await withTempHome(async (home) => {
    // Not age-expired (timeout huge), but isAlive says the handle is dead ⇒ reaped as "stopped".
    await writeReservationAge(home, "bg-resv-006", { startedAtMs: Date.now(), effectiveTimeoutSec: 86_400, ownerHandle: "win-9" });
    const { reapedRunIds } = await reapStaleBgRuns(home, { isAlive: (h) => h !== "win-9" });
    assert.deepEqual(reapedRunIds, ["bg-resv-006"]);
    const paths = getBgRunPaths("bg-resv-006", home);
    assert.equal(JSON.parse(await fs.readFile(paths.resultPath, "utf8")).status, "stopped");
  });
}

async function testReaperNeverSignals() {
  await withTempHome(async (home) => {
    await writeReservationAge(home, "bg-resv-007", { startedAtMs: Date.now() - 10_000_000, effectiveTimeoutSec: 1 });
    const realKill = process.kill;
    let called = false;
    process.kill = () => { called = true; throw new Error("process.kill must not be called by the reaper"); };
    try {
      await reapStaleBgRuns(home);
    } finally {
      process.kill = realKill;
    }
    assert.equal(called, false);
  });
}
```
**Verify:** `node --experimental-strip-types agents/test-fixtures/test-bg-state.mjs`
— all Group 1 tests green; `testReaperNeverSignals` would go red if the reaper ever
called `process.kill` (the spy throws).

---

### Phase 4 — P4R-2 tolerant + honest listing (REQ-7)

#### Step 4.1 — `agents/lib/bg-state.ts` — **EDIT** (anchored, 2 edits)

(a) Add the field. `ANCHOR`:
```ts
export type BgRunSummary = BgRunPaths & {
	createdAtMs: number;
	updatedAtMs: number;
	reserved: boolean;
	done: boolean;
	status: BgRunStatus;
};
```
`REPLACE`: same block with `	quarantined?: boolean;` added before the closing `};`.

(b) Make `listBgRuns` quarantine instead of throw. `ANCHOR`:
```ts
		if (stat.isSymbolicLink()) throw new Error(`refusing symlinked background run directory: ${paths.runDir}`);
		if (!stat.isDirectory()) continue;
```
`REPLACE`:
```ts
		if (stat.isSymbolicLink()) {
			runs.push({ ...paths, createdAtMs: 0, updatedAtMs: 0, reserved: true, done: false, status: "unknown", quarantined: true });
			continue;
		}
		if (!stat.isDirectory()) continue;
```
**Verify:** step 4.4's `testListQuarantinesNotOmits` passes — a symlinked run dir is
**returned** with `quarantined:true`, not thrown.

#### Step 4.2 — `agents/lib/bg-state.ts` — **EDIT** (anchored)

Count quarantined runs as active. `ANCHOR` (the line added in 3.3):
```ts
		if (!run.reserved) return false;
		return !isReservationExpired(await readReservation(getBgRunPaths(run.runId, homeDir)));
```
`REPLACE`:
```ts
		if (run.quarantined) return true;            // active-unless-proven-done (REQ-7)
		if (!run.reserved) return false;
		return !isReservationExpired(await readReservation(getBgRunPaths(run.runId, homeDir)));
```
**Verify:** step 4.4's `testQuarantinedCountsActive` passes.

#### Step 4.3 — write/launch path unchanged (no edit)

`writeJsonAtomic` / `assertReservedRun` / `markBgRunDone` still hard-throw on symlink.
**Verify:** step 4.4's `testWritePathStillRefuses` passes (writing through a symlinked
reservation still rejects).

#### Step 4.4 — `agents/test-fixtures/test-bg-state.mjs` — **APPEND** + register

```js
async function testListQuarantinesNotOmits() {
  await withTempHome(async (home, root) => {
    await ensureBgStateDir(home);
    const outside = path.join(root, "outside-run");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(getBgStateDir(home), "bg-quar-001"));
    const runs = await listBgRuns(home);                  // must NOT throw now
    const q = runs.find((r) => r.runId === "bg-quar-001");
    assert.ok(q && q.quarantined === true);
  });
}

async function testQuarantinedCountsActive() {
  await withTempHome(async (home, root) => {
    await ensureBgStateDir(home);
    const outside = path.join(root, "outside-run-2");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(getBgStateDir(home), "bg-quar-002"));
    assert.equal(await countActiveBgRuns(home), 1);       // quarantined ⇒ active
  });
}

async function testWritePathStillRefuses() {
  await withTempHome(async (home) => {
    const paths = await createBgRunState({ homeDir: home, runId: "bg-quar-003", effectiveTimeoutSec: 60 });
    const outside = path.join(home, "outside-reservation");
    await fs.writeFile(outside, "x\n");
    await fs.rm(paths.reservationPath, { force: true });
    await fs.symlink(outside, paths.reservationPath);
    await assert.rejects(() => writeBgResult(paths, { version: 1, runId: paths.runId, status: "completed" }), /refusing symlinked state path|not reserved/);
  });
}
```
**Verify:** suite green.

---

### Phase 5 — P4R-5 MAC key lifecycle (REQ-10)

#### Step 5.1 — `agents/lib/bg-state.ts` — **APPEND**

```ts
export async function retireSessionMacKeyIfFullyIdle(homeDir = resolveTrustedHome()): Promise<boolean> {
	const runs = await listBgRuns(homeDir);
	for (const run of runs) {
		if (run.quarantined) return false;
		if (run.reserved && !run.done) return false;
	}
	await deleteSessionMacKey(homeDir);
	return true;
}
```
(Does not modify `deleteSessionMacKey`.)
**Verify:** step 5.4's `testMacKeyRetainedWhileAnyRun`, `testMacKeyRetiredOnlyWhenFullyIdle` pass.

#### Step 5.2 — `agents/lib/bg-state.ts` — **EDIT** (anchored)

Retire at session-start, after pruning. `ANCHOR` (the end of `cleanupBgStateOnSessionStart`):
```ts
	return { prunedRunIds, removedPromptFiles, removedEventFiles };
}
```
`REPLACE`:
```ts
	await retireSessionMacKeyIfFullyIdle(homeDir);
	return { prunedRunIds, removedPromptFiles, removedEventFiles };
}
```
(There is exactly one such `return { prunedRunIds, … }` — in `cleanupBgStateOnSessionStart`.)
**Verify:** suite green.

#### Step 5.3 — `agents/index.ts` — **EDIT** (anchored)

Extend the **existing** `session_shutdown` handler to reap (free slots). Do NOT add a
second handler and do NOT use a `pi.on(...)` API (the file has none — handlers go
through `eventApi.on?.`). `ANCHOR`:
```ts
	eventApi.on?.("session_shutdown", (_event, ctx) => {
		disposeBackgroundRuns(ctx?.ui ?? { setWidget: () => {} });
	});
```
`REPLACE`:
```ts
	eventApi.on?.("session_shutdown", async (_event, ctx) => {
		disposeBackgroundRuns(ctx?.ui ?? { setWidget: () => {} });
		await reapStaleBgRuns(resolveTrustedHome()); // free slots only — NOT key retirement (N5)
	});
```
Import `reapStaleBgRuns`, `resolveTrustedHome` from `./lib/bg-state.ts` (extend the
existing import). The `os.homedir()` already present at `agents/index.ts:73` is
**host-context** and stays — N1 binds the worker, not the host extension.
**Verify:** `pi --no-extensions -e ./agents/index.ts --list-models` succeeds AND
`grep -c 'eventApi.on?.("session_shutdown"' agents/index.ts` returns `1` (no duplicate
handler).

#### Step 5.4 — `agents/test-fixtures/test-bg-state.mjs` — **APPEND** + register

```js
async function testMacKeyRetainedWhileAnyRun() {
  await withTempHome(async (home) => {
    await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 5));
    await createBgRunState({ homeDir: home, runId: "bg-mac-001", effectiveTimeoutSec: 86_400 }); // reserved, not done
    assert.equal(await retireSessionMacKeyIfFullyIdle(home), false);
    await fs.stat(getBgSessionMacPath(home)); // still present (no throw)
  });
}

async function testMacKeyRetiredOnlyWhenFullyIdle() {
  await withTempHome(async (home) => {
    await readOrCreateSessionMacKey(home, () => Buffer.alloc(32, 5));
    const paths = await createBgRunState({ homeDir: home, runId: "bg-mac-002", effectiveTimeoutSec: 60 });
    await writeBgResult(paths, { version: 1, runId: paths.runId, status: "completed" });
    await markBgRunDone(paths); // now fully idle (done)
    assert.equal(await retireSessionMacKeyIfFullyIdle(home), true);
    await assert.rejects(() => fs.stat(getBgSessionMacPath(home)), /ENOENT/);
  });
}
```
**Verify:** suite green.

---

### Phase 6 — P4R-6 hygiene + parent-plan correction (REQ-11/12/13)

#### Step 6.1 — `agents/test-fixtures/test-bg-state.mjs` — **APPEND** + register

The comparators in `listBgRuns` (`b.updatedAtMs - a.updatedAtMs`) and
`cleanupBgStateOnSessionStart` already sort by `updatedAtMs` — this step adds the
**regression guard** that ordering follows mtime, not `createdAtMs`/birthtime, so a
future edit can't reintroduce birthtime ordering.
```js
async function testOrderingUsesMtimeNotBirthtime() {
  await withTempHome(async (home) => {
    const a = await createBgRunState({ homeDir: home, runId: "bg-ord-001", effectiveTimeoutSec: 60 });
    const b = await createBgRunState({ homeDir: home, runId: "bg-ord-002", effectiveTimeoutSec: 60 });
    // Make 'a' the most-recently-modified despite being created first.
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(a.runDir, later, later);
    const runs = await listBgRuns(home);
    assert.equal(runs[0].runId, "bg-ord-001"); // newest mtime first, regardless of birth order
  });
}
```
**Verify:** suite green; the test fails if any comparator switches to birthtime.

#### Step 6.2 — `agents/lib/bg-state.ts` — **EDIT** (anchored)

Retain `events.jsonl` for kept (non-pruned) runs; pruned runs lose it with their dir.
`ANCHOR`:
```ts
		if (removeEventFiles && run.done) {
			if (await existsRegularFileNoSymlink(run.eventsPath)) {
				await fs.rm(run.eventsPath, { force: true });
				removedEventFiles.push(run.eventsPath);
			}
		}
```
`REPLACE`:
```ts
		// P4R-6: events.jsonl is retained for kept runs; pruned runs already lose it
		// with their whole dir. (removeEventFiles no longer wipes kept-run events.)
```
**Verify:** step 6.3-area `testEventsRetentionPolicy` passes:
```js
async function testEventsRetentionPolicy() {
  await withTempHome(async (home) => {
    const paths = await createBgRunState({ homeDir: home, runId: "bg-evt-001", effectiveTimeoutSec: 60 });
    await appendBgEvent(paths, { type: "started" });
    await writeBgResult(paths, { version: 1, runId: paths.runId, status: "completed" });
    await markBgRunDone(paths);
    await cleanupBgStateOnSessionStart({ homeDir: home, keepRecentRuns: 20 }); // kept (within keep window)
    assert.ok(await fs.readFile(paths.eventsPath, "utf8")); // retained, not wiped
  });
}
```
If `testCleanupPrunesCompletedAndRemovesPromptFiles` (existing) asserts a **kept**
run's events were removed, update that single assertion to expect retention (it lives
in the same file; fixture-change ledger — flag it in the commit). If it only asserts
**prompt-file** removal, no change is needed.

#### Step 6.3 — `agents/test-fixtures/test-bg-state.mjs` — **APPEND** + register

```js
async function testConcurrentCreateNeverOverAdmits() {
  await withTempHome(async (home) => {
    const k = 3;
    const attempts = Array.from({ length: 8 }, (_, i) =>
      createBgRunState({ homeDir: home, runId: `bg-conc-${i}`, maxConcurrentRuns: k, effectiveTimeoutSec: 86_400 })
        .then(() => true).catch(() => false));
    const ok = (await Promise.all(attempts)).filter(Boolean).length;
    assert.ok(ok <= k, `admitted ${ok} > cap ${k}`);
  });
}
```
**Verify:** suite green; asserts admitted reservations never exceed the cap.

#### Step 6.4 — `agents/docs/P4_BACKGROUND_AGENTS_PLAN.md` — **EDIT** (doc)

Find every passage asserting that the manifest carries **"identity, not
authority"** (grep the file for `identity, not authority` and for `homeDir` /
`cwd` described as non-authoritative) and replace each with: manifest `homeDir` is
identity **verified against** `resolveTrustedHome()` and rejected on mismatch; the
worker sources all roots from `os.userInfo().homedir`, never `$HOME`/`os.homedir()`
or a manifest field. Add a "Scope: user agents first" note near the top. If a
passage matching that phrase is **not** found, STOP and ask (the parent plan may
have been reworded) — do not guess which prose to change.
**Verify:** `git diff --name-only` for this commit lists **only**
`agents/docs/P4_BACKGROUND_AGENTS_PLAN.md`.

---

### Definition of done (whole plan)

All four must hold:
1. `bash agents/test-fixtures/run-bg-state-tests.sh` prints all ~29 tests passing,
   and the retained P4-1 suite is green within it.
2. `pi --no-extensions -e ./agents/index.ts --list-models` succeeds (load smoke).
3. `git grep -n "process.kill" agents/lib/bg-state.ts` returns **nothing** (no-kill
   invariant, N3).
4. `git grep -n "os.homedir()" agents/lib/bg-state.ts` returns **nothing**
   (trusted-root invariant, N1 — only `os.userInfo().homedir`, via
   `resolveTrustedHome()`, is used in the worker-facing module).
