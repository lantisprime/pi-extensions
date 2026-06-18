# P3G Child Tool-Context-Loader JIT Implementation Review

## Review context

Implementation reviewed:

- `agents/index.ts`
- `agents/lib/run-resolver.ts`
- `agents/lib/subagent-tool.ts`
- `agents/lib/ephemeral.ts`
- `agents/test-fixtures/test-child-args-jsonl.mjs`
- `agents/test-fixtures/test-extension-scaffold.mjs`
- `agents/test-fixtures/test-subagent-tool.mjs`
- `agents/test-fixtures/test-ephemeral.mjs`

Review method:

- Attempted bounded reviewer-role fallback after prior `/agents run reviewer` quota issue.
- First fallback with `openrouter/z-ai/glm-5.2` failed with `401 User not found`.
- Second fallback used `openrouter/deepseek/deepseek-chat` with `--no-tools` and full current implementation diff embedded in the prompt.

## Blocking issues

None found.

## Non-blocking issues

None found.

The reviewer suggested two optional validation improvements:

1. Add negative tests for invalid/malicious loader paths.
2. Add a test for precedence between explicit context path and environment fallback.

Both suggestions were implemented after review in `agents/test-fixtures/test-subagent-tool.mjs` via `testLoaderPathSourcePrecedenceAndValidation`.

## Missing tests/validation

Reviewer original suggestions:

- Could add negative test cases for invalid/malicious loader paths.
- Could test environment variable precedence over explicit path.

Applied follow-up:

- `testLoaderPathSourcePrecedenceAndValidation` now verifies:
  - `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` populates child options when no context path exists.
  - `ctx.explicitToolContextLoaderPath` overrides the environment fallback.
  - invalid environment path containing a newline is rejected by the existing `buildChildPiArgs` validation path.

## Safety/security concerns

Reviewer noted:

- Environment variable source is trusted but should be documented clearly.
- Loader path contents are not independently validated at resolver time; they rely on existing child-args validation.

Assessment:

- The plan now documents the trusted source as `ctx.explicitToolContextLoaderPath` first, then parent-process `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH`.
- The implementation deliberately keeps path validation in `buildChildPiArgs`, which already validates empty/NUL/newline path hazards before spawn.
- No model/tool/spec/task input can set the loader path.
- Broad extension discovery remains disabled via `--no-extensions`; the explicit `-e` is additive.

## Verdict

go

## Validation run after review follow-up

```bash
npx --yes tsx agents/test-fixtures/test-subagent-tool.mjs
./agents/test-fixtures/run-p3d-1-tests.sh
./agents/test-fixtures/run-p3c-1-tests.sh
```

Results:

- `subagent tool tests passed (42 tests)`
- P3d-1 aggregate passed
- P3c-1 aggregate passed
