# P3 Inheritance Proof: Child Pi Subprocess Global Extensions

## Objective

Before building agent/subagent workflows, prove whether child Pi subprocesses inherit globally installed extensions when run in non-interactive JSON/print mode.

Target command shape from the canonical workplan:

```bash
pi --mode json --no-session -p "..."
```

Decision needed:

- If global extensions load automatically, future subagent launchers can rely on globally installed `tool-context-loader`.
- If not, future subagent launchers must explicitly pass `-e ~/.pi/agent/extensions/tool-context-loader/index.ts`.

## Relevant Pi Docs

- `docs/extensions.md` says global extensions are auto-discovered from:
  - `~/.pi/agent/extensions/*.ts`
  - `~/.pi/agent/extensions/*/index.ts`
- `docs/extensions.md` Mode Behavior says:
  - JSON mode has `ctx.mode === "json"`
  - JSON mode has `ctx.hasUI === false`
  - extensions run, but UI methods are no-ops
- `README.md` CLI docs say:
  - `--mode json` outputs JSON lines
  - `--no-session` is ephemeral mode
  - `--no-extensions` disables extension discovery
  - explicit `-e/--extension` paths still work with `--no-extensions`

## Method

Use a temporary global probe extension, not the production loader, so the proof is observable without relying on model behavior.

Temporary probe location:

```text
~/.pi/agent/extensions/p3-inheritance-probe/index.ts
```

Probe behavior:

- writes JSONL records to `P3_PI_PROBE_LOG`
- logs extension factory load
- logs extension registration
- logs `session_start`
- logs `before_agent_start`
- logs `before_provider_request`
- throws from `before_provider_request` when `P3_PI_PROBE_ABORT=1`, avoiding an actual provider request after the extension has proven it loaded

The temporary probe was removed after the test.

## Commands

### 1. Global auto-discovery in child JSON/print mode

```bash
P3_PI_PROBE_LOG=/tmp/p3-probe-global.jsonl \
P3_PI_PROBE_MODE=global \
P3_PI_PROBE_ABORT=1 \
pi --mode json --no-session \
  --no-tools --no-skills --no-prompt-templates --no-context-files \
  -p "P3 inheritance probe noop"
```

Observed probe log:

```jsonl
{"event":"factory","mode":"global"}
{"event":"register","mode":"global"}
{"event":"session_start","mode":"global","ctxMode":"json","hasUI":false,"cwd":"/Users/charltondho/Developer/projects/pi-extensions"}
{"event":"before_agent_start","mode":"global","ctxMode":"json","hasUI":false}
{"event":"before_provider_request","mode":"global","ctxMode":"json","hasUI":false}
```

Observed stderr:

```text
Extension error (.../.pi/agent/extensions/p3-inheritance-probe/index.ts): P3 inheritance probe abort before provider request
```

### 2. Negative control: global discovery disabled

```bash
P3_PI_PROBE_LOG=/tmp/p3-probe-disabled.jsonl \
P3_PI_PROBE_MODE=disabled \
P3_PI_PROBE_ABORT=1 \
pi --mode json --no-session --no-extensions \
  --no-tools --no-skills --no-prompt-templates --no-context-files \
  --model __p3_probe_missing_model__ \
  -p "P3 inheritance probe noop"
```

Observed probe log:

```text
<missing>
```

Observed stderr:

```text
Error: Model "__p3_probe_missing_model__" not found. Use --list-models to see available models.
```

This confirms the global probe was not loaded when `--no-extensions` disabled extension discovery.

### 3. Explicit extension path control

```bash
P3_PI_PROBE_LOG=/tmp/p3-probe-explicit.jsonl \
P3_PI_PROBE_MODE=explicit \
P3_PI_PROBE_ABORT=1 \
pi --mode json --no-session --no-extensions \
  -e /tmp/p3-inheritance-probe-extension.ts \
  --no-tools --no-skills --no-prompt-templates --no-context-files \
  -p "P3 inheritance probe noop"
```

Observed probe log:

```jsonl
{"event":"factory","mode":"explicit"}
{"event":"register","mode":"explicit"}
{"event":"session_start","mode":"explicit","ctxMode":"json","hasUI":false,"cwd":"/Users/charltondho/Developer/projects/pi-extensions"}
{"event":"before_agent_start","mode":"explicit","ctxMode":"json","hasUI":false}
{"event":"before_provider_request","mode":"explicit","ctxMode":"json","hasUI":false}
```

This confirms explicit `-e` remains a viable fallback when extension discovery is disabled.

## Result

**Global extension inheritance is proven for child Pi subprocesses run as:**

```bash
pi --mode json --no-session -p "..."
```

In that mode, globally installed extensions from `~/.pi/agent/extensions/*/index.ts` are loaded and receive at least:

- factory load
- registration
- `session_start`
- `before_agent_start`
- `before_provider_request`

The observed context was:

```text
ctx.mode = json
ctx.hasUI = false
```

## Decision

Future subagent/agent child Pi launchers can rely on globally installed extensions by default, including:

```text
~/.pi/agent/extensions/tool-context-loader/index.ts
```

However, launchers should still support an explicit-extension fallback:

```bash
-e ~/.pi/agent/extensions/tool-context-loader/index.ts
```

Use that fallback when:

- the launcher passes `--no-extensions`
- a user requests hermetic extension loading
- a future regression shows global extension discovery is disabled in a specific subprocess mode

## Implications for P3/P4

- P3 can proceed to minimal agent/subagent scaffold planning.
- Agent prompts can include a short advisory line that local tool-context-loader guidance may appear after matching tool results.
- Do not duplicate runbook bodies or long lessons in agent prompts.
- Keep full workflow expansion deferred until the minimal scaffold proves subprocess behavior and output bounds.

## Cleanup Verified

After the proof:

- temporary global probe directory was removed
- `pi --list-models` still exits successfully
- Prompt Shield state remained:

```text
strictPermissions=false
riskyCount=0
dangerousCount=0
```
