// tmux-control: Path A bracketed-paste marker verification (P5c-2-S1, REQ-1/REQ-20).
//
// The smoke test (test-real-tmux-smoke.mjs) only checks that pasted text LANDS
// in the pane — it does NOT prove the bracketed-paste markers are emitted,
// because a shell's bracketed-paste support is version-dependent (bash 3.2 on
// macOS never enables it). This test closes that gap with "Path A": spawn a
// raw-mode Node target that emits DECSET 2004 (\e[?2004h) on startup — the byte
// tmux's input parser watches for to set MODE_BRACKETPASTE on the pane. Only
// then does `paste-buffer -p` wrap the payload in \e[200~ ... \e[201~.
//
// The target echoes every byte it reads from stdin back as hex (via pipe-pane
// we read the pane's OUTPUT), so we observe EXACTLY what the receiving app got.
//
// Verifies:
//   1. DECSET-2004 handshake gates the markers (READY proves the mode was set).
//   2. A small multi-line payload arrives as ONE bracketed event: \e[200~ and
//      \e[201~ appear exactly once, payload between them, interior LF→CR (REQ-1).
//   3. A >1KB payload still yields exactly one marker pair even though tmux
//      fragments it across multiple stdin reads (the S6 buffering requirement).
//
// Isolated socket + `-f /dev/null` (no user ~/.tmux.conf) so base-index/options
// are deterministic. Cleans up on exit.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const execFileP = promisify(execFile);
const SOCKET = `pi-pathA-${process.pid}`;
const T = (...a) => execFileP("tmux", ["-L", SOCKET, "-f", "/dev/null", ...a], { timeout: 6000 });
const TGT = join(tmpdir(), `pi-pathA-target-${process.pid}.mjs`);
const LOG = join(tmpdir(), `pi-pathA-recv-${process.pid}.log`);

const START_HEX = "1b5b3230307e"; // \e[200~
const END_HEX = "1b5b3230317e";   // \e[201~

function countHex(haystack, needle) {
	return (haystack.match(new RegExp(needle, "g")) || []).length;
}

async function cleanup() {
	await T("kill-server").catch(() => {});
	rmSync(TGT, { force: true });
	rmSync(LOG, { force: true });
}

// Spawn target, wait for READY, paste `payload` with -p, return the received hex.
async function pasteAndCapture(payload) {
	writeFileSync(LOG, "");
	await T("kill-server").catch(() => {});
	// respawn-less: a fresh session running the raw-mode target.
	await T("new-session", "-d", "-s", "s", "-x", "200", "-y", "50", `node ${TGT}`);

	let win;
	let ready = false;
	for (let i = 0; i < 50 && !ready; i++) {
		await new Promise((r) => setTimeout(r, 100));
		if (!win) {
			const { stdout } = await T("list-windows", "-t", "s", "-F", "#{window_index}").catch(() => ({ stdout: "" }));
			win = stdout.trim().split("\n")[0] || undefined;
		}
		if (win) {
			const cap = await T("capture-pane", "-p", "-t", `s:${win}`).catch(() => ({ stdout: "" }));
			ready = cap.stdout.includes("READY");
		}
	}
	assert.ok(ready, "target never signalled READY (DECSET 2004 not emitted/parsed)");

	await T("set-buffer", "-b", "pa", "--", payload);
	await T("paste-buffer", "-b", "pa", "-d", "-t", `s:${win}`, "-p");
	await new Promise((r) => setTimeout(r, 500));
	await T("send-keys", "-t", `s:${win}`, "-l", "q"); // 'q' tells target to flush + exit
	await new Promise((r) => setTimeout(r, 400));
	// Target prints "RX:<hex>\n" per read; strip the RX: prefixes/newlines, concat.
	return readFileSync(LOG, "utf8").replace(/RX:/g, "").replace(/\s+/g, "");
}

async function main() {
	console.log(`tmux-control Path A marker test (isolated socket: ${SOCKET})`);
	try {
		await execFileP("tmux", ["-V"]);
	} catch {
		console.log("SKIPPED: tmux not on $PATH");
		process.exit(0);
	}

	// Raw-mode target: enable bracketed paste, echo received bytes as hex, quit on 'q'.
	writeFileSync(
		TGT,
		[
			'import fs from "node:fs";',
			`const LOG = ${JSON.stringify(LOG)};`,
			'fs.writeFileSync(LOG, "");',
			'if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }',
			"process.stdin.resume();",
			'process.stdout.write("\\x1b[?2004h");', // DECSET 2004 — the handshake
			'process.stdout.write("READY\\n");',
			'process.stdin.on("data", (b) => {',
			'  fs.appendFileSync(LOG, "RX:" + b.toString("hex") + "\\n");',
			"  if (b.includes(0x71)) process.exit(0);", // 'q'
			"});",
			"setTimeout(() => process.exit(0), 20000);",
		].join("\n"),
	);

	try {
		// Case 1: small multi-line payload → single read, one marker pair, LF→CR.
		await step("small multi-line payload arrives as ONE bracketed event (markers once, LF→CR)", async () => {
			const hex = await pasteAndCapture("line1\nline2\nline3");
			assert.equal(countHex(hex, START_HEX), 1, `expected one \\e[200~, hex=${hex}`);
			assert.equal(countHex(hex, END_HEX), 1, `expected one \\e[201~, hex=${hex}`);
			const inner = hex.slice(hex.indexOf(START_HEX) + START_HEX.length, hex.indexOf(END_HEX));
			assert.equal(
				inner,
				Buffer.from("line1\rline2\rline3").toString("hex"),
				"payload bracketed exactly once; interior LF normalized to CR (REQ-1)",
			);
		});

		// Case 2: >1KB payload → fragmented across reads, but STILL one marker pair (S6).
		await step("large payload yields exactly one marker pair despite read fragmentation (S6)", async () => {
			const big = "A".repeat(3500); // < MAX_TEXT_BYTES (4000)
			const hex = await pasteAndCapture(big);
			assert.equal(countHex(hex, START_HEX), 1, "one \\e[200~ even when fragmented");
			assert.equal(countHex(hex, END_HEX), 1, "one \\e[201~ even when fragmented");
			const inner = hex.slice(hex.indexOf(START_HEX) + START_HEX.length, hex.indexOf(END_HEX));
			assert.equal(inner, Buffer.from(big).toString("hex"), "full payload sits between the single marker pair");
		});

		console.log("\n✅ Path A marker tests passed");
		await cleanup();
		process.exit(0);
	} catch (err) {
		await cleanup();
		console.error("\n❌ Path A marker test failed:", err.message);
		process.exit(1);
	}
}

function step(name, fn) {
	process.stdout.write(`  ${name} ... `);
	return fn().then(
		() => console.log("ok"),
		(err) => {
			console.log("FAIL");
			throw err;
		},
	);
}

main().catch(async (err) => {
	await cleanup();
	console.error("Unexpected error:", err);
	process.exit(1);
});
