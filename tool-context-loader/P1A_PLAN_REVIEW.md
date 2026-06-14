# Tool Context Loader P1a Plan Review

## Review Scope

Reviewed `tool-context-loader/P1A_PLAN.md` for correctness, implementation readiness, security, token efficiency, testability, and alignment with `WORKPLAN.md` and `tool-context-loader/DESIGN.md`.

## Executive Verdict

**Go for implementation, with guardrails.**

P1a is intentionally narrow and safe: discovery + diagnostics only, no context injection. This is the right first milestone because it proves the riskiest foundations — trust gating, frontmatter parsing, root safety, deterministic discovery, and diagnostics — before any model-visible behavior exists.

## What The Plan Gets Right

### 1. No injection in P1a

The plan explicitly excludes `before_agent_start`, `tool_call`, and `tool_result` behavior. This avoids prompt-injection and token-budget risk while discovery is still being validated.

### 2. Pure helper tests first

The plan emphasizes pure helpers for parsing, root resolution, source classification, dedupe, and diagnostics formatting. This keeps most validation deterministic and avoids needing live Pi sessions for core logic.

### 3. Trust gate is first-class

Project-local roots are only scanned if `ctx.isProjectTrusted()` is true. This matches the security model from the main design.

### 4. Unmapped episodes are diagnostics-only

This prevents accidental injection of unrelated episodic memory. It also gives visibility into available episodes without treating them as eligible.

### 5. Dedupe/source precedence is specified early

Doing this in P1a prevents later P1b/P1c ambiguity when multiple runbooks map to the same tools.

## Risks And Required Mitigations

### R-001: Reading full files for hash/frontmatter can violate lazy-body spirit

**Risk:** P1a says no body loading beyond frontmatter/hash, but computing a content hash may require reading full files.

**Mitigation:** In P1a, reading file text for parsing/hash is acceptable because nothing is injected into context, but tests should ensure diagnostics do not retain or print body text. For very large files, cap read size or record a warning and skip.

Recommended P1a cap:

```ts
const MAX_DISCOVERY_FILE_BYTES = 256_000;
```

Large files should be `skipped` with a warning.

### R-002: Symlink escape checks may be tricky for non-existent roots

**Risk:** `realpath` fails on missing roots and new files.

**Mitigation:** Only realpath existing roots/files. Missing roots should be marked missing and skipped. For discovered files, compare `realpath(file)` starts with `realpath(root) + path.sep` or equals root for edge cases.

### R-003: Frontmatter parser scope can creep

**Risk:** Supporting quoted strings, arrays, nested maps, and numbers can gradually become YAML.

**Mitigation:** Keep parser deliberately small. Unknown complex lines should produce invalid-file warning rather than partial guessing. Do not add YAML dependency in P1a.

### R-004: Config mutation commands can create persistence complexity

**Risk:** `/tool-context-loader on|off` could imply persistent config writes.

**Mitigation:** P1a should keep `on|off` as in-memory only or explicitly label it session-only. Persistent config editing can wait.

### R-005: Global episode scanning could reveal too much in diagnostics

**Risk:** Even metadata from global episodes may be sensitive.

**Mitigation:** P1a diagnostics should show only path, id, summary, tools/tags, and status. It should not show body snippets. Consider showing global episode counts by default and full metadata only under a future verbose flag.

### R-006: Project trust may be hard to unit-test without Pi context

**Risk:** `ctx.isProjectTrusted()` is available only in extension context.

**Mitigation:** Make discovery helper accept a plain `projectTrusted: boolean` parameter. The Pi handler only supplies `ctx.isProjectTrusted()`.

### R-007: Diagnostics command might become too noisy

**Risk:** Large episode directories could produce huge command output.

**Mitigation:** Cap diagnostics list output, e.g. first 50 records plus counts. Full verbose output can wait.

## Required Plan Adjustments Before Implementation

Add these to implementation details:

1. `MAX_DISCOVERY_FILE_BYTES` cap.
2. In-memory-only behavior for `/tool-context-loader on|off` in P1a.
3. Diagnostics output cap.
4. Helper-level `projectTrusted` parameter for unit testing.
5. Explicit no body retention in `RunbookRecord`.

## Suggested P1a Implementation Shape

Recommended single-file v1 shape:

```ts
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    discoveryState = await discover({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), config });
  });

  pi.registerCommand("tool-context-loader", {
    description: "Show/rescan tool-context-loader discovery diagnostics",
    handler: async (args, ctx) => { ... }
  });
}
```

Export pure helpers for tests:

```ts
export function parseFrontmatter(...)
export async function discoverFromRoots(...)
export function dedupeRecords(...)
export function formatDiagnostics(...)
```

This does slightly expose internals, but it makes testing much easier without introducing build tooling.

## Validation Review

P1a validation contracts are sufficient if mapped like this:

- P1A-001 missing roots safe — automated
- P1A-002 untrusted project gate — automated with `projectTrusted: false`
- P1A-003 deterministic discovery — automated
- P1A-004 valid frontmatter parsed — automated
- P1A-005 invalid frontmatter isolated — automated
- P1A-006 oversized discovery file skipped — automated
- P1A-007 unmapped episodes diagnostics-only — automated
- P1A-008 tag-mapped episodes eligible — automated
- P1A-009 source precedence dedupe — automated
- P1A-010 symlink escape rejected — automated if symlinks are supported in test environment; otherwise smoke/manual
- P1A-011 diagnostics omit bodies — automated
- P1A-012 diagnostics output capped — automated

P1a should also update `VALIDATION_MATRIX.md` to show later VC contracts deferred.

## Final Recommendation

Proceed to implementation after folding in the five required adjustments above. Keep P1a boring: scan, parse, list, test. Do not add context injection, matching, prompt customization, or body loading behavior until P1b/P1c.
