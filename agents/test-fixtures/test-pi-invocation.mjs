import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPiInvocation } from "../lib/child-args.ts";

function testPiInvocation_explicitCommandWins() {
  const result = getPiInvocation(["-p"], "pi-x");
  assert.equal(result.command, "pi-x");
}

async function testPiInvocation_piEntrypointReInvokes() {
  // A real script whose basename is "pi" IS the pi entrypoint → re-invoke it
  // (the bundled-binary / dev case: re-run the same executable to spawn a child).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-inv-"));
  const piPath = path.join(dir, "pi");
  await fs.writeFile(piPath, "#!/usr/bin/env node\n");
  try {
    const result = getPiInvocation(["-p"], undefined, { argv1: piPath, execPath: "/usr/bin/node" });
    assert.equal(result.command, "/usr/bin/node");
    assert.equal(result.args[0], piPath);
    assert.ok(result.args.includes("-p"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testPiInvocation_nonPiScriptFallsThroughToPi() {
  // REGRESSION (P5-fix, 2026-06-27): a non-pi parent script — e.g. the detached
  // bg-worker.ts — must NOT be re-invoked as pi. Previously getPiInvocation
  // re-ran argv[1] verbatim, so the bg-worker re-ran ITSELF with pi's flags
  // (`--mode json … -p`), read a flag as the manifest path, and the child run
  // failed in ~90ms. The guard now falls through to DEFAULT_PI_COMMAND ("pi").
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-inv-"));
  const workerPath = path.join(dir, "bg-worker.ts");
  await fs.writeFile(workerPath, "// worker\n");
  try {
    const result = getPiInvocation(["-p"], undefined, { argv1: workerPath, execPath: "/usr/bin/node" });
    assert.equal(result.command, "pi", "a non-pi script must not be re-invoked as pi");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function testPiInvocation_bunVirtualFallback() {
  // Bun virtual script → skip, execName matches bun → falls back to DEFAULT_PI_COMMAND
  const result = getPiInvocation(["-p"], undefined, {
    argv1: "/$bunfs/root/cli.js",
    execPath: "/usr/local/bin/bun",
  });
  assert.equal(result.command, "pi");
}

function testPiInvocation_genericRuntimeFallsBackToPath() {
  // No script, execName not node/bun → returns execPath directly
  const result = getPiInvocation(["-p"], undefined, {
    argv1: undefined,
    execPath: "/opt/app/server",
  });
  assert.equal(result.command, "/opt/app/server");
}

async function main() {
  testPiInvocation_explicitCommandWins();
  await testPiInvocation_piEntrypointReInvokes();
  await testPiInvocation_nonPiScriptFallsThroughToPi();
  testPiInvocation_bunVirtualFallback();
  testPiInvocation_genericRuntimeFallsBackToPath();
  console.log("OK: 5/5 tests passed");
}

main();
