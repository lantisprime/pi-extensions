// Workflow guard for pi: keep repo instructions load-bearing without context
// bloat.
//
// - Constant one-line standing rule per turn (bounded, no growth).
// - A single delta line when tracked packages are not green (at most one/turn).
// - Hard gates at decision points only: steering-file mutation (G1) and
//   commit/push/PR without a green run for the changed packages (G2).
// - Compliance state comes from a read-only git snapshot plus a persisted
//   content-hash ledger; an uncomputable snapshot fails closed.
//
// The contract is `.pi/workflow.json`; runbooks are derived separately by
// scripts/workflow-derive.mjs and never activated from here.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CONTRACT_RELATIVE_PATH, loadContract } from "./lib/contract.ts";
import { hashChangedFiles, readSnapshot, type Snapshot } from "./lib/git.ts";
import { matchGlob } from "./lib/glob.ts";
import { emptyState, loadState, recordGreen, saveState, type WorkflowState } from "./lib/state.ts";
import { clamp, deltaLine, enforcementStatus, standingLine } from "./lib/steering.ts";
import { evaluateCommitGate, isCommitLikeCommand, packagesTouched, planGateActive, protectedHit } from "./lib/gate.ts";
import type { PackageSpec, WorkflowContract } from "./lib/types.ts";

type AuditEvent = {
	ts: string;
	event: "block" | "override" | "confirm" | "green";
	path?: string;
	package?: string;
	reason?: string;
};

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function packageChangedKey(changed: string[]): string {
	// Paths only: a cheap per-turn delta signal. The gate uses content hashes.
	return changed.join("\n");
}

export function commandRunsTest(command: string, test: string): boolean {
	// A failed suite must not count as green: reject failure-masking operators.
	if (/\|\||;\s*\S/.test(command)) return false;
	const normalized = normalizeCommand(command);
	const expected = normalizeCommand(test);
	if (normalized === expected) return true;
	// Allow a `cd ... &&` prefix; the tested command must be the final segment.
	const segments = command
		.split(/\n|&&/)
		.map((segment) => normalizeCommand(segment))
		.filter(Boolean);
	return segments.length > 0 && segments[segments.length - 1] === expected;
}

export default function workflowGuard(pi: ExtensionAPI) {
	let contract: WorkflowContract | null = null;
	let contractError: string | undefined;
	let state: WorkflowState = emptyState(process.cwd());
	let enforcing = true;
	let snapshot: Snapshot | null = null;
	let snapshotStale = true;
	let deltaShownThisTurn = false;
	let overrideNext: string | null = null;
	const pendingCommands = new Map<string, string>();
	const auditFile = (cwd: string) => path.join(cwd, ".pi", "workflow-telemetry.jsonl");

	async function audit(cwd: string, event: AuditEvent): Promise<void> {
		try {
			await fs.appendFile(auditFile(cwd), `${JSON.stringify(event)}\n`, "utf8");
		} catch {
			// Audit is best-effort; never break a tool call over it.
		}
	}

	async function refreshSnapshot(cwd: string): Promise<Snapshot | null> {
		snapshot = await readSnapshot(cwd);
		snapshotStale = false;
		return snapshot;
	}

	function dirtyPackages(current: Snapshot | null): PackageSpec[] {
		if (!current || !contract || current.changed.length === 0) return [];
		return packagesTouched(contract, current.changed).filter((pkg) => {
			const files = current.changed.filter((file) => matchGlob(pkg.glob, file));
			return state.green[pkg.glob]?.changedKey !== packageChangedKey(files);
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI === false) return;
		ctx.ui.setStatus("workflow", enforcing ? `workflow ${contract ? "on" : "no contract"}` : "workflow off");
		if (contractError) ctx.ui.notify?.(`workflow: ${contractError}`, "error");
	}

	function packageForTestCommand(command: string): PackageSpec | null {
		if (!contract) return null;
		return contract.packages.find((pkg) => commandRunsTest(command, pkg.test)) ?? null;
	}

	pi.on("session_start", async (_event, ctx) => {
		enforcing = true;
		overrideNext = null;
		pendingCommands.clear();
		deltaShownThisTurn = false;
		const loaded = await loadContract(ctx.cwd, ctx.isProjectTrusted());
		contract = loaded?.contract ?? null;
		contractError = loaded?.error;
		state = await loadState(ctx.cwd);
		snapshot = null;
		snapshotStale = true;
		if (process.env.PI_WORKFLOW_GUARD_DEBUG === "1") {
			console.error(
				`[workflow-guard] contract=${contract ? "loaded" : "none"} packages=${contract?.packages.length ?? 0} enforcing=${enforcing}`,
			);
		}
		updateStatus(ctx);
	});

	pi.on("turn_start", async () => {
		deltaShownThisTurn = false;
		// Commands stay pending across a turn boundary: long suites can finish
		// after turn_end, and dropping them would lose the green run.
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!contract) return undefined;
		const parts: string[] = [standingLine(enforcing)];
		if (enforcing && !deltaShownThisTurn) {
			const current = snapshotStale || !snapshot ? await refreshSnapshot(ctx.cwd) : snapshot;
			const dirty = dirtyPackages(current);
			const delta = dirty.length > 0 ? deltaLine(dirty) : null;
			if (delta) {
				deltaShownThisTurn = true;
				parts.push(delta);
			}
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n")}` };
	});

	// Record the command before the gate runs; tool_call handlers are ordered.
	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash") {
			const input = (event.input ?? {}) as Record<string, unknown>;
			if (typeof input.command === "string") {
				if (pendingCommands.size > 256) {
					const oldest = pendingCommands.keys().next().value;
					if (oldest) pendingCommands.delete(oldest);
				}
				pendingCommands.set(event.toolCallId, input.command);
			}
		}
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!contract || !enforcing) return undefined;
		const input = (event.input ?? {}) as Record<string, unknown>;

		// G1: operator-owned steering files (write/edit and bash-mediated).
		const hit = protectedHit(event.toolName, input, contract, ctx.cwd);
		if (hit) {
			if (!ctx.hasUI) {
				await audit(ctx.cwd, { ts: new Date().toISOString(), event: "block", path: hit.path });
				return { block: true, reason: hit.reason };
			}
			const approved = await ctx.ui.confirm(
				`Change ${hit.path}?`,
				"This file steers the agent. Confirm only if the operator asked for this edit.",
			);
			await audit(ctx.cwd, { ts: new Date().toISOString(), event: "confirm", path: hit.path });
			if (!approved) return { block: true, reason: hit.reason };
			if (event.toolName !== "bash") return undefined;
		}

		if (event.toolName !== "bash") return undefined;
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return undefined;

		const current = await refreshSnapshot(ctx.cwd);
		if (!current) {
			if (isCommitLikeCommand(command) && contract.packages.length > 0) {
				const reason = clamp(
					"blocked: cannot read git state to verify tests (snapshot failed/timed out). Check `git status` and retry.",
					400,
				);
				await audit(ctx.cwd, { ts: new Date().toISOString(), event: "block", reason });
				return { block: true, reason };
			}
			return undefined;
		}

		if (current.truncated && isCommitLikeCommand(command)) {
			const reason = clamp(
				"blocked: too many changed paths to verify tests (git snapshot truncated). Commit in smaller batches.",
				400,
			);
			await audit(ctx.cwd, { ts: new Date().toISOString(), event: "block", reason });
			return { block: true, reason };
		}

		const touched = packagesTouched(contract, current.changed);
		const hashes = new Map<string, string | null>();
		for (const pkg of touched) {
			const files = current.changed.filter((file) => matchGlob(pkg.glob, file));
			hashes.set(pkg.glob, files.length > 0 ? await hashChangedFiles(current.root, files) : null);
		}

		const decision = evaluateCommitGate({
			contract,
			enforcing,
			command,
			changed: current.changed,
			hashes,
			green: state.green,
		});
		if (!decision) return undefined;

		if (overrideNext) {
			const reason = overrideNext;
			overrideNext = null;
			await audit(ctx.cwd, { ts: new Date().toISOString(), event: "override", reason });
			return undefined;
		}

		await audit(ctx.cwd, { ts: new Date().toISOString(), event: "block", reason: decision.reason });
		return decision;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!contract) return undefined;
		if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
			if (!event.isError) snapshotStale = true;
		}
		if (event.toolName !== "bash" || event.isError) return undefined;

		const command = pendingCommands.get(event.toolCallId);
		pendingCommands.delete(event.toolCallId);
		if (!command) return undefined;
		const pkg = packageForTestCommand(command);
		if (!pkg) return undefined;

		const current = await refreshSnapshot(ctx.cwd);
		if (!current) return undefined;
		const files = current.changed.filter((file) => matchGlob(pkg.glob, file));
		const hash = files.length > 0 ? await hashChangedFiles(current.root, files) : "empty";
		state = recordGreen(state, pkg.glob, hash, packageChangedKey(files));
		await saveState(state);
		await audit(ctx.cwd, { ts: new Date().toISOString(), event: "green", package: pkg.glob });
		return undefined;
	});

	pi.registerCommand("workflow", {
		description: "Workflow guard: status | enforce on|off | verify | override <reason>",
		getArgumentCompletions: (prefix) => {
			const options = ["status", "enforce on", "enforce off", "verify", "override "];
			const filtered = options.filter((option) => option.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [command, ...rest] = args.trim().split(/\s+/);
			const current = command || "status";

			if (current === "enforce") {
				const value = rest[0];
				if (value === "on") enforcing = true;
				else if (value === "off") enforcing = false;
				else {
					ctx.ui.notify("usage: /workflow enforce on|off", "warning");
					return;
				}
				updateStatus(ctx);
				ctx.ui.notify(enforcementStatus(enforcing), "info");
				return;
			}

			if (current === "override") {
				const reason = rest.join(" ").trim();
				if (reason.length < 3) {
					ctx.ui.notify("usage: /workflow override <reason> (min 3 chars)", "warning");
					return;
				}
				overrideNext = reason;
				await audit(ctx.cwd, { ts: new Date().toISOString(), event: "override", reason });
				ctx.ui.notify("workflow: next gated action allowed (recorded)", "info");
				return;
			}

			if (current === "verify") {
				const loaded = await loadContract(ctx.cwd, ctx.isProjectTrusted());
				contract = loaded?.contract ?? null;
				contractError = loaded?.error;
				state = await loadState(ctx.cwd);
				const missing: string[] = [];
				for (const pkg of contract?.packages ?? []) {
					const match = /^bash\s+(\S+)$/.exec(pkg.test);
					if (!match) continue;
					try {
						await fs.stat(path.join(ctx.cwd, match[1]));
					} catch {
						missing.push(`${pkg.glob}: ${match[1]}`);
					}
				}
				updateStatus(ctx);
				ctx.ui.notify(
					missing.length > 0
						? `workflow: ${missing.length} stale test path(s): ${missing.slice(0, 3).join(", ")}`
						: `workflow: contract OK (${contract?.packages.length ?? 0} packages)`,
					missing.length > 0 ? "warning" : "info",
				);
				return;
			}

			if (!contract) {
				ctx.ui.notify(
					`workflow: no contract at ${CONTRACT_RELATIVE_PATH}${contractError ? ` (${contractError})` : ""}`,
					"warning",
				);
				return;
			}
			const currentSnapshot = await refreshSnapshot(ctx.cwd);
			const dirty = dirtyPackages(currentSnapshot);
			const greenCount = Object.keys(state.green).length;
			const g3 = planGateActive(contract) ? " · G3 configured but not implemented (inert)" : "";
			ctx.ui.notify(
				[
					`workflow: ${enforcing ? "enforce on" : "enforce OFF"}${g3}`,
					`contract ${CONTRACT_RELATIVE_PATH} · ${contract.packages.length} packages · ${greenCount} green records`,
					currentSnapshot
						? `${currentSnapshot.changed.length} changed paths`
						: "git snapshot unavailable (gates fail closed)",
					dirty.length > 0
						? `pending: ${dirty.slice(0, 3).map((pkg) => pkg.glob).join(", ")}${dirty.length > 3 ? ` (+${dirty.length - 3})` : ""}`
						: "nothing pending",
				].join("\n"),
				"info",
			);
		},
	});
}
