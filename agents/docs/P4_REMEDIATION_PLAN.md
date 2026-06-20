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
runtime** (`os.homedir()`) and the backend-provided manifest *path*, never from
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
| REQ-5 | Each reservation records `pid` (diagnostic only), optional opaque `ownerHandle` (backend window/pgid, for `bg-stop`), `startedAtMs`, a **required** `effectiveTimeoutSec`, and `keyGenId`. A `startedAtMs` in the future or unparseable metadata is treated as age 0 (kept active until a real timeout), never as immediately reclaimable | `testReservationMetadata`, `testFutureStartedAtKeptActive` | MUST | N4. Fail toward keeping the slot |
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
| Worker locates registry/MAC/state via attacker-influenced `homeDir` → circular MAC, false grant | Critical | P4R-0: trusted-runtime root only; manifest `homeDir`/`cwd` identity-only, reject-on-mismatch | `testWorkerIgnoresManifestHomeDir`, `testFakeHomeManifestRejected` |
| Stale reservation exhausts the 5-slot cap (self-DoS) | High | age + injected `isAlive` reaping frees the slot | `testReapExpiredFreesSlotNoSignal`, `testActiveExcludesStale` |
| Reaper signals a reused pid (kills unrelated process) | High | **No-kill-on-reap** — reaper never calls `process.kill`; killing is the backend handle's job via `bg-stop` (N3) | `testReaperNeverSignals` |
| Corrupting a live run's dir drops it from cap accounting + status | High | Quarantine = returned + active-unless-proven-dead | `testQuarantinedCountsActive` |
| Tampered/forged manifest verifies | High | mac-excluded canonical view, non-finite rejection, exact-schema validation, `keyGenId` | `testManifestTamperFails`, `testCanonicalRejectsNonFinite` |
| MAC key rotated under a running worker / leaked forever | Medium | Retain while active-post-reaping; guaranteed retirement; `keyGenId` | `testMacKeyRetainedWhileActive`, `testMacKeyRetiredWhenIdle` |

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
  effectiveTimeoutSec: number; // REQUIRED; preflight resolves the default
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
  grace`) AND not (`isAlive` injected and returns false). Reaping **frees the slot
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
| `agents/index.ts` | 53, (new) `session_shutdown` | lifecycle | P4R-5: gated key retirement |
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

Group 1: reservation + no-kill reaping (P4R-1) (5 tests)
  testReservationMetadata
  testFutureStartedAtKeptActive
  testReapExpiredFreesSlotNoSignal
  testReapUsesInjectedIsAlive
  testReaperNeverSignals + testActiveExcludesStale

Group 2: tolerant + honest listing (P4R-2) (3 tests)
  testListQuarantinesNotOmits
  testQuarantinedCountsActive
  testWritePathStillRefuses

Group 3: manifest integrity + schema (P4R-3) (6 tests)
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

Total: ~27 tests. `testReaperNeverSignals` injects a fake `process.kill` spy and
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
- **events.jsonl retention (F7):** retain for kept runs vs wipe-on-start. Deferral:
  P4R-6. Proposal: retain for non-pruned runs, wipe on prune.
- **Worker entrypoint / `-e` loader source (B9):** trusted installed path vs
  `pi.exec`. Deferral: P4-3 plan. Hard rule: cwd/env/manifest must not decide
  worker code or loader source.

## Done Criteria

- [ ] ~27 MUST/SHOULD tests pass; P4-1 suite still green.
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
| `agents/index.ts` | P4R-5 `session_shutdown` gated key retirement |
| `agents/test-fixtures/test-bg-state.mjs` | Groups 0–5 (~27 tests) |
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
made above; below are exact signatures, exact edit anchors, and a verify command
per step.

### Executor contract (read first)

1. Do the **phases and steps in the exact order printed below** (Phase 1 → 6).
   The order is the build order — it is NOT the slice-ID number order. Do not
   skip, reorder, or batch. Every step compiles and tests at the point it appears.
2. Each step says exactly which file, what to add/change, and how to verify.
3. **Make no design decisions.** There are none left below. If a step seems to
   require one, or the anchor text is not found verbatim, **STOP and ask** — do
   not guess or invent an alternative.
4. Run the verify command after each step. If it fails, fix only that step; do
   not proceed until green.
5. Test command (the ONLY one; `run-bg-state-tests.sh` is created in Phase 0):
   `node --experimental-strip-types agents/test-fixtures/test-bg-state.mjs`.
6. Do not edit any file not named in the step. `child-runner.ts`,
   `can-run-agent.ts`, `registry.ts` are **read-only references** — never edit them.
7. One phase = one commit, message `P4R-<id>: <slice title>`, trailer
   `Co-Authored-By: <tool>` (see README).

**Build order: Phase 0 → 1 → 2 → 3 → 4 → 5 → 6.** Each phase is one slice; the
phase number is the build order, not the slice-ID order (P4R-3's manifest helpers
are built in Phase 1 because later phases depend on `keyGenId`).

### Phase 0 — constants + test runner (so later steps and the verify command exist)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 0.1 | `bg-state.ts` | Add these three module-level constants with the existing `export const`s at the top of the file (they are runtime values used by steps 1.5 and 3.3 — add them FIRST or those steps throw `ReferenceError`): `export const BG_REAP_GRACE_MS = 30_000;` `export const BG_MAX_TASK_BYTES = 64_000;` `export const BG_MAX_DURATION_SEC = 86_400;` | `grep -nE "BG_REAP_GRACE_MS\|BG_MAX_TASK_BYTES\|BG_MAX_DURATION_SEC" agents/lib/bg-state.ts` shows all three |
| 0.2 | `agents/test-fixtures/run-bg-state-tests.sh` | Create with two lines: `#!/usr/bin/env bash` and `exec node --experimental-strip-types "$(dirname "$0")/test-bg-state.mjs"`. `chmod +x` it. | `bash agents/test-fixtures/run-bg-state-tests.sh` runs the existing suite green |

### Phase 1 — P4R-3 manifest integrity + schema + `keyGenId` (REQ-8/9)

Built first because `keyGenId`/`verifyBgManifest` are prerequisites for later phases.

| Step | File | Exact action | Verify |
|---|---|---|---|
| 1.1 | `bg-state.ts` | In `canonicalJson`, replace the final `return JSON.stringify(value);` with: `if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite number in signed payload"); return JSON.stringify(value); } if (typeof value === "string" || typeof value === "boolean" || value === null) return JSON.stringify(value); throw new Error("unsupported type in signed payload: " + typeof value);` (leaves `string`/`boolean`/`null` untouched; rejects `bigint`/`function`/`symbol`). | `testCanonicalRejectsNonFinite` green AND `testSessionMacKeyLifecycleAndSigning` still green (round-trip) |
| 1.2 | `bg-state.ts` | Add `keyGenIdFromKey(key: Buffer): string` = `createHmac("sha256", key).update("keygen").digest("hex").slice(0, 8)`. | `grep -n keyGenIdFromKey agents/lib/bg-state.ts` |
| 1.3 | `bg-state.ts` | Add `keyGenId: string` to `BgRunManifest` type (alongside `mac`). | typecheck/grep |
| 1.4 | `bg-state.ts` | Add `signBgManifest(m: Omit<BgRunManifest,"mac">, key: Buffer): string` = `signBgPayload(m, key)`. Add `verifyBgManifest(m: BgRunManifest, key: Buffer): boolean`: copy `m` without `mac`, return `verifyBgPayloadMac(copyWithoutMac, key, m.mac) && m.keyGenId === keyGenIdFromKey(key)`. | `testManifestSignRoundTrip`, `testManifestWrongKeyFails`, `testKeyGenMismatchRejected` |
| 1.5 | `bg-state.ts` | Add `readBgManifest(paths: BgRunPaths): Promise<BgRunManifest>`: `readUtf8FileNoSymlink` → `JSON.parse` → exact-schema: `version===1`; `runId===paths.runId`; `identity` has exactly `{agentName,canonicalPath,expectedHash}` all strings; `options` keys are a subset of `{cwd,homeDir,maxDurationSec}` with `cwd`/`homeDir` strings; if `maxDurationSec` present, `Number.isInteger` and `1 <= it <= BG_MAX_DURATION_SEC`; `Buffer.byteLength(task,"utf8") <= BG_MAX_TASK_BYTES`; `/^[0-9a-f]{64}$/.test(mac)`; `/^[0-9a-f]{8}$/.test(keyGenId)`; **no unknown top-level keys** (allowed set: `version,runId,identity,task,options,mac,keyGenId`). Throw a distinct `Error` message per failure. | `testReadManifestValid`, `testReadManifestRejectsUnknownField`, `testReadManifestTaskTooLarge`, `testReadManifestBadTimeout` |
| 1.6 | `test-bg-state.mjs` | Add Group 3 tests + `testKeyGenMismatchRejected`. Register all in `main()`. | suite green |

### Phase 2 — P4R-0 authority-root binding (REQ-AR1/2/3)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 2.1 | `bg-state.ts` | Add `export function resolveTrustedHome(): string { return os.userInfo().homedir; }`. (Note: NOT `os.homedir()` — that follows `$HOME`.) | `grep -n "os.userInfo().homedir" agents/lib/bg-state.ts` |
| 2.2 | `bg-state.ts` | **Rebind every `os.homedir()` occurrence** to `resolveTrustedHome()`, in both forms: the `homeDir = os.homedir()` default-parameter form AND the `options.homeDir ?? os.homedir()` expression form (→ `?? resolveTrustedHome()`). There are 11 sites (≈L84,88,92,108,117,140,146,169,208,245,287): `getBgStateDir`, `getBgSessionMacPath`, `getBgRunPaths`, `ensureBgStateDir`, `readOrCreateSessionMacKey`, `readSessionMacKey`, `deleteSessionMacKey`, `createBgRunState` (`??` form, L169), `listBgRuns`, `countActiveBgRuns`, `cleanupBgStateOnSessionStart` (`??` form, L287). Mechanical rule: replace the literal text `os.homedir()` with `resolveTrustedHome()` at all 11 — do not stop on the `??` sites. This makes DoD #3's grep reachable and closes the N1 footgun for no-arg callers. | `git grep -n "os.homedir()" agents/lib/bg-state.ts` returns **nothing** |
| 2.3 | `bg-state.ts` | Add `export function assertManifestIdentityMatchesRuntime(m: BgRunManifest, trusted: { homeDir: string }): void { if (m.options.homeDir !== trusted.homeDir) throw new Error("manifest homeDir does not match trusted runtime"); }`. Do **not** compare `cwd` (N6). | `grep -n assertManifestIdentityMatchesRuntime agents/lib/bg-state.ts` |
| 2.4 | `test-bg-state.mjs` | Add `testWorkerRootIgnoresHomeEnv`: save `process.env.HOME`, set it to `/tmp/fake-home-xyz`, assert `resolveTrustedHome()` is unchanged from the pre-poison value (it equals `os.userInfo().homedir`), restore `HOME` in a `finally`. | suite green |
| 2.5 | `test-bg-state.mjs` | Add `testStateRootsShareTrustedHome` (all of `getBgStateDir(home)`, `getBgSessionMacPath(home)`, `getBgRunPaths("bg-x",home).runDir` start with `path.join(home,".pi","agent")`); `testManifestHomeDirMismatchRejected` (helper throws on `options.homeDir="/tmp/fake"`); `testFakeHomeManifestRejected` (sign manifest with a key from a fake home dir, `verifyBgManifest` with the real home's key ⇒ `false` — uses Phase 1 helpers, already built). | suite green |

Note: REQ-AR1 *full* wiring (the worker passes `resolveTrustedHome()` into
`canRunAgent`/registry reads too) is completed in the **worker** (P4-3); step 2.2
closes the `bg-state` defaults so a no-arg call can never follow `$HOME`.

### Phase 3 — P4R-1 reservation + no-kill reaping (REQ-4/5/6)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 3.1 | `bg-state.ts` | Define the reservation type: `type BgReservation = { pid: number; ownerHandle?: string; startedAtMs: number; effectiveTimeoutSec: number; keyGenId: string };`. Then replace the reservation write `await fs.writeFile(paths.reservationPath, \`${process.pid}\n\`, ...)` (≈L188) with a single JSON line: `JSON.stringify({ pid: process.pid, ownerHandle: options.ownerHandle, startedAtMs: Date.now(), effectiveTimeoutSec, keyGenId } satisfies BgReservation) + "\n"`. Add required `effectiveTimeoutSec: number` and optional `ownerHandle?: string` to `CreateBgRunOptions`. Source `keyGenId` from `keyGenIdFromKey(await readOrCreateSessionMacKey(homeDir))` — use `readOrCreate…` (NOT `readSessionMacKey`, which throws `ENOENT` when no key exists yet; `createBgRunState` must not require a pre-existing key). | `grep -n "BgReservation\|readOrCreateSessionMacKey" agents/lib/bg-state.ts` |
| 3.2 | `bg-state.ts` | Add `readReservation(paths): Promise<BgReservation \| { stale: true }>`: parse the JSON line; if parse fails, or `effectiveTimeoutSec` is not a positive integer, return `{stale:true}`. If `startedAtMs` is not a finite number **or is in the future**, set it to `Date.now()` (age 0, N4) and return the reservation — do NOT mark stale for a future timestamp. | unit asserts in 3.5 |
| 3.3 | `bg-state.ts` | Add `function isReservationExpired(r): boolean` = `r.stale === true || Date.now() - r.startedAtMs > r.effectiveTimeoutSec*1000 + BG_REAP_GRACE_MS`. In `countActiveBgRuns`, exclude a reserved-not-done run when `isReservationExpired(readReservation(...))` OR (an injected `isAlive` is provided and returns `false` for `ownerHandle`). **No `process.kill` anywhere.** | `testActiveExcludesStale`, `testFutureStartedAtKeptActive` |
| 3.4 | `bg-state.ts` | Add `reapStaleBgRuns(homeDir, opts?: { isAlive?: (h: string) => boolean }): Promise<{reapedRunIds:string[]}>`: for each reserved-not-done run, compute expired (3.3) and `dead = opts?.isAlive && r.ownerHandle ? !opts.isAlive(r.ownerHandle) : false`; if `expired || dead`, `writeBgResult(status: expired?"timed-out":"stopped")` then `markBgRunDone`. **Never call `process.kill`.** Call `reapStaleBgRuns` from `cleanupBgStateOnSessionStart` before pruning. | `testReapExpiredFreesSlotNoSignal`, `testReapUsesInjectedIsAlive` |
| 3.5 | `test-bg-state.mjs` | Add Group 1 tests. `testReaperNeverSignals`: monkey-patch `process.kill` to a spy that throws if called, run `reapStaleBgRuns` over an expired run, assert spy never invoked; restore in `finally`. | suite green |

### Phase 4 — P4R-2 tolerant + honest listing (REQ-7)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 4.1 | `bg-state.ts` | First add `quarantined?: boolean;` to the `BgRunSummary` type. Then in `listBgRuns`, wrap the per-entry body in try/catch. On the symlink/non-canonical errors that currently `throw`, instead push `{...paths, quarantined:true, done:false, reserved:true, status:"unknown", createdAtMs:0, updatedAtMs:0}` and `continue`. Re-throw only non-`ENOENT`, non-quarantine errors. | `testListQuarantinesNotOmits` |
| 4.2 | `bg-state.ts` | In `countActiveBgRuns`, count a `quarantined` run as active unless it is provably `done`. | `testQuarantinedCountsActive` |
| 4.3 | `bg-state.ts` | Leave `writeJsonAtomic`/`assertReservedRun`/`markBgRunDone` (write/launch path) **unchanged** — still hard-throw on symlink. | `testWritePathStillRefuses` |
| 4.4 | `test-bg-state.mjs` | Add Group 2 tests. | suite green |

### Phase 5 — P4R-5 MAC key lifecycle (REQ-10)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 5.1 | `bg-state.ts` | Add `retireSessionMacKeyIfFullyIdle(homeDir): Promise<boolean>`: list runs; if **any** run is reserved, not-done, OR quarantined → return `false` (no-op). Else call existing `deleteSessionMacKey(homeDir)` and return `true`. Do **not** modify `deleteSessionMacKey`. | `testMacKeyRetainedWhileAnyRun`, `testMacKeyRetiredOnlyWhenFullyIdle` |
| 5.2 | `bg-state.ts` | In `cleanupBgStateOnSessionStart` (the session-START path), after reaping+pruning, call `retireSessionMacKeyIfFullyIdle(homeDir)`. Do **not** retire at `session_shutdown` (N5 race). | suite green |
| 5.3 | `index.ts` | Register/extend `pi.on("session_shutdown", ...)` to call only `reapStaleBgRuns(resolveTrustedHome())` (free slots) — **not** key retirement. Anchor: `export default function agentsExtension(pi)` near the `session_start` handler (`agents/index.ts:53`). | `pi --no-extensions -e ./agents/index.ts --list-models` succeeds |
| 5.4 | `test-bg-state.mjs` | Add Group 4 tests. | suite green |

### Phase 6 — P4R-6 hygiene + parent-plan correction (REQ-11/12/13)

| Step | File | Exact action | Verify |
|---|---|---|---|
| 6.1 | `bg-state.ts` | In `listBgRuns` sorting, sort by `updatedAtMs` only; never reference `createdAtMs`/`birthtimeMs` in any comparator. | `testOrderingUsesMtimeNotBirthtime` |
| 6.2 | `bg-state.ts` | In `cleanupBgStateOnSessionStart`, remove `events.jsonl` **only** for runs being pruned (not for kept runs). (Decision already made: retain for non-pruned.) | `testEventsRetentionPolicy` |
| 6.3 | `test-bg-state.mjs` | Add `testConcurrentCreateNeverOverAdmits`: `Promise.all` of N `createBgRunState` with `maxConcurrentRuns=k`; assert successful reservations ≤ `k`. | suite green |
| 6.4 | `P4_BACKGROUND_AGENTS_PLAN.md` | Replace the "manifest is identity, not authority" claims (≈L20-47, L211-228) with: manifest `homeDir` is identity verified against `resolveTrustedHome()`; the worker sources all roots from `os.userInfo().homedir`, never `$HOME`. Add a "Scope: user agents first" note. | `git diff --stat` shows only this doc |

### Definition of done (whole plan)

All three must hold:
1. `bash agents/test-fixtures/run-bg-state-tests.sh` prints all ~27 tests passing.
2. `pi --no-extensions -e ./agents/index.ts --list-models` succeeds (load smoke).
3. `git grep -n "process.kill" agents/lib/bg-state.ts` returns **nothing** (no-kill
   invariant, N3), and `git grep -n "os.homedir()" agents/lib/bg-state.ts` returns
   **nothing** (trusted-root invariant, N1 — only `os.userInfo().homedir` is used).
