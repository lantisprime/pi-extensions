# P3f-3 Adversarial Review

## Review context

Plan reviewed: `agents/P3F3_PROFILE_DISCOVERY_REGISTRATION_PLAN.md`
Reviewer: `openai-codex/gpt-5.5` via direct `pi --no-tools --model openai-codex/gpt-5.5`
Type: Adversarial security review

## Blocking issues

1. **Project trust deactivation fails open.** EC3 says cached library persists after trust deactivation. Trust check must also verify current project trust state, or cached project profiles must be invalidated.
2. **Ephemeral agent behavior underspecified.** REQ-7 says "when running a registered agent" but ephemeral agents use `runBuiltInChildAgent` which now receives `profiles`. Must explicitly scope ephemeral agents out of project profile resolution.
3. **TOCTOU contradiction.** Plan requires cached hash "not a fresh file read" but EC4/EC5 imply file deletion/modification detection via runtime state. Must pick one model and align tests.
4. **Same-name/different-path collision not enforceable.** `profileTrustCheck` has no profile name input, yet State D detects "matching name but different path." Profile resolution is name-based — two same-name project profiles can collide before trust check runs.
5. **Corrupt registry fail-closed missing.** Plan covers duplicate entries but not parse failures, unreadable registry, malformed `profiles`, or invalid hashes.

## Non-blocking concerns

- Unknown frontmatter keys only warn. Authority-bearing keys should be explicitly rejected.
- Body content warning-only acceptable only if body bytes never reach child prompt/argv/diagnostics.
- Registration should enforce same symlink/canonical bounds as discovery.
- `RegisteredProfile.source` includes `"user"` though user registration is non-goal.
- Max-50 truncation should emit diagnostics.

## Missing tests/validation

- Runtime denies project-profile use after project trust deactivation mid-session.
- Ephemeral agents cannot resolve user/project profiles.
- `run_subagent` cannot specify or override a profile.
- Every trust-check failure asserts child spawn is NOT called.
- Corrupt/unreadable registry fails closed.
- Duplicate same-name profiles within same source fail closed.
- Profile body content never in child prompt/tool-visible diagnostics.
- Registration rejects symlink/path-escape profiles.

## Safety/security concerns

- Plan doesn't bind a registered agent spec to a specific registered profile identity — "any separately registered profile of that name" model should be explicit.
- User profiles can downgrade models (acceptable per invariant but diagnostics should show effective source/model).

## Verdict

no-go

## Follow-up applied

All 5 blockers resolved in plan revision:

- **B1**: Trust check now requires `projectTrusted: boolean` parameter. If project trust is inactive, check fails immediately before checking registry, with code `profile-trust-inactive`. Added REQ-7 test: `testProfileTrustCheckRequiresActiveProjectTrust`.
- **B2**: Added explicit rule: ephemeral agents (built from built-in template specs) have no `profile` field and resolve only against built-in profiles. Added `testEphemeralAgentCannotResolveProjectProfile` to REQ-7.
- **B3**: Resolved TOCTOU: trust check validates the cached hash from library build time against the registry entry. EC4/EC5 updated to reflect cached-hash model — deletion after build means cached version still passes if hash matches registry. Fresh file re-read is not used. If user changes a profile, they must rebuild the library (/agents reload) and re-register.
- **B4**: Added `profileName: string` parameter to `profileTrustCheck`. Check now validates (name + canonicalPath + rawBytesSha256) as a triple. State D (path mismatch) uses name to find the entry, then validates path. Same-name collision within same source is now a validation error during discovery. Added `testSameNameProfileSameSourceRejected`.
- **B5**: Added corrupt registry states: parse failure → trust check fails with `profile-registry-corrupt`; malformed `profiles` array → same; invalid hash format → `profile-registry-corrupt`. All fail closed — no child spawned. Added `testCorruptRegistryFailsClosed`.
