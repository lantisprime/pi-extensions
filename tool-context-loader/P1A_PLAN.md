# Tool Context Loader P1a Plan: Discovery + Diagnostics Only

## Purpose

Implement the first safe slice of `tool-context-loader`: discover local/global runbook, lesson, and episode metadata and expose diagnostics, without injecting anything into model context.

P1a intentionally proves discovery, trust gating, parsing, deterministic ordering, and diagnostics before any prompt/system/tool-result injection exists.

## TL;DR

- Build `tool-context-loader/index.ts` skeleton.
- Scan configured roots for Markdown files.
- Parse small YAML-like frontmatter metadata only.
- Respect project trust before reading project-local roots.
- Mark episodes without tool mappings as `unmapped` diagnostics-only.
- Dedupe by explicit `id`, normalized root-relative path, then content hash.
- Add `/tool-context-loader` diagnostics command.
- Add pure helper tests and fixture runbooks/episodes.
- Do **not** implement `before_agent_start`, `tool_call`, or `tool_result` injection yet.

## Design References

- `WORKPLAN.md`
- `tool-context-loader/DESIGN.md`
- `tool-context-loader/PLAN_REVIEW.md`
- `tool-context-loader/AGENT_EXTENSION_SEQUENCING.md`
- `WORKPLAN_ADVERSARIAL_REVIEW.md`
- `AGENTIC_WORKPLAN_FORMAT.md`

## P1a Scope

### In Scope

- Extension skeleton and command registration.
- Config loading with safe defaults.
- Project trust gate for project-local roots.
- Root resolution and safe path handling.
- Markdown discovery.
- Small frontmatter parser.
- Metadata registry.
- Episode eligibility detection.
- Source precedence and duplicate identity.
- Diagnostics command.
- Validation matrix stub for `VC-001` through `VC-024`.
- Unit tests for parser, discovery, trust, duplicate handling, unmapped episodes, and diagnostics formatting.

### Out of Scope

- No system-prompt injection.
- No `before_agent_start` context modification.
- No `tool_call` matching.
- No `tool_result` body injection.
- No runbook body retention or diagnostics body output. P1a may read bounded file text only to parse frontmatter and compute content hash.
- No Prompt Shield approval integration yet.
- No global episode injection eligibility unless explicitly tool-mapped.
- No agent/subagent integration.

## P1a User-Facing Behavior

### Slash command

```text
/tool-context-loader
/tool-context-loader status
/tool-context-loader rescan
/tool-context-loader on
/tool-context-loader off
```

P1a command output should include:

- enabled/disabled state
- trusted project-local scanning: yes/no
- configured project roots
- configured global roots
- discovered eligible runbooks count
- unmapped episodes count
- skipped/invalid files count
- warnings summary
- discovered metadata list, without body content

Example compact output:

```text
Tool Context Loader: enabled
Project trusted: yes
Project roots:
- .pi/runbooks: 2 eligible
- .runbooks: missing
- .episodic-memory/episodes: 1 eligible, 8 unmapped
Global roots:
- ~/.pi/agent/runbooks: missing
- ~/.episodic-memory/episodes: disabled for injection unless tool-mapped

Eligible runbooks:
- bash-kubectl [bash] .pi/runbooks/bash-kubectl.md — Kubernetes safety checks
- github-actions-edit [edit] .pi/runbooks/github-actions.md — CI workflow checklist

Warnings:
- .pi/runbooks/bad.md: invalid frontmatter, skipped
```

## Configuration Design

Config file:

```text
.pi/tool-context-loader.json
```

P1a defaults:

```ts
type LoaderConfig = {
  enabled: boolean;
  roots: string[];
  globalRoots: string[];
  enableGlobalEpisodes: boolean;
  defaultInjection: "tool_result";
  defaultPreload: "index";
  lazyReadBodies: true;
  maxRunbookBytes: number;
  maxPreloadBytesPerTurn: number;
  maxInjectedBytesPerTurn: number;
  maxInjectedLinesPerRunbook: number;
  dedupePerTurn: boolean;
  dedupePerSession: boolean;
};
```

Default config:

```json
{
  "enabled": true,
  "roots": [".pi/runbooks", ".runbooks", ".episodic-memory/episodes"],
  "globalRoots": ["~/.pi/agent/runbooks", "~/.episodic-memory/episodes"],
  "enableGlobalEpisodes": false,
  "maxInjectedBytesPerTurn": 10000,
  "maxPreloadBytesPerTurn": 2000,
  "maxRunbookBytes": 5000,
  "maxInjectedLinesPerRunbook": 160,
  "defaultInjection": "tool_result",
  "defaultPreload": "index",
  "lazyReadBodies": true,
  "dedupePerTurn": true,
  "dedupePerSession": false
}
```

In P1a, budget fields are parsed and displayed but not used for injection.

## Metadata Model

```ts
type InjectionMode = "preload" | "tool_result" | "steer";
type PreloadMode = "index" | "summary" | "body";
type SourceKind = "project-runbook" | "project-episode" | "global-runbook" | "global-episode";
type DiscoveryStatus = "eligible" | "unmapped" | "invalid" | "skipped";

type RunbookRecord = {
  id: string;
  identity: string;
  absolutePath: string;
  displayPath: string;
  root: string;
  sourceKind: SourceKind;
  sourcePrecedence: number;
  status: DiscoveryStatus;
  summary: string;
  tools: string[];
  tags: string[];
  injection: InjectionMode;
  preload: PreloadMode;
  priority: number;
  maxBytes: number;
  bodyBytes: number;
  contentHash: string;
  match: {
    commandIncludes: string[];
    pathIncludes: string[];
  };
  warning?: string;
  // No body field in P1a. Body text must not be retained in records.
};

type DiscoveryState = {
  enabled: boolean;
  projectTrusted: boolean;
  scannedAt: string;
  roots: Array<{ path: string; sourceKind: SourceKind; exists: boolean; scanned: boolean }>;
  records: RunbookRecord[];
  warnings: string[];
};
```

## Frontmatter Parser Design

The parser supports only:

- `key: scalar`
- `key: [a, b, c]`
- one-level nested `match:` map
- booleans and numbers
- quoted strings only as simple surrounding quotes, no escapes required in P1a

Supported fields:

- `id`
- `summary`
- `tools`
- `tags`
- `injection`
- `preload`
- `priority`
- `maxBytes`
- `match.commandIncludes`
- `match.pathIncludes`

Invalid frontmatter behavior:

- skip file from eligible registry
- add diagnostic warning
- continue discovery

No full YAML dependency in P1a.

## Discovery Algorithm

1. Load config with defaults.
2. Determine project trust via `ctx.isProjectTrusted()`.
3. Build root list:
   - project roots only if trusted
   - global roots always allowed, but global episodes are diagnostics-only unless `enableGlobalEpisodes` is true and explicitly tool-mapped
4. Resolve roots:
   - project roots relative to `ctx.cwd`
   - `~` roots relative to home directory
5. For each existing root:
   - recursively find `.md` files
   - sort paths deterministically
   - reject symlink escapes
   - skip files larger than `MAX_DISCOVERY_FILE_BYTES` with a warning
   - parse frontmatter
   - compute metadata and content hash
   - determine source kind and eligibility
6. Dedupe records:
   - explicit `id`
   - normalized root-relative path
   - content hash fallback
   - apply source precedence, then priority, then shortest display path
7. Store metadata in memory only.
8. Diagnostics command reads memory and caps output.

## Source Precedence

1. Project `.pi/runbooks/`
2. Project `.runbooks/`
3. Project `.episodic-memory/episodes/`
4. Global `~/.pi/agent/runbooks/`
5. Global `~/.episodic-memory/episodes/`

## Episode Eligibility

An episode is eligible only if it has one of:

- `tools: [bash, edit]`
- tag convention: `tool:bash`, `tool:edit`, `tool:write`, etc.

Otherwise:

- status: `unmapped`
- appears in diagnostics
- not eligible for future injection

## Security Design For P1a

- No context injection exists in P1a.
- No tool results are modified.
- No files are executed.
- Project-local roots are skipped when project is untrusted.
- Symlink escape is rejected.
- Diagnostics do not print full bodies.
- Global episodes are not injection-eligible by default.

## Implementation Plan

### Implementation Guardrails From Review

- Define `MAX_DISCOVERY_FILE_BYTES = 256_000` and skip larger files with a warning.
- `/tool-context-loader on|off` is in-memory/session-only in P1a; persistent config editing waits.
- Diagnostics list output is capped, e.g. first 50 records plus omitted count.
- Discovery helpers accept plain `projectTrusted: boolean` for unit testing; Pi handler supplies `ctx.isProjectTrusted()`.
- `RunbookRecord` must not retain body text.

### Step 1 — File skeleton

Create:

```text
tool-context-loader/index.ts
tool-context-loader/README.md
tool-context-loader/test-fixtures/
```

Register:

- `session_start`: load config and scan
- `resources_discover`: optionally rescan on reload, or rely on session_start for v1
- `/tool-context-loader`: diagnostics/status/rescan/on/off

### Step 2 — Pure helpers

Implement pure/testable helpers in `index.ts` first; split later only if needed:

- `mergeConfig`
- `resolveRoot`
- `findMarkdownFiles`
- `parseFrontmatter`
- `parseScalar`
- `parseArray`
- `classifySourceKind`
- `deriveToolsFromTags`
- `computeIdentity`
- `dedupeRecords`
- `formatDiagnostics`

### Step 3 — Discovery state

Maintain module-level state:

```ts
let config = DEFAULT_CONFIG;
let discoveryState: DiscoveryState = emptyDiscoveryState();
let enabledOverride: boolean | undefined;
```

P1a uses in-memory `enabledOverride`; persistent config mutation waits.

### Step 4 — Tests

Create fixtures:

```text
tool-context-loader/test-fixtures/project/.pi/runbooks/bash-kubectl.md
tool-context-loader/test-fixtures/project/.pi/runbooks/github-actions.md
tool-context-loader/test-fixtures/project/.pi/runbooks/invalid.md
tool-context-loader/test-fixtures/project/.episodic-memory/episodes/tool-mapped.md
tool-context-loader/test-fixtures/project/.episodic-memory/episodes/unmapped.md
tool-context-loader/test-fixtures/global/runbooks/global-bash.md
```

Create test runner:

```text
tool-context-loader/test-fixtures/test-discovery.ts
tool-context-loader/test-fixtures/run-p1a-tests.sh
```

### Step 5 — Validation matrix

Create:

```text
tool-context-loader/VALIDATION_MATRIX.md
```

Map at least P1a contracts to automated tests:

- VC-001
- VC-002
- VC-003
- VC-014
- VC-015
- VC-016
- VC-022
- VC-023
- VC-024

Mark later-stage contracts as deferred until P1b/P1c/P1d.

### Step 6 — Docs

Add README with:

- install path
- P1a status: discovery/diagnostics only
- commands
- config
- no-injection guarantee
- tests

## P1a Validation Contracts

### P1A-001: missing roots safe

Missing configured roots do not fail startup and appear as missing in diagnostics.

### P1A-002: untrusted project gate

When project is untrusted, project-local roots are not scanned.

### P1A-003: deterministic discovery

Repeated discovery over the same fixtures returns records in the same order.

### P1A-004: valid frontmatter parsed

Supported scalar, array, and one-level `match` fields parse correctly.

### P1A-005: invalid frontmatter isolated

Malformed frontmatter file is skipped with a warning, while other files load.

### P1A-006: oversized discovery file skipped

Files larger than `MAX_DISCOVERY_FILE_BYTES` are skipped with a warning and do not fail discovery.

### P1A-007: unmapped episodes are diagnostics-only

Episode files without tool mappings are marked `unmapped` and not eligible.

### P1A-008: tag-mapped episodes are eligible

Episode tags like `tool:bash` derive `tools: [bash]`.

### P1A-009: source precedence dedupe

Duplicate IDs prefer higher-precedence source, then priority, then shortest path.

### P1A-010: symlink escape rejected

Symlinks escaping configured roots are not loaded.

### P1A-011: diagnostics omit bodies

Diagnostics include metadata but no Markdown body content.

### P1A-012: diagnostics output capped

Diagnostics list output is capped with a count of omitted records to avoid flooding the UI.

## P1a Done Criteria

- `tool-context-loader/index.ts` exists and loads in Pi.
- `/tool-context-loader` diagnostics command works.
- Project trust gate is implemented.
- Missing roots are safe.
- Parser tests pass.
- Discovery tests pass.
- Validation matrix exists.
- No system prompt or tool result injection exists.
- CI or local test command is documented.

## Commands

```bash
tool-context-loader/test-fixtures/run-p1a-tests.sh
pi --no-extensions -e ./tool-context-loader/index.ts --list-models
```

Full repo sanity:

```bash
web-search/test-fixtures/run-redirect-fetch-tests.sh
scripts/verify-shared-sync.sh
scripts/test-security-scan.mjs
npx --yes tsx permission-policy/test-fixtures/test-classification.ts
```
