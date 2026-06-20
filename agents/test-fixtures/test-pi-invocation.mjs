import assert from "node:assert";
import { getPiInvocation } from "../lib/child-args.ts";

function testPiInvocation_explicitCommandWins() {
  const result = getPiInvocation(["-p"], "pi-x");
  assert.equal(result.command, "pi-x");
}

function testPiInvocation_realScript() {
  // No env → uses real process.argv[1] and process.execPath
  const result = getPiInvocation(["-p"]);
  // process.argv[1] should exist and be a real script
  assert.equal(result.command, process.execPath);
  assert.equal(result.args[0], process.argv[1]);
  // The rest of args should follow
  assert.ok(result.args.includes("-p"));
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

function main() {
  testPiInvocation_explicitCommandWins();
  testPiInvocation_realScript();
  testPiInvocation_bunVirtualFallback();
  testPiInvocation_genericRuntimeFallsBackToPath();
  console.log("OK: 4/4 tests passed");
}

main();
