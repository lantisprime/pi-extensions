// Tests: jev extension reaches child agents.
//
// Contract: when a jev extension path is resolved, child argv must carry
// `-e <path>` AND `jev_ask` must appear in the `--tools` allowlist — loading the
// extension alone is not enough, because `--tools` filters extension tools too.
// Trust rule: the path comes from ctx/env only, never from an agent spec.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildChildPiArgs, JEV_TOOL_NAME } from "../lib/child-args.ts";
import {
	buildChildRunOptions,
	JEV_EXTENSION_PATH_ENV,
	resolveExplicitJevExtensionPath,
} from "../lib/run-resolver.ts";
import { getBuiltInAgentSpec } from "../lib/specs.ts";

const spec = getBuiltInAgentSpec("scout");
assert.ok(spec, "scout built-in spec must exist");

function withEnv(value, fn) {
	const prev = process.env[JEV_EXTENSION_PATH_ENV];
	if (value === undefined) delete process.env[JEV_EXTENSION_PATH_ENV];
	else process.env[JEV_EXTENSION_PATH_ENV] = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env[JEV_EXTENSION_PATH_ENV];
		else process.env[JEV_EXTENSION_PATH_ENV] = prev;
	}
}

function toolsOf(argv) {
	const i = argv.indexOf("--tools");
	assert.ok(i >= 0, "argv must include --tools");
	return argv[i + 1] ?? "";
}

// The installed location this environment actually uses (symlinked extension).
const installed = path.join(os.homedir(), ".pi", "agent", "extensions", "jev", "index.ts");
const jevInstalled = existsSync(installed);

// 1. Default resolution finds the installed extension.
const auto = resolveExplicitJevExtensionPath();
if (jevInstalled) {
	assert.equal(auto, installed, "default resolution must find the installed jev extension");
} else {
	assert.equal(auto, undefined, "with no jev installed and no env, resolution must be undefined");
}

// 2. With jev resolved, child argv carries -e <path> and jev_ask in --tools.
withEnv(undefined, () => {
	const inv = buildChildPiArgs(spec, "task", {
		...buildChildRunOptions({ cwd: process.cwd() }),
		systemPromptPath: "/tmp/sp.txt",
	});
	if (jevInstalled) {
		assert.ok(inv.argv.includes("-e"), "argv must include -e for the jev extension");
		assert.ok(inv.argv.includes(installed), "argv must include the resolved jev path");
		assert.ok(
			toolsOf(inv.argv).split(",").includes(JEV_TOOL_NAME),
			"jev_ask must be in the --tools allowlist",
		);
	} else {
		assert.ok(!toolsOf(inv.argv).includes(JEV_TOOL_NAME), "without jev, jev_ask must not be added");
	}
});

// 3. env opt-out disables jev in children.
withEnv("off", () => {
	assert.equal(resolveExplicitJevExtensionPath(), undefined, "env 'off' must disable jev");
	const inv = buildChildPiArgs(spec, "task", {
		...buildChildRunOptions({ cwd: process.cwd() }),
		systemPromptPath: "/tmp/sp.txt",
	});
	assert.ok(!toolsOf(inv.argv).includes(JEV_TOOL_NAME), "disabled jev must not add jev_ask");
});

// 3b. every disable spelling is honoured, case-insensitively.
for (const v of ["0", "false", "none", "OFF", "Off"]) {
	withEnv(v, () =>
		assert.equal(resolveExplicitJevExtensionPath(), undefined, `env '${v}' must disable jev`),
	);
}

// 4. env override wins over the default install location.
withEnv("/custom/jev/index.ts", () => {
	assert.equal(resolveExplicitJevExtensionPath(), "/custom/jev/index.ts");
});

// 5. ctx beats env.
withEnv("/from/env.ts", () => {
	assert.equal(
		resolveExplicitJevExtensionPath({ explicitJevExtensionPath: "/from/ctx.ts" }),
		"/from/ctx.ts",
	);
});

// 6. A spec cannot inject the path: buildChildPiArgs has no such option, so an
//    unknown field on the spec never becomes argv.
withEnv(undefined, () => {
	const tampered = { ...spec, explicitJevExtensionPath: "/tmp/evil.ts" };
	const inv = buildChildPiArgs(tampered, "task", { systemPromptPath: "/tmp/sp.txt" });
	assert.ok(!inv.argv.includes("/tmp/evil.ts"), "a spec-injected jev path must never reach argv");
});

// 7. Unsafe paths are rejected by validation.
for (const bad of ["", "  ", "/tmp/bad\nloader.ts", "/tmp/bad\rloader.ts"]) {
	assert.throws(
		() =>
			buildChildPiArgs(spec, "task", {
				explicitJevExtensionPath: bad,
				systemPromptPath: "/tmp/sp.txt",
			}),
		/explicitJevExtensionPath/,
		`unsafe jev path ${JSON.stringify(bad)} must throw`,
	);
}

// 8. The trust rule is documented in source (specs must not carry the path).
const childArgsSrc = readFileSync(new URL("../lib/child-args.ts", import.meta.url), "utf8");
assert.match(childArgsSrc, /never from an agent spec/, "child-args must document the spec trust rule");

console.log("test-jev-child-args: all assertions passed");
