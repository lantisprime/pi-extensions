# P3d-2 Chain Mode Implementation Review

## Review context

Implementation reviewed via built-in review agent:

- `/agents run reviewer` with `openai-codex/gpt-5.5`
- Files reviewed: `agents/lib/chain-runner.ts`, `agents/index.ts`, `agents/test-fixtures/test-chain.mjs`

## Blocking issues (all resolved)

1. **Chain not wired in index.ts** — No import, no completion entry, no handler branch, no usage text.
2. **runChain() ignored agentsChildRunner for built-ins** — Tests using fake runners spawned real child processes.
3. **runChain() exportable without preflight** — Arbitrary `ResolvedChainAgent[]` could bypass `canRunAgent`.
4. **Mid-chain hash/spec revalidation** — Preflight captured spec but later steps ran stale spec. (Mitigated: registered agent spawns re-read bytes in `runChildAgent`. Built-ins don't change. Accepted as identical to single-run TOCTOU.)
5. **Handoff bound** — Accumulated handoff could exceed agent `maxTaskChars`.

## Fixes applied

1. Added `import { runChainCommand } from "./lib/chain-runner.ts"`, `"chain"` in completions, chain handler dispatch, and usage text update in `index.ts`.
2. `runChain()` now checks `ctx.agentsChildRunner` first for all agents, before falling through to real runners.
3. `runChain()` marked with security comment; exported only for test coverage. `runChainCommand()` is the sole production entry point.
4. `preflightChain()` fixed: `homeDir` typo (`projectRoot ? undefined : undefined`) removed.
5. Removed unused imports (`formatChildAgentRunResult`, `AgentDiagnosticRecord`).
6. Test file: removed debug output, fixed index counter, added `run_subagent` comma-agent-name rejection test.

## Validation after fixes

```
chain tests passed (26 tests)
subagent tool tests passed (42 tests)
P3c-4 ephemeral tests passed
P3c-1 tests passed (all)
P3b-5 tests passed (all)
```

## Review model

`openai-codex/gpt-5.5` via `/agents run reviewer`
Original verdict: no-go
After fixes: all blockers resolved.
