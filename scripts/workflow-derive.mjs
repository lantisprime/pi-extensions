#!/usr/bin/env node
// Derive the repo workflow contract and runbook drafts from deterministic
// sources: CI steps, package scripts, test entry points. No LLM, no network.
//
//   node scripts/workflow-derive.mjs            # preview (no writes)
//   node scripts/workflow-derive.mjs --write    # write .pi/workflow.json + drafts
//   node scripts/workflow-derive.mjs --accept test-agents,ship-change
//
// Acceptance is operator-only and fail-closed: the rendered draft must pass the
// shared scanner before it moves from .pi/workflow-drafts/ to .pi/runbooks/.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = path.join(ROOT, ".pi", "workflow.json");
const DRAFTS = path.join(ROOT, ".pi", "workflow-drafts");
const RUNBOOKS = path.join(ROOT, ".pi", "runbooks");
const DEFAULT_DOCS_ONLY = ["**/*.md", "docs/**", ".plans/**"];
const DEFAULT_PROTECTED = ["AGENTS.md", "MEMORY.md", ".pi/runbooks/**", ".pi/workflow.json"];

export function redactCommand(command) {
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

/** Scan only what will be injected (summary + body), not runbook metadata. */
export function draftScanText(content) {
	const summary = /^summary:\s*(.+)$/m.exec(content)?.[1] ?? "";
	const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	return `${summary}\n${body}`;
}

export function acceptDecision(risk, force = false) {
	if (risk === "dangerous") return { ok: false, reason: "dangerous" };
	if (risk === "suspicious" && !force) return { ok: false, reason: "suspicious (re-run with --force after reading it)" };
	return { ok: true, reason: "ok" };
}

export function mergeContracts(existing, generated) {
	if (!existing || typeof existing !== "object") return generated;
	return {
		...generated,
		// Operator-owned fields survive regeneration.
		docsOnly: Array.isArray(existing.docsOnly) ? existing.docsOnly : generated.docsOnly,
		protectedPaths: Array.isArray(existing.protectedPaths) ? existing.protectedPaths : generated.protectedPaths,
		gates: existing.gates && typeof existing.gates === "object" ? existing.gates : generated.gates,
	};
}

function read(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function leading(line) {
	return line.length - line.trimStart().length;
}

export function parseCi(text, source) {
	const lines = text.split("\n");
	const steps = [];
	let currentName = "";
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const named = /^\s*-\s+name:\s*(.+)$/.exec(line);
		if (named) currentName = named[1].trim();

		const run = /^(\s*)run:\s*(.*)$/.exec(line);
		if (!run) continue;
		const indent = run[1].length;
		let command = run[2].trim();
		if (command === "|" || command === ">" || command === "|-" || command === ">-") {
			const block = [];
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
		steps.push({ name: currentName || `step ${steps.length + 1}`, command, source: `${source}:${i + 1}` });
	}
	return steps;
}

const SHELL_NOISE = /^(?:if|then|else|elif|fi|for|while|do|done|set\b|echo\b|#|cd\b|\{)|BREAK_VALIDATE/;

function isTestCommand(command) {
	if (!command || SHELL_NOISE.test(command.trim())) return false;
	return /\b(test|--test|run-tests\.sh|run-[a-z-]*tests\.sh|pytest|unittest)\b/.test(command);
}

function dirOf(command) {
	const tokens = command.split(/\s+/);
	for (const token of tokens) {
		const match = /^([A-Za-z0-9._-]+)\//.exec(token);
		if (!match) continue;
		const candidate = match[1];
		if (fs.existsSync(path.join(ROOT, candidate))) return candidate;
	}
	return null;
}

export function discoverFromCi() {
	const dirs = path.join(ROOT, ".github", "workflows");
	if (!fs.existsSync(dirs)) return { steps: [], byDir: new Map() };
	const steps = [];
	for (const file of fs.readdirSync(dirs).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort()) {
		const relative = path.relative(ROOT, path.join(dirs, file));
		steps.push(...parseCi(read(path.join(dirs, file)) ?? "", relative));
	}
	const byDir = new Map();
	for (const step of steps) {
		for (const line of step.command.split("\n")) {
			const redacted = redactCommand(line);
			if (!redacted || !isTestCommand(redacted)) continue;
			const dir = dirOf(redacted);
			if (!dir) continue;
			const list = byDir.get(dir) ?? [];
			if (!list.includes(redacted)) list.push(redacted);
			byDir.set(dir, list);
		}
	}
	return { steps, byDir };
}

function firstMarkdownFree(entries, pattern) {
	return entries.filter((entry) => pattern.test(entry)).sort()[0] ?? null;
}

export function discoverPackages(ciByDir = new Map()) {
	const packages = [];
	for (const entry of fs.readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const dir = entry.name;
		const absolute = path.join(ROOT, dir);
		const candidates = ciByDir.get(dir) ?? [];
		let test = candidates.length > 0 ? candidates.join(" && ") : null;

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
				? fs.readdirSync(path.join(absolute, "test-fixtures")).filter((name) => /^run-.*\.sh$/.test(name)).sort()
				: [];
			const race = firstMarkdownFree(fixtures, /run-.*\.sh/);
			if (race) test = `bash ${dir}/test-fixtures/${race}`;
		}
		if (!test) {
			const tests = fs.existsSync(path.join(absolute, "test"))
				? fs.readdirSync(path.join(absolute, "test")).filter((name) => /\.(test|spec)\.[cm]?[jt]s$/.test(name)).sort()
				: [];
			if (tests.length > 0) test = `npx --yes tsx --test ${dir}/test/`;
		}
		if (!test) continue;
		packages.push({ glob: `${dir}/**`, test: redactCommand(test), dir });
	}
	if (fs.existsSync(path.join(ROOT, "shared"))) {
		packages.push({ glob: "shared/**", test: "node scripts/test-security-scan.mjs", dir: "shared" });
	}
	return packages;
}

function gitSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function slug(value) {
	return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function draftFrontmatter({ id, summary, commandIncludes, source, commit }) {
	return [
		"---",
		`id: ${id}`,
		`summary: ${summary}`,
		"tools: [bash]",
		"tags: [workflow, tool:bash]",
		"match:",
		`  commandIncludes: [${commandIncludes.map((value) => JSON.stringify(value)).join(", ")}]`,
		"injection: tool_result",
		"priority: 60",
		"maxBytes: 2048",
		`derivedFrom: ${JSON.stringify(source)}`,
		`sourceCommit: ${commit}`,
		"draft: true",
		"---",
	].join("\n");
}

export function buildDrafts(packages, ciSteps, commit) {
	// One aggregate runbook, not one per package: the loader injects it after a
	// git inspection command, i.e. before the commit it is meant to steer.
	// Per-package drafts only appeared after the test had already run.
	const table = packages
		.map((pkg) => `- \`${pkg.glob}\` → \`${redactCommand(pkg.test)}\``)
		.join("\n");
	const ciLines = ciSteps
		.filter((step) => isTestCommand(step.command))
		.map((step) => `- \`${redactCommand(step.command)}\` (${step.source})`)
		.join("\n");
	const id = "ship-change";
	return [
		{
			id,
			file: `${id}.md`,
			content: [
				draftFrontmatter({
					id,
					summary: "Changed-package test commands and ship order (derived from CI)",
					commandIncludes: ["git status", "git diff", "git commit", "git push", "gh pr create"],
					source: ".github/workflows + package test entry points",
					commit,
				}),
				"",
				"# Ship a change",
				"",
				"1. Inspect the diff (status and diff commands).",
				"2. Run the suite for every changed package (table below). A green run",
				"   must be recorded before commit, push, or PR; the workflow guard reads",
				"   the exact command from `.pi/workflow.json`.",
				"3. Update the plan/handoff artifact the repo asks for.",
				"",
				"## Package suites",
				"",
				table || "- (none discovered)",
				"",
				"## CI executes",
				"",
				ciLines || "- (no CI test steps discovered)",
				"",
			].join("\n"),
		},
	];
}

export function buildContract(packages, ciSteps) {
	const sources = [...new Set(ciSteps.map((step) => step.source.split(":")[0]))];
	if (sources.length === 0) sources.push(".github/workflows");
	return {
		version: 1,
		sources,
		packages: packages.map(({ glob, test }) => ({ glob, test })),
		docsOnly: DEFAULT_DOCS_ONLY,
		protectedPaths: DEFAULT_PROTECTED,
		gates: {
			"protect-instructions": { enabled: true },
			"test-before-commit": { enabled: true },
			"plan-before-pr": { enabled: false },
		},
	};
}

async function loadScanner() {
	const source = path.join(ROOT, "shared", "security-scan.ts");
	if (!fs.existsSync(source)) return null;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-scan-"));
	const tsc = spawnSync(
		"npx",
		[
			"-p",
			"typescript@6",
			"tsc",
			source,
			"--target",
			"ES2022",
			"--module",
			"ES2022",
			"--moduleResolution",
			"node",
			"--outDir",
			tmp,
			"--skipLibCheck",
			"--ignoreDeprecations",
			"6.0",
		],
		{ encoding: "utf8" },
	);
	if (tsc.status !== 0) return null;
	const out = path.join(tmp, "security-scan.mjs");
	try {
		fs.renameSync(path.join(tmp, "security-scan.js"), out);
	} catch {
		return null;
	}
	try {
		return await import(pathToFileURL(out).href);
	} catch {
		return null;
	}
}

async function accept(ids, force, dryRun, verifiedBy) {
	const scanner = await loadScanner();
	if (!scanner) {
		console.error("refusing acceptance: shared scanner could not be built (fail closed)");
		process.exitCode = 1;
		return;
	}
	fs.mkdirSync(RUNBOOKS, { recursive: true });
	for (const id of ids) {
		const file = path.join(DRAFTS, `${id}.md`);
		const content = read(file);
		if (!content) {
			console.error(`missing draft: ${path.relative(ROOT, file)}`);
			process.exitCode = 1;
			continue;
		}
		const result = scanner.scanTextForAgentRisk(draftScanText(content), { provenance: "project", source: "skill" });
		const decision = acceptDecision(result.risk, force);
		if (dryRun) {
			const findings = (result.findings ?? []).map((finding) => `${finding.category}:${finding.match ?? finding.detail ?? ""}`).slice(0, 4);
			console.log(
				`would ${decision.ok ? "accept" : "refuse"} ${id} (risk=${result.risk} score=${result.score})${findings.length ? ` [${findings.join("; ")}]` : ""}`,
			);
			if (!decision.ok) process.exitCode = 1;
			continue;
		}
		if (!decision.ok) {
			console.error(`refusing ${id}: scanner risk=${result.risk} score=${result.score} (${decision.reason})`);
			process.exitCode = 1;
			continue;
		}
		const verified = content
			.replace(/^draft: true$/m, `verifiedBy: ${verifiedBy}`)
			.replace(/^(---\n[\s\S]*?)(\n---\n)/, `$1\nverifiedAt: ${new Date().toISOString().slice(0, 10)}$2`);
		fs.writeFileSync(path.join(RUNBOOKS, `${id}.md`), verified, "utf8");
		fs.unlinkSync(file);
		console.log(`accepted ${id} -> .pi/runbooks/${id}.md (risk=${result.risk})`);
	}
}

function usage() {
	console.log(`usage:
  node scripts/workflow-derive.mjs                 preview
  node scripts/workflow-derive.mjs --write         write contract + drafts
  node scripts/workflow-derive.mjs --accept <ids>  move drafts to .pi/runbooks (comma-separated)
  flags: --force (accept suspicious), --dry-run (scan without moving),
         --verified-by <who> (provenance; default operator), --json`);
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) return usage();

	const { steps, byDir } = discoverFromCi();
	const packages = discoverPackages(byDir);
	const commit = gitSourceCommit();
	const generated = buildContract(packages, steps);
	const existing = (() => {
		const raw = read(CONTRACT);
		if (!raw) return null;
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	})();
	const contract = mergeContracts(existing, generated);
	const drafts = buildDrafts(packages, steps, commit);

	if (args.includes("--json")) {
		console.log(JSON.stringify({ contract, drafts: drafts.map((draft) => draft.id) }, null, 2));
		return;
	}

	if (args.includes("--accept")) {
		const index = args.indexOf("--accept");
		const value = args[index + 1] ?? "";
		const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
		if (ids.length === 0) return usage();
		const verifiedIndex = args.indexOf("--verified-by");
		const verifiedBy = verifiedIndex >= 0 ? args[verifiedIndex + 1] ?? "operator" : "operator";
		await accept(ids, args.includes("--force"), args.includes("--dry-run"), verifiedBy);
		return;
	}

	console.log(`packages (${packages.length}):`);
	for (const pkg of packages) console.log(`  ${pkg.glob}  ←  ${pkg.test}`);
	console.log(`\ndrafts (${drafts.length}): ${drafts.map((draft) => draft.id).join(", ")}`);
	console.log(`\nCI steps scanned: ${steps.length}`);

	if (!args.includes("--write")) {
		console.log("\npreview only. Re-run with --write to update .pi/workflow.json and drafts.");
		return;
	}

	fs.mkdirSync(path.dirname(CONTRACT), { recursive: true });
	fs.writeFileSync(CONTRACT, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
	fs.mkdirSync(DRAFTS, { recursive: true });
	for (const draft of drafts) fs.writeFileSync(path.join(DRAFTS, draft.file), draft.content, "utf8");
	console.log(`\nwrote ${path.relative(ROOT, CONTRACT)} and ${drafts.length} draft(s) in .pi/workflow-drafts/`);
	console.log("review drafts, then: node scripts/workflow-derive.mjs --accept <id[,id]>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
