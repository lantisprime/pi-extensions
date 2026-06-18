# P4 Background Agents — Adversarial Security Review

**Reviewer**: `openrouter/anthropic/claude-opus-4-8`
**Date**: 2026-06-18
**Verdict**: conditional-go — 5 blockers, all center on manifest-as-trust-anchor for a process without live context

## Blockers

### B1. Manifest-based `explicitToolContextLoaderPath` → RCE
- **Invariant**: "No model/tool/spec injection — trusted loader path from `ctx` only"
- **Path**: `buildChildPiArgs` emits `-e <path>`; in P3 this comes from live session `ctx`. A detached worker must read `-e` from the manifest. 0700/0600 stops other users, not same-UID compromise. Anything writing `manifest.json` injects an arbitrary loader → code execution in child.
- **Fix**: Worker derives `explicitToolContextLoaderPath` from trusted runtime source (env `PI_AGENTS_TOOL_CONTEXT_LOADER_PATH` / pinned config), never from manifest. Sign manifest with per-session MAC; exclude `-e` from manifest entirely.

### B2. `disableResourceDiscovery: false` strips `--no-approve` and all hardening flags
- **Invariant**: "Child argv must not include `--approve` by default"; "forbidden tools blocked"
- **Path**: `child-args.ts:33` — `if (options.disableResourceDiscovery !== false)` pushes all five hardening flags. A single tampered manifest option (`disableResourceDiscovery:false`) removes `--no-approve`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes` at once.
- **Fix**: Worker hard-pins `disableResourceDiscovery` to safe value regardless of manifest. Assert child argv contains `--no-approve` and `--no-extensions` or abort.

### B3. Frozen manifest defeats re-read current spec bytes + hash mismatch fail-closed
- **Invariant**: "Current spec bytes must be re-read before execution"; "Raw-byte hash mismatch must fail closed"
- **Path**: Sync path re-reads file bytes and re-runs `canRunAgent` before every run. P4 freezes spec into manifest at preflight and worker executes frozen spec without re-reading or re-running the gate. Agent unregistered/revoked between preflight and spawn → bg run still executes. For bg-chain, step 2 spawns much later with still-frozen authority.
- **Fix**: Worker re-reads current file bytes, recomputes `rawBytesSha256`, reads current registry from disk, re-runs `canRunAgent` before each spawn including chain steps. Manifest pins identity (name/path/expected-hash), not execution authority.

### B4. Project-trust TOCTOU: trust checked in parent at preflight, never re-checked by worker
- **Invariant**: "Project agents require active project trust"
- **Path**: `canRunRegisteredProject` denies on `!context.projectTrusted`. `isProjectTrusted()` is a live session callback. Detached worker has no live trust state. Long bg-chain that outlives trust revocation continues executing with project-agent authority.
- **Fix**: Worker re-loads project registry + trust state from disk and re-evaluates `canRunAgent` with current trust at each spawn. If trust state isn't persisted/derivable, project agents must be ineligible for bg execution.

### B5. Architecture contradiction: "tmux launches supervisor" vs "reuse runChildAgent in same process / no supervisor binary"
- **Why blocker**: Cannot both be true. `tmux new-window '/path/to/supervisor manifest.json'` is a new process with no live `ctx`. If instead "same process," there is no real tmux backgrounding and the feature's premise is fake. This ambiguity produces B1–B4.
- **Fix**: State the process boundary explicitly. If separate process, document worker entrypoint and require it to re-run full P3 gate from disk + re-derive trusted-only options. Remove contradictory "same process / no supervisor binary" hard stop.

## Non-blocking issues

- `prompt.txt` persists "until read" — parent crash = task text on disk forever. Add TTL pruning.
- `events.jsonl` is raw and persisted — only `result.json` is redacted. Ensure no command surfaces raw JSONL.
- `runId` collision across concurrent Pi sessions — use `O_EXCL`/`wx` creation, EEXIST → regenerate.
- Symlink/predictable-path hardening — `mkdir` not `-p`, refuse pre-existing or symlinked dirs, `realpath` manifest before read.
- Concurrency-limit race — atomic reservation file with `wx` before tmux spawn.
- Window-name source — confirm `<shortId>` derived from random `runId`, never agent name.

## Missing negative tests

- Worker re-reads file bytes + re-runs `canRunAgent` at spawn; agent unregistered after preflight → no child pi spawned
- bg-chain step 2 authority revoked after preflight → step 2 fails closed, step 1 result still readable
- Manifest tamper: inject `write`/`edit`/`bash`/`run_subagent` → `buildChildPiArgs` forbidden-tool check rejects, no spawn
- Manifest tamper: `disableResourceDiscovery:false` → child argv still contains `--no-approve --no-extensions`
- Manifest tamper: malicious `explicitToolContextLoaderPath` → `-e` ignored/aborts
- Project trust revoked between preflight and spawn → project bg run denied
- `prompt.txt` deleted even when parent never reads result (crash path)
- `events.jsonl` never surfaced raw by any `bg-*` command
- `$TMUX` absent / nested tmux / detached → clean deny, no orphan worker, no manifest left executable
- Worker denied at spawn → tmux window closes, status=failed, no grandchild pi
- `runId` collision across two simulated concurrent sessions → regenerate, no overwrite
- Disk-full / partial atomic write → no partially-written manifest ever executed
- Concurrency limit hit by two simultaneous spawns → exactly one wins reservation
- Symlinked run dir / manifest → refused

## Verdict

**conditional-go** — Promote to **go** only after:
1. Worker re-derives trusted-only options (`-e`, `--no-*` set) from trusted runtime source, never manifest
2. Worker re-reads file bytes + registry + project-trust and re-runs `canRunAgent` (fail closed) before each spawn including chain steps
3. Manifest carries identity only (name/path/expected-hash), not authority; integrity-protected (MAC)
4. Process boundary stated explicitly; contradictory hard stop removed
5. Listed negative tests added and passing
