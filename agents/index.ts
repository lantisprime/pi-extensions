import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export * from "./lib/specs.ts";
export * from "./lib/agent-markdown.ts";
export * from "./lib/registry.ts";
export * from "./lib/can-run-agent.ts";
export * from "./lib/child-args.ts";
export * from "./lib/child-runner.ts";
export * from "./lib/diagnostics.ts";
export * from "./lib/ephemeral.ts";
export * from "./lib/jsonl-monitor.ts";
export * from "./lib/registration.ts";
export * from "./lib/profiles.ts";
export * from "./lib/profile-discovery.ts";
export * from "./lib/context-providers/git-runner.ts";
export * from "./lib/context-providers/review-context.ts";
export { dispatchChildRun, executeChildRun, nextStepForRunBlock, parseDoArgs, parseRunArgs, resolveRegisteredRunTarget, runAgentCommand, runIntentCommand, runResolvedTarget, type AgentsContextLike, type RunnableRegisteredRecord } from "./lib/run-resolver.ts";

import { buildProjectAgentRecommendation, collectAgentDiagnostics, formatAgentInspect, formatAgentsConfig, formatAgentsDoctor, formatAgentsList, formatAgentsRegistry, formatAgentsVerify } from "./lib/diagnostics.ts";
import { runEphemeralCommand, saveTempCommand, type EphemeralRunHandlerContext } from "./lib/ephemeral.ts";
import { registerAgent, registerProjectAgents, unregisterAgent } from "./lib/registration.ts";
import { runAgentCommand, runIntentCommand, dispatchChildRun, resolveRegisteredRunTarget } from "./lib/run-resolver.ts";
import type { AgentsContextLike } from "./lib/run-resolver.ts";
import { disposeBackgroundRuns } from "./lib/bg-run.ts";
import { validateBuiltInAgentSpecs } from "./lib/specs.ts";
import { registerSubagentTool } from "./lib/subagent-tool.ts";
import { preflightBgAgent } from "./lib/bg-preflight.ts";
import { getBgTerminalBackend } from "./lib/bg-terminal.ts";
import { formatBuiltInProfilesList, toProfileLibrary, buildProfileLibrary, type ModelProfileLibrary, type ProfileLibraryBuildWarning } from "./lib/profiles.ts";
import { discoverProfiles, rejectDuplicateProfileNames, DEFAULT_PROFILE_DISCOVERY_LIMITS, type ParsedProfile } from "./lib/profile-discovery.ts";
import { addOrReplaceRegisteredProfile, findMatchingRegisteredProfile, type RegisteredProfile } from "./lib/registry.ts";
import { runChainCommand } from "./lib/chain-runner.ts";
import { loadGateConfig, classifyGateIntent, GATE_INSTRUCTIONS } from "./lib/intent-gate.ts";
import { reapStaleBgRuns, resolveTrustedHome, listBgRuns, getBgRunPaths, readBgResult, writeBgResult, markBgRunDone, countActiveBgRuns } from "./lib/bg-state.ts";
import os from "node:os";
import path from "node:path";

const shownProjectRecommendationKeys = new Set<string>();
const profileLibrary = toProfileLibrary();

type AgentsContext = {
	cwd?: string;
	hasUI?: boolean;
	agentsHomeDir?: string;
	agentsPiCommand?: string;
	agentsChildRunner?: import("./lib/child-runner.ts").ChildAgentRunner;
	explicitToolContextLoaderPath?: string;
	agentsLastEphemeralSpec?: { spec: import("./lib/specs.ts").AgentSpec; task: string };
	profileLibrary?: ModelProfileLibrary;
	profileLibraryWarnings?: ProfileLibraryBuildWarning[];
	isProjectTrusted?: () => boolean;
	// Resolved trust + registry for the run path (project-profile trust check needs these).
	projectTrusted?: boolean;
	projectRegistry?: import("./lib/registry.ts").ProjectAgentRegistry;
	// SEC-5: gate-routed children set this so the child run passes --no-context-files.
	disableContextFiles?: boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error" | string): void;
		confirm?(title: string, message: string): Promise<boolean> | boolean;
		// P8: interactive widget surface used for the live background-run indicator.
		setWidget?(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
		// P4-6: footer status line for persistent background agent count.
		setStatus?(key: string, text: string | undefined): void;
	};
	// P8-followup: inject a completed subagent result into pi's conversation (set in the handler).
	deliverResult?: (content: string) => void;
};

/** P8-followup: wire ctx.deliverResult to pi.sendUserMessage so a completed subagent run is fed
 *  back into pi's conversation (triggers a turn so pi reacts to the findings). deliverAs:"followUp"
 *  queues politely if pi is busy. MUST be called on every ctx that can dispatch a run — both the
 *  /agents command handler AND the natural-language `input`-gate handler hand us a fresh ctx without
 *  it, and a gate-routed run whose ctx lacks deliverResult drops its result silently (run-resolver
 *  guards on `typeof ctx.deliverResult === "function"`). */
function attachDeliverResult(pi: ExtensionAPI, ctx: AgentsContext): void {
	const sendUserMessage = (pi as ExtensionAPI & { sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void }).sendUserMessage;
	if (typeof sendUserMessage === "function") {
		ctx.deliverResult = (content: string) => sendUserMessage(content, { deliverAs: "followUp" });
	}
}

export default function agentsExtension(pi: ExtensionAPI) {
	const eventApi = pi as ExtensionAPI & { on?: (name: string, handler: (event: unknown, ctx: AgentsContext) => Promise<void> | void) => void };
	let sessionAgentsCtx: AgentsContext | undefined;
	// P8-4: clear any live background-run spinner timer + widget when the session shuts down.
	// N3: bg-state authority root is ALWAYS resolveTrustedHome() (os.userInfo().homedir).
	// The write path (preflight, worker) and every bg-state read must use the same root;
	// agentsHomeDir is for user-config discovery only, not bg-run state.
	eventApi.on?.("session_shutdown", async (_event, ctx) => {
		disposeBackgroundRuns(ctx?.ui ?? { setWidget: () => {} });
		// Clear status line + stop polling BEFORE async reap so they're always
		// cleaned up even if reapStaleBgRuns rejects.
		if (bgStatusPollTimer !== undefined) { clearInterval(bgStatusPollTimer); bgStatusPollTimer = undefined; }
		if (typeof ctx?.ui?.setStatus === "function") ctx.ui.setStatus(BG_STATUS_KEY, undefined);
		await reapStaleBgRuns(resolveTrustedHome()); // free slots only — NOT key retirement (N5)
	});
	eventApi.on?.("session_start", async (_event, ctx) => {
		sessionAgentsCtx = ctx;
		// Wire deliverResult onto the session ctx so BOTH dispatch paths can reach it: the /agents
		// command handler (via attachDeliverResult on its own ctx) and the NL `input`-gate handler
		// (which re-attaches it from sessionCtx in handleGateInput). Without this the gate path drops
		// a completed run's findings silently.
		attachDeliverResult(pi, ctx);
		// P4-6: show current background agent count in the footer on session start.
		// Only start polling if there are active runs — avoid a throwaway timer on idle sessions.
		if (await updateBgStatusLine(ctx) > 0) ensureBgStatusPolling(ctx);
		ctx.profileLibrary = profileLibrary; // start with built-ins
		// Discover user/project profiles and rebuild library.
		// os.homedir() is intentional here (NOT resolveTrustedHome()): profile discovery
		// respects the HOME env var for user-expected config locations (~/.pi/agent/profiles).
		// resolveTrustedHome() = os.userInfo().homedir ignores HOME and is used only for
		// authority-root paths (bg-state, MAC key) that must be immune to a mutable HOME.
		try {
			const homeDir = ctx.agentsHomeDir ?? os.homedir();
			const userProfilesDir = path.join(homeDir, ".pi", "agent", "profiles");
			const projectTrusted = resolveProjectTrusted(ctx);
			const userParsed = await discoverProfiles(userProfilesDir, "user");
			const dedupedUser = rejectDuplicateProfileNames(userParsed);
			const userProfiles = dedupedUser.filter((p) => p.profile).map((p) => p.profile!);
			let projectProfiles: ModelProfile[] = [];
			if (projectTrusted && ctx.cwd) {
				const projectProfilesDir = path.join(ctx.cwd, ".pi", "profiles");
				const projectParsed = await discoverProfiles(projectProfilesDir, "project");
				const dedupedProject = rejectDuplicateProfileNames(projectParsed);
				projectProfiles = dedupedProject.filter((p) => p.profile).map((p) => p.profile!);
			}
			const result = buildProfileLibrary({ userProfiles, projectProfiles, projectTrusted });
			ctx.profileLibrary = result.library;
			ctx.profileLibraryWarnings = result.warnings;
		} catch {
			// If discovery fails, keep built-in-only library
		}
		if (!ctx.hasUI) return;
		await maybeNotifyProjectRecommendation(ctx, false);
	});

	// P7-2: prompt-intent gate — intercept natural-language prompts before model processing.
	// Gate disables itself for /commands, non-TUI sessions, untrusted projects, and missing config.
	eventApi.on?.("input", async (event: { text: string }, ctx: AgentsContext) => {
		const result = await handleGateInput(event.text, ctx, sessionAgentsCtx);
		return result;
	});

	registerSubagentTool(pi, () => sessionAgentsCtx);

	pi.registerCommand("agents", {
		description: "Show P3 agent diagnostics and run built-in or registered agents",
		getArgumentCompletions: (prefix: string) => {
			const options = ["list", "built-ins", "config", "inspect", "registry", "verify", "doctor", "register", "register-project", "unregister", "run", "do", "chain", "run-temp", "save-temp", "profiles", "bg", "bg-status", "bg-stop", "bg-result", "bg-open"];
			const trimmed = prefix.trim();
			const filtered = options.filter((option) => option.startsWith(trimmed));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseAgentsArgs(args);
			// The profile library is built once at session_start and stashed on sessionAgentsCtx.
			// When pi hands the command a fresh ctx, ctx.profileLibrary is undefined — agents with a
			// mandatory `profile:` (e.g. a registered project agent) then fail with "no profile
			// library available". Re-attach the session library so profile resolution works.
			if (!ctx.profileLibrary && sessionAgentsCtx?.profileLibrary) {
				ctx.profileLibrary = sessionAgentsCtx.profileLibrary;
				ctx.profileLibraryWarnings = sessionAgentsCtx.profileLibraryWarnings;
			}
			// P8-followup: deliver a completed subagent's result into pi's conversation (triggers a
			// turn so pi reacts to the findings). Shared with the NL `input`-gate handler.
			attachDeliverResult(pi, ctx);
			const diagnostics = await collectAgentDiagnostics({ cwd: ctx.cwd, homeDir: ctx.agentsHomeDir, projectTrusted: resolveProjectTrusted(ctx) });
			// Thread the resolved trust + project registry onto ctx so the run path's project-profile
			// trust check sees them (the per-command ctx only carries isProjectTrusted(), not the
			// resolved booleans). Without this, a registered project agent with a project `profile:`
			// fails with "project trust is not active" even though its gate already passed.
			ctx.projectTrusted = diagnostics.projectTrusted;
			ctx.projectRegistry = diagnostics.projectRegistry;
			if (parsed.action === "list" || parsed.action === "built-ins") {
				if (parsed.action === "list") await maybeNotifyProjectRecommendation(ctx, true, diagnostics);
				ctx.ui.notify(`P3 agents diagnostics: child execution is available via /agents run <built-in-or-registered> <task>.\n${formatAgentsList(diagnostics)}`, "info");
				return;
			}
			if (parsed.action === "config") {
				ctx.ui.notify(formatAgentsConfig(diagnostics), "info");
				return;
			}
			if (parsed.action === "registry") {
				ctx.ui.notify(formatAgentsRegistry(diagnostics), "info");
				return;
			}
			if (parsed.action === "verify") {
				const validation = validateBuiltInAgentSpecs();
				const builtInMessage = validation.ok ? "Built-in specs: valid" : `Built-in specs: invalid\n${validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join("\n")}`;
				ctx.ui.notify(`${builtInMessage}\n${formatAgentsVerify(diagnostics)}`, validation.ok && diagnostics.summary.blocked === 0 ? "info" : "warning");
				return;
			}
			if (parsed.action === "doctor") {
				ctx.ui.notify(formatAgentsDoctor(diagnostics), diagnostics.summary.blocked === 0 && diagnostics.projectRegistryRootOk ? "info" : "warning");
				return;
			}
			if (parsed.action === "inspect") {
				if (!parsed.rest) {
					ctx.ui.notify("Usage: /agents inspect <name>", "warning");
					return;
				}
				ctx.ui.notify(formatAgentInspect(diagnostics, parsed.rest), "info");
				return;
			}
			if (parsed.action === "register") {
				const result = await registerAgent(parsed.rest, registrationOptions(ctx, diagnostics));
				ctx.ui.notify(result.message, result.status === "registered" ? "info" : "warning");
				return;
			}
			if (parsed.action === "register-project") {
				const result = await registerProjectAgents({ ...registrationOptions(ctx, diagnostics), allSafe: parseFlags(parsed.rest).has("--all-safe") });
				ctx.ui.notify(result.message, result.status === "registered" ? "info" : "warning");
				return;
			}
			if (parsed.action === "unregister") {
				const result = await unregisterAgent(parsed.rest, registrationOptions(ctx, diagnostics));
				ctx.ui.notify(result.message, result.status === "unregistered" ? "info" : "warning");
				return;
			}
			if (parsed.action === "profiles") {
				const subAction = parsed.rest.split(/\s+/)[0];
				if (subAction === "register") {
					const target = parsed.rest.slice("register".length).trim();
					await handleProfileRegister(target, ctx, diagnostics);
					return;
				}
				if (subAction === "unregister") {
					const target = parsed.rest.slice("unregister".length).trim();
					await handleProfileUnregister(target, ctx, diagnostics);
					return;
				}
				// Default: list profiles from all sources
				ctx.ui.notify(formatProfileList(ctx, diagnostics), "info");
				return;
			}
		if (parsed.action === "chain") {
				await runChainCommand(parsed.rest, ctx, diagnostics);
				return;
			}
			if (parsed.action === "run") {
				await runAgentCommand(parsed.rest, ctx, diagnostics);
				return;
			}
			if (parsed.action === "do") {
				await runIntentCommand(parsed.rest, ctx, diagnostics);
				return;
			}
			if (parsed.action === "run-temp") {
				const ephCtx: EphemeralRunHandlerContext = { cwd: ctx.cwd, hasUI: ctx.hasUI, agentsPiCommand: ctx.agentsPiCommand, agentsChildRunner: ctx.agentsChildRunner, agentsLastEphemeralSpec: ctx.agentsLastEphemeralSpec, ui: ctx.ui, deliverResult: ctx.deliverResult };
				const stashed = await runEphemeralCommand(parsed.rest, ephCtx);
				if (stashed) ctx.agentsLastEphemeralSpec = stashed;
				return;
			}
			if (parsed.action === "save-temp") {
				const userAgentsDir = diagnostics.userAgentsDir;
				const ephCtx: EphemeralRunHandlerContext = { cwd: ctx.cwd, hasUI: ctx.hasUI, agentsPiCommand: ctx.agentsPiCommand, agentsChildRunner: ctx.agentsChildRunner, agentsLastEphemeralSpec: ctx.agentsLastEphemeralSpec, ui: ctx.ui, deliverResult: ctx.deliverResult };
				await saveTempCommand(parsed.rest, ephCtx, { projectTrusted: diagnostics.projectTrusted, userAgentsDir });
				return;
			}
			if (parsed.action === "bg") {
				await handleBgCommand(parsed.rest, ctx, diagnostics);
				return;
			}
			if (parsed.action === "bg-status") {
				await handleBgStatus(ctx);
				return;
			}
			if (parsed.action === "bg-stop") {
				await handleBgStop(parsed.rest, ctx);
				return;
			}
			if (parsed.action === "bg-result") {
				await handleBgResult(parsed.rest, ctx);
				return;
			}
			if (parsed.action === "bg-open") {
				await handleBgOpen(parsed.rest, ctx);
				return;
			}
			ctx.ui.notify("Usage: /agents [list|built-ins|config|inspect <name>|registry|verify|doctor|register <path-or-name>|register-project [--all-safe]|unregister <name>|run <agent> <task>|chain <agent>,<agent>[,<agent>] <task>|run-temp <scout|planner|reviewer> <task>|save-temp <name>|profiles|bg <agent> <task>|bg-status|bg-stop <id>|bg-result <id>|bg-open <id>].", "warning");
		},
	});
}

// ── P7-2: Prompt-intent gate handler ────────────────────────────────────

/** Test seam: override fn to intercept gate-level child dispatch in tests.
 *  Do not mutate in production. Defaults to dispatchChildRun. */
export const __gateDispatch = { fn: dispatchChildRun };

export async function handleGateInput(
	text: string,
	ctx: AgentsContext,
	sessionCtx?: AgentsContext,
): Promise<{ action: "continue" | "handled" | "transform"; text?: string }> {
	// REQ-9: skip non-TUI sessions
	if (!ctx.hasUI) return { action: "continue" };

	// REQ-8: skip /-prefixed commands
	if (text.trimStart().startsWith("/")) return { action: "continue" };

	// REQ-1 / REQ-SEC-1: load config, gated on project trust
	const configPath = path.join(ctx.cwd ?? process.cwd(), ".pi", "intent-workflows.json");
	const projectTrusted = resolveProjectTrusted(ctx);
	const configResult = await loadGateConfig(configPath, projectTrusted);
	if (!configResult.ok) return { action: "continue" };

	// REQ-2: classify
	const decision = classifyGateIntent(text, configResult.config);

	// REQ-4 / REQ-11: route or confirm — always ask in TUI (REQ-SEC-3)
	if (decision.kind === "route" || decision.kind === "confirm") {
		// REQ-SEC-3: NL-routed prompts ALWAYS confirm, regardless of P6 confidence
		if (ctx.ui.confirm) {
			const ok = await ctx.ui.confirm(
				`Route to ${decision.agent}?`,
				`Intent '${decision.metadata.intentId}' matched by ${decision.metadata.matchedBy}.\nTask: ${text}`,
			);
			if (!ok) { ctx.ui.notify("Routing cancelled.", "info"); return { action: "continue" }; }
		}

		// REQ-SEC-5: gate-routed children must disable context files
		ctx.disableContextFiles = true;

		// The "input" event hands us a fresh ctx without the session-built profile library, so a
		// config-named profile (any source — user, project, or built-in) would fail to resolve with
		// "no profile library is available". Re-attach the session library, and thread the *resolved*
		// project trust + registry (never hardcoded) so project-source profiles also pass the runtime
		// trust check. Mirrors the /agents command handler's session-state re-attach.
		if (!ctx.profileLibrary && sessionCtx?.profileLibrary) {
			ctx.profileLibrary = sessionCtx.profileLibrary;
			ctx.profileLibraryWarnings = sessionCtx.profileLibraryWarnings;
		}
		// Same fresh-ctx gap for result delivery: the input-event ctx has no deliverResult, so a
		// gate-routed run would finish and its findings would never reach pi's conversation. Re-attach
		// from the session ctx (wired at session_start) — mirrors the profileLibrary re-attach above.
		if (!ctx.deliverResult && sessionCtx?.deliverResult) {
			ctx.deliverResult = sessionCtx.deliverResult;
		}
		if (decision.profile) {
			const diagnostics = await collectAgentDiagnostics({ cwd: ctx.cwd, homeDir: ctx.agentsHomeDir, projectTrusted });
			ctx.projectTrusted = diagnostics.projectTrusted;
			ctx.projectRegistry = diagnostics.projectRegistry;
		}

		// C3: config-chosen agent = spawned agent — direct dispatch, no re-classification.
		// Bypasses runIntentCommand's classifier + auto-run rail (SEC-3 satisfied).
		// Profile passed structurally, not via string interpolation (SEC-2).
		void __gateDispatch.fn(decision.agent, text, ctx, "built-in", decision.profile).catch((err) => {
			ctx.ui.notify(`Gate dispatch failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		});
		return { action: "handled" };
	}

	// REQ-5 / REQ-SEC-4: plan-only injects code-owned instruction
	if (decision.kind === "inject") {
		const instruction = GATE_INSTRUCTIONS[decision.instruction];
		return { action: "transform", text: instruction + "\n\n" + text };
	}

	// REQ-7: pass-through for unmatched / ambiguous
	return { action: "continue" };
}

function parseAgentsArgs(args: string): { action: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { action: "list", rest: "" };
	const [action, ...rest] = trimmed.split(/\s+/);
	return { action, rest: rest.join(" ").trim() };
}

function resolveProjectTrusted(ctx: AgentsContext): boolean {
	try {
		return Boolean(ctx.isProjectTrusted?.());
	} catch {
		return false;
	}
}

function registrationOptions(ctx: AgentsContext, diagnostics: Awaited<ReturnType<typeof collectAgentDiagnostics>>) {
	return {
		cwd: ctx.cwd,
		homeDir: ctx.agentsHomeDir,
		projectTrusted: diagnostics.projectTrusted,
		hasUI: Boolean(ctx.hasUI),
		ui: ctx.ui,
		diagnostics,
	};
}

function parseFlags(input: string): Set<string> {
	return new Set(input.split(/\s+/).filter((part) => part.startsWith("--")));
}

async function maybeNotifyProjectRecommendation(ctx: AgentsContext, force: boolean, diagnostics = undefined as Awaited<ReturnType<typeof collectAgentDiagnostics>> | undefined): Promise<void> {
	const current = diagnostics ?? await collectAgentDiagnostics({ cwd: ctx.cwd, homeDir: ctx.agentsHomeDir, projectTrusted: resolveProjectTrusted(ctx) });
	const recommendation = buildProjectAgentRecommendation(current);
	if (!recommendation) return;
	if (!force && shownProjectRecommendationKeys.has(recommendation.key)) return;
	shownProjectRecommendationKeys.add(recommendation.key);
	ctx.ui.notify(recommendation.message, "info");
}

// ── P3f-3: Profile list and registration helpers ─────────────────────────

export function formatProfileList(ctx: AgentsContext, diagnostics: Awaited<ReturnType<typeof collectAgentDiagnostics>>): string {
	const library = ctx.profileLibrary;
	const lines = ["Agent profiles:"];
	if (!library || library.profiles.length === 0) {
		lines.push("(no profiles available)");
		return lines.join("\n");
	}

	const builtIns = ["fast-local", "reasoning-deep", "adversarial-review"];
	for (const profile of library.profiles) {
		const source = builtIns.includes(profile.name) ? "built-in" : "unknown";
		const parts = [`  ${profile.name} [${source}]`];
		if (profile.model) parts.push(`model=${profile.model}`);
		if (profile.thinking) parts.push(`thinking=${profile.thinking}`);
		if (!profile.model && !profile.thinking) parts.push("effect: none (Pi default)");
		if (profile.purpose) parts.push(`(${profile.purpose})`);
		lines.push(parts.join(" "));
	}

	if (ctx.profileLibraryWarnings && ctx.profileLibraryWarnings.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const w of ctx.profileLibraryWarnings.slice(0, 10)) {
			lines.push(`  ${w.message}`);
		}
	}

	return lines.join("\n");
}

async function handleProfileRegister(target: string, ctx: AgentsContext, diagnostics: Awaited<ReturnType<typeof collectAgentDiagnostics>>): Promise<void> {
	if (!target) {
		ctx.ui.notify("Usage: /agents profiles register <path>", "warning");
		return;
	}
	if (!diagnostics.projectTrusted) {
		ctx.ui.notify("Project trust must be active to register project profiles.", "warning");
		return;
	}
	if (!ctx.hasUI || !ctx.ui.confirm) {
		ctx.ui.notify("Profile registration requires interactive confirmation. Run in TUI mode.", "warning");
		return;
	}
	// Resolve path
	const resolved = path.resolve(ctx.cwd ?? process.cwd(), target);
	const { parseProfileFile } = await import("./lib/profile-discovery.ts");
	const parsed = await parseProfileFile(resolved, "project");
	if (!parsed.profile) {
		ctx.ui.notify(`Cannot register: ${parsed.issues[0]?.message ?? "invalid profile"}`, "warning");
		return;
	}
	const confirmed = await ctx.ui.confirm("Register project profile?", `Register profile '${parsed.profile.name}' at ${resolved}?\nSHA-256: ${parsed.rawBytesSha256}\nModel: ${parsed.profile.model ?? "default"}\nThinking: ${parsed.profile.thinking ?? "default"}`);
	if (!confirmed) {
		ctx.ui.notify("Registration cancelled.", "info");
		return;
	}
	// Write to project registry
	const { readProjectRegistry, writeProjectRegistry, addOrReplaceRegisteredProfile } = await import("./lib/registry.ts");
	const registry = await readProjectRegistry(diagnostics.projectRoot, ctx.agentsHomeDir);
	const entry: RegisteredProfile = {
		name: parsed.profile.name,
		source: "project",
		canonicalPath: resolved,
		rawBytesSha256: parsed.rawBytesSha256,
		approvedAt: new Date().toISOString(),
		approvedBy: "user",
	};
	const updated = addOrReplaceRegisteredProfile(registry, entry);
	await writeProjectRegistry(updated, diagnostics.projectRoot, ctx.agentsHomeDir);
	ctx.ui.notify(`Registered profile '${entry.name}'.`, "info");
}

async function handleProfileUnregister(target: string, ctx: AgentsContext, diagnostics: Awaited<ReturnType<typeof collectAgentDiagnostics>>): Promise<void> {
	if (!target) {
		ctx.ui.notify("Usage: /agents profiles unregister <name>", "warning");
		return;
	}
	if (!ctx.hasUI || !ctx.ui.confirm) {
		ctx.ui.notify("Profile unregistration requires interactive confirmation. Run in TUI mode.", "warning");
		return;
	}
	const { readProjectRegistry, writeProjectRegistry } = await import("./lib/registry.ts");
	const registry = await readProjectRegistry(diagnostics.projectRoot, ctx.agentsHomeDir);
	const profiles = registry.profiles ?? [];
	const match = profiles.find((p) => p.name === target);
	if (!match) {
		ctx.ui.notify(`No registered project profile named '${target}'.`, "warning");
		return;
	}
	const confirmed = await ctx.ui.confirm("Unregister profile?", `Remove registered profile '${target}'?\nThis does not delete the profile file.`);
	if (!confirmed) {
		ctx.ui.notify("Unregistration cancelled.", "info");
		return;
	}
	const updated = { ...registry, profiles: profiles.filter((p) => p.name !== target), updatedAt: new Date().toISOString() };
	await writeProjectRegistry(updated, diagnostics.projectRoot, ctx.agentsHomeDir);
	ctx.ui.notify(`Unregistered profile '${target}'.`, "info");
}

// ── P4-6: Background agent status line ─────────────────────────────────

const BG_STATUS_KEY = "agents:bg-count";
const BG_STATUS_POLL_MS = 15_000; // refresh every 15s while runs are active
let bgStatusPollTimer: ReturnType<typeof setInterval> | undefined;
let bgStatusPollBusy = false; // guard against pile-up when countActiveBgRuns is slow

/** Test-only: override the home dir for countActiveBgRuns.  Production
 *  code never calls this — it's for test isolation so tests don't mutate
 *  real bg-state on the developer's machine. */
let __bgStatusHomeOverride: string | undefined;
export function __setBgStatusHomeOverride(home: string | undefined): void {
	__bgStatusHomeOverride = home;
}

/** Update the pi footer status line with the current background agent
 *  count.  Reads from the bg-state authority root (resolveTrustedHome()),
 *  same as the write path + all other bg-state operations.  Silently
 *  no-ops when setStatus is unavailable (non-TUI / pre-P4-6 pi).
 *  Returns the count, or -1 on error / unavailable. */
export async function updateBgStatusLine(ctx: AgentsContext): Promise<number> {
	if (typeof ctx?.ui?.setStatus !== "function") return -1;
	try {
		const count = __bgStatusHomeOverride !== undefined
			? await countActiveBgRuns(__bgStatusHomeOverride)
			: await countActiveBgRuns();
		ctx.ui.setStatus(BG_STATUS_KEY, count > 0 ? `${count} agent${count === 1 ? "" : "s"} running` : undefined);
		return count;
	} catch { /* best-effort; don't break the session over a status update */ }
	return -1;
}

/** Start periodic polling while there are active background runs so the
 *  status line stays current even when no /agents command was typed.
 *  Stops itself when count drops to 0.  Restarts the timer if already
 *  running (defeats TOCTOU: a launch between count→0 and clearInterval).
 *  No-ops when setStatus is unavailable (non-TUI / pre-P4-6 pi). */
function ensureBgStatusPolling(ctx: AgentsContext): void {
	if (typeof ctx?.ui?.setStatus !== "function") return;
	// Restart any existing timer so a launch that raced with a tick that
	// saw count=0 but hasn't cleared yet doesn't leave us polling-less.
	if (bgStatusPollTimer !== undefined) {
		clearInterval(bgStatusPollTimer);
		bgStatusPollTimer = undefined;
	}
	bgStatusPollTimer = setInterval(async () => {
		if (bgStatusPollBusy) return;
		bgStatusPollBusy = true;
		try {
			// Single countActiveBgRuns call feeds both the status line AND the
			// stop decision — no TOCTOU gap between the two.
			const count = await updateBgStatusLine(ctx);
			if (count === 0 && bgStatusPollTimer !== undefined) {
				clearInterval(bgStatusPollTimer);
				bgStatusPollTimer = undefined;
			}
		} catch { /* swallow — don't crash the poll loop */ }
		finally { bgStatusPollBusy = false; }
	}, BG_STATUS_POLL_MS);
	(bgStatusPollTimer as { unref?: () => void })?.unref?.();
}

// ── P4-5: Background agent commands ─────────────────────────────────────
//
// N3 INVARIANT: All bg-state paths (reads and writes) use resolveTrustedHome()
// = os.userInfo().homedir (getpwuid-based, ignores HOME env var).
// The worker hard-asserts manifest.homeDir === resolveTrustedHome(); preflight
// writes under the same root.  agentsHomeDir is a config-discovery hint only,
// never an authority root for bg-run state.  Changing this requires a
// coordinated change to bg-preflight.ts options.homeDir, bg-worker.ts authority
// derivation, and the N3/N5 security model — not a +4/-4 patch.

/** Extract the first whitespace-delimited token from a subcommand's rest args
 *  to isolate a runId. Returns empty string if no token is present. */
function extractRunId(args: string): string {
	return (args ?? "").trim().split(/\s+/)[0] || "";
}

/** /agents bg <agent> <task> — preflight + launch a background agent. */
export async function handleBgCommand(
	args: string,
	ctx: AgentsContext,
	diagnostics: Awaited<ReturnType<typeof collectAgentDiagnostics>>,
): Promise<void> {
	const backend = getBgTerminalBackend();
	if (!backend) {
		ctx.ui.notify("No terminal backend installed. Load tmux-terminal or equivalent to use background agents.", "warning");
		return;
	}
	if (typeof backend.isAvailable === "function" && !(await backend.isAvailable())) {
		ctx.ui.notify(`Terminal backend "${backend.name}" is not available.`, "error");
		return;
	}
	// Parse <agent> <task> (split on first whitespace; agent name
	// is the first token, everything after is the task).
	const tokens = args.split(/\s+/);
	if (tokens.length < 2) {
		ctx.ui.notify("Usage: /agents bg <agent> <task>", "warning");
		return;
	}
	const agentName = tokens[0];
	const task = tokens.slice(1).join(" ").trim();
	if (!agentName || !task) {
		ctx.ui.notify("Usage: /agents bg <agent> <task>", "warning");
		return;
	}

	// Resolve the agent target (same gate as /agents run).
	const resolved = await resolveRegisteredRunTarget(agentName, diagnostics);
	if (!resolved.ok) {
		ctx.ui.notify(resolved.message, "warning");
		return;
	}

	// Preflight: write signed manifest + reservation.
	const preflightCtx = { cwd: ctx.cwd, hasUI: ctx.hasUI, agentsHomeDir: ctx.agentsHomeDir } as AgentsContextLike;
	const result = await preflightBgAgent(resolved.record, task, preflightCtx, diagnostics);
	if (!result.ok) {
		ctx.ui.notify(`Preflight failed: ${result.reason}`, "error");
		return;
	}

	// Launch via the terminal backend.
	const launchResult = await backend.launch({
		agentName: resolved.record.name ?? resolved.record.filePath,
		runId: result.runId,
		manifestPath: result.paths.manifestPath,
		cwd: ctx.cwd ?? process.cwd(),
	});

	if (launchResult.status === "failed") {
		// Clean up the reservation + manifest that preflight wrote.
		// Without this, the slot stays reserved until the stale-reaper
		// times it out (BG_MAX_DURATION_SEC).
		try {
			await writeBgResult(result.paths, { version: 1, runId: result.runId, status: "failed", error: launchResult.error ?? "unknown launch error" });
			await markBgRunDone(result.paths);
		} catch { /* best-effort; the reaper will catch it on next session */ }
		ctx.ui.notify(`Launch failed: ${launchResult.error ?? "unknown error"}`, "error");
		await updateBgStatusLine(ctx);
		return;
	}

	ctx.ui.notify(`Background agent ${agentName} running (${result.runId.slice(0, 16)}…) via ${backend.name}.`, "info");
	await updateBgStatusLine(ctx);
	ensureBgStatusPolling(ctx);
}

/** /agents bg-status — show running + recent background runs. */
export async function handleBgStatus(ctx: AgentsContext): Promise<void> {
	const homeDir = resolveTrustedHome();
	const runs = await listBgRuns(homeDir);

	// P4-6: refresh the status line — a run may have completed since last update.
	// Re-arm polling if there are still active runs (the poll may have self-stopped at 0).
	if (await updateBgStatusLine(ctx) > 0) ensureBgStatusPolling(ctx);

	if (runs.length === 0) {
		ctx.ui.notify("No background agent runs.", "info");
		return;
	}

	const lines: string[] = [];
	const backend = getBgTerminalBackend();
	let liveRunIds: string[] | undefined;
	if (backend) {
		// Collect runIds from backend entries (TermBgWindowEntry.runId), not
		// opaque windowIds.  windowId is a backend handle that may differ from
		// the bg-state runId; runId is the correlation key.
		try { liveRunIds = (await backend.list()).filter(function _a(e) { return e.runId; }).map(function _b(e) { return e.runId!; }); } catch { /* best-effort */ }
	}

	for (const run of runs) {
		const elapsed = run.createdAtMs ? Math.floor((Date.now() - run.createdAtMs) / 1000) : 0;
		const alive = liveRunIds ? liveRunIds.includes(run.runId) : undefined;
		// Guard: a done/failed/stopped run is naturally absent from the
		// backend's live window list — don't mislabel it as stale.
		const statusTag = (alive === false && !run.done) ? "(stale)" : run.status;
		lines.push(`  ${run.runId.slice(0, 16)}  ${statusTag}  ${formatElapsed(elapsed)}  ${run.done ? "done" : "active"}`);
	}

	ctx.ui.notify(`Background agent runs (${runs.length}):\n${lines.join("\n")}`, "info");
}

/** /agents bg-stop <runId> — kill a background agent. */
export async function handleBgStop(args: string, ctx: AgentsContext): Promise<void> {
	const runId = extractRunId(args);
	if (!runId) {
		ctx.ui.notify("Usage: /agents bg-stop <runId>", "warning");
		return;
	}

	const backend = getBgTerminalBackend();
	if (backend) {
		// Correlate runId → windowId via list() (kill() takes an opaque
		// windowId, not a runId — the two may differ).
		try {
			const windows = await backend.list();
			const entry = windows.find((e) => e.runId === runId);
			if (entry) {
				const killResult = await backend.kill(entry.windowId);
				if (killResult.status === "failed") {
					ctx.ui.notify(`Kill via backend failed: ${killResult.error ?? "unknown"} (falling back to reaper)`, "warning");
				}
			}
		} catch { /* best-effort; reaper catches it below */ }
	}

	// Reap via bg-state regardless of backend result.
	await reapStaleBgRuns(resolveTrustedHome());
	// Re-arm polling if there are still active runs (e.g. a multi-agent session).
	if (await updateBgStatusLine(ctx) > 0) ensureBgStatusPolling(ctx);
	ctx.ui.notify(`Stop requested for ${runId.slice(0, 16)}….`, "info");
}

/** /agents bg-result <runId> — show result for a completed/failed/stopped run. */
export async function handleBgResult(args: string, ctx: AgentsContext): Promise<void> {
	const runId = extractRunId(args);
	if (!runId) {
		ctx.ui.notify("Usage: /agents bg-result <runId>", "warning");
		return;
	}

	// Validate the runId format before handing it to getBgRunPaths, which
	// throws on invalid ids.  Catch the throw so we emit a friendly warning
	// instead of an uncaught exception.
	const homeDir = resolveTrustedHome();
	let paths: ReturnType<typeof getBgRunPaths>;
	try {
		paths = getBgRunPaths(runId, homeDir);
	} catch {
		ctx.ui.notify(`Invalid run ID: ${runId.slice(0, 16)}….`, "warning");
		return;
	}
	const result = await readBgResult(paths);

	// P4-6: refresh the status line — the run may have completed since last update.
	// Re-arm polling if there are still active runs.
	if (await updateBgStatusLine(ctx) > 0) ensureBgStatusPolling(ctx);

	if (!result) {
		ctx.ui.notify(`No result found for run ${runId.slice(0, 16)}…. (Still running or invalid runId?)`, "warning");
		return;
	}

	const lines = [`Background agent result (${runId.slice(0, 16)}…):`];
	lines.push(`  Status: ${result.status}`);
	lines.push(`  Agent: ${result.agentName ?? "unknown"}`);
	if (result.startedAt) lines.push(`  Started: ${result.startedAt}`);
	if (result.finishedAt) lines.push(`  Finished: ${result.finishedAt}`);
	if (result.error) lines.push(`  Error: ${result.error}`);
	if (result.resultText) {
		const truncated = result.resultText.length > 2000;
		const preview = truncated
			? result.resultText.slice(0, 2000)
			: result.resultText;
		lines.push(`  Result (${result.resultText.length} chars${truncated ? ", truncated" : ""}):`);
		for (const l of preview.split("\n")) lines.push(`    ${l}`);
		if (truncated) lines.push(`    … [use /agents bg-open <id> to see full output]`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

/** /agents bg-open <runId> — check whether a background agent window is alive.
 *
 *  P4-5 current: liveness check only.  Window focus/activation requires a
 *  terminal-backend focus() method which is deferred to a post-P4-7 backend
 *  enhancement (see P5_PLUGGABLE_TERMINAL_BACKEND.md). */
export async function handleBgOpen(args: string, ctx: AgentsContext): Promise<void> {
	const runId = extractRunId(args);
	if (!runId) {
		ctx.ui.notify("Usage: /agents bg-open <runId>", "warning");
		return;
	}

	const backend = getBgTerminalBackend();
	if (!backend) {
		ctx.ui.notify("No terminal backend installed. Cannot check window.", "warning");
		return;
	}

	// Correlate runId → windowId via list() (isAlive() takes an opaque
	// windowId, not a runId — the two may differ).
	try {
		const windows = await backend.list();
		const entry = windows.find((e) => e.runId === runId);
		if (!entry) {
			ctx.ui.notify(`No live terminal window for ${runId.slice(0, 16)}….`, "warning");
			return;
		}
		const alive = await backend.isAlive(entry.windowId);
		if (!alive) {
			ctx.ui.notify(`No live terminal window for ${runId.slice(0, 16)}….`, "warning");
			return;
		}
		ctx.ui.notify(`Window for ${runId.slice(0, 16)}… is alive.`, "info");
	} catch {
		ctx.ui.notify(`Backend error checking window for ${runId.slice(0, 16)}….`, "warning");
	}
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m${seconds % 60}s`;
}
