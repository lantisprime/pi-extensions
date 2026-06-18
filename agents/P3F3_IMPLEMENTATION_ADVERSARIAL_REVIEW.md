# P3f-3 Implementation Adversarial Review

Reviewer: openai-codex/gpt-5.5 | Type: Implementation adversarial review | Verdict: no-go (3 blockers)

## Blockers

1. **B1** — Trust check passes undefined/empty for canonicalPath and cachedHash. `profileTrustCheck(profileName, undefined, "", ...)` can't validate against registry. Must carry actual path+hash from resolved profile.
2. **B2** — Corrupt registry entries not schema-validated. Individual entries could be null, missing fields, wrong types.
3. **B3** — `buildChildPiArgs(spec, ...)` called on trust failure before `spawnErrorResult`. Denial should skip argv construction.

## Non-blocking

- Built-in exemption by name, not metadata — safe today due to precedence but fragile.
- Cross-source duplicate handling only safe with rigorous precedence tests.

## Follow-up applied

All 3 blockers fixed:

- **B1**: Added `canonicalPath` and `rawBytesSha256` to ModelProfile and ResolvedProfile. ParsedProfile sets these on the profile. resolveSpecProfile carries them through. runChildAgent passes actual values to profileTrustCheck.
- **B2**: Added entry validation in profileTrustCheck — each entry must be a non-null object with required string fields. Malformed entries treated as registry corruption → HARD DENY.
- **B3**: Denial path no longer calls buildChildPiArgs. Instead returns spawnErrorResult with a minimal synthetic invocation.
