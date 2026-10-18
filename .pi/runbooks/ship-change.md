---
id: ship-change
summary: Changed-package test commands and ship order (derived from CI)
tools: [bash]
tags: [workflow, tool:bash]
match:
  commandIncludes: ["git status", "git diff", "git commit", "git push", "gh pr create"]
injection: tool_result
priority: 60
maxBytes: 2048
derivedFrom: ".github/workflows + package test entry points"
sourceCommit: f3790dc6e7a6056027022a37c0ac5b8a6611818e
verifiedBy: operator (delegated to agent, 2026-10-18)
verifiedAt: 2026-10-18
---

# Ship a change

1. Inspect the diff (status and diff commands).
2. Run the suite for every changed package (table below). A green run
   must be recorded before commit, push, or PR; the workflow guard reads
   the exact command from `.pi/workflow.json`.
3. Update the plan/handoff artifact the repo asks for.

## Package suites

- `agents/**` → `npx --yes tsx --test agents/test/test-agents-run-tool.mjs && npx --yes tsx --test agents/test/test-agents-run-wiring.mjs && npx --yes tsx --test agents/test/test-chain-runner.mjs && npx --yes tsx --test agents/test/test-bg-trust.mjs && npx --yes tsx --test agents/test/test-bg-wake.mjs && npx --yes tsx --test agents/test/test-builtins.mjs`
- `cmux-control/**` → `bash cmux-control/test-fixtures/run-tests.sh`
- `cmux-terminal/**` → `bash cmux-terminal/test-fixtures/run-cmux-tests.sh`
- `context-manager/**` → `npx --yes tsx --test context-manager/test/`
- `herdr-control/**` → `bash herdr-control/test-fixtures/run-tests.sh`
- `mcp/**` → `npx --yes tsx mcp/test/run-config-test.mjs && npx --yes tsx mcp/test/run-headers-test.mjs && npx --yes tsx mcp/test/run-client-test.mjs && npx --yes tsx mcp/test/run-http-test.mjs`
- `mcp-gateway/**` → `bash mcp-gateway/test-fixtures/run-mcp-gateway-tests.sh`
- `permission-policy/**` → `npx --yes tsx permission-policy/test-fixtures/test-classification.ts && npx --yes tsx permission-policy/test-fixtures/test-herdr-blocked.ts && npx --yes tsx permission-policy/test-fixtures/test-seat-auto.ts`
- `prompt-shield/**` → `bash prompt-shield/test-fixtures/run-cache-management-test.sh`
- `scripts/**` → `scripts/test-security-scan.mjs`
- `smart-compaction/**` → `npx --yes tsx --test smart-compaction/test/`
- `tmux-control/**` → `npm test --prefix tmux-control`
- `tmux-terminal/**` → `bash tmux-terminal/test-fixtures/run-p5-tests.sh`
- `tool-context-loader/**` → `tool-context-loader/test-fixtures/run-p1a-tests.sh`
- `web-search/**` → `web-search/test-fixtures/run-redirect-fetch-tests.sh`
- `workflow-guard/**` → `npx --yes tsx --test workflow-guard/test/unit.test.mjs workflow-guard/test/wiring.test.mjs`
- `zellij-terminal/**` → `bash zellij-terminal/test-fixtures/run-zellij-tests.sh`
- `shared/**` → `node scripts/test-security-scan.mjs`

## CI executes

- `scripts/test-security-scan.mjs` (.github/workflows/ci.yml:43)
- `web-search/test-fixtures/run-redirect-fetch-tests.sh` (.github/workflows/ci.yml:46)
- `tool-context-loader/test-fixtures/run-p1a-tests.sh` (.github/workflows/ci.yml:49)
- `npx --yes tsx --test workflow-guard/test/unit.test.mjs workflow-guard/test/wiring.test.mjs` (.github/workflows/ci.yml:52)
- `npx --yes tsx permission-policy/test-fixtures/test-classification.ts` (.github/workflows/ci.yml:72)
- `npx --yes tsx permission-policy/test-fixtures/test-herdr-blocked.ts` (.github/workflows/ci.yml:75)
- `npx --yes tsx permission-policy/test-fixtures/test-seat-auto.ts` (.github/workflows/ci.yml:78)
- `npx --yes tsx mcp/test/run-config-test.mjs npx --yes tsx mcp/test/run-headers-test.mjs npx --yes tsx mcp/test/run-client-test.mjs npx --yes tsx mcp/test/run-http-test.mjs` (.github/workflows/ci.yml:86)
- `bash herdr-control/test-fixtures/run-tests.sh` (.github/workflows/ci.yml:88)
- `npx --yes tsx --test agents/test/test-agents-run-tool.mjs npx --yes tsx --test agents/test/test-agents-run-wiring.mjs npx --yes tsx --test agents/test/test-chain-runner.mjs npx --yes tsx --test agents/test/test-bg-trust.mjs npx --yes tsx --test agents/test/test-bg-wake.mjs npx --yes tsx --test agents/test/test-builtins.mjs` (.github/workflows/ci.yml:103)
