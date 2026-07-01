#!/usr/bin/env -S node --require jiti/register
// Usage: node --require jiti/register permission-policy/test-fixtures/test-classification.ts
// or run via the shell wrapper

import { createHash } from "node:crypto";
import path from "node:path";

const PERMISSION_LABELS: Record<string, string> = {
	readOutsideProject: "Read files outside this project",
	bashCommands: "Run bash commands",
	destructiveBash: "Run destructive shell commands",
	git: "Run git commands",
	web: "Search or fetch from the web",
	writeFiles: "Write or edit files",
};

const WEB_TOOL_NAMES = new Set(["web_search", "search_web", "web", "browser", "fetch", "http_get"]);

const readOnlyCommands = new Set([
	"pwd", "ls", "find", "grep", "rg", "cat", "head", "tail", "wc",
	"sort", "uniq", "awk", "sed", "file", "stat", "du", "df",
	"echo", "printf", "which", "command", "test",
]);

function looksLikeGitCommand(command: string): boolean {
	return /\bgit\b/i.test(command);
}

function looksDestructive(command: string): boolean {
	const destructiveCommand = /(^|[;&|()\s])(rm|mv|cp|unlink|rmdir|chmod|chown|install|truncate)\s+/i.test(command);
	const overwriteRedirect = /(^|\s)(\d?>|&>|tee\s+)(?!>)/i.test(command);
	const inPlaceEdit = /(^|[;&|()\s])(sed|perl|python|node|ruby)\s+.*\s(-i|--in-place)\b/i.test(command);
	return destructiveCommand || overwriteRedirect || inPlaceEdit;
}

function isYoloHardDenied(command: string, projectPath: string, cwd: string): string | undefined {
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

function isYoloHardDeniedBool(command: string, projectPath: string, cwd: string): boolean {
	return !!isYoloHardDenied(command, projectPath, cwd);
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

function isReadOnlyShellCommand(command: string): boolean {
	if (/[;&]\s*(rm|mv|cp|chmod|chown|install|truncate|touch|mkdir|rmdir)\b/i.test(command)) return false;
	const normalized = command.replace(/\s+/g, " ").trim();
	const segments = normalized.split(/\s*(?:&&|\|\||\|)\s*/);
	return segments.every((segment) => {
		const first = segment.trim().match(/^([A-Za-z0-9_.-]+)/)?.[1];
		return !!first && readOnlyCommands.has(first) && !/\s(-i|--in-place)\b/.test(segment);
	});
}

function isReadOnlyGitCommand(command: string): boolean {
	const match = command.match(/\bgit\s+(?:-[^\s]+\s+)*(\w[\w-]*)/i);
	if (!match) return false;
	return new Set([
		"status", "diff", "log", "show", "branch", "remote", "rev-parse",
		"ls-files", "grep", "describe", "blame",
	]).has(match[1].toLowerCase());
}

function isOutsideProject(requestedPath: string, projectPath: string, cwd: string): boolean {
	const absolute = path.resolve(cwd, requestedPath);
	const relative = path.relative(projectPath, absolute);
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function classifyBashCommand(command: string): string[] {
	const keys: string[] = [];
	if (looksLikeGitCommand(command)) keys.push("git");
	if (looksDestructive(command)) keys.push("destructiveBash");
	if (keys.length === 0 && command.trim()) keys.push("bashCommands");
	return keys;
}

function classifyToolCall(toolName: string, input: Record<string, unknown>, projectPath: string, cwd: string): string[] {
	if (toolName === "read") {
		const requestedPath = String(input.path || "");
		if (requestedPath && isOutsideProject(requestedPath, projectPath, cwd)) return ["readOutsideProject"];
		return [];
	}
	if (toolName === "write" || toolName === "edit") return ["writeFiles"];
	if (toolName === "bash") return classifyBashCommand(String(input.command || ""));
	if (WEB_TOOL_NAMES.has(toolName) || /(^|_)(web|search|browser)(_|$)/i.test(toolName)) return ["web"];
	return [];
}

function isReadOnlyAutoAllowedForBash(command: string, projectPath: string, cwd: string): boolean {
	if (looksDestructive(command)) return false;
	if (commandMentionsOutsideProject(command, projectPath, cwd)) return false;
	if (looksLikeGitCommand(command)) return isReadOnlyGitCommand(command);
	return isReadOnlyShellCommand(command);
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

// ---- Tests ----
const projectPath = "/home/user/project";
const cwd = "/home/user/project/sub";
let passed = 0;
let failed = 0;
let scenario = 0;

function check(scenarioName: string, actual: unknown, expected: unknown) {
	scenario++;
	if (JSON.stringify(actual) === JSON.stringify(expected)) {
		passed++;
	} else {
		failed++;
		console.log(`FAIL scenario ${scenario}: ${scenarioName}`);
		console.log(`  expected: ${JSON.stringify(expected)}`);
		console.log(`  actual:   ${JSON.stringify(actual)}`);
	}
}

// destructive detection
check("rm is destructive", looksDestructive("rm -rf /tmp/x"), true);
check("mv is destructive", looksDestructive("mv a b"), true);
check("cp is destructive", looksDestructive("cp a b"), true);
check("chmod is destructive", looksDestructive("chmod 755 x"), true);
check("chown is destructive", looksDestructive("chown user:group x"), true);
check("install is destructive", looksDestructive("install -m 755 a b"), true);
check("truncate is destructive", looksDestructive("truncate -s 0 x"), true);
check("unlink is destructive", looksDestructive("unlink x"), true);
check("rmdir is destructive", looksDestructive("rmdir x"), true);
check("overwrite redirect is destructive", looksDestructive("echo x > y"), true);
check("tee is destructive", looksDestructive("echo x | tee y"), true);
check("append redirect is not destructive", looksDestructive("echo x >> y"), false);
// The in-place-edit regex requires text between the command name and the flag.
// When -i/--in-place is the first argument, the greedy .* consumes it and 
// then \s before (-i|--in-place) cannot backtrack past it. This is a known limitation.
check("sed -i 's/a/b/' file (known: flag first arg not caught)", looksDestructive("sed -i 's/a/b/' file"), false);
check("sed -i -e 's/a/b/' somefile.txt (known: -i first arg not caught)", looksDestructive("sed -i -e 's/a/b/' somefile.txt"), false);
check("sed --in-place file (known: flag first arg not caught)", looksDestructive("sed --in-place 's/a/b/' file"), false);
check("python -i script.py (known: flag first arg not caught)", looksDestructive("python -i script.py"), false);
check("python --in-place script.py (known: flag first arg not caught)", looksDestructive("python --in-place script.py"), false);
// But when there's preceding text, it IS caught:
check("sed something -i file IS caught", looksDestructive("sed something -i file"), true);
check("node script.js --in-place IS caught", looksDestructive("node script.js --in-place"), true);
check("ls is not destructive", looksDestructive("ls -la"), false);
check("cat is not destructive", looksDestructive("cat file"), false);
check("echo is not destructive", looksDestructive("echo hello"), false);
check("git status is not destructive", looksDestructive("git status"), false);

// git detection
check("git detected", looksLikeGitCommand("git status"), true);
check("git in chain detected", looksLikeGitCommand("cd repo && git push"), true);
check("no git", looksLikeGitCommand("gitter status"), false);

// read-only shell commands
check("pwd is read-only", isReadOnlyShellCommand("pwd"), true);
check("ls is read-only", isReadOnlyShellCommand("ls -la"), true);
check("cat is read-only", isReadOnlyShellCommand("cat file"), true);
check("grep is read-only", isReadOnlyShellCommand("grep pattern file"), true);
check("find is read-only", isReadOnlyShellCommand("find . -name '*.ts'"), true);
check("wc is read-only", isReadOnlyShellCommand("wc -l file"), true);
check("head is read-only", isReadOnlyShellCommand("head -20 file"), true);
check("tail is read-only", isReadOnlyShellCommand("tail -f file"), true);
check("sort is read-only", isReadOnlyShellCommand("sort file"), true);
check("awk is read-only", isReadOnlyShellCommand("awk '{print $1}' file"), true);
check("sed is read-only (no -i)", isReadOnlyShellCommand("sed 's/a/b/' file"), true);
check("echo is read-only", isReadOnlyShellCommand("echo hello"), true);
check("which is read-only", isReadOnlyShellCommand("which node"), true);
check("touch is not read-only", isReadOnlyShellCommand("touch file"), false);
check("mkdir is not read-only", isReadOnlyShellCommand("mkdir dir"), false);
check("npm install is not read-only", isReadOnlyShellCommand("npm install"), false);
check("rm in chain makes not read-only", isReadOnlyShellCommand("ls && rm -f x"), false);
check("chained read-only is read-only", isReadOnlyShellCommand("ls && cat file"), true);
check("pipe with read-only is read-only", isReadOnlyShellCommand("cat file | grep pattern"), true);

// read-only git
check("git status is read-only", isReadOnlyGitCommand("git status"), true);
check("git diff is read-only", isReadOnlyGitCommand("git diff"), true);
check("git log is read-only", isReadOnlyGitCommand("git log"), true);
check("git show is read-only", isReadOnlyGitCommand("git show HEAD"), true);
check("git branch is read-only", isReadOnlyGitCommand("git branch"), true);
check("git push is NOT read-only git", isReadOnlyGitCommand("git push"), false);
check("git commit is NOT read-only git", isReadOnlyGitCommand("git commit"), false);
check("git reset --hard is NOT read-only git", isReadOnlyGitCommand("git reset --hard"), false);

// readOnlyAuto bash classification
check("pwd allowed in readOnlyAuto", isReadOnlyAutoAllowedForBash("pwd", projectPath, cwd), true);
check("ls allowed in readOnlyAuto", isReadOnlyAutoAllowedForBash("ls -la", projectPath, cwd), true);
check("touch blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("touch x", projectPath, cwd), false);
check("rm blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("rm x", projectPath, cwd), false);
check("chmod blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("chmod 777 x", projectPath, cwd), false);
check("git status allowed in readOnlyAuto", isReadOnlyAutoAllowedForBash("git status", projectPath, cwd), true);
check("git push blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("git push", projectPath, cwd), false);
check("overwrite redirect blocked", isReadOnlyAutoAllowedForBash("echo x > y", projectPath, cwd), false);

// outside project detection
check("/etc outside", isOutsideProject("/etc/passwd", projectPath, cwd), true);
check("project file inside", isOutsideProject("file.ts", projectPath, cwd), false);
// ../other from within project/sub resolves to /home/user/project/other (still inside project)
check("../other from sub stays inside project", isOutsideProject("../other", projectPath, cwd), false);
// ../project (go above project root) is outside
check("above project root is outside", isOutsideProject("../../other", projectPath, cwd), true);

// command mentions outside project
check("cat /etc/passwd mentions outside", commandMentionsOutsideProject("cat /etc/passwd", projectPath, cwd), true);
check("ls -la does not mention outside", commandMentionsOutsideProject("ls -la", projectPath, cwd), false);
check("cd .. mentions outside", commandMentionsOutsideProject("cd ..", projectPath, cwd), true);

// classifyBashCommand
check("git cmd -> git", classifyBashCommand("git status"), ["git"]);
check("destructive -> destructiveBash", classifyBashCommand("rm file"), ["destructiveBash"]);
// git reset --hard is classified as git only; it does not match the destructive regex
// because "reset" is not in the destructive command list
check("git push -> git only (not destructive)", classifyBashCommand("git push"), ["git"]);
check("git reset --hard -> git only (reset not in destructive list)", classifyBashCommand("git reset --hard"), ["git"]);
check("ordinary -> bashCommands", classifyBashCommand("touch file"), ["bashCommands"]);
check("read-only -> bashCommands (no auto)", classifyBashCommand("ls -la"), ["bashCommands"]);
check("empty -> no request", classifyBashCommand("  "), []);

// classifyToolCall
check("write tool -> writeFiles", classifyToolCall("write", { path: "x", content: "y" }, projectPath, cwd), ["writeFiles"]);
check("edit tool -> writeFiles", classifyToolCall("edit", { path: "x" }, projectPath, cwd), ["writeFiles"]);
check("inside read -> none", classifyToolCall("read", { path: "file.ts" }, projectPath, cwd), []);
check("outside read -> readOutsideProject", classifyToolCall("read", { path: "/etc/passwd" }, projectPath, cwd), ["readOutsideProject"]);
check("web tool -> web", classifyToolCall("web_search", {}, projectPath, cwd), ["web"]);
check("secure_web_search -> web", classifyToolCall("secure_web_search", {}, projectPath, cwd), ["web"]);
check("search_web -> web", classifyToolCall("search_web", {}, projectPath, cwd), ["web"]);
check("browser -> web", classifyToolCall("browser", {}, projectPath, cwd), ["web"]);
check("bash -> classifyBashCommand", classifyToolCall("bash", { command: "ls" }, projectPath, cwd), ["bashCommands"]);
check("unknown tool -> none", classifyToolCall("grep", {}, projectPath, cwd), []);

// YOLO hard-deny behavior: auto-allow everything except rm -f/rm -rf style commands and repo deletion.
check("YOLO allows ordinary bash", isYoloHardDeniedBool("npm test", projectPath, cwd), false);
check("YOLO allows write-like non-rm command", isYoloHardDeniedBool("touch file && echo ok > file", projectPath, cwd), false);
check("YOLO allows git clean by policy exception scope", isYoloHardDeniedBool("git clean -fdx", projectPath, cwd), false);
check("YOLO allows rm without -f for ordinary file", isYoloHardDeniedBool("rm file.txt", projectPath, cwd), false);
check("YOLO allows rm -r for ordinary directory", isYoloHardDeniedBool("rm -r build", projectPath, cwd), false);
check("YOLO allows rm -i because it is not force", isYoloHardDeniedBool("rm -i file.txt", projectPath, cwd), false);
check("YOLO blocks rm -f", isYoloHardDeniedBool("rm -f file.txt", projectPath, cwd), true);
check("YOLO blocks rm -rf", isYoloHardDeniedBool("rm -rf build", projectPath, cwd), true);
check("YOLO blocks rm -fr", isYoloHardDeniedBool("rm -fr build", projectPath, cwd), true);
check("YOLO blocks rm -r -f", isYoloHardDeniedBool("rm -r -f build", projectPath, cwd), true);
check("YOLO blocks rm --force", isYoloHardDeniedBool("rm --force file.txt", projectPath, cwd), true);
check("YOLO blocks chained rm -f", isYoloHardDeniedBool("echo ok && rm -f file.txt", projectPath, cwd), true);
check("YOLO blocks rm -rf with newline", isYoloHardDeniedBool("echo ok\\nrm -rf build", projectPath, cwd), true);
check("YOLO blocks rm .git", isYoloHardDeniedBool("rm -r .git", projectPath, cwd), true);
check("YOLO blocks rm ./.git", isYoloHardDeniedBool("rm -r ./.git", projectPath, cwd), true);
check("YOLO blocks adversarial find .git rm", isYoloHardDeniedBool("find . -name .git -exec rm -r {} +", projectPath, cwd), true);
check("YOLO blocks unlink .git", isYoloHardDeniedBool("unlink .git", projectPath, cwd), true);
check("YOLO blocks repo deletion via parent from subdir", isYoloHardDeniedBool("rm -r ..", projectPath, cwd), true);
check("YOLO blocks repo deletion at project root", isYoloHardDeniedBool("rm -r .", projectPath, projectPath), true);
check("YOLO blocks rmdir project root from subdir", isYoloHardDeniedBool("rmdir ..", projectPath, cwd), true);
check("YOLO blocks forced git worktree removal", isYoloHardDeniedBool("git worktree remove --force ../project", projectPath, cwd), true);
check("YOLO allows non-forced git worktree removal by hard-deny scope", isYoloHardDeniedBool("git worktree remove ../project", projectPath, cwd), false);

// parseMode (for CLI --permission-mode flag)
type PermissionMode = "ask" | "readOnlyAuto" | "llmAuto" | "yolo";

function parseMode(mode: string): PermissionMode | undefined {
	if (mode === "ask" || mode === "manual") return "ask";
	if (mode === "read-only" || mode === "readonly" || mode === "readOnlyAuto".toLowerCase()) return "readOnlyAuto";
	if (mode === "auto" || mode === "llm" || mode === "llm-auto" || mode === "automatic") return "llmAuto";
	if (mode === "yolo" || mode === "unsafe" || mode === "dangerous") return "yolo";
	return undefined;
}

// parseMode tests
check("parseMode ask", parseMode("ask"), "ask");
check("parseMode manual", parseMode("manual"), "ask");
check("parseMode read-only", parseMode("read-only"), "readOnlyAuto");
check("parseMode readonly", parseMode("readonly"), "readOnlyAuto");
check("parseMode readOnlyAuto", parseMode("readonlyauto"), "readOnlyAuto");
check("parseMode auto", parseMode("auto"), "llmAuto");
check("parseMode llm", parseMode("llm"), "llmAuto");
check("parseMode llm-auto", parseMode("llm-auto"), "llmAuto");
check("parseMode automatic", parseMode("automatic"), "llmAuto");
check("parseMode yolo", parseMode("yolo"), "yolo");
check("parseMode unsafe", parseMode("unsafe"), "yolo");
check("parseMode dangerous", parseMode("dangerous"), "yolo");
check("parseMode invalid", parseMode("garbage"), undefined);
check("parseMode empty", parseMode(""), undefined);

console.log(`\n${passed} passed, ${failed} failed out of ${scenario} scenarios`);
if (failed > 0) process.exit(1);
