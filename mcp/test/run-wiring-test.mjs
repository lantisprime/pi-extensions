// Wiring-adjacent unit tests for the registered-server path: config mapping
// (lib/config.ts registeredToServerConfig) and dynamic "!cmd" header/env
// resolution (lib/headers.ts). Run:
//   npm exec -y --package=tsx -- tsx test/run-wiring-test.mjs
import { registeredToServerConfig } from "../lib/config.ts";
import { resolveEnvCommands, resolveInlineHeaders } from "../lib/headers.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label, cond) {
	console.log(`${cond ? "✓" : "✗"} ${label}`);
	if (!cond) failures++;
}

const w = [];
let c = registeredToServerConfig({ name: "a", config: { url: "https://x/mcp", timeout: 90 } }, w);
check("timeout seconds → callTimeout ms", c?.callTimeout === 90000);

c = registeredToServerConfig({ name: "a", config: { url: "https://x/mcp" } }, w);
check("default exposure (codemode) → lazy", c?.lazy === true);

process.env.SUB ??= "sub1";
c = registeredToServerConfig({ name: "a", config: { url: "https://x/${SUB}/mcp" } }, w);
check("${VAR} expanded in url", c?.url === "https://x/sub1/mcp");

c = registeredToServerConfig({ name: "d", config: { url: "https://x/mcp", exposure: "direct" } }, w);
check("exposure direct → full registration (not lazy)", c !== null && c.lazy !== true);

w.length = 0;
c = registeredToServerConfig({ name: "h", config: { url: "https://x/mcp", exposure: "hidden" } }, w);
check("hidden → skipped with warning", c === null && w.some((m) => m.includes("hidden")));

w.length = 0;
c = registeredToServerConfig({ name: "o", config: { url: "https://x/mcp", oauth: {} } }, w);
check("oauth → skipped with warning", c === null && w.some((m) => m.includes("OAuth")));

w.length = 0;
c = registeredToServerConfig({ name: "p", config: { url: "https://x/mcp", auth: { provider: "zai" } } }, w);
check("auth.provider → skipped with warning", c === null && w.some((m) => m.includes("provider-token")));

w.length = 0;
c = registeredToServerConfig({ name: "t", config: { url: "https://x/mcp", toolExposure: { a: "hidden" } } }, w);
check("toolExposure → warned, entry served", c !== null && w.some((m) => m.includes("toolExposure")));

c = registeredToServerConfig({ name: "s", config: { command: "uvx", args: ["srv"], env: { K: "v" } } }, w);
check("stdio entry mapped", c?.command === "uvx" && Array.isArray(c?.args) && c?.env?.K === "v");

w.length = 0;
c = registeredToServerConfig({ name: "bad", config: { command: "x", url: "https://x" } }, w);
check("command+url both set → skipped", c === null);

// --- dynamic "!cmd" values -------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "pi-mcp-wiring-"));
const script = join(dir, "tok.sh");
writeFileSync(script, "#!/bin/sh\nprintf 'Bearer fixed-token'\n", { mode: 0o755 });
const bad = join(dir, "bad.sh");
writeFileSync(bad, '#!/bin/sh\necho "secret-token" >&2\nexit 3\n', { mode: 0o755 });

const headers = await resolveInlineHeaders({ "X-Static": "v", Authorization: `!${script}` });
check("!cmd header resolved, static passthrough", headers?.Authorization === "Bearer fixed-token" && headers["X-Static"] === "v");

let leak = "";
try {
	await resolveInlineHeaders({ Authorization: `!${bad}` });
} catch (error) {
	leak = String(error.message);
}
check(
	"failing !cmd error is secret-free (no message, no stderr, no path)",
	!/secret-token/.test(leak) && !leak.includes("bad.sh") && /exit code 3/.test(leak),
);

const env = await resolveEnvCommands({ A: "plain", B: `!${script}` });
check("!cmd env resolved", env?.A === "plain" && env?.B === "Bearer fixed-token");

if (failures) {
	console.error(`${failures} test(s) FAILED`);
	process.exit(1);
}
console.log("All wiring tests passed");
