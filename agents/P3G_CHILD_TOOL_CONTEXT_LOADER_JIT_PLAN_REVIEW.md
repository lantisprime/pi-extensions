# P3G Child Tool-Context-Loader JIT Plan Review

## Review context

Plan reviewed:

- `agents/P3G_CHILD_TOOL_CONTEXT_LOADER_JIT_PLAN.md`
- Compared against `agents/PLAN_TEMPLATE.md`

Requested review mode:

- Built-in `/agents run reviewer` adversarial plan review.

Execution note:

- Attempted `/agents run reviewer ...` through `pi -e ./agents/index.ts`.
- The child reviewer run failed before producing output due to model quota:
  - `usage_limit_reached`
  - provider/model path surfaced as Codex quota exhaustion.
- Fallback used a bounded direct Pi reviewer-role invocation with explicit OpenRouter model:
  - `pi --model openrouter/z-ai/glm-5.2 --mode text --no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --tools read -p @<prompt-file>`
- The fallback prompt constrained review to:
  - `agents/P3G_CHILD_TOOL_CONTEXT_LOADER_JIT_PLAN.md`
  - `agents/PLAN_TEMPLATE.md`
- The fallback is not a successful built-in child-agent run, but it used the same reviewer role/output contract and a bounded read-only tool policy.

## Blocking issues

None.

The reviewer found that the plan follows `PLAN_TEMPLATE.md` section-for-section, maps MUST requirements to tests or validation checks, lists implementation files, and captures the key child extension-loading safety boundaries.

## Non-blocking issues

1. The open decision "What exact session field provides the trusted loader path?" is deferred to P3G-1 but was not listed as a P3G-1 Done Criteria item.
2. `testSubagentDetailsDoNotExposePromptTransport` appeared in REQ-10 but was missing from the Test Case Catalog.
3. REQ-6 relied partly on static review for proving agent specs/frontmatter cannot supply a loader path; the reviewer recommended an automated assertion such as `testAgentSpecCannotSetLoaderPath`.
4. Runtime boundary "child loads only the explicit loader extension" is only proven at argv level; this is acceptable for deterministic CI, but the plan should be clear that live loaded-extension behavior is a manual smoke, not a CI assertion.
5. A test should assert trusted loader path source population once the source is decided.

## Missing tests/validation

- Add or name a test that proves the trusted path source populates session context end-to-end once decided.
- Add an automated assertion that `AgentSpec` / frontmatter cannot carry `explicitToolContextLoaderPath`.
- Add `testSubagentDetailsDoNotExposePromptTransport` to the Test Case Catalog.
- Add Done Criteria for resolving the trusted loader path source decision and confirming no AgentSpec field exists.

## Safety/security concerns

The safety boundaries are substantially complete:

- model-controlled loading is explicitly forbidden
- broad discovery stays disabled with `--no-extensions`
- registered-agent gates remain intact
- path leakage is addressed through existing compact result whitelisting
- denial paths remain fail-closed

Residual concern: the exact trusted source of `explicitToolContextLoaderPath` must be pinned before implementation. Until then, "session/extension-owned, not model-owned" is a design intent rather than a concrete contract.

## Verdict

conditional-go

## Follow-up applied

The plan was revised to:

- add a MUST requirement for resolving/testing the trusted loader-path source
- add `testAgentSpecCannotSetLoaderPath`
- list `testSubagentDetailsDoNotExposePromptTransport` in Test Case Catalog
- add Done Criteria for loader-path source resolution and AgentSpec/frontmatter exclusion
- record this review in the Review Consensus table

## Implementation follow-up

The local implementation resolved the trusted loader-path source:

1. `ctx.explicitToolContextLoaderPath` from trusted session/embedding context has highest priority.
2. If absent, parent-process environment variable `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` is used.
3. Tool params, delegated tasks, and agent specs/frontmatter do not set or override the path.

Added tests cover both session/context forwarding and environment fallback:

- `testRunBuiltInForwardsToolContextLoaderPath`
- `testRunRegisteredForwardsToolContextLoaderPath`
- `testEnvToolContextLoaderPathSourcePopulatesRunOptions`
- `testRunSubagentBuiltInForwardsToolContextLoaderPath`
- `testRunSubagentRegisteredForwardsToolContextLoaderPath`
- `testTrustedLoaderPathSourcePopulatesSessionContext`
- `testAgentSpecCannotSetLoaderPath`
- `testRunTempForwardsToolContextLoaderPath`
