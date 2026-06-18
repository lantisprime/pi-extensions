# P3f-3 Model Profiles File Discovery and Hash-Registration Plan

## Status

Planning only. Do not implement until this plan, plan review, and adversarial review are accepted.

## Episode Search Summary

Searched episodic memory for `P3f-3`, `profile registration`, `profile discovery`, `hash-registration`, `trust gap`.

Key active memories:

- `20260618-015844-canonical-workplan-p3f-2-merged-pr-35-p3-8a69`: Canonical workplan has P3f-3 as next priority alongside P3d-2. P3f-2 merged at 8c7243a.
- P3F_MODEL_PROFILES.md §Trust gap (L193-206): Full analysis of why P3f-2 trust gap exists and why P3f-3 hash-registration is the correct closure mechanism. Three adversarial reviews unanimously agreed the gap must close.
- P3F_MODEL_PROFILES.md §Slice Ladder (L215-216): P3f-3 defined as file discovery + hash-registration + diagnostics. Hard stop: none — this closes the trust gap.

## Objective

Add user-level (`~/.pi/agent/profiles/*.md`) and project-level (`.pi/profiles/*.md`) profile file discovery with frontmatter-only parsing. Hash-register project profiles in the project registry using exact path + raw-file-byte SHA-256 (same trust model as agent specs). Add a runtime profile trust check in `runChildAgent` that verifies a referenced project profile's hash matches its registry entry, closing the P3f-2 trust gap with HARD DENY on mismatch.

## Why

P3f-2 wired profile resolution but only against three built-in capability-hint profiles. Real-world use requires users and projects to define their own model profiles. Without hash-registration, a project can ship a `.pi/profiles/reviewer-profile.md` that silently downgrades a hash-registered reviewer agent to a weak model — the agent spec passes `canRunAgent` but its effective capability is determined by an unregistered file. P3f-3 extends the exact-hash registration trust anchor from agent specs to project profiles, and provides the discovery and management commands needed for practical profile use.

## Requirements (Ground Truth)

| ID | Requirement | Test(s) | Priority | Notes |
|---|---|---|---|---|
| REQ-1 | User profile files SHALL be discovered from `~/.pi/agent/profiles/*.md` using deterministic directory scanning. | `testDiscoverUserProfiles`, `testDiscoverUserProfilesEmptyDir`, `testDiscoverUserProfilesMissingDir` | MUST | Returns `[]` for missing dir (ENOENT). Sorted by filename. |
| REQ-2 | Project profile files SHALL be discovered from `.pi/profiles/*.md` only when project trust is active. | `testDiscoverProjectProfilesWhenTrusted`, `testDiscoverProjectProfilesBlockedWhenUntrusted` | MUST | Untrusted → empty list, no filesystem access to project dir. |
| REQ-3 | Profile files SHALL be frontmatter-only with accepted keys `name`, `model`, `thinking`, `purpose`. Unknown keys SHALL produce warnings. Missing frontmatter delimiters SHALL be rejected. Body content after frontmatter SHALL produce a warning. | `testParseProfileValid`, `testParseProfileRejectsMissingName`, `testParseProfileRejectsMissingFrontmatter`, `testParseProfileRejectsBodySection`, `testParseProfileWarnsUnknownKey` | MUST | Reuses `splitFrontmatter` + `parseFrontmatterBlock` from agent-markdown.ts.
| REQ-4 | Each parsed profile SHALL be validated through `validateProfile` (P3f-1) before inclusion in the profile library. Invalid profiles SHALL be reported in diagnostics but SHALL NOT block discovery of other profiles. | `testInvalidProfileListedWithIssues`, `testInvalidProfileNotInLibrary` | MUST | Same validate-before-use pattern as agent specs. |
| REQ-5 | Project profiles SHALL be hash-registered in the project registry using exact path + raw-file-byte SHA-256, stored in an additive `profiles` array on the existing registry alongside `agents`. The registry SHALL remain backward-compatible: readers treat absent `profiles` as `[]` and version stays 1. | `testRegisterProjectProfileStoresHash`, `testRegistryStoresProfilesAlongsideAgents`, `testRegistryBackwardCompatible` | MUST | 
| REQ-6 | The profile library SHALL merge built-in, user, and project profiles with precedence built-in > user > project. Duplicate names from lower-precedence sources SHALL be shadowed with a diagnostic warning. Unregistered project profiles SHALL be excluded from the library. | `testProfileLibraryMergePrecedence`, `testProfileLibraryShadowWarning`, `testUnregisteredProjectProfileNotInLibrary` | MUST | Same-name profiles across sources use precedence, not rejection. |
| REQ-7 | When running a registered agent that references a project profile, the resolved profile's canonical path, name, and raw-file-byte hash SHALL be verified against the project registry entry using the hash captured at resolution time (not a fresh file read). The check SHALL also verify project trust is currently active. Canonical path, name, or hash mismatch SHALL result in HARD DENY before any child process spawns. Ephemeral agents SHALL NOT resolve user or project profiles — only built-in profiles. | `testProfileTrustCheckBlocksMismatch`, `testProfileTrustCheckPassesMatch`, `testProfileTrustCheckSkippedForBuiltIn`, `testProfileTrustCheckSkippedForUser`, `testProfileTrustCheckRequiresActiveProjectTrust`, `testProfileTrustCheckValidatesCanonicalPath`, `testProfileTrustCheckBlocksSameNameDifferentPath`, `testEphemeralAgentCannotResolveProjectProfile`, `testCorruptRegistryFailsClosed`, `testSameNameProfileSameSourceRejected` | MUST | Closes P3f-2 trust gap. Uses cached hash from resolved profile to prevent TOCTOU. Project trust must be active at check time (not just at library build). Ephemeral agents are built from built-in templates with no profile field — they skip user/project profiles entirely. Same-name profiles within the same source are rejected during discovery. |
| REQ-8 | `/agents profiles` SHALL list profiles from all sources (built-in, user, project) with source label, SHA-256 hash, and registration status for project profiles. | `testProfilesListShowsAllSources`, `testProfilesListShowsRegistrationStatus` | MUST | Extends P3f-2 command which shows only built-ins. |
| REQ-9 | Doctor SHALL flag unregistered project profiles and project profile hash mismatches with next-step guidance. | `testDoctorFlagsUnregisteredProjectProfile`, `testDoctorFlagsProfileHashMismatch` | MUST | Consistent with existing agent doctor checks. |
| REQ-10 | Profile registration and unregistration SHALL require TUI confirmation; non-TUI SHALL fail-closed. Project profile registration SHALL require active project trust. | `testProfileRegisterRequiresConfirmation`, `testProfileRegisterNonTuiFailClosed`, `testProfileRegisterRequiresProjectTrust`, `testProfileUnregisterRequiresConfirmation` | MUST | Same pattern as `/agents register`. |
| REQ-11 | Profile discovery SHALL be bounded: max 50 `*.md` files per source (after filtering), max 8KB frontmatter per file, max 64KB file size. Profile file canonical paths SHALL stay within their source directory root; symlinks outside the root SHALL be rejected. | `testProfileDiscoveryBounded`, `testProfileDiscoveryRejectsSymlinkOutsideProject` | MUST | Prevent resource exhaustion and path escape. |
| REQ-12 | User profiles SHALL NOT require hash-registration to be usable; they are user-owned files trusted by definition. | `testUserProfileWorksWithoutRegistration` | MUST | Trust gap only applies to project profiles. |

## Non-Goals

Out of scope for this feature:

- Profile hot-reload or file watching (explicit `/agents reload` or session restart to refresh).
- User-level profile hash-registration (user owns their files; trust gap doesn't apply).
- `/agents profiles edit` command.
- Auto-detection and re-registration prompt on session start for changed project profiles.
- Separate profile registry files (co-located with agent registry for simplicity and atomicity).

## Safety / Security

| Concern | Severity | Mitigation | Test(s) |
|---|---|---|---|
| Malicious project profile downgrades model | High | Hash-register project profiles; runtime trust check verifies hash before child spawn. | `testProfileTrustCheckBlocksMismatch` |
| Profile name collision across sources | Low | Precedence: built-in > user > project. Shadowed profiles get diagnostic warnings, excluded from library. | `testProfileLibraryMergePrecedence`, `testProfileLibraryShadowWarning` |
| Profile frontmatter injection | Medium | Frontmatter-only, no body execution. `validateProfile` rejects tools/safety/limits/forbiddenTools. Unknown keys warned. | `testParseProfileWarnsUnknownKey` + P3f-1 forbidden-field tests |
| Unregistered project profile used by agent | Medium | Unregistered project profiles excluded from profile library. Runtime trust check as defense-in-depth. | `testUnregisteredProjectProfileNotInLibrary` |
| Large profile directory DoS | Low | Bounded: max 50 files, 8KB frontmatter, 64KB file. | `testProfileDiscoveryBounded` |
| Registry backward-compat break | Low | `profiles` is additive optional field. Readers treat absent field as `[]`. Version stays 1. | `testRegistryBackwardCompatible` |

## Design

### Key types

```ts
/** A registered profile entry stored in the agent registry alongside agents. */
type RegisteredProfile = {
  name: string;
  source: "user" | "project";
  canonicalPath: string;
  rawBytesSha256: string;
  approvedAt: string;
  approvedBy: "user";
};

/** Extended registry types (additive, backward-compatible). */
type AgentRegistry = {
  version: 1;
  updatedAt: string;
  agents: RegisteredAgent[];
  profiles?: RegisteredProfile[];   // NEW
};

type ProjectAgentRegistry = AgentRegistry & {
  projectRoot: string;
  projectRootHash: string;
  // profiles inherited from AgentRegistry
};

/** Parsed profile file result. */
type ParsedProfile = {
  filePath: string;
  canonicalPath?: string;
  rawBytesSha256: string;
  profile?: ModelProfile;           // undefined if validation fails
  source: "user" | "project";
  issues: AgentValidationIssue[];
  warnings: string[];
  unknownKeys: string[];
};

/** Options for building the full profile library from all sources. */
type BuildProfileLibraryOptions = {
  userProfilesDir?: string;
  projectProfilesDir?: string;
  projectTrusted: boolean;
  projectRegistry?: ProjectAgentRegistry;
};

/** Result of a profile trust check at runtime. */
type ProfileTrustCheck =
  | { ok: true }
  | { ok: false; code: string; message: string };
```

### Key invariants

- Built-in profiles always included; user/project profiles additive.
- Project profiles excluded from library when project trust is inactive.
- Trust check requires current project trust to be active — not just at library build time.
- Hash check only for project profiles referenced by registered agents.
- Built-in and user profiles skip the hash check (trusted by definition).
- Ephemeral agents use built-in template specs with no `profile` field — they never resolve user or project profiles.
- Same-name profiles within the same source are rejected during discovery.
- Frontmatter parser reused from agent-markdown.ts (`splitFrontmatter`, `parseFrontmatterBlock`).
- Profile validation reused from profiles.ts (`validateProfile`).
- Registry is backward-compatible: readers treat absent `profiles` field as `[]`. Corrupt registry = HARD DENY at trust check.

### Resolution / flow

```text
Session start:
  → discoverUserProfiles(~/.pi/agent/profiles/*.md)
  → if projectTrusted: discoverProjectProfiles(.pi/profiles/*.md)
  → parse each → validate each → filter eligible
  → buildProfileLibrary(built-ins, user, project, precedence)
  → store in ctx.profileLibrary

Agent run with profile reference:
  → runChildAgent(spec, task, options, profiles)
    → if ephemeral spec: skip project profile resolution entirely
    → resolveSpecProfile(spec, profiles)              [P3f-2, unchanged]
    → if resolved AND resolved.fromProjectProfile:
        → profileTrustCheck(name, canonicalPath, cachedRawBytesSha256, projectRegistry, projectTrusted)
          → verify project trust is currently active
          → match on (name + canonicalPath + rawBytesSha256) triple
          → any mismatch or trust inactive → HARD DENY (no child spawn)
    → buildChildPiArgs(effectiveSpec, ...)             [unchanged]
```

### Precedence

```
built-in > user > project
```

Built-in `fast-local` shadows user-defined `fast-local`. User `my-profile` shadows project `my-profile`.
Shadowed profiles get diagnostic warnings and are excluded from the merged library.

## Existing Hook Points

| File | Line(s) | What it does | Impact |
|---|---|---|---|
| `agents/lib/profiles.ts` | L262-269 | `toProfileLibrary()` returns built-ins only | Replace with `buildProfileLibrary(options)` merging all sources. Keep `toProfileLibrary()` as wrapper for P3f-2 callers. |
| `agents/lib/agent-markdown.ts` | L142-185 | `splitFrontmatter`, `parseFrontmatterBlock` | Reuse for profile frontmatter-only parsing. |
| `agents/lib/registry.ts` | L15-22 | `AgentRegistry` type | Add optional `profiles?: RegisteredProfile[]`. |
| `agents/lib/registry.ts` | L23-27 | `ProjectAgentRegistry` | Inherits `profiles` from `AgentRegistry`. No change needed. |
| `agents/lib/registry.ts` | L79-88 | `readUserRegistry`, `readProjectRegistry` | Readers handle absent `profiles` → default `[]`. |
| `agents/lib/registry.ts` | L92-100 | `writeUserRegistry`, `writeProjectRegistry` | Serializers include `profiles` when non-empty. |
| `agents/lib/child-runner.ts` | L71-80 | `runChildAgent` resolution block | Add profile trust check after `resolveSpecProfile`, before `buildChildPiArgs`. |
| `agents/lib/diagnostics.ts` | L14 | `BUILT_IN_PROFILES` import | Replace with `buildProfileLibrary` for full-source diagnostics. |
| `agents/index.ts` | L22 | `toProfileLibrary()` module-level call | Replace with `buildProfileLibrary(options)` built from discovered profiles. |
| `agents/index.ts` | L111-114 | `/agents profiles` handler | Show all sources with hashes and registration status. |

## Slice Ladder

Single slice. P3f-3 is self-contained after P3f-2 merge.

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| P3f-3 | File discovery + hash-registration + trust gap closure | `agents/lib/profile-discovery.ts` (new), `agents/lib/profiles.ts`, `agents/lib/registry.ts`, `agents/lib/child-runner.ts`, `agents/lib/diagnostics.ts`, `agents/index.ts` | Profile file discovery; frontmatter parsing; project hash-registration; profile trust check; `/agents profiles` updated; doctor checks | 39 tests across 7 groups | No separate registry files; no user profile hash-registration; no hot-reload |

## Cut Order

If context or implementation scope grows, cut in this order:

1. User profile discovery (keep built-ins + project-only).
2. Doctor profile checks (keep core trust check only).

Do not cut:

- Project profile hash-registration (closes trust gap).
- Profile trust check in `runChildAgent` (the security gate).
- Hash mismatch HARD DENY (fail-closed requirement).
- Profile registration TUI confirmation and non-TUI fail-closed (REQ-10).

## Contracts

### `parseProfileFile(filePath: string, source: "user" \| "project"): Promise<ParsedProfile>`

**Input contract:** Absolute or relative path to a Markdown file. Source discriminates user vs project for diagnostics.

**Output contract:** Always returns a `ParsedProfile` (never throws). `profile` is `undefined` when parsing or validation fails. Issues and warnings are populated for diagnostics.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Valid | Frontmatter present, name valid, passes `validateProfile` | `profile` set, `issues: []`, `warnings` may include unknown keys |
| B. File read error | `fs.readFile` throws (deleted, permissions) | `profile: undefined`, issue `file-read-error` with error message |
| C. File too large | Raw bytes > 64KB | `profile: undefined`, issue `file-too-large` |
| D. Missing frontmatter | No `---` delimiters | `profile: undefined`, issue `frontmatter-missing` |
| E. Unclosed frontmatter | Opening `---` without closing `---` | `profile: undefined`, issue `frontmatter-unclosed` |
| F. Frontmatter too large | Frontmatter > 8KB | `profile: undefined`, issue `frontmatter-too-large` |
| G. Invalid profile | Frontmatter present but `validateProfile` fails | `profile: undefined`, issues from `validateProfile` |
| H. Body content present | Frontmatter followed by non-empty body | `profile` set (if valid), warning `profile-has-body` — body is ignored but warned |

**Error codes:**

| Code | Field | Trigger |
|---|---|---|
| `file-read-error` | `file` | `fs.readFile` threw an error |
| `file-too-large` | `file` | File exceeds 64KB |
| `frontmatter-missing` | `frontmatter` | No `---` delimiters found |
| `frontmatter-unclosed` | `frontmatter` | Opening `---` without closing `---` |
| `frontmatter-too-large` | `frontmatter` | Frontmatter exceeds 8KB |
| `name-required` | `name` | Name missing or empty (from `validateProfile`) |

### `discoverProfiles(dir: string, source: "user" \| "project", maxFiles?: number): Promise<ParsedProfile[]>`

**Input contract:** Directory path, source discriminator, optional max file count (default 50).

**Output contract:** Sorted array of `ParsedProfile`. Returns `[]` for ENOENT (missing directory). Never throws for filesystem errors — reports them as issues on synthetic `ParsedProfile` entries.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Directory exists | `readdir` succeeds | Parsed profiles for each `*.md` file, sorted by filename |
| B. Missing directory | ENOENT | `[]` (empty array) |
| C. Other filesystem error | EACCES, etc. | `[]` (empty array — silently skipped) |
| D. Bounded | > maxFiles `*.md` entries (after filtering) | Only first `maxFiles` (by sorted filename) are parsed |

### `buildProfileLibrary(options: BuildProfileLibraryOptions): ModelProfileLibrary`

**Input contract:** Options with user/project dirs, trust flag, and optional project registry for filtering unregistered project profiles.

**Output contract:** `ModelProfileLibrary` with profiles in precedence order. Unregistered project profiles are excluded. Invalid profiles are excluded. Shadowed duplicates get diagnostic warnings.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Full library | All sources present, valid, registered | Merged library with built-ins first, then user, then project |
| B. No user profiles | User dir missing or empty | Built-ins + project only |
| C. Project untrusted | `projectTrusted: false` | Built-ins + user only |
| D. Shadowing | Same name in multiple sources | Higher-precedence profile kept; lower-precedence warned via diagnostics channel |
| E. Unregistered project profile | Project profile not in registry `profiles` array | Excluded from library |
| F. Invalid profile | `validateProfile` fails | Excluded from library; issues propagated to diagnostics |
| G. Hash-mismatched registered profile | Profile in registry but file hash differs | Excluded from library; flagged in diagnostics for re-registration |

### `profileTrustCheck(profileName: string, canonicalPath: string, cachedRawBytesSha256: string, projectRegistry: ProjectAgentRegistry, projectTrusted: boolean): ProfileTrustCheck`

**Input contract:** The resolved profile's name, canonical path, raw-file-byte SHA-256 hash captured at resolution time, the project registry (with `profiles` array), and current project trust state.

**Output contract:** `{ ok: true }` if project trust is active AND the registry contains an entry matching name + canonical path + raw-byte hash. `{ ok: false, code, message }` for any failure — trust inactive, no match, name mismatch, path mismatch, hash mismatch, corrupt registry, or duplicate entries.

**State table (exhaustive):**

| State | Condition | Output |
|---|---|---|
| A. Match | Project trust active; registry has entry matching name + canonicalPath + rawBytesSha256 | `{ ok: true }` |
| B. Trust inactive | `projectTrusted` is `false` | `{ ok: false, code: "profile-trust-inactive" }` |
| C. Hash mismatch | Name + path match but rawBytesSha256 differs | `{ ok: false, code: "profile-hash-mismatch" }` |
| D. Not registered | No registry entry matches the name | `{ ok: false, code: "profile-unregistered" }` |
| E. Path mismatch | Name matches but canonicalPath differs (same-name, different file) | `{ ok: false, code: "profile-path-mismatch" }` |
| F. Duplicate entries | Multiple registry entries match the same name + canonicalPath | `{ ok: false, code: "profile-registry-corrupt" }` |
| G. Corrupt registry | Registry file unreadable, parse failure, or malformed `profiles` | `{ ok: false, code: "profile-registry-corrupt" }` |

## Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | Profile file with no frontmatter delimiters | Parsing fails; profile excluded from library; issue reported | `testParseProfileRejectsMissingName` |
| EC2 | Profile file with invalid model/thinking values | `validateProfile` catches; profile excluded from library | `testInvalidProfileNotInLibrary` |
| EC3 | Project trust deactivated mid-session | Trust check verifies current project trust — if inactive, HARD DENY even if library still has cached project profiles | `testProfileTrustCheckRequiresActiveProjectTrust` |
| EC4 | Profile file deleted after registration | Cached hash from library build is still valid against registry — deletion after build doesn't affect runs using cached library. Next library rebuild will exclude deleted file. | `testProfileTrustCheckPassesMatch` |
| EC5 | Profile file modified after registration | Cached hash from library build differs from registry entry → HARD DENY. User must `/agents reload` to rebuild library with new profile, then re-register if hash changed. | `testProfileTrustCheckBlocksMismatch` |
| EC6 | Same profile name in user and project sources | User profile wins; project profile shadowed with warning | `testProfileLibraryMergePrecedence` |
| EC7 | User defines profile shadowing a built-in | Built-in wins; user's definition unused; doctor warning | `testProfileLibraryShadowWarning` |
| EC8 | Agent references unregistered project profile | Profile excluded from library; resolution fails with profile-not-found | `testUnregisteredProjectProfileNotInLibrary` |
| EC9 | Profile frontmatter exceeds 8KB | Parsing fails; profile excluded | `testProfileDiscoveryBounded` |
| EC10 | Profile directory has 100+ files | Only first 50 `*.md` files scanned (bounded) | `testProfileDiscoveryBounded` |
| EC11 | Two project profiles with same name at different paths | Same-name profiles in the same source rejected during discovery. Cross-source: user shadows project per precedence. | `testSameNameProfileSameSourceRejected` |
| EC12 | Profile symlink points outside project root | Rejected during discovery; profile excluded with warning | `testProfileDiscoveryRejectsSymlinkOutsideProject` |
| EC13 | Ephemeral agent attempts to reference user/project profile | Ephemeral specs are built from built-in templates with no `profile` field; user/project profiles not resolved for them | `testEphemeralAgentCannotResolveProjectProfile` |
| EC14 | Registry file is corrupt or unreadable | Trust check fails with `profile-registry-corrupt` → HARD DENY. No child spawned. | `testCorruptRegistryFailsClosed` |

## Test Case Catalog

Grouped by concern. Every test name here SHALL appear in the Requirements table.

```text
Group 1: Profile file discovery (5 tests)
  testDiscoverUserProfiles
  testDiscoverUserProfilesEmptyDir
  testDiscoverUserProfilesMissingDir
  testDiscoverProjectProfilesWhenTrusted
  testDiscoverProjectProfilesBlockedWhenUntrusted

Group 2: Profile parsing + validation (7 tests)
  testParseProfileValid
  testParseProfileRejectsMissingName
  testParseProfileRejectsMissingFrontmatter
  testParseProfileRejectsBodySection
  testParseProfileWarnsUnknownKey
  testInvalidProfileListedWithIssues
  testInvalidProfileNotInLibrary

Group 3: Profile library merging (3 tests)
  testProfileLibraryMergePrecedence
  testProfileLibraryShadowWarning
  testUnregisteredProjectProfileNotInLibrary

Group 4: Profile hash-registration (7 tests)
  testRegisterProjectProfileStoresHash
  testRegistryStoresProfilesAlongsideAgents
  testRegistryBackwardCompatible
  testProfileRegisterRequiresConfirmation
  testProfileRegisterNonTuiFailClosed
  testProfileRegisterRequiresProjectTrust
  testProfileUnregisterRequiresConfirmation

Group 5: Profile trust check (10 tests)
  testProfileTrustCheckBlocksMismatch
  testProfileTrustCheckPassesMatch
  testProfileTrustCheckSkippedForBuiltIn
  testProfileTrustCheckSkippedForUser
  testProfileTrustCheckRequiresActiveProjectTrust
  testProfileTrustCheckValidatesCanonicalPath
  testProfileTrustCheckBlocksSameNameDifferentPath
  testEphemeralAgentCannotResolveProjectProfile
  testCorruptRegistryFailsClosed
  testSameNameProfileSameSourceRejected

Group 6: Bounded discovery + safety (2 tests)
  testProfileDiscoveryBounded
  testProfileDiscoveryRejectsSymlinkOutsideProject

Group 7: Diagnostics + commands (5 tests)
  testProfilesListShowsAllSources
  testProfilesListShowsRegistrationStatus
  testDoctorFlagsUnregisteredProjectProfile
  testDoctorFlagsProfileHashMismatch
  testUserProfileWorksWithoutRegistration
```

Total: 39 tests (5 + 7 + 3 + 7 + 10 + 2 + 5).

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Registry schema change breaks existing installs | Low | `profiles` is additive optional field; absent = `[]`. Version stays 1. |
| Profile trust check adds latency to every agent run | Low | Only triggers for project profiles referencing registered agents; single `fs.readFile` + `sha256`. |
| User confusion between `/agents profiles` (list) and `/agents profiles register` (manage) | Low | Different arg parsing; `/agents profiles` with no args = list, with `register` arg = manage. |
| Profile discovery misses files changed between build and run | Low | Runtime trust check catches hash changes; no hot-reload needed. |

## Open Decisions

1. **Should user profiles be hash-registered?** Decision: no. User owns `~/.pi/agent/profiles/`; trust gap only applies to project files. If audit trail needed, user manages via git. Deferred: may revisit if user-profile sharing becomes a feature.
2. **Profile registration subcommand naming.** Decision: `/agents profiles register <name>` and `/agents profiles unregister <name>`. Consistent with `/agents register` pattern, keeps profiles under profiles namespace.

## Done Criteria

- [ ] User profile files discovered from `~/.pi/agent/profiles/*.md`
- [ ] Project profile files discovered from `.pi/profiles/*.md` when trusted
- [ ] Profile frontmatter parsing reuses agent-markdown bounded parser
- [ ] Project profiles hash-registered in project registry `profiles` array
- [ ] Profile trust check in `runChildAgent` blocks hash mismatches
- [ ] `/agents profiles` shows all sources with hashes and registration status
- [ ] Doctor flags unregistered profiles and hash mismatches
- [ ] Profile registration requires TUI confirmation, non-TUI fail-closed
- [ ] 39 tests passing
- [ ] All existing test suites (P3b-1 through P3f-2) pass
- [ ] No-model smoke passes

## Review Consensus

| Pass | Reviewer | Model | Blocker count | Verdict |
|---|---|---|---|---|
| 1 | Agent (plan review) | openai-codex/gpt-5.5 | 6 → 0 (all resolved) | no-go → conditional-go |
| 2 | Agent (adversarial review) | openai-codex/gpt-5.5 | 5 → 0 (all resolved) | no-go → conditional-go |

### Resolved blockers

| # | Blocker | Resolution |
|---|---|---|
| 1 | Test count mismatch (catalog 26, ladder 20, done 24) | Converged to 39 across all sections. |
| 2 | REQ/test cross-reference gaps | Added all missing tests to Requirements and catalog. |
| 3 | Contract state tables not exhaustive | Added 8 states to parseProfileFile, 7 to profileTrustCheck, 7 to buildProfileLibrary, 4 to discoverProfiles. |
| 4 | Trust check by name, not path+hash | Redesigned to `profileTrustCheck(name, canonicalPath, cachedHash, registry, trust)` matching triple. |
| 5 | TOCTOU on fresh file read | Trust check uses cached hash from resolution time. Deletion/modification after build handled by library rebuild. |
| 6 | Cut order allowed dropping registration | Moved to Do Not Cut. |
| 7 | Project trust deactivation fails open | Trust check requires `projectTrusted: boolean`; fails immediately if inactive. |
| 8 | Ephemeral agent profile underspecified | Ephemeral agents explicitly scoped to built-in profiles only. |
| 9 | Same-name/different-path collision | Added `profileName` to trust check; same-name same-source rejected at discovery. |
| 10 | Corrupt registry fail-closed missing | Added corrupt registry states; all fail with HARD DENY. |

## Appendix: Implementation Plan

Concrete file-level implementation plan.

### Files to create

1. `agents/lib/profile-discovery.ts` — `parseProfileFile`, `discoverProfiles`, `ParsedProfile` type
2. `agents/test-fixtures/test-p3f-3.mjs` — 39 tests across 7 groups
3. `agents/test-fixtures/run-p3f-3-tests.sh` — test runner

### Files to modify

| File | Change |
|---|---|
| `agents/lib/profiles.ts` | Add `RegisteredProfile` type. Add `buildProfileLibrary(options)` merging built-in + user + project profiles with precedence. Keep `toProfileLibrary()` as backward-compat wrapper. |
| `agents/lib/registry.ts` | Add `profiles?: RegisteredProfile[]` to `AgentRegistry`. `ProjectAgentRegistry` inherits it. `addOrReplaceRegisteredProfile` helper. Readers default absent `profiles` to `[]`. |
| `agents/lib/child-runner.ts` | In `runChildAgent`, after `resolveSpecProfile` success: if project profile referenced, call `profileTrustCheck`. On failure → `spawnErrorResult`. Need project registry and profiles dir passed via options or context. |
| `agents/lib/diagnostics.ts` | `collectAgentDiagnostics` now discovers profiles. `formatAgentsDoctor` flags unregistered project profiles and hash mismatches. |
| `agents/index.ts` | Replace `toProfileLibrary()` with `buildProfileLibrary(options)` built from discovered profiles. `/agents profiles` shows all sources. `/agents profiles register` and `/agents profiles unregister` subcommands. Pass project registry to `runChildAgent` options. |

### Implementation sequence

| Step | Action | Validation |
|---|---|---|
| 1 | Add `RegisteredProfile` type and extend registries in `registry.ts` | Existing registry tests pass |
| 2 | Write `profile-discovery.ts`: `parseProfileFile` + `discoverProfiles` | Unit tests pass |
| 3 | Add `buildProfileLibrary` to `profiles.ts` with merging logic | Profile merging tests pass |
| 4 | Wire profile discovery into `diagnostics.ts` + doctor checks | Diagnostics tests pass |
| 5 | Update `index.ts`: build full library, `/agents profiles` command, registration subcommands | Smoke: `pi -e agents --list-models` |
| 6 | Add `profileTrustCheck` + wire into `child-runner.ts` | Trust check tests pass |
| 7 | Write full test suite `test-p3f-3.mjs` (39 tests) | All 39 pass |
| 8 | Full regression: all P3b-1 through P3f-3 test suites | All pass |

### Risks

| Risk | Mitigation |
|---|---|
| `runChildAgent` needs project registry + profiles dir for trust check | Pass via `RunChildAgentOptions` or a new context parameter. Minimal impact — only the registered-agent path (not built-in) needs these. |
| Registry read/write compatibility with existing registry files | Additive `profiles` field; absent → `[]`. Write only when `profiles` is non-empty. |
| `buildProfileLibrary` may be called before discovery completes | Call discovery in `collectAgentDiagnostics` which runs synchronously before library build. |
