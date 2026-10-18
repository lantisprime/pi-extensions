#!/usr/bin/env node
// Derive the repo workflow contract and runbook drafts from deterministic
// sources: CI steps, package scripts, test entry points. No LLM, no network.
//
// Run with tsx (the shared discovery module is TypeScript):
//
//   npx --yes tsx scripts/workflow-derive.mjs                 # preview
//   npx --yes tsx scripts/workflow-derive.mjs --write         # contract + drafts
//   npx --yes tsx scripts/workflow-derive.mjs --accept <ids>  # operator-only
//
// Discovery lives in workflow-guard/lib/derive.ts so the guard can derive the
// same contract at session start without writing into the scanned repo.
// Acceptance is fail-closed: the draft must pass the shared scanner before it
// moves from .pi/workflow-drafts/ to .pi/runbooks/.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildContract as buildDerivedContract,
	buildRunbook,
	discoverFromCi as discoverCiFor,
	discoverPackages as discoverPackagesFor,
	discoverPythonPackage as discoverPythonFor,
	parseCi,
	redactCommand,
} from "../workflow-guard/lib/derive.ts";

export { parseCi, redactCommand };

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rootArgument() {
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--root") return argv[i + 1] ?? null;
		if (argv[i].startsWith("--root=")) return argv[i].slice("--root=".length);
	}
	return null;
}

const ROOT = path.resolve(rootArgument() ?? SCRIPT_ROOT);
if (!fs.existsSync(ROOT)) {
	console.error(`root does not exist: ${ROOT}`);
	process.exit(1);
}

const CONTRACT = path.join(ROOT, ".pi", "workflow.json");
const DRAFTS = path.join(ROOT, ".pi", "workflow-drafts");
const RUNBOOKS = path.join(ROOT, ".pi", "runbooks");

export function discoverFromCi() {
	return discoverCiFor(ROOT);
}

export function discoverPackages(ciByDir = new Map()) {
	return discoverPackagesFor(ROOT, ciByDir);
}

export function discoverPythonPackage() {
	return discoverPythonFor(ROOT);
}

export function buildContract(packages, ciSteps) {
	return buildDerivedContract(ROOT, packages, ciSteps);
}

export function buildDrafts(packages, ciSteps, commit) {
	return [
		{
			id: "ship-change",
			file: "ship-change.md",
			content: buildRunbook({ packages, ciSteps, commit, draft: true }),
		},
	];
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

function gitSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

async function loadScanner() {
	const source = path.join(SCRIPT_ROOT, "shared", "security-scan.ts");
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
  npx --yes tsx scripts/workflow-derive.mjs [--root <dir>]  preview
  npx --yes tsx scripts/workflow-derive.mjs --write         write contract + drafts
  npx --yes tsx scripts/workflow-derive.mjs --accept <ids>  move drafts to .pi/runbooks (comma-separated)
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
	console.log("review drafts, then: npx --yes tsx scripts/workflow-derive.mjs --accept <id[,id]>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
