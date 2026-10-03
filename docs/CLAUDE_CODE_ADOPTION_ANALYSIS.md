# Claude Code harness vs pi-extensions — adoption & conflict analysis

*Date: 2026-09-30 · Session: CC-CMP (comparison) + follow-up conflict review*
*Sources: [code.claude.com/docs/en/overview](https://code.claude.com/docs/en/overview), [code.claude.com/docs/en/features-overview](https://code.claude.com/docs/en/features-overview) (fetched live via searxng, 2026-09), pi core docs (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs`), repo code (file:line spot-checked where noted).*

---

## 1. Claude Code feature map (current, verified against live docs)

Extension-layer features from `features-overview`:

- **CLAUDE.md** persistent context (nested, `@path` imports) + auto memory + `.claude/rules/` path-scoped rules
- **Output styles** (per-session role/tone/format instruction sets)
- **Skills** (reference + action, frontmatter, `disable-model-invocation`, `context: fork`, namespaced plugin skills)
- **Subagents** (isolated context, custom system prompts, skills preloading, conversation forking, agent-to-agent messaging, Explore/Plan built-ins, `omitClaudeMd`)
- **Dynamic workflows** (model-written orchestration script running many subagents with cross-checking, returns one result)
- **Cross-session messaging** (session → session messages)
- **LSP code intelligence** (definition/references/type diagnostics after edits)
- **MCP** (tool search, deferred schemas, auto-reconnect)
- **Hooks** (lifecycle events: PreToolUse, PostToolUse, SessionStart, permission requests, compaction; actions: script / HTTP / MCP tool / prompt / subagent; JSON output control, block semantics) — CC's flagship deterministic-automation feature
- **Plugins + marketplaces** (namespaced bundles of skills/hooks/agents/MCP)
- **Artifacts** (publish session output as interactive web page)
- **Background agents** (agent view, parallel full sessions)
- **Schedules**: Routines (cloud), desktop scheduled tasks, `/loop`
- **Remote Control, Channels** (Telegram/Discord/webhooks), teleport, `/desktop` handoff
- **CI/CD**: GitHub Actions, GitLab CI, code review
- **Agent SDK**
- **Bundled skills**: `/code-review`, `/batch`, `/debug`
- **Context management**: `/context`, prompt caching, compaction hooks

Core-layer features (from docs structure + product knowledge): plan mode, permission modes (allow/ask/deny rules, settings), checkpoints `/rewind` (file-state + conversation restore), sandboxed bash, statusline, keybindings, background bash tasks, IDE integrations, headless mode.

## 2. Classification vs this repo

### ✅ HAVE — parity or ahead

| Claude Code | pi-extensions |
|---|---|
| Skills | pi core skills + repo discipline packs (`tasks`, `episodic-memory`, `typesafe-ai`) |
| Subagents / background agents | P3 agents (hash-registered specs, intent routing, chains) + herdr + tmux/cmux bg lanes |
| CLAUDE.md / auto memory | `AGENTS.md` + episodic-memory skill (arguably richer) |
| Task tracking | `tasks` extension — **ahead**: evidence gates, plan-artifact pinning, write-blocking ladder |
| Permission modes | `permission-policy` (ask/read-only/auto/yolo + project-persisted rules) |
| MCP | bridge extension + pi core native MCP |
| MCP tool search / deferred schemas | pi core `tool_search`/`deferred` — **verified** docs/mcp.md:127–154; not adoptable |
| Scheduled/recurring tasks | `monitor-threads` crons + monitors with framed wake events |
| Prompt-injection defense | `prompt-shield` + `secure_web_search` — **ahead**: no CC equivalent |
| Context observability | `context-manager` `/ctx:health` — **ahead** of CC `/context` |

### 🟡 PARTIAL — extend what exists

- **Path-scoped rules** (`.claude/rules/*` with `paths:` frontmatter) — `tool-context-loader` does JIT injection matched on *tools* (`index.ts:660` claim/dedupe), not file paths. Add path-glob matching.
- **Cross-session messaging** — herdr panes + tmux send exist; no formal protocol. Formalize on `herdr_prompt`.
- **Bundled workflow skills** (`/code-review`, `/debug`, `/batch`) — `reviewer` agent exists; package flows as model-invocable skills.
- **Plugins/marketplace** — repo installs via manual symlinks (`~/.pi/agent/extensions`); a registry + namespacing convention would fit pi's package story.

### 🔴 MISSING — adopt, ranked (Jev-assisted, jev-1.13.0)

| # | Feature | Jev signal | Why / how it fits |
|---|---|---|---|
| 1 | **Hooks engine** | top5 choice 0.58; feasible-without-fork noul 0.76 | CC's flagship: config-declared actions (shell/HTTP/MCP/prompt/subagent) *guaranteed* at lifecycle events with block semantics. We enforce rules only via bespoke TS (prompt-shield, permission-policy, tasks ladder). A `hooks.json` extension on pi's existing event bus turns the repo's "guardrails must be deterministic" philosophy into user config. Hook action type `prompt` maps directly onto `jev_ask` as an LLM-graded PreToolUse gate. |
| 2 | **Plan mode** | top5 0.31; feasible-as-composition noul 0.78 | Enforced read-only planning + explicit approval before writes. All pieces exist — permission-policy read-only mode, `.plans/<CODE>/spec.md` artifacts, tasks discipline — but no *enforced* gate. Compose: plan mode = read-only until `/plan approve`. |
| 3 | **Dynamic workflows** | — | Model-written orchestration scripts fanning out many subagents with verification passes. Chains cap at 3–8; nothing does script-driven fan-out + cross-checking. Natural `agents_run` follow-up; Jev slots in as verifier. |
| 4 | **LSP code intelligence** | — | definition/references/diagnostics-after-edit tools; repo is grep-only. TypeScript language server first. |
| 5 | **Checkpoints /rewind** | top5 0.02 | File-state snapshots + restore around edits. Pi "checkpoints" are transcript-format only (**verified** compaction.md:83, extensions.md:186) — a real gap. |

**Not worth adopting:** cloud-bound surfaces (Slack, mobile/teleport, Routines-cloud, Chrome, desktop app, artifacts-as-webpage) — outside a local terminal harness's scope.

**Suggested first slice:** hooks extension — highest leverage, pure extension-layer work; plan mode becomes nearly free afterward (it is a hook-shaped write gate).

## 3. Conflict analysis — do the missing features clash with existing skills/extensions?

*Verified against code 2026-09-30. Verdict: no hard blockers; four design decisions required.*

| Adopt feature | Conflicts with | Severity | Nature |
|---|---|---|---|
| Hooks engine | permission-policy, prompt-shield, tasks ladder | 🟠 design decision | Gating precedence + new attack surface |
| Plan mode | tasks skill, permission-policy mode state | 🟠 design decision | `.plans/` carve-out needed |
| Dynamic workflows | DELEGATION.md, agent registry caps | 🟡 integration | Doc amendment + safety gating |
| LSP code intelligence | tool-context-loader budget, context-manager | 🟡 integration | Second context injector |
| Checkpoints/rewind | permission-policy, tasks evidence | 🟢 minor | Gate it + record it |

**1. Hooks ↔ permission-policy precedence.** Both gate tool calls at the same event. Undefined behavior if a hook says "allow" and permission-policy says "ask" (or vice versa). Rule to adopt: *permission-policy evaluates first; hooks may only tighten, never loosen.* `hooks.json` is config-as-code running shell commands — exactly what prompt-shield scans; route hook declarations through its approval flow. The tasks compliance ladder (`tasks/index.ts:177,401` — **verified**) is effectively a hardcoded PreToolUse/PostToolUse hook pair; a hooks engine should not duplicate it — migrate gradually.

**2. Plan mode blocks the tasks skill's own workflow.** Sharpest real conflict: the tasks discipline *writes* `.plans/<CODE>/spec.md` during planning — plan mode blocks writes. Without a carve-out, plan mode makes the repo's planning discipline impossible. Fix: whitelist `.plans/**` (task tools are harness-level, unaffected). Second: `/plan approve` and `/permission-policy:cycle` (`permission-policy/index.ts:103` — **verified**) would both own "mode" state; plan mode must be a layer on read-only, not a second source of truth.

**3. Dynamic workflows vs the delegation safety model.** `skills/tasks/DELEGATION.md` (existence **verified**) is the executor decision tree; a workflow engine is a new executor → amend the doc (repo rule 5: append under Amendments). Constraints it must respect: bg lanes run *registered* agents only; chains are capped 3–8 (**README-sourced only — code grep on `agents/index.ts` for caps found nothing; verify against `agents/lib` before building**). Workflow subagents are invisible to the session task list → compliance ladder either nags or is bypassed; give each workflow run an owning task or an explicit exemption.

**4. LSP diagnostics = a second context injector.** `tool-context-loader` claims per-turn injection budget with dedupe (`tool-context-loader/index.ts:660` `claimMatchesForTurn` — **verified**). Diagnostics-after-edit must claim from the same budget or a coordinated one. Context-manager will see a new span type after every edit → needs classification/elision rules. Spawning language servers from config is a supply-chain surface (like MCP servers) → reuse prompt-shield scanner/approval pattern.

**5. Checkpoints are the clean one.** Rewind is a bulk write → permission-gate it; it can retroactively invalidate task "evidence" (completed task, work undone) → record rewind events so tasks/episodic-memory see them. *(Postscript 2026-09-30: the same day, a real context-manager bug was fixed — purity-triggered compact could fire below pi's keepRecent floor, rejected with "session too small"; fixed via `COMPACT_MIN_TOKENS` guard, see `.plans/CONTEXT/spec-phase2.md` Amendments. Relevant precedent for any checkpoint/restore work: pi-side size/validity contracts must be guarded before calling in.)*

## 4. Status & next steps

- Conflict analysis is self-reviewed with code spot-checks; the independent adversarial review delegation did **not** run (no registered agent at the time). Re-run before implementation.
- Adoption plans per feature: §5 below. First slice to draft as a formal `.plans/CC-HOOKS/spec.md`: the hooks extension (§5.1).

---

## 5. Adoption plans

Order follows §2 ranking. Every slice ships with wiring tests (repo rule 4: wiring bugs get wiring tests); design docs get Amendments, not silent edits (rule 5).

### 5.1 CC-HOOKS — config-driven hooks extension (S/M, do first)

**Goal:** user-declared actions guaranteed to fire at lifecycle events, turning bespoke guardrail TS into config.

- **S1 Schema + loader** — `~/.pi/agent/hooks.json` (global) + `.pi/hooks.json` (project), deep-merged. Events: `pre_tool_use`, `post_tool_use`, `session_start`, `turn_end`, `pre_compact`. Matchers: tool-name globs, path globs. Actions: `command` (shell, stdin=event JSON), `http`, `mcp_tool`, `prompt` (Jev-graded), `subagent` (registered agents only). Block semantics: exit 2 or JSON `{decision:"block", reason}` on `pre_tool_use`.
- **S2 Enforcement wiring** — subscribe via the pi extension event bus (same events prompt-shield/permission-policy use). **Precedence (decision D1): permission-policy evaluates first; hooks may only tighten, never loosen.** Per-action timeout; hook stdout capped and injected like CC.
- **S3 prompt-shield integration** — hooks declarations are config-as-code: scan + approval flow on hooks.json changes (hash-pinned, re-approve on change). (Decision D2 — reuse prompt-shield approvals, do not build a second approval UI.)
- **S4 (optional, later)** — migrate the tasks compliance ladder (`tasks/index.ts:177,401`) onto the hook layer once semantics match; until then leave it untouched (no duplication).

**Open questions:** parallel vs sequential hook execution; secret env passthrough to `command` actions; whether `post_tool_use` output claims budget from tool-context-loader or gets its own cap.

**ACs (draft):** AC-1 matched hook fires deterministically at each event, once; AC-2 `pre_tool_use` block prevents tool execution and surfaces reason; AC-3 no hook can override a permission-policy denial; AC-4 modified hooks.json is inert until prompt-shield approval; AC-5 hook timeout ⇒ skip + telemetry, never hang the turn.

### 5.2 CC-PLAN — plan mode (S, second — nearly free after 5.1)

**Goal:** enforced read-only planning with explicit approval gate before writes.

- **S1 State layer** — `plan` as a layer on permission-policy's read-only mode (single source of truth for mode state — decision D3; `/plan` sets it, `/plan approve <ref>` lifts it and restores the prior mode). Not a second mode enum.
- **S2 Carve-out** — allow writes under `.plans/**` and harness-level task tools while planning; everything else write-gated. Without this the tasks discipline (which writes spec.md during planning) is impossible.
- **S3 UX** — status segment state; on approve, pin the plan artifact hash (tasks plan-artifact pattern).

**Open questions:** interaction with yolo mode (plan mode must still gate); auto-approve rules for `.plans/**` under prompt-shield.

### 5.3 CC-WF — dynamic workflows (M)

**Goal:** model-authored orchestration scripts fanning out subagents with cross-checking, returning one result.

- **S1 Runner** — workflow = ordered plan of subagent calls (registered agents only — bg-lane rule), declared in a plan file the model writes; runner executes via `agents_run`/herdr lanes.
- **S2 Safety** — respect existing registry gating and chain caps. ⚠️ **The 3–8 chain cap is README-sourced; code grep found no cap in `agents/index.ts` — verify the real enforcement in `agents/lib` before sizing this.**
- **S3 Tracking** — each workflow run owns a session task (or explicit exemption) so the compliance ladder neither nags nor is bypassed.
- **S4 Verification pass** — cross-check findings via one batched Jev call (noul per finding) before returning.

**Open questions:** max fan-out; budget ceiling per run; amendment to `skills/tasks/DELEGATION.md` decision tree (rule 5).

### 5.4 CC-LSP — code intelligence (M)

**Goal:** definition/references/diagnostics tools; stop being grep-only.

- **S1 Server** — TypeScript language server first, spawned per workspace; tools `lsp_definition`, `lsp_references`, `lsp_diagnostics`.
- **S2 Context economy** — diagnostics after edits claim from tool-context-loader's per-turn budget (`index.ts:660` claim/dedupe) or a coordinated cap; context-manager gets a `lsp-diag` span class with elision rules.
- **S3 Supply chain** — server binaries approved via the prompt-shield MCP-server approval pattern.

**Open questions:** multi-root workspaces; non-TS languages (later phases).

### 5.5 CC-REW — checkpoints / rewind (S/M, last)

**Goal:** restore file state + conversation position around edits.

- **S1 Snapshots** — pre-image side-car captures before write/edit tools (pattern: context-manager elision side-car).
- **S2 Restore** — `/rewind` permission-gated (it is a bulk write); restores file pre-images; transcript untouched (context-manager shape state is derived from entry IDs, so no desync).
- **S3 Eventing** — record rewind events so tasks evidence and episodic-memory observe them (a rewind can invalidate completed-task evidence).

**Precedent to respect:** pi-side validity contracts must be guarded before calling in — see the 2026-09-30 context-manager floor fix (`COMPACT_MIN_TOKENS`, spec-phase2 Amendments): a checkpoint restore must no-op cleanly when pi rejects the operation, mirroring the compact guard.

### Milestones

1. **M1:** CC-HOOKS S1–S3 shipped + `.plans/CC-HOOKS/spec.md` ratified → deterministic guardrails become config.
2. **M2:** CC-PLAN shipped (composes M1 gate machinery) → enforced plan-then-execute discipline.
3. **M3:** CC-WF (after agents-cap verification) + CC-LSP in parallel.
4. **M4:** CC-REW; then PARTIAL items (path-scoped rules, cross-session messaging, bundled skills, packaging) as capacity allows.
