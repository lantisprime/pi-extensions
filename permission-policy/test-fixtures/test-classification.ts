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

console.log(`\n${passed} passed, ${failed} failed out of ${scenario} scenarios`);
if (failed > 0) process.exit(1);
