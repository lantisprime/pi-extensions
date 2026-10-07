import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	| "writeFiles"
	| "mcp";

type Decision = "allow" | "deny";
type PermissionMode = "ask" | "readOnlyAuto" | "llmAuto" | "seatAuto" | "yolo";

// The seat block is written by herdr-driver (Phase 1 contract). pi only reads
// manifestPath/expiresAt; every field must survive saves verbatim.
type SeatPolicy = {
	installedBy?: string;
	session?: string;
	name?: string;
	manifestPath?: string;
	installedAt?: string;
	expiresAt?: string;
	[key: string]: unknown;
};

// Fields pi does not know about (the seat block, hd bookkeeping) round-trip
// verbatim through load/save (spec A.5).
type PolicyFile = {
	schemaVersion?: number;
	projectPath: string;
	updatedAt: string;
	mode: PermissionMode;
	permissions: Partial<Record<PermissionKey, Decision>>;
	seat?: SeatPolicy;
	[key: string]: unknown;
};

type PermissionRequest = {
	key: PermissionKey;
	title: string;
	detail: string;
	command?: string;
	// Absolute write/edit target, plumbed from the tool input (spec A.2).
	targetPath?: string;
};

type PermissionDecision = {
	allowed: boolean;
	// Set when a seatAuto write/edit allow armed a post-write guard.
	seatAutoWrite?: { path: string };
};

// Armed between tool_call (pre-write snapshot) and tool_result (re-stat).
type PendingSeatWrite = { path: string; previous?: Buffer };

const POLICY_DIR = path.join(os.homedir(), ".pi", "agent", "permission-policy", "projects");
const PROMPT_SHIELD_STATE_PATH = path.join(os.homedir(), ".pi", "agent", "prompt-shield", "state.json");
const WEB_TOOL_NAMES = new Set(["web_search", "search_web", "web", "browser", "fetch", "http_get"]);
// Tools registered by the MCP bridge extension use the mcp_<server>_<tool>
// namespace. Their trust anchor is the user-authored mcp.json config (with
// per-server auth), so they get their own permission key instead of being
// blanket-classified by name (e.g. mcp_knowledge_knowledge_search is not web
// access just because the underlying tool name ends in _search).
const MCP_TOOL_PREFIX = "mcp_";
const SESSION_PERMISSIONS = new Map<string, Partial<Record<PermissionKey, Decision>>>();
// Set once inside the default export. ensurePermission/confirmYoloMode are
// top-level functions with several call sites, so threading pi (or a callback)
// through every handler would touch five call sites; a module-level bus set at
// registration time reaches both dialogs without changing their signatures.
// Undefined outside an extension load, and emitDialogBlocked no-ops then.
let extensionEvents: EventBus | undefined;
const YOLO_WARNING = [
	"YOLO permission mode is dangerous.",
	"It auto-allows permission requests without prompting and should only be used in disposable/trusted workspaces.",
	"permission-policy will still block rm -f/rm -rf style commands and commands that appear to delete the repository.",
].join("\n");

const MODE_LABELS: Record<PermissionMode, string> = {
	ask: "Ask when no project/session permission is recorded",
	readOnlyAuto: "Auto-allow read-only commands in the current project",
	llmAuto: "Use the current LLM to auto-allow commands judged non-destructive",
	seatAuto: "seatAuto: deterministic seat allows (read-only shapes, test runners, in-project git, in-project writes); everything else asks",
	yolo: "YOLO: auto-allow by default except rm -f/rm -rf and repo deletion",
};

const PERMISSION_LABELS: Record<PermissionKey, string> = {
	readOutsideProject: "Read files outside this project",
	bashCommands: "Run bash commands",
	destructiveBash: "Run destructive shell commands",
	git: "Run git commands",
	web: "Search or fetch from the web",
	writeFiles: "Write or edit files",
	mcp: "Call MCP server tools",
};

export default function (pi: ExtensionAPI) {
	extensionEvents = pi.events;

	pi.registerFlag("permission-mode", {
		description: "Set permission mode: ask, read-only, auto, seat-auto, or yolo",
		type: "string",
	});

	pi.on("session_start", async (event, ctx) => {
		await updatePermissionStatus(ctx);
		const projectPath = await getProjectPath(ctx.cwd);
		const policy = await loadPolicy(projectPath);

		// Apply CLI --permission-mode flag on initial startup
		if (event.reason === "startup") {
			const cliMode = pi.getFlag("permission-mode") as string | undefined;
	if (cliMode !== undefined) {
				const mode = parseMode(cliMode.trim().toLowerCase());
				if (mode) {
					if (mode === "yolo" && policy.mode !== "yolo") {
						// Require confirmation in interactive mode; bypass in non-interactive
						if (ctx.hasUI && !(await confirmYoloMode(ctx))) return;
					}
					policy.mode = mode;
				} else {
					// Invalid value: fail closed — explicitly reset to ask
					policy.mode = "ask";
				}
				policy.updatedAt = new Date().toISOString();
				await savePolicy(projectPath, policy);
				await updatePermissionStatus(ctx);
			}
		}

		if (policy.mode === "yolo" && ctx.hasUI) ctx.ui.notify(YOLO_WARNING, "warning");
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Cycle permission-policy mode",
		handler: async (ctx) => {
			const projectPath = await getProjectPath(ctx.cwd);
			const policy = await loadPolicy(projectPath);
			const next = nextMode(policy.mode);
			if (next === "yolo" && !(await confirmYoloMode(ctx))) return;
			policy.mode = next;
			policy.updatedAt = new Date().toISOString();
			await savePolicy(projectPath, policy);
			await updatePermissionStatus(ctx);
			ctx.ui.notify(`Permission mode: ${policy.mode} - ${MODE_LABELS[policy.mode]}`, policy.mode === "yolo" ? "warning" : "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const projectPath = await getProjectPath(ctx.cwd);
		const requests = await classifyToolCall(event.toolName, event.input as Record<string, unknown>, projectPath, ctx.cwd);
		if (requests.length === 0) return undefined;

		for (const request of requests) {
			const decision = await ensurePermission(ctx, projectPath, request);
			if (!decision.allowed) return { block: true, reason: `Permission denied: ${request.title}` };
			if (decision.seatAutoWrite) await armSeatWriteGuard(event.toolCallId, decision.seatAutoWrite.path);
		}

		return undefined;
	});

	// Post-write verification for seatAuto write/edit allows (spec A.2):
	// re-stat the target and revert from the pre-write copy on mismatch.
	pi.on("tool_result", async (event, ctx) => {
		await verifySeatWrite(event as { toolCallId: string; toolName: string; isError?: boolean }, ctx);
	});

	pi.on("user_bash", async (event, ctx) => {
		const projectPath = await getProjectPath(event.cwd || ctx.cwd);
		const requests = classifyBashCommand(event.command);
		if (requests.length === 0) return undefined;

		for (const request of requests) {
			// Operator-typed ! commands keep today's behaviour and are never
			// subject to seatAuto allows (spec N6).
			const decision = await ensurePermission(ctx, projectPath, request, { userBash: true });
			if (!decision.allowed) {
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
		description: "Show/reset permission-policy settings, or set mode: /permissions mode ask|read-only|auto|seat-auto|yolo",
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
					ctx.ui.notify("Usage: /permissions mode ask|read-only|auto|seat-auto|yolo", "warning");
					return;
				}
				if (mode === "yolo" && policy.mode !== "yolo" && !(await confirmYoloMode(ctx))) return;
				policy.mode = mode;
				policy.updatedAt = new Date().toISOString();
				await savePolicy(projectPath, policy);
				await updatePermissionStatus(ctx);
				ctx.ui.notify(`Permission mode set to ${mode}: ${MODE_LABELS[mode]}`, mode === "yolo" ? "warning" : "info");
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
				"Use /permissions mode ask|read-only|auto|seat-auto|yolo to change mode.",
				"Use /permissions reset to clear both for this project.",
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

export async function classifyToolCall(
	toolName: string,
	input: Record<string, unknown>,
	projectPath: string,
	cwd: string,
): Promise<PermissionRequest[]> {
	if (toolName === "read") {
		const requestedPath = String(input.path || "");
		// Resolve against the real-pathed cwd like write/edit targets do (spec
		// A.2 plumbing): the raw cwd can sit under a symlinked prefix (macOS /tmp
		// → /private/tmp), which would make in-project reads look outside.
		const baseCwd = requestedPath ? await getProjectPath(cwd) : cwd;
		if (requestedPath && isOutsideProject(path.resolve(baseCwd, requestedPath), projectPath, baseCwd)) {
			return [
				{
					key: "readOutsideProject",
					title: PERMISSION_LABELS.readOutsideProject,
					detail: `Requested path: ${path.resolve(baseCwd, requestedPath)}`,
				},
			];
		}
		// B5: the lexical check misses paths that reach a protected root or git
		// dir through a symlink (read ssh-link/id_rsa where the link points at
		// ~/.ssh); resolve the real path and hard-deny those too.
		if (requestedPath) {
			const absolute = path.resolve(baseCwd, requestedPath);
			const real = await realpathThroughExisting(absolute);
			if (real) {
				const gitDirs = await resolveGitEntryDirs(projectPath);
				if (await isProtectedPath(real, os.homedir(), gitDirs)) {
					return [
						{
							key: "readOutsideProject",
							title: PERMISSION_LABELS.readOutsideProject,
							detail: `Requested path resolves into a protected location: ${real}`,
						},
					];
				}
			}
		}
	}

	if (toolName === "write" || toolName === "edit") {
		const rawPath = String(input.path || "");
		// Resolve against the real-pathed cwd: the raw cwd can sit under a
		// symlinked prefix (macOS /tmp → /private/tmp), which would make every
		// in-project target look outside the project (spec A.2 plumbing).
		const baseCwd = await getProjectPath(cwd);
		return [
			{
				key: "writeFiles",
				title: PERMISSION_LABELS.writeFiles,
				detail: `${toolName} path: ${rawPath || "(unknown)"}`,
				targetPath: rawPath ? path.resolve(baseCwd, rawPath) : undefined,
			},
		];
	}

	if (toolName === "bash") {
		return classifyBashCommand(String(input.command || ""));
	}

	if (toolName.startsWith(MCP_TOOL_PREFIX)) {
		return [
			{
				key: "mcp",
				title: PERMISSION_LABELS.mcp,
				detail: `Tool: ${toolName}`,
			},
		];
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

export function classifyBashCommand(command: string): PermissionRequest[] {
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

export function looksLikeGitCommand(command: string): boolean {
	// Be intentionally broad: the policy is "ask before git commands", including
	// read-only git commands and commands embedded in shell chains like
	// `cd repo && git status` or `env FOO=bar git status`.
	return /\bgit\b/i.test(command);
}

export function looksDestructive(command: string): boolean {
	const destructiveCommand = /(^|[;&|()\s])(rm|mv|cp|unlink|rmdir|chmod|chown|install|truncate)\s+/i.test(command);
	// Stream dups (2>&1, >&2) and /dev/null discard output instead of overwriting
	// a file, and >> appends; none of those are overwrite redirects (spec A.4).
	// Everything else with an overwrite-style redirect or tee into a file is.
	const overwriteRedirect = /(^|\s)(?:\d*&?>|\d?>|tee\s+)(?!>|\s*\/dev\/null\b|\s*&\s*\d+\b)/i.test(command);
	const inPlaceEdit = /(^|[;&|()\s])(sed|perl|python|node|ruby)\s+.*\s(-i|--in-place)\b/i.test(command);
	return destructiveCommand || overwriteRedirect || inPlaceEdit;
}

export function isYoloHardDenied(command: string, projectPath: string, cwd: string): string | undefined {
	const normalized = command.replace(/\\n|[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	if (/(^|[;&|()\s])rm\s+[^;&|()]*?(?:--force\b|-[A-Za-z]*f[A-Za-z]*\b)/i.test(normalized)) return "rm -f/rm -rf commands are blocked even in YOLO mode";
	if (/(^|[;&|()\s])rm\s+[^;&|()]*\s(?:\.git|\.git\/|\.\/\.git|\.\/\.git\/)(?:\s|$)/i.test(normalized)) return "commands that delete the repository metadata are blocked even in YOLO mode";
	if (/(?:\.git\b.{0,120}\brm\b|\brm\b.{0,120}\.git\b)/i.test(normalized)) return "commands that delete the repository metadata are blocked even in YOLO mode";
	if (/\bgit\s+worktree\s+remove\b/i.test(normalized) && /(?:^|\s)(?:--force|-f)(?:\s|$)/i.test(normalized)) return "forced repository worktree deletion is blocked even in YOLO mode";

	const rmTargets = extractRmLikeTargets(normalized);
	for (const target of rmTargets) {
		if (target === ".git" || target.startsWith(`.git${path.sep}`)) return "commands that delete the repository metadata are blocked even in YOLO mode";
		const absolute = path.resolve(cwd, target);
		if (absolute === projectPath || projectPath.startsWith(`${absolute}${path.sep}`)) {
			return "commands that delete the project repository are blocked even in YOLO mode";
		}
	}
	return undefined;
}

function extractRmLikeTargets(command: string): string[] {
	const targets: string[] = [];
	for (const segment of command.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
		const tokens = segment.match(/(?:"[^"]+"|'[^']+'|\S+)/g) || [];
		const commandIndex = tokens.findIndex((token) => /^(rm|rmdir|unlink)$/.test(token));
		if (commandIndex < 0) continue;
		for (const raw of tokens.slice(commandIndex + 1)) {
			const token = raw.replace(/^['"]|['"]$/g, "");
			if (!token || token === "--" || token.startsWith("-")) continue;
			targets.push(token);
		}
	}
	return targets;
}

export function isReadOnlyAutoAllowed(request: PermissionRequest, projectPath: string, cwd: string): boolean {
	if (!request.command) return false;
	if (request.key === "readOutsideProject" || request.key === "writeFiles" || request.key === "destructiveBash" || request.key === "web") {
		return false;
	}
	if (commandMentionsOutsideProject(request.command, projectPath, cwd)) return false;
	if (looksDestructive(request.command)) return false;
	if (request.key === "git") return isReadOnlyGitCommand(request.command);
	return isReadOnlyShellCommand(request.command);
}

export function isReadOnlyGitCommand(command: string): boolean {
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

// Newline is a command separator too (spec N4): a smuggled second line must
// never inherit the first line's shape.
function splitCommandSegments(command: string): string[] {
	return command
		.split(/\s*(?:\r?\n|&&|\|\||;|\|)\s*/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function shellTokens(segment: string): string[] {
	return (segment.match(/(?:"[^"]+"|'[^']+'|\S+)/g) || []).map((token) => token.replace(/^['"]|['"]$/g, ""));
}

// Strict read-only shapes (spec N1): find may not delete/execute/print-to-file,
// sed is only -n with a print script, awk and xargs are not read-only. When
// unsure, NOT read-only.
const SIMPLE_READONLY_COMMANDS = new Set([
	"pwd",
	"ls",
	"grep",
	"rg",
	"cat",
	"head",
	"tail",
	"wc",
	"sort",
	"uniq",
	"file",
	"stat",
	"du",
	"df",
	"echo",
	"printf",
	"which",
	"test",
]);

function isFindReadOnly(args: string[]): boolean {
	return !args.some((arg) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg));
}

function isPrintOnlySedSubstitute(part: string): boolean {
	if (part.length < 2) return false;
	const delimiter = part[1];
	const body = part.slice(2).split(`\\${delimiter}`).join("\u0000");
	const pieces = body.split(delimiter);
	if (pieces.length < 2 || pieces.length > 3) return false;
	// s/// flags: g, p, case/match flags and occurrence numbers are fine; the
	// w (write-to-file) and e (execute) flags are not.
	return !/[^gpIiMm0-9]/.test(pieces[2] || "");
}

function isPrintOnlySedScript(script: string): boolean {
	return script
		.split(";")
		.map((part) => part.trim())
		.every((part) => {
			if (!part) return false;
			if (/^(?:\/[^/]+\/|\$|\d+)(?:,(?:\/[^/]+\/|\$|\d+))?p$/.test(part)) return true;
			return part.startsWith("s") && isPrintOnlySedSubstitute(part);
		});
}

function isSedPrintOnly(args: string[]): boolean {
	let sawN = false;
	const scriptArgs: string[] = [];
	for (const arg of args) {
		if (arg === "-n") {
			sawN = true;
			continue;
		}
		if (arg.startsWith("-")) return false; // -i, -e, -f, ...: unsure → not read-only
		scriptArgs.push(arg);
	}
	if (!sawN || scriptArgs.length === 0) return false;
	return isPrintOnlySedScript(scriptArgs[0]);
}

function isReadOnlyShellSegment(segment: string): boolean {
	const tokens = shellTokens(segment);
	const first = tokens[0];
	if (!first) return false;
	if (first === "find") return isFindReadOnly(tokens.slice(1));
	if (first === "sed") return isSedPrintOnly(tokens.slice(1));
	// B1: `command` is an exec wrapper — `command node -e …` or
	// `command bash -c …` must not ride the read-only set. Only the exact
	// shape `command -v <word>` (print a command's path) is read-only.
	if (first === "command") return tokens.length === 3 && tokens[1] === "-v" && /^[A-Za-z0-9_./-]+$/.test(tokens[2]);
	return SIMPLE_READONLY_COMMANDS.has(first);
}

export function isReadOnlyShellCommand(command: string): boolean {
	if (/[;&]\s*(rm|mv|cp|chmod|chown|install|truncate|touch|mkdir|rmdir)\b/i.test(command)) return false;
	return splitCommandSegments(command).every(isReadOnlyShellSegment);
}

// ---------------------------------------------------------------------------
// seatAuto: deterministic seat allows (Phase 1 spec A). No LLM decides any
// allow here; anything not matching the shapes below falls through to the
// normal operator dialog, where hd watch reports the pane as blocked.
// ---------------------------------------------------------------------------

const SEAT_BASH_KEYS: PermissionKey[] = ["bashCommands", "destructiveBash", "git"];
const SEAT_GIT_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse"]);
const PENDING_SEAT_WRITE_LIMIT = 64;
const pendingSeatWrites = new Map<string, PendingSeatWrite>();
const SEAT_VIOLATIONS_PATH = path.join(os.homedir(), ".pi", "agent", "permission-policy", "seat-violations.jsonl");

function seatManifestPath(policy: PolicyFile): string | undefined {
	const manifestPath = policy.seat?.manifestPath;
	return typeof manifestPath === "string" && manifestPath ? manifestPath : undefined;
}

// Spec N7: mode seatAuto with a missing or expired seat block behaves as ask.
function isSeatAutoActive(policy: PolicyFile): boolean {
	if (policy.mode !== "seatAuto") return false;
	const expiresAt = policy.seat?.expiresAt;
	if (typeof expiresAt !== "string") return false;
	const expires = Date.parse(expiresAt);
	return Number.isFinite(expires) && expires > Date.now();
}

// realpath that tolerates a missing leaf: resolves the longest existing
// prefix and rejoins the rest, so a path through a symlinked directory is
// still caught even when the final component does not exist yet.
async function realpathThroughExisting(absolute: string): Promise<string | undefined> {
	let current = absolute;
	const missing: string[] = [];
	for (let i = 0; i < 64; i++) {
		try {
			const real = await fs.realpath(current);
			return missing.length ? path.join(real, ...missing) : real;
		} catch {
			missing.unshift(path.basename(current));
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
	return undefined;
}

async function seatProtectedRootsFor(home: string): Promise<string[]> {
	const real = await realpathThroughExisting(home);
	const homes = real && real !== home ? [home, real] : [home];
	return homes.flatMap((root) => [
		path.join(root, ".pi", "agent", "permission-policy"),
		path.join(root, ".ssh"),
		path.join(root, ".config"),
		path.join(root, ".aws"),
		path.join(root, ".gnupg"),
		path.join(root, ".cache", "herdr-driver"),
	]);
}

function isInsideAny(candidate: string, roots: string[]): boolean {
	return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

// The worktree's .git entry: the file (or dir) at <project>/.git plus the
// git-dir and common dir ($(git rev-parse --git-common-dir)) it points at.
async function resolveGitEntryDirs(projectPath: string): Promise<string[]> {
	const entry = path.join(projectPath, ".git");
	const dirs = [entry];
	try {
		const st = await fs.lstat(entry);
		if (st.isDirectory()) return dirs;
		if (st.isFile()) {
			const text = await fs.readFile(entry, "utf8");
			const match = text.match(/gitdir:\s*(.+)/);
			if (match) {
				let gitDir = match[1].trim();
				if (!path.isAbsolute(gitDir)) gitDir = path.resolve(projectPath, gitDir);
				dirs.push(gitDir);
				// <main>/.git/worktrees/<name> → common dir <main>/.git
				const parent = path.dirname(gitDir);
				dirs.push(path.basename(parent) === "worktrees" ? path.dirname(parent) : parent);
			}
		}
	} catch {
		// No .git entry (or unreadable): lexical entry protection only.
	}
	return dirs;
}

// A path is protected when it — or, for existing paths, the target it resolves
// to through symlinks — lands on the .git entry, a git dir, or a protected
// root under $HOME (spec A.1).
async function isProtectedPath(absolute: string, home: string, gitDirs: string[]): Promise<boolean> {
	const candidates = [absolute];
	const real = await realpathThroughExisting(absolute);
	if (real && real !== absolute) candidates.push(real);
	const protectedRoots = await seatProtectedRootsFor(home);
	for (const candidate of candidates) {
		if (isInsideAny(candidate, gitDirs)) return true;
		if (isInsideAny(candidate, protectedRoots)) return true;
	}
	return false;
}

// Spec A.2(a): component-wise lstat walk with no symlink component. Anchored
// at the (already real-pathed) project; the seat manifest exception (N3)
// anchors at realpath($HOME). macOS-style aliases (/tmp → /private/tmp) are
// tolerated only when realpath resolves the target back onto the anchor, so
// in-project symlink components are still caught on the lexical walk.
async function hasNoSymlinkComponent(absolute: string, projectPath: string, home: string): Promise<boolean> {
	let walkRoot = projectPath;
	let walkTarget = absolute;
	if (isOutsideProject(absolute, projectPath, projectPath)) {
		const real = await realpathThroughExisting(absolute);
		if (real && !isOutsideProject(real, projectPath, projectPath)) {
			// Tolerate a macOS-style aliased prefix (/tmp → /private/tmp) only
			// when the divergence sits above the project root: the lexical target
			// must end with the project-relative real remainder. A differing tail
			// means an in-project symlink component — denied.
			const aliasTail = path.join(path.sep, path.relative(projectPath, real));
			if (!absolute.endsWith(aliasTail)) return false;
			walkTarget = real;
		} else {
			const realHome = (await realpathThroughExisting(home)) || home;
			const underHome =
				absolute === home ||
				absolute.startsWith(`${home}${path.sep}`) ||
				absolute === realHome ||
				absolute.startsWith(`${realHome}${path.sep}`) ||
				(!!real && (real === realHome || real.startsWith(`${realHome}${path.sep}`)));
			if (!underHome) return false;
			try {
				walkRoot = await fs.realpath(realHome);
			} catch {
				return false;
			}
			if (real) walkTarget = real;
		}
	}
	const relative = path.relative(walkRoot, walkTarget);
	if (!relative) return true;
	let current = walkRoot;
	for (const part of relative.split(path.sep)) {
		current = path.join(current, part);
		try {
			const st = await fs.lstat(current);
			if (st.isSymbolicLink()) return false;
		} catch {
			// First missing component: nothing below it can exist yet.
			return true;
		}
	}
	return true;
}

async function passesSeatPathChecks(
	absolute: string,
	projectPath: string,
	home: string,
	gitDirs: string[],
	opts: { allowManifest: boolean; manifestPath?: string },
): Promise<boolean> {
	let isManifest = false;
	if (opts.allowManifest && opts.manifestPath) {
		isManifest = absolute === opts.manifestPath;
		if (!isManifest) {
			const realManifest = await realpathThroughExisting(opts.manifestPath);
			isManifest = !!realManifest && realManifest === absolute;
		}
	}
	if (!isManifest && (await isProtectedPath(absolute, home, gitDirs))) return false;
	return hasNoSymlinkComponent(absolute, projectPath, home);
}

// Spec A.2: deterministic write/edit allow. Returns the resolved absolute
// target when the write is allowed, so the caller can arm the post-write
// guard.
async function seatAutoWriteAllowPath(
	request: PermissionRequest,
	projectPath: string,
	cwd: string,
	policy: PolicyFile,
): Promise<string | undefined> {
	if (request.key !== "writeFiles" || !request.targetPath) return undefined;
	// B9: the post-write guard map is bounded. Past the limit, fail closed
	// (the request falls through to the operator dialog) instead of evicting
	// an armed guard.
	if (pendingSeatWrites.size >= PENDING_SEAT_WRITE_LIMIT) return undefined;
	const home = os.homedir();
	const manifestPath = seatManifestPath(policy);
	const absolute = path.resolve(cwd, request.targetPath);
	// Containment tolerates a macOS-style aliased prefix (/tmp → /private/tmp):
	// the target counts as inside when its realpath resolves back into the
	// project. In-project symlink components are still caught by the walk.
	const real = await realpathThroughExisting(absolute);
	const inProject = !isOutsideProject(absolute, projectPath, cwd) || (!!real && !isOutsideProject(real, projectPath, cwd));
	// N3: the seat's exact manifest path is the ONE allowed write outside the
	// project, and only here — never for shell redirects.
	if (!inProject && absolute !== manifestPath) return undefined;
	const gitDirs = await resolveGitEntryDirs(projectPath);
	if (!(await passesSeatPathChecks(absolute, projectPath, home, gitDirs, { allowManifest: true, manifestPath }))) return undefined;
	try {
		const st = await fs.lstat(absolute);
		// (b) an existing target must have exactly one link. Directories always
		// carry nlink >= 2 and would fail the write anyway, so they are denied.
		if (st.isSymbolicLink() || st.nlink !== 1) return undefined;
	} catch {
		// (d) new file: the nearest existing ancestor already passed the walk
		// above (it stops at the first missing component after checking every
		// existing one); nothing deeper exists yet.
	}
	return absolute;
}

type SegmentRedirect = { op: string; target: string };

// Splits redirects out of a segment. Heredocs/here-strings and clobber
// redirects are never auto-allowed (N4); stream dups (2>&1, >&2) are removed;
// a remaining bare & is backgrounding (N4).
function parseSegmentRedirects(segment: string): { bare: string; redirects: SegmentRedirect[]; forbidden: boolean } {
	if (/<<|>\|/.test(segment)) return { bare: "", redirects: [], forbidden: true };
	let rest = segment.replace(/\d*>\s*&\s*\d+\b/g, " ");
	const redirects: SegmentRedirect[] = [];
	rest = rest.replace(/(\d*)\s*(&>>|>>|&>|>&|>)\s*(\S*)/g, (_match, fd: string, op: string, target: string) => {
		redirects.push({ op: (fd || "") + op, target });
		return " ";
	});
	if (redirects.some((redirect) => !redirect.target)) return { bare: "", redirects, forbidden: true };
	if (/&/.test(rest)) return { bare: "", redirects, forbidden: true };
	return { bare: rest.replace(/\s+/g, " ").trim(), redirects, forbidden: false };
}

// Redirect targets may be /dev/null or a file inside the project that passes
// the A.2 path checks. The manifest exception never extends to redirects.
async function isRedirectTargetAllowed(
	redirect: SegmentRedirect,
	projectPath: string,
	cwd: string,
	home: string,
	gitDirs: string[],
): Promise<boolean> {
	if (redirect.target === "/dev/null") return true;
	const absolute = path.resolve(cwd, redirect.target);
	if (isOutsideProject(absolute, projectPath, cwd)) return false;
	if (!(await passesSeatPathChecks(absolute, projectPath, home, gitDirs, { allowManifest: false }))) return false;
	// A4/B7: an existing redirect target must be a plain file with exactly one
	// link, like write/edit targets (spec A.2/A.4).
	try {
		const st = await fs.lstat(absolute);
		if (st.isSymbolicLink() || st.nlink !== 1) return false;
	} catch {
		// New file: nothing exists to swap yet.
	}
	return true;
}

// Spec A.3 test-runner shapes. N5: the type-check shape is
// ./node_modules/.bin/tsc --noEmit only, never npx. Test runners execute
// seat-authored code as the operator; that is allowlisted on purpose and
// documented as a residual risk.
function isTestRunnerSegment(tokens: string[]): boolean {
	const [first, second, third] = tokens;
	if (first === "python3" && second === "-m" && (third === "unittest" || third === "pytest")) return true;
	// A7: every argument must be a tests/<name>.sh path.
	if (first === "sh" && tokens.length >= 2 && tokens.slice(1).every((token) => /^tests\/.+\.sh$/.test(token))) return true;
	if (first === "node" && second === "--test") return true;
	if (first === "npm" && second === "test") return true;
	if (
		first === "./node_modules/.bin/tsc" &&
		tokens.includes("--noEmit") &&
		!tokens.some((token) => /^--(build|emit|emitDeclarationOnly|outDir|outFile|declaration|incremental)/.test(token))
	)
		return true;
	if (first === "claude" && second === "plugin" && (third === "test" || third === "validate")) return true;
	return false;
}

// Parses leading git global options. N2: -c/--config-env and the repo/config
// redirecting options are denied outright; -C may only target the project.
function parseGitSegment(
	tokens: string[],
	projectPath: string,
	cwd: string,
): { subcommand: string; args: string[] } | { denied: string } | undefined {
	let i = 1;
	for (; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") {
			i++;
			break;
		}
		if (!token.startsWith("-")) break;
		// A1: deny -c, the glued -c<key>=<value> form (e.g. -ccore.hooksPath=…)
		// and --config-env outright; -C stays a distinct, case-sensitive option.
		if (/^-c/.test(token) || /^--config-env/.test(token)) {
			return { denied: "git -c/--config-env is not permitted without operator approval" };
		}
		if (/^(--git-dir|--work-tree|--exec-path|--namespace|--super-prefix)(=|$)/.test(token)) {
			return { denied: "git global repo/config options are not permitted without operator approval" };
		}
		if (token === "-C" || /^-C[^-]/.test(token)) {
			const target = token === "-C" ? tokens[i + 1] : token.slice(2);
			if (!target || isOutsideProject(path.resolve(cwd, target), projectPath, cwd)) {
				return { denied: "git -C outside the project is not permitted without operator approval" };
			}
			if (token === "-C") i++;
			continue;
		}
	}
	const subcommand = tokens[i];
	if (!subcommand) return undefined;
	return { subcommand, args: tokens.slice(i + 1) };
}

function isSeatGitCommitArgs(args: string[], projectPath: string, cwd: string): boolean {
	if (args.length === 0) return false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-m" || arg === "--message") {
			if (i + 1 >= args.length) return false;
			i++;
			continue;
		}
		if (arg.startsWith("--message=")) continue;
		if (arg === "-F" || arg === "--file") {
			const target = args[i + 1];
			if (!target || isOutsideProject(path.resolve(cwd, target), projectPath, cwd)) return false;
			i++;
			continue;
		}
		if (arg.startsWith("--file=")) {
			const target = arg.slice("--file=".length);
			if (!target || isOutsideProject(path.resolve(cwd, target), projectPath, cwd)) return false;
			continue;
		}
		return false;
	}
	return true;
}

// In-project git shapes (spec A.3): status/diff/log/show/rev-parse free-form,
// add with plain paths, commit with -m/-F only, branch --show-current only.
function isInProjectGitSegment(tokens: string[], projectPath: string, cwd: string): boolean {
	if (tokens[0] !== "git") return false;
	const parsed = parseGitSegment(tokens, projectPath, cwd);
	if (!parsed || "denied" in parsed) return false;
	const { subcommand, args } = parsed;
	// A3/B2: --output, --output=… and glued -o… on read subcommands write
	// anywhere on disk; never auto-allowed.
	if (args.some((arg) => /^--output/.test(arg) || /^-o/.test(arg))) return false;
	if (SEAT_GIT_READ_SUBCOMMANDS.has(subcommand)) return true;
	if (subcommand === "branch") return args.length === 1 && args[0] === "--show-current";
	if (subcommand === "add") return args.length > 0 && args.every((arg) => !arg.startsWith("-") && arg !== "--");
	if (subcommand === "commit") return isSeatGitCommitArgs(args, projectPath, cwd);
	return false;
}

// The sed script argument (tokens[2]: sed -n SCRIPT FILES...) only looks like
// an absolute path; it is validated by isSedPrintOnly instead.
function withoutSedScript(bare: string): string {
	const tokens = shellTokens(bare);
	if (tokens[0] === "sed" && tokens[1] === "-n" && tokens.length > 2) {
		return tokens.filter((_, index) => index !== 2).join(" ");
	}
	return bare;
}

// B4: `$` outside single-quoted spans is expanded by bash before any literal
// check below runs; single quotes are the only quoting that suppresses
// expansion, so an unquoted `$` means the checked text is not what will run.
function containsUnquotedDollar(segment: string): boolean {
	return segment.replace(/'[^']*'/g, " ").includes("$");
}

async function isSeatAutoBashAllowed(command: string, projectPath: string, cwd: string, policy: PolicyFile): Promise<boolean> {
	const segments = splitCommandSegments(command);
	if (segments.length === 0) return false;
	const home = os.homedir();
	const gitDirs = await resolveGitEntryDirs(projectPath);
	for (const segment of segments) {
		// B4: reject any segment with an unquoted `$` — redirect targets and
		// path-bearing tokens would be checked literally but expanded by bash.
		if (containsUnquotedDollar(segment)) return false;
		const parsed = parseSegmentRedirects(segment);
		if (parsed.forbidden || !parsed.bare) return false;
		for (const redirect of parsed.redirects) {
			if (!(await isRedirectTargetAllowed(redirect, projectPath, cwd, home, gitDirs))) return false;
		}
		const bare = parsed.bare;
		// sed scripts (/re/p, s/.../p) are arguments, not paths: run the outside
		// mention scan with the script argument excluded.
		if (commandMentionsOutsideProject(withoutSedScript(bare), projectPath, cwd)) return false;
		if (isReadOnlyShellSegment(bare)) continue;
		const tokens = shellTokens(bare);
		if (isTestRunnerSegment(tokens)) continue;
		if (isInProjectGitSegment(tokens, projectPath, cwd)) continue;
		return false;
	}
	return true;
}

// Spec A.1 hard-deny set beyond isYoloHardDenied: never reaches any allow path
// in any mode; only the interactive dialog keystroke may let these through.
async function seatHardDeniedReason(command: string, projectPath: string, cwd: string): Promise<string | undefined> {
	if (/~/u.test(command)) return "shell ~ paths are not permitted without operator approval";
	if (/\$\{?\s*HOME\s*\}?/.test(command)) return "$HOME is not permitted without operator approval";
	if (/`|\$\(|<\(|>\(/.test(command)) return "command substitution is not permitted without operator approval";
	const home = os.homedir();
	const gitDirs = await resolveGitEntryDirs(projectPath);
	for (const segment of splitCommandSegments(command)) {
		const tokens = shellTokens(segment);
		for (const token of tokens) {
			const base = path.basename(token);
			if (["ln", "link", "curl", "wget", "nc", "ssh", "scp", "rsync", "eval", "source"].includes(base)) {
				return `"${base}" is not permitted without operator approval`;
			}
		}
		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].toLowerCase() !== "git") continue;
			const parsed = parseGitSegment(tokens.slice(i), projectPath, cwd);
			if (parsed && "denied" in parsed) return parsed.denied;
			if (parsed && ["config", "push", "worktree", "remote", "submodule"].includes(parsed.subcommand)) {
				return `git ${parsed.subcommand} is not permitted without operator approval`;
			}
		}
		for (const token of tokens) {
			// A3/B2/B8: option values hide paths; scan the value part as well.
			const candidates = [token, optionValueOf(token)].filter((candidate): candidate is string => !!candidate);
			for (const candidate of candidates) {
				if (candidate.startsWith("-")) continue;
				const absolute = path.resolve(cwd, candidate);
				if (await isProtectedPath(absolute, home, gitDirs)) {
					return "paths into protected locations are not permitted without operator approval";
				}
			}
		}
	}
	return undefined;
}

async function isSeatHardDenied(command: string, projectPath: string, cwd: string): Promise<string | undefined> {
	return isYoloHardDenied(command, projectPath, cwd) || (await seatHardDeniedReason(command, projectPath, cwd));
}

async function armSeatWriteGuard(toolCallId: string, targetPath: string): Promise<void> {
	// Normalize aliased prefixes (macOS /tmp → /private/tmp) so the post-write
	// realpath comparison does not fail on the path's own spelling.
	const guardPath = (await realpathThroughExisting(targetPath)) || targetPath;
	let previous: Buffer | undefined;
	try {
		previous = await fs.readFile(guardPath);
	} catch {
		previous = undefined;
	}
	if (pendingSeatWrites.size >= PENDING_SEAT_WRITE_LIMIT) {
		// B9: never evict an armed guard. Unreachable while seatAuto arms guards
		// (seatAutoWriteAllowPath fails the request closed at the limit); kept
		// defensive so a future call site cannot silently evict a guard.
		return;
	}
	pendingSeatWrites.set(toolCallId, { path: guardPath, previous });
}

async function recordSeatViolation(violatedPath: string, note: string): Promise<void> {
	try {
		await fs.mkdir(path.dirname(SEAT_VIOLATIONS_PATH), { recursive: true });
		await fs.appendFile(
			SEAT_VIOLATIONS_PATH,
			`${JSON.stringify({ ts: new Date().toISOString(), path: violatedPath, action: "reverted", note })}\n`,
			"utf8",
		);
	} catch {
		// Recording must never break the tool flow.
	}
}

// Spec A.2 post-write verification: re-stat (realpath plus nlink) after the
// tool ran; on mismatch, revert from the pre-write copy and record a
// violation. The window between the write landing and this re-stat remains a
// documented residual swap race.
async function verifySeatWrite(
	event: { toolCallId: string; toolName: string; isError?: boolean },
	ctx: ExtensionContext,
): Promise<void> {
	const entry = pendingSeatWrites.get(event.toolCallId);
	if (!entry) return;
	pendingSeatWrites.delete(event.toolCallId);
	if (event.isError) return;
	let intact = false;
	try {
		const st = await fs.lstat(entry.path);
		intact = !st.isSymbolicLink() && st.nlink === 1 && (await fs.realpath(entry.path)) === entry.path;
	} catch {
		intact = false;
	}
	if (intact) return;
	let note: string;
	try {
		await fs.rm(entry.path, { force: true, recursive: true });
		if (entry.previous) await fs.writeFile(entry.path, entry.previous);
		note = entry.previous ? "reverted from pre-write copy" : "removed created file";
	} catch (error) {
		note = `revert failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	await recordSeatViolation(entry.path, note);
	if (ctx.hasUI) ctx.ui.notify(`seatAuto: post-write check failed for ${entry.path}; ${note}`, "warning");
}

// A3/B2/B8: option values (`--opt=/abs`, glued `-X/abs`) hide a path that
// never appears as its own token; extract the value part so the path scans
// see it.
function optionValueOf(token: string): string | undefined {
	const eq = token.match(/^--[^\s=]+=(.+)$/);
	if (eq) return eq[1];
	const glued = token.match(/^-[A-Za-z](.+)$/);
	return glued ? glued[1] : undefined;
}

function mentionsOutsideProject(token: string, projectPath: string, cwd: string): boolean {
	if (token === ".." || token.startsWith(`..${path.sep}`)) return true;
	return path.isAbsolute(token) && isOutsideProject(token, projectPath, cwd);
}

export function commandMentionsOutsideProject(command: string, projectPath: string, cwd: string): boolean {
	const tokens = command.match(/(?:"[^"]+"|'[^']+'|\S+)/g) || [];
	for (const rawToken of tokens) {
		const token = rawToken.replace(/^['"]|['"]$/g, "");
		if (mentionsOutsideProject(token, projectPath, cwd)) return true;
		// The value of an --opt=… / -X… token is a path too (spec A3).
		const value = optionValueOf(token);
		if (value && mentionsOutsideProject(value, projectPath, cwd)) return true;
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

// herdr's pi integration (herdr-agent-state.ts) listens on "herdr:blocked" and
// marks the pane "blocked" while active, so supervisors waiting on
// `herdr agent wait` / `prompt --wait` can see the agent is stuck on a modal
// dialog instead of appearing to work. Emitting to a bus with no listener (plain
// pi, herdr integration absent) is a no-op that cannot throw.
function emitPermissionDialogBlocked(active: boolean, label?: string) {
	if (!extensionEvents) return;
	try {
		extensionEvents.emit("herdr:blocked", active ? { active: true, label } : { active: false });
	} catch {
		// Never let blocked-state reporting break the permission flow.
	}
}

async function ensurePermission(
	ctx: ExtensionContext,
	projectPath: string,
	request: PermissionRequest,
	opts: { userBash?: boolean } = {},
): Promise<PermissionDecision> {
	const policy = await loadPolicy(projectPath);
	const userBash = opts.userBash === true;

	// Spec A.1: hard-deny categories never reach any allow path in any mode.
	// Only the interactive dialog keystroke may let them through; stored
	// session/project grants are not operator actions (N6). Operator-typed !
	// commands keep today's flow and skip this gate (N6).
	if (!userBash && request.command) {
		const hardDenyReason = await isSeatHardDenied(request.command, projectPath, projectPath);
		if (hardDenyReason) {
			if (policy.mode === "yolo") {
				// YOLO denies outright and never shows a dialog.
				if (ctx.hasUI) ctx.ui.notify(hardDenyReason, "warning");
				return { allowed: false };
			}
			return promptForPermission(ctx, projectPath, request, policy);
		}
	}

	// B3: a write/edit target that resolves onto a protected path never
	// reaches any allow path — stored grants included — in any mode (spec
	// A.1/N6). Run before every grant lookup so write/edit requests cannot
	// bypass the protected-path, symlink and nlink checks. N3: the seat's own
	// exact manifest path stays the one writable location outside the project.
	if (request.key === "writeFiles" && request.targetPath) {
		const home = os.homedir();
		const gitDirs = await resolveGitEntryDirs(projectPath);
		const real = (await realpathThroughExisting(request.targetPath)) || request.targetPath;
		const manifestPath = seatManifestPath(policy);
		const isManifest = !!manifestPath && (request.targetPath === manifestPath || real === manifestPath);
		if (!isManifest && (await isProtectedPath(real, home, gitDirs))) {
			return promptForPermission(ctx, projectPath, request, policy);
		}
	}

	if (policy.mode === "yolo") {
		if (request.command) {
			const hardDenyReason = isYoloHardDenied(request.command, projectPath, ctx.cwd);
			if (hardDenyReason) {
				if (ctx.hasUI) ctx.ui.notify(hardDenyReason, "warning");
				return { allowed: false };
			}
		}
		return { allowed: true };
	}

	const promptShieldStrict = await isPromptShieldStrict();
	const sensitiveUnderShield = promptShieldStrict && isSensitiveWhenPromptShieldRiskActive(request.key);
	// B3: while seatAuto is active, stored writeFiles grants (session and
	// project) never decide — seatAuto's own checks must run instead.
	const seatAutoActive = !userBash && isSeatAutoActive(policy);
	const ignoreWriteGrants = seatAutoActive && request.key === "writeFiles";

	if (!sensitiveUnderShield && !ignoreWriteGrants) {
		const sessionDecision = SESSION_PERMISSIONS.get(projectPath)?.[request.key];
		if (sessionDecision) return { allowed: sessionDecision === "allow" };
	}

	if (!sensitiveUnderShield) {
		if (!ignoreWriteGrants) {
			const projectDecision = policy.permissions[request.key];
			if (projectDecision) return { allowed: projectDecision === "allow" };
		}

		if (policy.mode === "readOnlyAuto" && isReadOnlyAutoAllowed(request, projectPath, ctx.cwd)) {
			return { allowed: true };
		}

		if (seatAutoActive) {
			// projectPath is the realpath of ctx.cwd, so it is also the correct
			// base for resolving seat request paths (macOS /tmp → /private/tmp).
			const seatWritePath = await seatAutoWriteAllowPath(request, projectPath, projectPath, policy);
			if (seatWritePath) return { allowed: true, seatAutoWrite: { path: seatWritePath } };
			if (request.command && SEAT_BASH_KEYS.includes(request.key) && (await isSeatAutoBashAllowed(request.command, projectPath, projectPath, policy))) {
				return { allowed: true };
			}
		}

		if (policy.mode === "llmAuto" && request.command) {
			const safe = await evaluateCommandWithLlm(ctx, request.command, projectPath);
			if (safe === true) return { allowed: true };
		}
	}

	return promptForPermission(ctx, projectPath, request, policy, sensitiveUnderShield);
}

async function promptForPermission(
	ctx: ExtensionContext,
	projectPath: string,
	request: PermissionRequest,
	policy: PolicyFile,
	shieldBypassed = false,
): Promise<PermissionDecision> {
	if (!ctx.hasUI) {
		return { allowed: false };
	}

	// Report the open modal to herdr and ALWAYS clear it, even if the dialog
	// throws or is cancelled.
	emitPermissionDialogBlocked(true, `Permission required: ${request.title}`);
	let choice: string | undefined;
	try {
		choice = await ctx.ui.select(
			[
				`Permission required: ${request.title}`,
				"",
				`Project: ${projectPath}`,
				request.detail,
				...(shieldBypassed ? ["", "Prompt Shield has active unapproved risk, so automatic/project grants are bypassed for this sensitive action."] : []),
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
	} finally {
		emitPermissionDialogBlocked(false);
	}

	if (choice === "Allow once") return { allowed: true };
	if (choice === "Deny once" || !choice) return { allowed: false };

	if (choice === "Allow for current session" || choice === "Deny for current session") {
		setSessionDecision(projectPath, request.key, choice.startsWith("Allow") ? "allow" : "deny");
		return { allowed: choice.startsWith("Allow") };
	}

	if (choice === "Allow permanently for this project" || choice === "Deny permanently for this project") {
		const decision: Decision = choice.startsWith("Allow") ? "allow" : "deny";
		policy.permissions[request.key] = decision;
		policy.updatedAt = new Date().toISOString();
		await savePolicy(projectPath, policy);
		return { allowed: decision === "allow" };
	}

	return { allowed: false };
}

function setSessionDecision(projectPath: string, key: PermissionKey, decision: Decision) {
	const current = SESSION_PERMISSIONS.get(projectPath) || {};
	current[key] = decision;
	SESSION_PERMISSIONS.set(projectPath, current);
}

function isSensitiveWhenPromptShieldRiskActive(key: PermissionKey): boolean {
	return key === "bashCommands" || key === "destructiveBash" || key === "git" || key === "web" || key === "writeFiles" || key === "readOutsideProject" || key === "mcp";
}

async function isPromptShieldStrict(): Promise<boolean> {
	try {
		const state = JSON.parse(await fs.readFile(PROMPT_SHIELD_STATE_PATH, "utf8")) as { strictPermissions?: boolean };
		return state.strictPermissions === true;
	} catch {
		return false;
	}
}

async function updatePermissionStatus(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	const projectPath = await getProjectPath(ctx.cwd);
	const policy = await loadPolicy(projectPath);
	ctx.ui.setStatus("permission-policy", `│ permission: ${modeShortLabel(policy.mode)}`);
}

async function confirmYoloMode(ctx: ExtensionContext): Promise<boolean> {
	if (!ctx.hasUI) return false;
	emitPermissionDialogBlocked(true, "Permission required: Enable YOLO permission mode?");
	try {
		return await ctx.ui.confirm("Enable YOLO permission mode?", `${YOLO_WARNING}\n\nContinue?`);
	} finally {
		emitPermissionDialogBlocked(false);
	}
}

function modeShortLabel(mode: PermissionMode): string {
	if (mode === "readOnlyAuto") return "read-only";
	if (mode === "llmAuto") return "auto";
	if (mode === "seatAuto") return "seat-auto";
	if (mode === "yolo") return "yolo";
	return "ask";
}

function nextMode(mode: PermissionMode): PermissionMode {
	if (mode === "ask") return "readOnlyAuto";
	if (mode === "readOnlyAuto") return "llmAuto";
	if (mode === "llmAuto") return "yolo";
	return "ask";
}

export function parseMode(mode: string): PermissionMode | undefined {
	if (mode === "ask" || mode === "manual") return "ask";
	if (mode === "read-only" || mode === "readonly" || mode === "readOnlyAuto".toLowerCase()) return "readOnlyAuto";
	if (mode === "auto" || mode === "llm" || mode === "llm-auto" || mode === "automatic") return "llmAuto";
	if (mode === "seat-auto" || mode === "seatauto") return "seatAuto";
	if (mode === "yolo" || mode === "unsafe" || mode === "dangerous") return "yolo";
	return undefined;
}

async function loadPolicy(projectPath: string): Promise<PolicyFile> {
	try {
		const text = await fs.readFile(policyPath(projectPath), "utf8");
		const parsed = JSON.parse(text) as PolicyFile;
		// Spec A.5: fields pi does not know about (the seat block, hd
		// bookkeeping) must survive every load/save round trip verbatim, so the
		// parsed object is spread and only managed fields are normalised.
		return {
			...parsed,
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
	const { schemaVersion, ...rest } = policy;
	const output = { schemaVersion: schemaVersion ?? 2, ...rest };
	await fs.writeFile(policyPath(projectPath), `${JSON.stringify(output, null, "\t")}\n`, "utf8");
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

export function isOutsideProject(requestedPath: string, projectPath: string, cwd: string): boolean {
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
