// herdr-control: mechanical lifecycle harness for LIVE test scripts.
// (Plain JS on purpose: .mjs files are not type-stripped by the runner.)
//
// createSessionHarness(): the private-session variant. Live tests run in an
// ISOLATED herdr session ("herdr --session <name> ...") with its own server,
// socket, and panes — never in the user's session/tab. Teardown is
// mechanical and total: spawned panes are closed, then `herdr session stop`
// kills the whole test server, so nothing can leak even on abort.
import { execFileSync, spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";

function herdr(argv, timeoutMs = 15000) {
	try {
		const stdout = execFileSync("herdr", argv, { timeout: timeoutMs, encoding: "utf8" });
		return { ok: true, stdout, stderr: "" };
	} catch (err) {
		const e = err;
		return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
	}
}

function liveAgents(argvPrefix) {
	const res = herdr([...argvPrefix, "agent", "list"]);
	if (!res.ok) return [];
	try {
		const parsed = JSON.parse(res.stdout);
		return (parsed.result?.agents ?? [])
			.map((a) => ({ name: a.agent ?? a.name ?? "", paneId: a.pane_id ?? "" }))
			.filter((a) => a.name && a.paneId);
	} catch {
		return [];
	}
}

export async function createSessionHarness(session, prefix) {
	const argvPrefix = ["--session", session];
	const spawned = [];
	let stopped = false;
	const handlers = [];
	const serverLog = `/tmp/${session}-server.log`;

	function sweep() {
		const closed = [];
		for (const { name, paneId } of liveAgents(argvPrefix)) {
			if (!name.startsWith(prefix)) continue;
			const res = herdr([...argvPrefix, "pane", "close", paneId]);
			if (res.ok) closed.push(`${name}(${paneId})`);
		}
		return closed;
	}

	function stopSession() {
		if (stopped) return;
		stopped = true;
		// Session-wide backstop: closing the session stops its server and every
		// pane/process in it — the guarantee per-pane cleanup can't give.
		// DELETE (not just stop) so the next run starts pristine: restored
		// panes/agents from crashed runs must never leak into a new run.
		herdr(["session", "stop", session], 20_000);
		herdr(["session", "delete", session], 20_000);
	}

	function finish() {
		if (finished_h) return;
		finished_h = true;
		for (const [signal, handler] of handlers) process.off(signal, handler);
		const closed = sweep();
		if (closed.length > 0) console.log(`[harness] swept panes: ${closed.join(", ")}`);
		stopSession();
		console.log(`[harness] session "${session}" stopped (log: ${serverLog})`);
	}
	let finished_h = false;

	// Signals + crashes route through the same mechanical teardown.
	for (const signal of ["SIGINT", "SIGTERM"]) {
		const handler = () => {
			finish();
			process.exit(signal === "SIGINT" ? 130 : 143);
		};
		process.on(signal, handler);
		handlers.push([signal, handler]);
	}
	const failHandler = (err) => {
		console.error("[harness] fatal:", err);
		finish();
		process.exit(1);
	};
	process.on("uncaughtException", failHandler);
	process.on("unhandledRejection", failHandler);
	handlers.push(["exit", () => finish()]);
	process.on("exit", () => finish());

	// 1. Preflight: fully remove any prior instance of this session (stopped
		// or running) so restored panes/agents from crashed runs can't leak in.
	{
		const list = herdr(["session", "list"], 15_000);
		if (list.ok && list.stdout.includes(session)) {
			console.log(`[harness] removing stale session "${session}" from a previous run`);
			herdr(["session", "stop", session], 20_000);
			herdr(["session", "delete", session], 20_000);
		}
		const pre = sweep();
		if (pre.length > 0) console.log(`[harness] preflight sweep: ${pre.join(", ")}`);
	}

	// 2. Start the private headless server for this session (detached).
	const up = herdr([...argvPrefix, "status", "--json"], 10_000);
	const alreadyRunning = up.ok && /"running":\s*true/.test(up.stdout);
	if (!alreadyRunning) {
		const log = openSync(serverLog, "a");
		// NOTE: the session flag goes AFTER the subcommand: `herdr server --session <name>`.
		const child = spawn("herdr", ["server", "--session", session], { detached: true, stdio: ["ignore", log, log], env: process.env });
		child.unref();
		closeSync(log);
		// wait until the session server reports running
		const deadline = Date.now() + 20_000;
		let ready = false;
		while (Date.now() < deadline && !ready) {
			await new Promise((r) => setTimeout(r, 500));
			const s = herdr([...argvPrefix, "status", "--json"], 10_000);
			ready = s.ok && /"running":\s*true/.test(s.stdout);
		}
		if (!ready) {
			throw new Error(`private session "${session}" did not come up; see ${serverLog}`);
		}
	}
	console.log(`[harness] private session "${session}" running${alreadyRunning ? " (reused)" : ""}`);

	// 3. Root pane for spawns: the pipeline uses --current, which resolves via
	// HERDR_PANE_ID — point it at a pane inside the PRIVATE session.
	const ws = herdr([...argvPrefix, "workspace", "create", "--cwd", "/tmp", "--label", "e2e", "--no-focus"]);
	if (!ws.ok) throw new Error(`workspace create failed: ${ws.stderr.slice(0, 200)}`);
	const parsed = JSON.parse(ws.stdout);
	const rootPaneId = parsed.result?.root_pane?.pane_id;
	if (!rootPaneId) throw new Error("workspace create returned no root pane");
	process.env.HERDR_PANE_ID = rootPaneId;
	console.log(`[harness] root pane ${rootPaneId}`);

	return {
		session,
		argvPrefix,
		spawned,
		sweep,
		finish,
	};
}
