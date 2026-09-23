# GitHub Research: Similar Pi Extensions and Their Approaches

## Scope

Searched GitHub for public Pi extension repos and inspected README/source snippets for extensions related to:

- web search/browsing
- memory/context learning
- planning/workflows
- permission systems
- token/output compaction
- supervisors/subagents

## Sources Reviewed

- `nicobailon/pi-web-access` — https://github.com/nicobailon/pi-web-access
- `MattDevy/pi-extensions` — https://github.com/MattDevy/pi-extensions
- `MasuRii/pi-permission-system` — https://github.com/MasuRii/pi-permission-system
- `MasuRii/pi-rtk-optimizer` — https://github.com/MasuRii/pi-rtk-optimizer
- `owainlewis/pi-extensions` — https://github.com/owainlewis/pi-extensions
- `narumiruna/pi-extensions` — https://github.com/narumiruna/pi-extensions
- `tintinweb/pi-supervisor` — https://github.com/tintinweb/pi-supervisor
- `tmdgusya/roach-pi` — https://github.com/tmdgusya/roach-pi
- `ogulcancelik/pi-extensions` — https://github.com/ogulcancelik/pi-extensions

## Findings By Theme

### 1. Web search/browsing extensions favor provider fallback chains

`nicobailon/pi-web-access` uses a provider/fallback model: Exa MCP/API, Perplexity, Gemini API, Gemini Web with browser cookies, Jina Reader for blocked pages, and special handling for GitHub URLs by cloning them locally instead of scraping rendered HTML.

Approach:

- provider abstraction
- fallback chain
- optional API keys
- special-case GitHub for better code access
- pragmatic reliability over strict security

Implication for this repo:

- Our `secure_web_search` should keep security checks as its differentiator, but a provider abstraction would help reduce DuckDuckGo HTML fragility.
- For no-paid-API mode, a future provider order could be: self-hosted SearXNG, DuckDuckGo HTML fallback, then specialized free APIs like GitHub/Wikipedia/Stack Exchange.
- GitHub URL handling should eventually clone or use GitHub APIs instead of scraping rendered pages.

### 2. Continuous learning/context systems use event observation plus bounded prompt injection

`MattDevy/pi-continuous-learning` observes many Pi lifecycle events: `session_start`, `before_agent_start`, `agent_end`, `tool_execution_start`, `tool_execution_end`, `turn_start`, `turn_end`, `user_bash`, `session_compact`, and `model_select`. It distills observations into reusable “instincts,” tracks confidence, injects relevant instincts before agent turns, and can promote mature knowledge into AGENTS.md/skills/commands.

Approach:

- event-based observation
- local persisted learned rules
- confidence scoring and decay
- prompt injection only when relevant
- graduation path to stable docs/skills

Implication for this repo:

- `tool-context-loader` should remain metadata-first and relevance-gated.
- Future lessons/episodes could include confidence/evidence metadata, but v1 should avoid auto-learning complexity.
- Promotion to stable runbooks/skills is a useful later feature.

### 3. Planning extensions persist structured state and gate progress

`MattDevy/pi-blueprint` turns objectives into phased plans with dependencies, verification gates, state/history files, commands, and LLM tools. It injects active blueprint context on session start and provides commands like `/plan-status`, `/plan-verify`, and `/plan-next`.

Approach:

- phased plans
- dependency tracking
- verification gates
- machine-readable state + human-readable plan
- audit history

Implication for this repo:

- `WORKPLAN.md` should keep staged milestones and validation gates.
- A validation matrix for `VC-001` through `VC-024` matches the broader Pi ecosystem pattern.

### 4. Code review extensions use edit tracking, turn batching, and short injected checklists

`MattDevy/pi-code-review` hooks `tool_execution_end` to track modified files, batches by `turn_end`, and injects a language-specific review checklist at `before_agent_start`. It also supports on-demand structured review.

Approach:

- observe tool execution results
- batch work by turn
- inject concise guidance, not large context
- provide command-driven deeper review

Implication for this repo:

- This validates our `tool-context-loader` design: match during tool events, dedupe by turn, and keep preload compact.
- Use concise index/checklist-style preload and only load bodies JIT.

### 5. Permission extensions prefer deterministic rules and simple frontmatter

`MasuRii/pi-permission-system` ports OpenCode-style permissions into Pi agent markdown frontmatter and intentionally keeps frontmatter simple: scalars and nested maps, not full YAML features. It uses deterministic permission gates for tools, bash, MCP, skills, and special operations.

Approach:

- deterministic policy evaluation
- simple portable frontmatter
- per-agent permission rules
- compatibility with agent markdown files

Implication for this repo:

- Our small YAML-like parser decision is consistent with external practice.
- Avoid full YAML complexity in `tool-context-loader` v1.
- If/when agents are added, per-agent tool permissions should be explicit and conservative.

### 6. Token optimization extensions use pipeline compaction and tool-result modification

`MasuRii/pi-rtk-optimizer` rewrites bash commands and compacts noisy outputs from bash/read/grep. Its compaction pipeline includes ANSI stripping, test aggregation, build filtering, git compaction, linter aggregation, search grouping, smart truncation, and hard caps.

Approach:

- token budget as a first-class concern
- output compaction pipelines
- tool_result modification
- config/status commands

Implication for this repo:

- `secure_web_search` and `tool-context-loader` should keep deterministic byte/line caps.
- JIT context should be aggressively bounded and include source links/paths rather than full unbounded bodies.

### 7. Supervisors and agent systems often avoid polluting main context

`tintinweb/pi-supervisor` supervises goal progress from outside the main context, using a separate in-memory Pi session. It observes turns and can steer when the agent drifts, but avoids directly modifying the main agent’s context window/system prompt by default.

Approach:

- outside observer pattern
- goal drift detection
- steering only when needed
- separate model/session context

Implication for this repo:

- For future agent/subagent work, prefer isolated review/supervisor contexts over always injecting everything into the main context.
- `tool-context-loader` should inject only when tool activity proves relevance.

### 8. Goal/subagent extensions keep prompts short, state append-only, and hand off near context limits

`ogulcancelik/pi-goal` stores append-only state entries, queues continuation messages after agent cycles, and hands off to a linked new session around context limits. `ogulcancelik/pi-spar` supports peer model sparring with configured models/tools/skills and read-only tools by default.

Approach:

- append-only session state
- context-budget-aware handoff
- read-only peer agents by default
- explicit tool/skill configs

Implication for this repo:

- Minimal agent scaffolds should be read-only by default.
- Agent prompts should remain short and rely on `tool-context-loader` for local JIT guidance.
- Any long-running goal mode should include handoff/compaction behavior.

### 9. Larger suites split functionality into independently installable packages

`narumiruna/pi-extensions`, `MattDevy/pi-extensions`, and `ogulcancelik/pi-extensions` all use package-oriented extension suites where individual extensions can be installed independently.

Approach:

- extension-per-package or package-per-feature
- clear README per extension
- tests per package
- selective install

Implication for this repo:

- Keep each extension independently installable.
- Avoid runtime dependencies across extensions unless explicitly vendored or shared via copied code, as this repo already does with `shared/security-scan.ts`.

## Recommendations For This Repo

### Keep

- Security-first `secure_web_search` rather than a broad unguarded web extension.
- Vendored shared scanner model for independent installability.
- Staged `tool-context-loader` rollout.
- Small frontmatter parser.
- Index-only preload and JIT body loading.
- Conservative agent sequencing.

### Add Later

- Search provider abstraction for `secure_web_search`.
- Self-hosted SearXNG provider for no-paid/private search.
- Specialized GitHub URL handling using clone/API instead of generic web scraping.
- Validation matrix modeled after mature planning extensions.
- Agent/subagent read-only defaults and explicit tool lists.
- Optional confidence/evidence metadata for lessons/episodes after v1.

### Avoid

- Large always-on prompt injection.
- Full YAML parsing in v1.
- Public/random SearXNG instances as default.
- Browser-cookie search modes unless explicitly opt-in and clearly privacy-warned.
- Building a broad agent library before `tool-context-loader` is observable and tested.

## Bottom Line

The broader Pi extension ecosystem validates this repo’s direction: event-driven observation, compact prompt injection, staged plans with validation gates, deterministic permissions, token-aware output handling, and isolated subagents/supervisors. The main improvement suggested by external approaches is to add provider abstraction/fallbacks to `secure_web_search` while preserving this repo’s stronger security checks.
