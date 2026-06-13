import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

type PermissionKey =
	| "readOutsideProject"
	| "bashCommands"
	| "destructiveBash"
	| "git"
	| "web"
	| "writeFiles";

type Decision = "allow" | "deny";
type PermissionMode = "ask" | "readOnlyAuto" | "llmAuto";

type PolicyFile = {
	projectPath: string;
	updatedAt: string;
	mode: PermissionMode;
	permissions: Partial<Record<PermissionKey, Decision>>;
};

type PermissionRequest = {
	key: PermissionKey;
	title: string;
	detail: string;
	command?: string;
};

const POLICY_DIR = path.join(os.homedir(), ".pi", "agent", "permission-policy", "projects");
const WEB_TOOL_NAMES = new Set(["web_search", "search_web", "web", "browser", "fetch", "http_get"]);
const SESSION_PERMISSIONS = new Map<string, Partial<Record<PermissionKey, Decision>>>();

const MODE_LABELS: Record<PermissionMode, string> = {
	ask: "Ask when no project/session permission is recorded",
	readOnlyAuto: "Auto-allow read-only commands in the current project",
	llmAuto: "Use the current LLM to auto-allow commands judged non-destructive",
};

const PERMISSION_LABELS: Record<PermissionKey, string> = {
	readOutsideProject: "Read files outside this project",
	bashCommands: "Run bash commands",
	destructiveBash: "Run destructive shell commands",
	git: "Run git commands",
	web: "Search or fetch from the web",
	writeFiles: "Write or edit files",
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await updatePermissionStatus(ctx);
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Cycle permission-policy mode",
		handler: async (ctx) => {
			const projectPath = await getProjectPath(ctx.cwd);
			const policy = await loadPolicy(projectPath);
			policy.mode = nextMode(policy.mode);
			policy.updatedAt = new Date().toISOString();
			await savePolicy(projectPath, policy);
			await updatePermissionStatus(ctx);
			ctx.ui.notify(`Permission mode: ${policy.mode} - ${MODE_LABELS[policy.mode]}`, "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const projectPath = await getProjectPath(ctx.cwd);
		const requests = classifyToolCall(event.toolName, event.input as Record<string, unknown>, projectPath, ctx.cwd);
		if (requests.length === 0) return undefined;

		for (const request of requests) {
			const allowed = await ensurePermission(ctx, projectPath, request);
			if (!allowed) return { block: true, reason: `Permission denied: ${request.title}` };
		}

		return undefined;
	});

	pi.on("user_bash", async (event, ctx) => {
		const projectPath = await getProjectPath(event.cwd || ctx.cwd);
		const requests = classifyBashCommand(event.command);
		if (requests.length === 0) return undefined;

		for (const request of requests) {
			const allowed = await ensurePermission(ctx, projectPath, request);
			if (!allowed) {
				return {
					result: {
						output: `Permission denied: ${request.title}\n`,
						exitCode: 1,
						cancelled: false,
						truncated: false,
					},
				};
			}
		}

		return undefined;
	});

	pi.registerCommand("permissions", {
		description: "Show/reset permission-policy settings, or set mode: /permissions mode ask|read-only|auto",
		handler: async (args, ctx) => {
			const projectPath = await getProjectPath(ctx.cwd);
			const normalizedArgs = args.trim().toLowerCase();

			if (normalizedArgs === "reset") {
				SESSION_PERMISSIONS.delete(projectPath);
				await deletePolicy(projectPath);
				ctx.ui.notify("Permission policy reset for this project", "info");
				return;
			}

			const policy = await loadPolicy(projectPath);

			if (normalizedArgs.startsWith("mode")) {
				const modeArg = normalizedArgs.replace(/^mode\s*/, "");
				const mode = parseMode(modeArg);
				if (!mode) {
					ctx.ui.notify("Usage: /permissions mode ask|read-only|auto", "warning");
					return;
				}
				policy.mode = mode;
				policy.updatedAt = new Date().toISOString();
				await savePolicy(projectPath, policy);
				await updatePermissionStatus(ctx);
				ctx.ui.notify(`Permission mode set to ${mode}: ${MODE_LABELS[mode]}`, "info");
				return;
			}

			const session = SESSION_PERMISSIONS.get(projectPath) || {};
			const lines = [
				`Permission policy for: ${projectPath}`,
				"",
				`Mode: ${policy.mode} - ${MODE_LABELS[policy.mode]}`,
				"",
				"Persistent project permissions:",
				...formatPermissions(policy.permissions),
				"",
				"Current-session permissions:",
				...formatPermissions(session),
				"",
				"Use /permissions mode ask|read-only|auto to change mode.",
				"Use /permissions reset to clear both for this project.",
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

function classifyToolCall(
	toolName: string,
	input: Record<string, unknown>,
	projectPath: string,
	cwd: string,
): PermissionRequest[] {
	if (toolName === "read") {
		const requestedPath = String(input.path || "");
		if (requestedPath && isOutsideProject(requestedPath, projectPath, cwd)) {
			return [
				{
					key: "readOutsideProject",
					title: PERMISSION_LABELS.readOutsideProject,
					detail: `Requested path: ${path.resolve(cwd, requestedPath)}`,
				},
			];
		}
	}

	if (toolName === "write" || toolName === "edit") {
		return [
			{
				key: "writeFiles",
				title: PERMISSION_LABELS.writeFiles,
				detail: `${toolName} path: ${String(input.path || "(unknown)")}`,
			},
		];
	}

	if (toolName === "bash") {
		return classifyBashCommand(String(input.command || ""));
	}

	if (WEB_TOOL_NAMES.has(toolName) || /(^|_)(web|search|browser)(_|$)/i.test(toolName)) {
		return [
			{
				key: "web",
				title: PERMISSION_LABELS.web,
				detail: `Tool: ${toolName}`,
			},
		];
	}

	return [];
}

function classifyBashCommand(command: string): PermissionRequest[] {
	const requests: PermissionRequest[] = [];

	if (looksLikeGitCommand(command)) {
		requests.push({
			key: "git",
			title: PERMISSION_LABELS.git,
			detail: `Command: ${command}`,
			command,
		});
	}

	if (looksDestructive(command)) {
		requests.push({
			key: "destructiveBash",
			title: PERMISSION_LABELS.destructiveBash,
			detail: `Command: ${command}`,
			command,
		});
	}

	// Ask for general bash permission for non-git, non-destructive commands too.
	// Git and destructive commands keep their more specific permission categories.
	if (requests.length === 0 && command.trim()) {
		requests.push({
			key: "bashCommands",
			title: PERMISSION_LABELS.bashCommands,
			detail: `Command: ${command}`,
			command,
		});
	}

	return dedupeRequests(requests);
}

function looksLikeGitCommand(command: string): boolean {
	// Be intentionally broad: the policy is "ask before git commands", including
	// read-only git commands and commands embedded in shell chains like
	// `cd repo && git status` or `env FOO=bar git status`.
	return /\bgit\b/i.test(command);
}

function looksDestructive(command: string): boolean {
	const destructiveCommand = /(^|[;&|()\s])(rm|mv|cp|unlink|rmdir|chmod|chown|install|truncate)\s+/i.test(command);
	const overwriteRedirect = /(^|\s)(\d?>|&>|tee\s+)(?!>)/i.test(command);
	const inPlaceEdit = /(^|[;&|()\s])(sed|perl|python|node|ruby)\s+.*\s(-i|--in-place)\b/i.test(command);
	return destructiveCommand || overwriteRedirect || inPlaceEdit;
}

function isReadOnlyAutoAllowed(request: PermissionRequest, projectPath: string, cwd: string): boolean {
	if (!request.command) return false;
	if (request.key === "readOutsideProject" || request.key === "writeFiles" || request.key === "destructiveBash" || request.key === "web") {
		return false;
	}
	if (commandMentionsOutsideProject(request.command, projectPath, cwd)) return false;
	if (looksDestructive(request.command)) return false;
	if (request.key === "git") return isReadOnlyGitCommand(request.command);
	return isReadOnlyShellCommand(request.command);
}

function isReadOnlyGitCommand(command: string): boolean {
	const match = command.match(/\bgit\s+(?:-[^\s]+\s+)*(\w[\w-]*)/i);
	if (!match) return false;
	return new Set([
		"status",
		"diff",
		"log",
		"show",
		"branch",
		"remote",
		"rev-parse",
		"ls-files",
		"grep",
		"describe",
		"blame",
	]).has(match[1].toLowerCase());
}

function isReadOnlyShellCommand(command: string): boolean {
	if (/[;&]\s*(rm|mv|cp|chmod|chown|install|truncate|touch|mkdir|rmdir)\b/i.test(command)) return false;
	const readOnlyCommands = new Set([
		"pwd",
		"ls",
		"find",
		"grep",
		"rg",
		"cat",
		"head",
		"tail",
		"wc",
		"sort",
		"uniq",
		"awk",
		"sed",
		"file",
		"stat",
		"du",
		"df",
		"echo",
		"printf",
		"which",
		"command",
		"test",
	]);
	const normalized = command.replace(/\s+/g, " ").trim();
	const segments = normalized.split(/\s*(?:&&|\|\||\|)\s*/);
	return segments.every((segment) => {
		const first = segment.trim().match(/^([A-Za-z0-9_.-]+)/)?.[1];
		return !!first && readOnlyCommands.has(first) && !/\s(-i|--in-place)\b/.test(segment);
	});
}

function commandMentionsOutsideProject(command: string, projectPath: string, cwd: string): boolean {
	const tokens = command.match(/(?:"[^"]+"|'[^']+'|\S+)/g) || [];
	for (const rawToken of tokens) {
		const token = rawToken.replace(/^['"]|['"]$/g, "");
		if (token === ".." || token.startsWith(`..${path.sep}`)) return true;
		if (path.isAbsolute(token) && isOutsideProject(token, projectPath, cwd)) return true;
	}
	return false;
}

async function evaluateCommandWithLlm(
	ctx: ExtensionContext,
	command: string,
	projectPath: string,
): Promise<boolean | undefined> {
	if (!ctx.model) return undefined;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) return undefined;
		const message: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `Project directory: ${projectPath}\nCommand: ${command}\n\nReturn exactly SAFE or UNSAFE.`,
				},
			],
			timestamp: Date.now(),
		};
		const response = await complete(
			ctx.model,
			{
				systemPrompt:
					"You classify shell commands for a permission gate. Return SAFE only when the command is read-only/non-destructive and does not write, delete, move, chmod/chown, install, network-fetch, exfiltrate secrets, or operate outside the project. Return UNSAFE otherwise. Output exactly SAFE or UNSAFE.",
				messages: [message],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
		);
		const text = response.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("\n")
			.trim()
			.toUpperCase();
		if (/^SAFE\b/.test(text)) return true;
		if (/^UNSAFE\b/.test(text)) return false;
	} catch {
		return undefined;
	}
	return undefined;
}

async function ensurePermission(ctx: ExtensionContext, projectPath: string, request: PermissionRequest): Promise<boolean> {
	const sessionDecision = SESSION_PERMISSIONS.get(projectPath)?.[request.key];
	if (sessionDecision) return sessionDecision === "allow";

	const policy = await loadPolicy(projectPath);
	const projectDecision = policy.permissions[request.key];
	if (projectDecision) return projectDecision === "allow";

	if (policy.mode === "readOnlyAuto" && isReadOnlyAutoAllowed(request, projectPath, ctx.cwd)) {
		return true;
	}

	if (policy.mode === "llmAuto" && request.command) {
		const safe = await evaluateCommandWithLlm(ctx, request.command, projectPath);
		if (safe === true) return true;
	}

	if (!ctx.hasUI) {
		return false;
	}

	const choice = await ctx.ui.select(
		[
			`Permission required: ${request.title}`,
			"",
			`Project: ${projectPath}`,
			request.detail,
			"",
			"How should Pi handle this permission?",
		].join("\n"),
		[
			"Allow once",
			"Allow for current session",
			"Allow permanently for this project",
			"Deny once",
			"Deny for current session",
			"Deny permanently for this project",
		],
	);

	if (choice === "Allow once") return true;
	if (choice === "Deny once" || !choice) return false;

	if (choice === "Allow for current session" || choice === "Deny for current session") {
		setSessionDecision(projectPath, request.key, choice.startsWith("Allow") ? "allow" : "deny");
		return choice.startsWith("Allow");
	}

	if (choice === "Allow permanently for this project" || choice === "Deny permanently for this project") {
		const decision: Decision = choice.startsWith("Allow") ? "allow" : "deny";
		policy.permissions[request.key] = decision;
		policy.updatedAt = new Date().toISOString();
		await savePolicy(projectPath, policy);
		return decision === "allow";
	}

	return false;
}

function setSessionDecision(projectPath: string, key: PermissionKey, decision: Decision) {
	const current = SESSION_PERMISSIONS.get(projectPath) || {};
	current[key] = decision;
	SESSION_PERMISSIONS.set(projectPath, current);
}

async function updatePermissionStatus(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	const projectPath = await getProjectPath(ctx.cwd);
	const policy = await loadPolicy(projectPath);
	ctx.ui.setStatus("permission-policy", `permission: ${modeShortLabel(policy.mode)}`);
}

function modeShortLabel(mode: PermissionMode): string {
	if (mode === "readOnlyAuto") return "read-only";
	if (mode === "llmAuto") return "auto";
	return "ask";
}

function nextMode(mode: PermissionMode): PermissionMode {
	if (mode === "ask") return "readOnlyAuto";
	if (mode === "readOnlyAuto") return "llmAuto";
	return "ask";
}

function parseMode(mode: string): PermissionMode | undefined {
	if (mode === "ask" || mode === "manual") return "ask";
	if (mode === "read-only" || mode === "readonly" || mode === "readOnlyAuto".toLowerCase()) return "readOnlyAuto";
	if (mode === "auto" || mode === "llm" || mode === "llm-auto" || mode === "automatic") return "llmAuto";
	return undefined;
}

async function loadPolicy(projectPath: string): Promise<PolicyFile> {
	try {
		const text = await fs.readFile(policyPath(projectPath), "utf8");
		const parsed = JSON.parse(text) as PolicyFile;
		return {
			projectPath,
			updatedAt: parsed.updatedAt || new Date().toISOString(),
			mode: parsed.mode || "ask",
			permissions: parsed.permissions || {},
		};
	} catch {
		return { projectPath, updatedAt: new Date().toISOString(), mode: "ask", permissions: {} };
	}
}

async function savePolicy(projectPath: string, policy: PolicyFile) {
	await fs.mkdir(POLICY_DIR, { recursive: true });
	await fs.writeFile(policyPath(projectPath), `${JSON.stringify(policy, null, "\t")}\n`, "utf8");
}

async function deletePolicy(projectPath: string) {
	try {
		await fs.unlink(policyPath(projectPath));
	} catch {
		// Already absent.
	}
}

function policyPath(projectPath: string) {
	const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
	return path.join(POLICY_DIR, `${hash}.json`);
}

async function getProjectPath(cwd: string): Promise<string> {
	try {
		return await fs.realpath(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

function isOutsideProject(requestedPath: string, projectPath: string, cwd: string): boolean {
	const absolute = path.resolve(cwd, requestedPath);
	const relative = path.relative(projectPath, absolute);
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function dedupeRequests(requests: PermissionRequest[]): PermissionRequest[] {
	const seen = new Set<PermissionKey>();
	return requests.filter((request) => {
		if (seen.has(request.key)) return false;
		seen.add(request.key);
		return true;
	});
}

function formatPermissions(permissions: Partial<Record<PermissionKey, Decision>>): string[] {
	const lines = (Object.keys(PERMISSION_LABELS) as PermissionKey[]).map((key) => {
		return `- ${PERMISSION_LABELS[key]}: ${permissions[key] || "ask"}`;
	});
	return lines.length ? lines : ["- none"];
}
