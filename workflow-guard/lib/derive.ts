// Repo workflow discovery, shared by the guard (runtime derivation) and
// scripts/workflow-derive.mjs (explicit contract generation).
//
// Everything here is deterministic and filesystem-read-only: no LLM, no
// network, and no writes into the scanned repository.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PackageSpec = { glob: string; test: string; dir?: string };
export type CiStep = { name: string; command: string; source: string; workdir?: string | null };
export type DerivedContract = {
	version: 1;
	sources: string[];
	packages: Array<{ glob: string; test: string }>;
	docsOnly: string[];
	protectedPaths: string[];
	gates: {
		"protect-instructions": { enabled: boolean };
		"test-before-commit": { enabled: boolean };
		"plan-before-pr": { enabled: boolean };
	};
};

export const DEFAULT_DOCS_ONLY = ["**/*.md", "docs/**", ".plans/**"];
export const DEFAULT_PROTECTED = ["AGENTS.md", "MEMORY.md", ".pi/runbooks/**", ".pi/workflow.json"];

export function redactCommand(command: string): string {
	let out = command;
	out = out.replace(
		/((?:[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)=)(?:"[^"]*"|'[^']*'|\S+)/gi,
		"$1***",
	);
	out = out.replace(
		/(--?(?:token|password|api-key|apikey|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
		"$1***",
	);
	out = out.replaceAll(os.homedir(), "~");
	return out.replace(/\s+/g, " ").trim();
}

function read(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function leading(line: string): number {
	return line.length - line.trimStart().length;
}

export function parseCi(text: string, source: string): CiStep[] {
	const lines = text.split("\n");
	const steps: CiStep[] = [];
	let currentName = "";
	let workingDirectory: string | null = null;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const named = /^\s*-\s+name:\s*(.+)$/.exec(line);
		if (named) currentName = named[1].trim();

		const workdir = /^\s*(?:-\s+)?working-directory:\s*(\S+)\s*$/.exec(line);
		if (workdir) workingDirectory = workdir[1];

		const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
		if (!run) continue;
		const indent = run[1].length;
		let command = run[2].trim();
		if (command === "|" || command === ">" || command === "|-" || command === ">-") {
			const block: string[] = [];
			let j = i + 1;
			while (j < lines.length) {
				const next = lines[j];
				if (next.trim() === "") {
					block.push("");
					j += 1;
					continue;
				}
				if (leading(next) <= indent) break;
				block.push(next.trim());
				j += 1;
			}
			command = block.filter((entry) => entry && !entry.startsWith("#")).join("\n");
			i = j - 1;
		}
		if (!command) continue;
		steps.push({ name: currentName || `step ${steps.length + 1}`, command, source: `${source}:${i + 1}`, workdir: workingDirectory });
	}
	return steps;
}

const SHELL_NOISE = /^(?:if|then|else|elif|fi|for|while|do|done|set\b|echo\b|#|cd\b|\{)|BREAK_VALIDATE/;

export function isTestCommand(command: string): boolean {
	if (!command || SHELL_NOISE.test(command.trim())) return false;
	return /\b(test|--test|run-tests\.sh|run-[a-z-]*tests\.sh|pytest|unittest)\b/.test(command);
}

function dirOf(root: string, command: string): string | null {
	for (const token of command.split(/\s+/)) {
		const match = /^([A-Za-z0-9._-]+)\//.exec(token);
		if (!match) continue;
		if (fs.existsSync(path.join(root, match[1]))) return match[1];
	}
	return null;
}

export function discoverFromCi(root: string): { steps: CiStep[]; byDir: Map<string, string[]> } {
	const dirs = path.join(root, ".github", "workflows");
	if (!fs.existsSync(dirs)) return { steps: [], byDir: new Map() };
	const steps: CiStep[] = [];
	for (const file of fs
		.readdirSync(dirs)
		.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
		.sort()) {
		const relative = path.relative(root, path.join(dirs, file));
		steps.push(...parseCi(read(path.join(dirs, file)) ?? "", relative));
	}
	const byDir = new Map<string, string[]>();
	for (const step of steps) {
		for (const line of step.command.split("\n")) {
			const redacted = redactCommand(line);
			if (!redacted || !isTestCommand(redacted)) continue;
			const dir = step.workdir ?? dirOf(root, redacted);
			if (!dir) continue;
			const list = byDir.get(dir) ?? [];
			if (!list.includes(redacted)) list.push(redacted);
			byDir.set(dir, list);
		}
	}
	return { steps, byDir };
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist", "artifacts"]);

// Nested Node packages (e.g. docs/mocks) never appear as top-level dirs.
export function discoverNestedNodePackages(root: string, maxDepth = 2): PackageSpec[] {
	const found: PackageSpec[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > maxDepth) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
			const absolute = path.join(dir, entry.name);
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			const pkgJson = read(path.join(absolute, "package.json"));
			if (pkgJson) {
				try {
					const scripts = JSON.parse(pkgJson).scripts ?? {};
					if (typeof scripts.test === "string") {
						found.push({ glob: `${relative}/**`, test: redactCommand(`npm test --prefix ${relative}`), dir: relative });
					}
				} catch {
					// ignore malformed package.json
				}
			}
			walk(absolute, depth + 1);
		}
	};
	walk(root, 0);
	return found;
}

function docPytestCommand(root: string): string | null {
	for (const name of ["AGENTS.md", "CLAUDE.md", "README.md"]) {
		const text = read(path.join(root, name));
		if (!text) continue;
		for (const line of text.split("\n")) {
			const candidate = line
				.trim()
				.replace(/^[-*]\s+/, "")
				.replace(/^`|`$/g, "");
			if (candidate.length > 400 || !/\bpytest\b/.test(candidate) || !/\btests\b/.test(candidate)) continue;
			if (!/^(?:[A-Z0-9_]+=\S+\s+)*(?:\.\/)?(?:[\w.-]+\/)*python[0-9.]*\s+-m\s+pytest\b/.test(candidate)) continue;
			return candidate;
		}
	}
	return null;
}

// Python roots: pytest is the entry point documented in AGENTS.md, with a
// deterministic fallback when the docs do not name one.
export function discoverPythonPackage(root: string): PackageSpec[] {
	const tests = path.join(root, "tests");
	if (!fs.existsSync(tests)) return [];
	let entries: string[];
	try {
		entries = fs.readdirSync(tests);
	} catch {
		return [];
	}
	if (!entries.some((name) => /^test_.*\.py$/.test(name))) return [];
	const venv = path.join(root, ".venv", "bin", "python");
	const command =
		docPytestCommand(root) ??
		(fs.existsSync(venv)
			? "PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m pytest -q -p no:cacheprovider tests"
			: "python3 -m pytest -q -p no:cacheprovider tests");
	return [{ glob: "**/*", test: redactCommand(command), dir: "." }];
}

export function discoverPackages(root: string, ciByDir = new Map<string, string[]>()): PackageSpec[] {
	const packages: PackageSpec[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const dir = entry.name;
		const absolute = path.join(root, dir);
		const candidates = ciByDir.get(dir) ?? [];
		let test: string | null = candidates.length > 0 ? candidates.join(" && ") : null;

		if (!test) {
			const pkgJson = read(path.join(absolute, "package.json"));
			if (pkgJson) {
				try {
					const scripts = JSON.parse(pkgJson).scripts ?? {};
					if (typeof scripts.test === "string") test = `npm test --prefix ${dir}`;
				} catch {
					// ignore malformed package.json
				}
			}
		}
		if (!test) {
			const fixtures = fs.existsSync(path.join(absolute, "test-fixtures"))
				? fs
						.readdirSync(path.join(absolute, "test-fixtures"))
						.filter((name) => /^run-.*\.sh$/.test(name))
						.sort()
				: [];
			const race = fixtures[0] ?? null;
			if (race) test = `bash ${dir}/test-fixtures/${race}`;
		}
		if (!test) {
			const tests = fs.existsSync(path.join(absolute, "test"))
				? fs
						.readdirSync(path.join(absolute, "test"))
						.filter((name) => /\.(test|spec)\.[cm]?[jt]s$/.test(name))
						.sort()
				: [];
			if (tests.length > 0) test = `npx --yes tsx --test ${dir}/test/`;
		}
		if (!test) continue;
		packages.push({ glob: `${dir}/**`, test: redactCommand(test), dir });
	}
	if (fs.existsSync(path.join(root, "shared"))) {
		packages.push({ glob: "shared/**", test: "node scripts/test-security-scan.mjs", dir: "shared" });
	}
	const seen = new Set(packages.map((pkg) => pkg.glob));
	for (const extra of [...discoverNestedNodePackages(root), ...discoverPythonPackage(root)]) {
		if (seen.has(extra.glob)) continue;
		seen.add(extra.glob);
		packages.push(extra);
	}
	return packages;
}

export function buildContract(root: string, packages: PackageSpec[], ciSteps: CiStep[]): DerivedContract {
	const sources = [...new Set(ciSteps.map((step) => step.source.split(":")[0]))];
	if (sources.length === 0) sources.push(".github/workflows");
	// docs/** is not automatically documentation: repos keep Playwright suites
	// under docs/. Exempt it only when no discovered package lives there.
	const docsOnly = DEFAULT_DOCS_ONLY.filter(
		(glob) => !(glob === "docs/**" && packages.some((pkg) => pkg.glob.startsWith("docs/"))),
	);
	const protectedPaths = [...DEFAULT_PROTECTED];
	for (const name of ["CLAUDE.md", "AGENTS.override.md"]) {
		if (fs.existsSync(path.join(root, name))) protectedPaths.push(name);
	}
	return {
		version: 1,
		sources,
		packages: packages.map(({ glob, test }) => ({ glob, test })),
		docsOnly,
		protectedPaths,
		gates: {
			"protect-instructions": { enabled: true },
			"test-before-commit": { enabled: true },
			"plan-before-pr": { enabled: false },
		},
	};
}

// One aggregate runbook, not one per package: the loader injects it after a
// git inspection command, i.e. before the commit it is meant to steer.
export function buildRunbook(options: {
	packages: PackageSpec[];
	ciSteps: CiStep[];
	commit: string;
	draft?: boolean;
	projectKey?: string;
	maxBytes?: number;
}): string {
	const { packages, ciSteps, commit, draft = false, projectKey, maxBytes = 2048 } = options;
	const rows: string[] = [];
	let used = 0;
	const prefix = "- `";
	for (const pkg of packages) {
		const row = `${prefix}${pkg.glob}\` → \`${redactCommand(pkg.test)}\``;
		if (Buffer.byteLength(rows.join("\n") + row, "utf8") > maxBytes - 900) break;
		rows.push(row);
		used += 1;
	}
	if (used < packages.length) rows.push(`- (+${packages.length - used} more packages; run \`/workflow status\`)`);
	const ciLines = ciSteps
		.filter((step) => isTestCommand(step.command))
		.map((step) => `- \`${redactCommand(step.command)}\` (${step.source}${step.workdir ? `, cwd \`${step.workdir}\`` : ""})`)
		.join("\n");
	const match = ["git status", "git diff", "git commit", "git push", "gh pr create", "tea pr create"];
	return [
		"---",
		"id: ship-change",
		"summary: Changed-package test commands and ship order (derived from CI and test entry points)",
		"tools: [bash]",
		"tags: [workflow, tool:bash]",
		"match:",
		`  commandIncludes: [${match.map((value) => JSON.stringify(value)).join(", ")}]`,
		...(projectKey ? [`  project: ${JSON.stringify(projectKey)}`] : []),
		"injection: tool_result",
		"priority: 60",
		`maxBytes: ${maxBytes}`,
		`derivedFrom: "CI steps + package test entry points"`,
		`sourceCommit: ${commit}`,
		...(draft ? ["draft: true"] : [`verifiedBy: derived (auto-detected at session start)`, `verifiedAt: ${new Date().toISOString().slice(0, 10)}`]),
		"---",
		"",
		"# Ship a change",
		"",
		"1. Inspect the diff (status and diff commands).",
		"2. Run the suite for every changed package (table below). A green run",
		"   must be recorded before commit, push, or PR; the workflow guard reads",
		"   the exact command from `.pi/workflow.json` or, when that file is",
		"   absent, from the contract it derives at session start.",
		"3. Update the plan/handoff artifact the repo asks for.",
		"",
		"## Package suites",
		"",
		rows.join("\n") || "- (none discovered)",
		"",
		"## CI executes",
		"",
		ciLines || "- (no CI test steps discovered)",
		"",
	].join("\n");
}
