# P3f-3 Plan Review

## Review context

Plan reviewed: `agents/P3F3_PROFILE_DISCOVERY_REGISTRATION_PLAN.md`
Reviewer: `openai-codex/gpt-5.5` via direct `pi --no-tools --model openai-codex/gpt-5.5`

## Blocking issues

1. **B1 — Test count mismatch.** Catalog says 26 tests. Slice Ladder says 20 tests. Done Criteria and Appendix say 24 tests. Must converge on one number.
2. **B2 — Requirements/test catalog mismatch.** `testProfileDiscoveryBounded` and `testUserProfileWorksWithoutRegistration` in Requirements but missing from catalog. `testUnregisteredProjectProfileNotInLibrary` and `testProfileTrustCheckFileReadError` in catalog but not in Requirements table.
3. **B3 — Contract state tables not exhaustive.** `parseProfileFile` missing file-read-error and body-content states. `discoverProfiles` has contradiction between output contract (synthetic ParsedProfile issues) and state table (EACCES returns []). `buildProfileLibrary` missing invalid-profile and hash-mismatch states. `profileTrustCheck` missing canonical-path mismatch state.
4. **B4 — Trust check validates by name, not path+hash.** `profileTrustCheck(name, registry, dir)` looks up by profile name only. Two project files with same name but different paths could collide — a malicious file at path A could be the resolved profile while the trust check validates path B's registered entry. Must check canonicalPath + rawBytesSha256.
5. **B5 — TOCTOU on cached profile data.** Library built at session start. Runtime trust check rereads current file bytes. If profile file changed between library build and agent run, the resolved profile (from cached library) and the trust check (reading current file) could use different data. Need trust check to validate against the resolved parsed profile bytes, not a fresh file read.
6. **B6 — Cut order violates MUST REQ-10.** Cut order allows removing `/agents profiles register` and keeping "manual registry editing". But REQ-10 says registration SHALL require TUI confirmation, non-TUI fail-closed. Manual editing bypasses this.

## Non-blocking concerns

- `RegisteredProfile.source` includes `"user"` but user profiles are not registered — confusing.
- `buildProfileLibrary` returns `ModelProfileLibrary` synchronously but discovery is async.
- No channel for shadow/invalid/unregistered warnings from `buildProfileLibrary`.
- Built-in profiles have no raw file bytes — SHA-256 display for built-ins needs a defined behavior.
- File count limit ambiguous: before or after filtering to `*.md`.
- Project registration should explicitly require active project trust.

## Missing tests/validation

- `testParseProfileRejectsMissingFrontmatter`
- `testParseProfileRejectsBodySection`
- `testRegistryBackwardCompatible`
- `testProjectProfileDuplicateNameRejectedOrDeterministic`
- `testProfileTrustCheckValidatesCanonicalPath`
- `testProfileTrustCheckBlocksSameNameDifferentPath`
- `testProfileDiscoveryRejectsSymlinkOutsideProject`
- `testProfileRegisterRequiresProjectTrust`
- `testProfileUnregisterRequiresConfirmation`

## Safety/security concerns

- Same-name project profile collision = trust bypass without canonical path in check.
- Symlinks/canonical paths outside project root not addressed.
- Stale cached profile can bypass runtime check.
- Forbidden frontmatter keys: warning-only could hide privilege-affecting intent.

## Verdict

no-go

## Follow-up applied

All 6 blockers resolved in plan revision:

- **B1**: Test count converged to 36. All sections (Slice Ladder, Done Criteria, Test Catalog, Appendix) say 36.
- **B2**: Added `testProfileDiscoveryBounded`, `testUserProfileWorksWithoutRegistration`, `testProfileDiscoveryRejectsSymlinkOutsideProject`, `testParseProfileRejectsMissingFrontmatter`, `testParseProfileRejectsBodySection`, `testRegistryBackwardCompatible`, `testProfileRegisterRequiresProjectTrust`, `testProfileUnregisterRequiresConfirmation` to catalog. Added `testUnregisteredProjectProfileNotInLibrary` to REQ-6 and `testProfileTrustCheckFileReadError` to REQ-7. Test catalog now has 36 tests across 7 groups, every test name appears in the Requirements table.
- **B3**: Added missing states: `parseProfileFile` now has file-read-error, unclosed-frontmatter, and body-content states. `discoverProfiles` resolved contradiction — EACCES returns `[]`. `buildProfileLibrary` added invalid-profile and hash-mismatch states. `profileTrustCheck` added canonical-path-mismatch and duplicate-entries states.
- **B4**: Changed `profileTrustCheck` signature to accept `canonicalPath` + `cachedRawBytesSha256` instead of `profileName` + dir. Check matches both path AND hash against registry entry.
- **B5**: Changed trust check to use cached hash from resolved profile (captured at resolution time), not a fresh file read. Prevents TOCTOU where profile changes between library build and agent run.
- **B6**: Removed "manual registry editing" from cut order. Registration TUI confirmation and non-TUI fail-closed are now Do Not Cut alongside trust check and HARD DENY.

Added 11 reviewer-suggested tests: missing frontmatter, body section, backward compat, project trust requirement, unregister confirmation, canonical path validation, same-name-different-path blocking, bounded discovery, symlink rejection, file read error on trust check, and user profile no-registration.

Final plan stats: 12 requirements, 36 tests, 7 groups, 7 contract states, 12 edge cases.
