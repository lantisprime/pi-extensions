#!/usr/bin/env -S node --require jiti/register
// Usage: node --require jiti/register permission-policy/test-fixtures/test-classification.ts
// or run via the shell wrapper
//
// These scenarios import the classification helpers from the REAL extension
// module (permission-policy/index.ts) so the tests cannot drift from the
// implementation (spec A.2/B6). Like test-seat-auto.ts, it points HOME at a
// throwaway directory and stubs @earendil-works/pi-ai before the dynamic
// import, removing the stub afterwards (only when this run created it).

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");

// Filled in by main() after the dynamic import below.
type IndexModule = Record<string, any>;
let index: IndexModule;

function looksLikeGitCommand(command: string): boolean {
	return index.looksLikeGitCommand(command) as boolean;
}

function looksDestructive(command: string): boolean {
	return index.looksDestructive(command) as boolean;
}

function isReadOnlyShellCommand(command: string): boolean {
	return index.isReadOnlyShellCommand(command) as boolean;
}

function isReadOnlyGitCommand(command: string): boolean {
	return index.isReadOnlyGitCommand(command) as boolean;
}

function isOutsideProject(requestedPath: string, projectPath: string, cwd: string): boolean {
	return index.isOutsideProject(requestedPath, projectPath, cwd) as boolean;
}

function commandMentionsOutsideProject(command: string, projectPath: string, cwd: string): boolean {
	return index.commandMentionsOutsideProject(command, projectPath, cwd) as boolean;
}

function classifyBashCommand(command: string): string[] {
	return (index.classifyBashCommand(command) as { key: string }[]).map((request) => request.key);
}

async function classifyToolCall(toolName: string, input: Record<string, unknown>, projectPath: string, cwd: string): Promise<string[]> {
	return ((await index.classifyToolCall(toolName, input, projectPath, cwd)) as { key: string }[]).map((request) => request.key);
}

// The extension's readOnlyAuto gate takes a full PermissionRequest and routes
// by request key; mirror classifyBashCommand's key assignment for bash text.
function isReadOnlyAutoAllowedForBash(command: string, projectPath: string, cwd: string): boolean {
	const key = index.looksLikeGitCommand(command) && !index.looksDestructive(command) ? "git" : "bashCommands";
	return index.isReadOnlyAutoAllowed({ key, title: "", detail: "", command }, projectPath, cwd) as boolean;
}

function isYoloHardDeniedBool(command: string, projectPath: string, cwd: string): boolean {
	return !!index.isYoloHardDenied(command, projectPath, cwd);
}

function parseMode(mode: string): string | undefined {
	return index.parseMode(mode);
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

async function main() {
	// Redirect HOME BEFORE importing index.ts: its module-level POLICY_DIR and
	// PROMPT_SHIELD_STATE_PATH constants are computed from os.homedir() at load.
	process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "classif-home-"));

	// Minimal stub for index.ts's runtime import of @earendil-works/pi-ai.
	// A6: removed again in the finally below, but only when this run created
	// it, so a pre-existing install is never clobbered. A3/R2: if a stub (or a
	// real install) is already present, fail instead of overwriting it.
	const stubDir = path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai");
	if (existsSync(stubDir)) {
		console.error(
			`refusing to run: ${stubDir} already exists — remove the @earendil-works/pi-ai stub from node_modules first (A3: the suites never overwrite an existing install)`,
		);
		process.exit(1);
	}
	const createdStub = !existsSync(stubDir);
	try {
		mkdirSync(stubDir, { recursive: true });
		writeFileSync(
			path.join(stubDir, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.0.0-test-stub", type: "module", main: "index.js" }, null, "\t"),
		);
		writeFileSync(
			path.join(stubDir, "index.js"),
			"export function complete() { throw new Error('stubbed: complete() is not used by these tests'); }\n",
		);
		index = (await import("../index.ts")) as IndexModule;
		await runScenarios();
	} finally {
		if (createdStub) rmSync(stubDir, { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failed} failed out of ${scenario} scenarios`);
	if (failed > 0) process.exit(1);
}

async function runScenarios(): Promise<void> {
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
check("2>&1 is not an overwrite redirect (A.4)", looksDestructive("npm test 2>&1"), false);
check(">&2 is not an overwrite redirect (A.4)", looksDestructive("npm test >&2"), false);
check(">/dev/null is not an overwrite redirect (A.4)", looksDestructive("npm test > /dev/null"), false);
check("2>/dev/null is not an overwrite redirect (A.4)", looksDestructive("npm test 2> /dev/null"), false);
check("&>file is an overwrite redirect", looksDestructive("npm test &> out.txt"), true);
check(">| is an overwrite redirect", looksDestructive("echo x >| out.txt"), true);
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
check("command -v <word> is the only command shape that is read-only (B1)", isReadOnlyShellCommand("command -v node"), true);
check("command node -e is not read-only (B1)", isReadOnlyShellCommand("command node -e x"), false);
check("command bash -c is not read-only (B1)", isReadOnlyShellCommand("command bash -c x"), false);
check("command -v with two words is not read-only (B1)", isReadOnlyShellCommand("command -v node -e x"), false);
check("find is read-only (strict shape)", isReadOnlyShellCommand("find . -name '*.ts'"), true);
check("find -delete is not read-only (N1)", isReadOnlyShellCommand("find . -name '*.ts' -delete"), false);
check("find -exec is not read-only (N1)", isReadOnlyShellCommand("find . -exec rm {} +"), false);
check("find -fprint is not read-only (N1)", isReadOnlyShellCommand("find . -fprint out.txt"), false);
check("wc is read-only", isReadOnlyShellCommand("wc -l file"), true);
check("head is read-only", isReadOnlyShellCommand("head -20 file"), true);
check("tail is read-only", isReadOnlyShellCommand("tail -f file"), true);
check("sort is read-only", isReadOnlyShellCommand("sort file"), true);
// B1/R2: strict shapes for members with write/exec argument forms.
check("sort -o writes OUT, not read-only (B1/R2)", isReadOnlyShellCommand("sort -o out.txt in.txt"), false);
check("sort --output= is not read-only (B1/R2)", isReadOnlyShellCommand("sort --output=x in.txt"), false);
check("sort --output==x is not read-only (B1/R2)", isReadOnlyShellCommand("sort --output==x in.txt"), false);
check("sort short cluster containing o (-no) is not read-only (B1/R2)", isReadOnlyShellCommand("sort -no in.txt"), false);
check("sort --compress-program executes, not read-only (B1/R2)", isReadOnlyShellCommand("sort --compress-program=gzip in.txt"), false);
check("sort with benign flags stays read-only (B1/R2)", isReadOnlyShellCommand("sort -rn -k2 in.txt"), true);
check("uniq IN OUT writes OUT, not read-only (B1/R2)", isReadOnlyShellCommand("uniq in.txt out.txt"), false);
check("uniq with a single input stays read-only (B1/R2)", isReadOnlyShellCommand("uniq -c in.txt"), true);
check("wc --files0-from is not read-only (B1/R2)", isReadOnlyShellCommand("wc --files0-from=list.txt"), false);
check("du --files0-from is not read-only (B1/R2)", isReadOnlyShellCommand("du --files0-from=list.txt"), false);
check("file -C compiles a magic file, not read-only (B1/R2)", isReadOnlyShellCommand("file -C"), false);
check("rg --pre executes CMD, not read-only (B1/R2)", isReadOnlyShellCommand("rg --pre=./evil.sh pat f"), false);
check("rg search stays read-only (B1/R2)", isReadOnlyShellCommand("rg pattern src"), true);
check("awk is not read-only (N1)", isReadOnlyShellCommand("awk '{print $1}' file"), false);
check("xargs is not read-only (N1)", isReadOnlyShellCommand("ls | xargs cat"), false);
check("sed -n with a print script is read-only (N1)", isReadOnlyShellCommand("sed -n '10,20p' file"), true);
check("sed -n with an address print is read-only (N1)", isReadOnlyShellCommand("sed -n '/error/p' log"), true);
check("sed without -n is not read-only (N1)", isReadOnlyShellCommand("sed 's/a/b/' file"), false);
check("sed -n with a w command is not read-only (N1)", isReadOnlyShellCommand("sed -n 's/a/b/w out.txt' file"), false);
check("sed -i is not read-only (N1)", isReadOnlyShellCommand("sed -i 's/a/b/' file"), false);
check("echo is read-only", isReadOnlyShellCommand("echo hello"), true);
check("which is read-only", isReadOnlyShellCommand("which node"), true);
check("touch is not read-only", isReadOnlyShellCommand("touch file"), false);
check("mkdir is not read-only", isReadOnlyShellCommand("mkdir dir"), false);
check("npm install is not read-only", isReadOnlyShellCommand("npm install"), false);
check("rm in chain makes not read-only", isReadOnlyShellCommand("ls && rm -f x"), false);
check("chained read-only is read-only", isReadOnlyShellCommand("ls && cat file"), true);
check("pipe with read-only is read-only", isReadOnlyShellCommand("cat file | grep pattern"), true);
check("newline smuggles a second command (N4)", isReadOnlyShellCommand("ls\ntouch file"), false);
check("newline-joined read-only stays read-only (N4)", isReadOnlyShellCommand("ls\nwc -l file"), true);

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
// R3: readOnlyAuto checks only text bash will run as written
check("backslash path blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("cat \\/etc/passwd", projectPath, cwd), false);
check("unquoted $ blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("cat $TMPDIR/x", projectPath, cwd), false);
check("glued quotes blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash('cat "a"b', projectPath, cwd), false);
check("glob blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("cat .*/../*", projectPath, cwd), false);
check("brace blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("cat {..,src}/x", projectPath, cwd), false);
check("quoted glob allowed in readOnlyAuto", isReadOnlyAutoAllowedForBash("find . -name '*.ts'", projectPath, cwd), true);
check("single-quoted backslash allowed in readOnlyAuto", isReadOnlyAutoAllowedForBash("grep 'x\\.y' f.txt", projectPath, cwd), true);
check("chmod blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("chmod 777 x", projectPath, cwd), false);
check("git status allowed in readOnlyAuto", isReadOnlyAutoAllowedForBash("git status", projectPath, cwd), true);
check("git push blocked in readOnlyAuto", isReadOnlyAutoAllowedForBash("git push", projectPath, cwd), false);
check("overwrite redirect blocked", isReadOnlyAutoAllowedForBash("echo x > y", projectPath, cwd), false);
check("/dev/null is not an overwrite redirect (A.4)", looksDestructive("echo x > /dev/null"), false);
check("echo with /dev/null redirect still blocked by the outside-mention gate in readOnlyAuto", isReadOnlyAutoAllowedForBash("echo x > /dev/null", projectPath, cwd), false);
check("awk blocked in readOnlyAuto (N1)", isReadOnlyAutoAllowedForBash("awk '{print $1}' f", projectPath, cwd), false);
check("sed -n print allowed in readOnlyAuto (N1)", isReadOnlyAutoAllowedForBash("sed -n '1p' f", projectPath, cwd), true);
check("sed without -n blocked in readOnlyAuto (N1)", isReadOnlyAutoAllowedForBash("sed 's/a/b/' f", projectPath, cwd), false);

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
// Option values are paths too (A3/B2/B8): --opt=value and glued -Xvalue.
check("--import=/abs mentions outside (A3)", commandMentionsOutsideProject("node --test --import=/abs/x.js", projectPath, cwd), true);
check("--prefix=../.. mentions outside (A3)", commandMentionsOutsideProject("npm test --prefix=../..", projectPath, cwd), true);
check("glued -X/abs mentions outside (A3)", commandMentionsOutsideProject("tool -L/abs/x", projectPath, cwd), true);
check("--flag=value inside project does not mention outside", commandMentionsOutsideProject("node --test --import=./setup.js", projectPath, cwd), false);
// B2: relative tokens that escape lexically must resolve to outside. Real
// callers pass cwd ≡ the project root (commandMentionsOutsideProject is fed
// projectPath/ctx.cwd), so the brief-literal rows run from the project root.
check("cat x/../../.zsh_history mentions outside (B2)", commandMentionsOutsideProject("cat x/../../.zsh_history", projectPath, projectPath), true);
check("cat ./../.netrc mentions outside (B2)", commandMentionsOutsideProject("cat ./../.netrc", projectPath, projectPath), true);
check("git diff --no-index with ../ escape mentions outside (B2)", commandMentionsOutsideProject("git diff --no-index x/../../etc/passwd /dev/null", projectPath, projectPath), true);
check("../ escape resolves against a subdirectory cwd too (B2)", commandMentionsOutsideProject("cat x/../../../.zsh_history", projectPath, cwd), true);
check("alias-spelled cwd does not make in-project tokens look outside (B2)", commandMentionsOutsideProject("ls -la", "/p", "/link/p"), false);
check("plain in-project relative path does not mention outside (B2)", commandMentionsOutsideProject("cat src/a.ts", projectPath, cwd), false);
check("./-prefixed in-project relative path does not mention outside (B2)", commandMentionsOutsideProject("cat ./src/a.ts", projectPath, cwd), false);

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
check("write tool -> writeFiles", await classifyToolCall("write", { path: "x", content: "y" }, projectPath, cwd), ["writeFiles"]);
check("edit tool -> writeFiles", await classifyToolCall("edit", { path: "x" }, projectPath, cwd), ["writeFiles"]);
check("inside read -> none", await classifyToolCall("read", { path: "file.ts" }, projectPath, cwd), []);
check("outside read -> readOutsideProject", await classifyToolCall("read", { path: "/etc/passwd" }, projectPath, cwd), ["readOutsideProject"]);
check("web tool -> web", await classifyToolCall("web_search", {}, projectPath, cwd), ["web"]);
check("secure_web_search -> web", await classifyToolCall("secure_web_search", {}, projectPath, cwd), ["web"]);
check("search_web -> web", await classifyToolCall("search_web", {}, projectPath, cwd), ["web"]);
check("browser -> web", await classifyToolCall("browser", {}, projectPath, cwd), ["web"]);
check("bash -> classifyBashCommand", await classifyToolCall("bash", { command: "ls" }, projectPath, cwd), ["bashCommands"]);
check("unknown tool -> none", await classifyToolCall("grep", {}, projectPath, cwd), []);

// MCP bridge tools: own category, never misclassified as web by name.
check("mcp knowledge_search -> mcp only", await classifyToolCall("mcp_knowledge_knowledge_search", {}, projectPath, cwd), ["mcp"]);
check("mcp task_list -> mcp only", await classifyToolCall("mcp_taskboard_task_list", {}, projectPath, cwd), ["mcp"]);
check("mcp message_list -> mcp only", await classifyToolCall("mcp_taskboard_message_list", {}, projectPath, cwd), ["mcp"]);
check("mcp searxng search -> mcp only (web gate not applied by name)", await classifyToolCall("mcp_searxng_web_search", {}, projectPath, cwd), ["mcp"]);
check("mcp episodic_search -> mcp only", await classifyToolCall("mcp_knowledge_episodic_search", {}, projectPath, cwd), ["mcp"]);

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
check("parseMode seat-auto", parseMode("seat-auto"), "seatAuto");
check("parseMode seatauto", parseMode("seatauto"), "seatAuto");
check("parseMode invalid", parseMode("garbage"), undefined);
check("parseMode empty", parseMode(""), undefined);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
