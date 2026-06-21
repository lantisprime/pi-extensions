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
export { executeChildRun, nextStepForRunBlock, parseDoArgs, parseRunArgs, resolveRegisteredRunTarget, runAgentCommand, runIntentCommand, runResolvedTarget, type AgentsContextLike, type RunnableRegisteredRecord } from "./lib/run-resolver.ts";

import { buildProjectAgentRecommendation, collectAgentDiagnostics, formatAgentInspect, formatAgentsConfig, formatAgentsDoctor, formatAgentsList, formatAgentsRegistry, formatAgentsVerify } from "./lib/diagnostics.ts";
import { runEphemeralCommand, saveTempCommand, type EphemeralRunHandlerContext } from "./lib/ephemeral.ts";
import { registerAgent, registerProjectAgents, unregisterAgent } from "./lib/registration.ts";
import { runAgentCommand, runIntentCommand } from "./lib/run-resolver.ts";
import { disposeBackgroundRuns } from "./lib/bg-run.ts";
import { validateBuiltInAgentSpecs } from "./lib/specs.ts";
import { registerSubagentTool } from "./lib/subagent-tool.ts";
import { formatBuiltInProfilesList, toProfileLibrary, buildProfileLibrary, type ModelProfileLibrary, type ProfileLibraryBuildWarning } from "./lib/profiles.ts";
import { discoverProfiles, rejectDuplicateProfileNames, DEFAULT_PROFILE_DISCOVERY_LIMITS, type ParsedProfile } from "./lib/profile-discovery.ts";
import { addOrReplaceRegisteredProfile, findMatchingRegisteredProfile, type RegisteredProfile } from "./lib/registry.ts";
import { runChainCommand } from "./lib/chain-runner.ts";
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
	ui: {
		notify(message: string, level?: "info" | "warning" | "error" | string): void;
		confirm?(title: string, message: string): Promise<boolean> | boolean;
		// P8: interactive widget surface used for the live background-run indicator.
		setWidget?(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	};
	// P8-followup: inject a completed subagent result into pi's conversation (set in the handler).
	deliverResult?: (content: string) => void;
};

export default function agentsExtension(pi: ExtensionAPI) {
	const eventApi = pi as ExtensionAPI & { on?: (name: string, handler: (event: unknown, ctx: AgentsContext) => Promise<void> | void) => void };
	let sessionAgentsCtx: AgentsContext | undefined;
	// P8-4: clear any live background-run spinner timer + widget when the session shuts down.
	eventApi.on?.("session_shutdown", (_event, ctx) => {
		disposeBackgroundRuns(ctx?.ui ?? { setWidget: () => {} });
	});
	eventApi.on?.("session_start", async (_event, ctx) => {
		sessionAgentsCtx = ctx;
		ctx.profileLibrary = profileLibrary; // start with built-ins
		// Discover user/project profiles and rebuild library
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

	registerSubagentTool(pi, () => sessionAgentsCtx);

	pi.registerCommand("agents", {
		description: "Show P3 agent diagnostics and run built-in or registered agents",
		getArgumentCompletions: (prefix: string) => {
			const options = ["list", "built-ins", "config", "inspect", "registry", "verify", "doctor", "register", "register-project", "unregister", "run", "do", "chain", "run-temp", "save-temp", "profiles"];
			const trimmed = prefix.trim();
			const filtered = options.filter((option) => option.startsWith(trimmed));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseAgentsArgs(args);
			// P8-followup: deliver a completed subagent's result into pi's conversation (triggers a
			// turn so pi reacts to the findings). deliverAs:"followUp" queues politely if pi is busy.
			const sendUserMessage = (pi as ExtensionAPI & { sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void }).sendUserMessage;
			if (typeof sendUserMessage === "function") {
				ctx.deliverResult = (content: string) => sendUserMessage(content, { deliverAs: "followUp" });
			}
			const diagnostics = await collectAgentDiagnostics({ cwd: ctx.cwd, homeDir: ctx.agentsHomeDir, projectTrusted: resolveProjectTrusted(ctx) });
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
			ctx.ui.notify("Usage: /agents [list|built-ins|config|inspect <name>|registry|verify|doctor|register <path-or-name>|register-project [--all-safe]|unregister <name>|run <agent> <task>|chain <agent>,<agent>[,<agent>] <task>|run-temp <scout|planner|reviewer> <task>|save-temp <name>|profiles].", "warning");
		},
	});
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
