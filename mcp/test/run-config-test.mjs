// Config loader tests. Run: npm exec -y --package=tsx -- tsx test/run-config-test.mjs

import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandEnvString, loadMcpConfig } from "../lib/config.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mcp-cfg-"));
const projectDir = path.join(tmp, "proj");
await fs.mkdir(projectDir, { recursive: true });

// Seed a fake HOME so the global path points into tmp.
const fakeHome = path.join(tmp, "home");
await fs.mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true });
process.env.HOME = fakeHome;
// Re-import with patched HOME is not possible for the module-level homedir()
// calls, so instead verify project file behavior plus expansion helpers, and
// test the global path via the documented location only in integration.

await fs.writeFile(
	path.join(projectDir, ".pi.json.tmp"), "", "utf8",
).catch(() => {});
await fs.mkdir(path.join(projectDir, ".pi"), { recursive: true });
await fs.writeFile(
	path.join(projectDir, ".pi", "mcp.json"),
	JSON.stringify({
		mcpServers: {
			fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}"] },
			disabled: { command: "nope", enabled: false },
			broken: { args: ["x"] },
			remote: { url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${TEST_TOKEN}" } },
			authcmd: { url: "https://api.example.com/mcp", headersCommand: "printf '{}'" },
			stdiocmd: { command: "x", headersCommand: "printf '{}'" },
			badtype: { command: "x", timeout: "soon" },
		},
	}),
	"utf8",
);

process.env.TEST_TOKEN = "secret123";
const config = await loadMcpConfig(projectDir);

let failed = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`✓ ${name}`);
	} catch (error) {
		failed++;
		console.log(`✗ ${name}\n  ${error.message}`);
	}
}

await check("valid servers load", () => {
	assert.ok(config.servers.fs, "fs server missing");
	assert.ok(config.servers.remote, "remote server missing");
	assert.deepEqual(config.servers.fs.args, ["-y", "@modelcontextprotocol/server-filesystem", process.env.HOME]);
});

await check("enabled=false preserved", () => {
	assert.equal(config.servers.disabled.enabled, false);
});

await check("invalid server skipped with warning", () => {
	assert.equal(config.servers.broken, undefined);
	assert.ok(config.warnings.some((w) => w.includes('"broken"')), JSON.stringify(config.warnings));
});

await check("bad timeout warned and defaulted", () => {
	assert.equal(config.servers.badtype.timeout, 30000);
	assert.ok(config.warnings.some((w) => w.includes('"badtype"') && w.includes("timeout")));
});

await check("env expansion in headers", () => {
	assert.equal(config.servers.remote.headers.Authorization, "Bearer secret123");
});

await check("expandEnvString leaves lone $", () => {
	assert.equal(expandEnvString("$ 5 and ${MISSING_XYZ}!"), "$ 5 and !");
});

await check("missing config files are fine", async () => {
	const empty = await loadMcpConfig(path.join(tmp, "nowhere"));
	assert.deepEqual(empty.servers, {});
	assert.deepEqual(empty.warnings, []);
});

await check("headersCommand parsed on http servers", () => {
	assert.equal(config.servers.authcmd.headersCommand, "printf '{}'");
});

await check("headersCommand ignored on stdio servers with warning", () => {
	assert.ok(config.servers.stdiocmd, "stdio server should still load");
	assert.equal(config.servers.stdiocmd.headersCommand, undefined);
	assert.ok(
		config.warnings.some((w) => w.includes('"stdiocmd"') && w.includes("headersCommand")),
		JSON.stringify(config.warnings),
	);
});

await check("malformed JSON throws with path", async () => {
	await fs.writeFile(path.join(projectDir, ".pi", "mcp.json"), "{oops", "utf8");
	await assert.rejects(
		() => loadMcpConfig(projectDir),
		(e) => e.message.includes(".pi/mcp.json"),
	);
});

console.log(failed === 0 ? "\nAll config tests passed" : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
