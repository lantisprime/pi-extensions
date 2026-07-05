// agents/test/test-bg-trust.mjs
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";
import { readOrCreateProjectTrustKey, readProjectTrustStore, projectRootSha256, readProjectTrustKey, sha256Hex } from "../lib/bg-trust.ts";
import { signBgPayload, verifyBgPayloadMac, readOrCreateSessionMacKey } from "../lib/bg-state.ts";

let passed = 0, failed = 0;
function test(name, fn) { Promise.resolve(fn()).then(() => { passed++; console.log("ok " + name); }, (e) => { failed++; console.log("not ok " + name + ": " + (e?.message || e)); }); }
function tmpProject() { const d = mkdtempSync(path.join(tmpdir(), "p5f-")); writeFileSync(path.join(d, ".git"), "", { mode: 0o644 }); return d; }
async function mintStore(projectDir, defaultBackend) {
  // mintStore must be async + await readOrCreateProjectTrustKey (it is async — bg-state.ts:167 pattern mirrored).
  const key = await readOrCreateProjectTrustKey(projectDir);
  const storeWithoutMac = {
    schemaVersion: 1,
    projectRootSha256: projectRootSha256(projectDir),
    defaultBackend,
    grantedAtMs: Date.now(),
    keyGenId: "UNUSED_IN_FIXTURE", // placeholder; real keyGenId is derived but tests sign directly
  };
  const mac = signBgPayload(storeWithoutMac, key);
  return { ...storeWithoutMac, mac };
}
function writeStore(projectDir, store) {
  const dir = path.join(projectDir, ".pi/trust"); if (!existsSync(dir)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  writeFileSync(path.join(dir, "default-backend.json"), JSON.stringify(store), { mode: 0o600 });
}

// --- Group 1 (10 tests; 3 verbatim shown below + 7 contracted per the 8-test contract table at end of block) ---

test("testReadTrustStore_parsesValidFile", async () => {
  const d = tmpProject(); const s = await mintStore(d, "tmux"); writeStore(d, s);
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.ok && r.store.defaultBackend, "tmux");
});

test("testReadTrustStore_rejectsSymlink", async () => {
  const d = tmpProject(); const real = path.join(d, ".pi/trust/default-backend.json");
  writeStore(d, await mintStore(d, "tmux"));
  const link = real + ".lnk"; if (existsSync(link)) rmSync(link);
  symlinkSync(real, link); // NOTE: plan declares symlink→{ok:false,reason:"symlink"}; this proves RED-when-symlink.
  // Replace the trust file with a symlink to prove the guard catches it.
  rmSync(real); symlinkSync(path.join(d, ".pi/trust/default-backend.json.bak"), real);
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, false); if (!r.ok) assert.strictEqual(r.reason, "symlink");
  // GREEN control: replace with the real file and it returns ok:true (proves the failure was the symlink, not incidental).
  rmSync(real); writeStore(d, await mintStore(d, "tmux"));
  const r2 = await readProjectTrustStore(d);
  assert.strictEqual(r2.ok, true);
});

test("testReadTrustStore_rejectsForeignProjectRoot_withSharedKeySentinel", async () => {
  // DISCRIMINATING FIXTURE (Blocker-2 fix): inject A's key into B so MAC verifies, isolating root-binding.
  const A = tmpProject(); const B = tmpProject();
  // Assert sentinel: A and B have distinct projectRootSha256 before the cross-read.
  const rootA = projectRootSha256(A); const rootB = projectRootSha256(B);
  assert.notStrictEqual(rootA, rootB, "sentinel: A/B roots must differ or the fixture is non-discriminating");
  if (process.env.BREAK === "1") { assert.strictEqual(rootA, rootB, "BREAK mode forces identical roots to prove the test fails"); }
  // Mint store in A, then read under B (B has NO trust file). To isolate root-binding from MAC failure, copy A's key into B.
  const storeA = await mintStore(A, "tmux"); writeStore(A, storeA);
  const keyDirB = path.join(B, ".pi/trust"); if (!existsSync(keyDirB)) { mkdirSync(keyDirB, { recursive: true, mode: 0o700 }); }
  writeFileSync(path.join(keyDirB, ".trust.mac"), readFileSync(path.join(A, ".pi/trust/.trust.mac")), { mode: 0o600 });
  writeFileSync(path.join(keyDirB, "default-backend.json"), JSON.stringify(storeA), { mode: 0o600 });
  const r = await readProjectTrustStore(B);
  assert.strictEqual(r.ok, false); if (!r.ok) assert.strictEqual(r.reason, "forged"); // root mismatch → forged (State H), MAC passed
});

// --- 8-test contract: author each to match name + state + flag exactly ---

test("testReadTrustStore_returnsNullWhenAbsent", async () => {
  // State A: no trust file → {ok:false, reason:"absent"}.
  const d = tmpProject();
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.reason, "absent");
});

test("testReadTrustStore_rejectsCorruptJson", async () => {
  // State C: file exists, invalid JSON → {ok:false, reason:"malformed"}.
  const d = tmpProject();
  const dir = path.join(d, ".pi/trust"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "default-backend.json"), "{ this is not valid JSON", { mode: 0o600 });
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.reason, "malformed");
});

test("testReadTrustStore_rejectsSchemaInvalid", async () => {
  // State D: JSON parses but missing/wrong-type field → {ok:false, reason:"malformed"}.
  const d = tmpProject();
  const dir = path.join(d, ".pi/trust"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Parses, but schemaVersion is wrong and defaultBackend is a number (not string).
  writeFileSync(path.join(dir, "default-backend.json"), JSON.stringify({ schemaVersion: 999, defaultBackend: 42, projectRootSha256: "x", grantedAtMs: "nope", keyGenId: "k", mac: "m" }), { mode: 0o600 });
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.reason, "malformed");
});

test("testReadTrustStore_keyAbsentTreatedAsForged", async () => {
  // State E: trust file present, .trust.mac deleted → {ok:false, reason:"forged"} (NO key creation during read).
  const d = tmpProject();
  // Mint a valid store (creates both .trust.mac and default-backend.json).
  const s = await mintStore(d, "tmux"); writeStore(d, s);
  // Now delete the MAC key — the store still exists but cannot be verified.
  rmSync(path.join(d, ".pi/trust/.trust.mac"));
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.reason, "forged");
});

test("testReadTrustStore_rejectsMalformedMac", async () => {
  // State F: mac field present but does not match /^[0-9a-f]{64}$/i → {ok:false, reason:"malformed"}.
  const d = tmpProject();
  await readOrCreateProjectTrustKey(d); // ensure key exists
  const dir = path.join(d, ".pi/trust"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Schema-valid shape, but mac is too short (not 64 hex chars).
  writeFileSync(path.join(dir, "default-backend.json"), JSON.stringify({
    schemaVersion: 1, projectRootSha256: "a", defaultBackend: "tmux", grantedAtMs: 1, keyGenId: "k", mac: "deadbeef",
  }), { mode: 0o600 });
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.reason, "malformed");
});

test("testReadTrustStore_rejectsTamperedMac", async () => {
  // State G: valid-hex MAC that fails verifyBgPayloadMac → {ok:false, reason:"forged"}.
  const d = tmpProject();
  const s = await mintStore(d, "tmux");
  // Flip a byte in the MAC (still valid hex, but wrong signature).
  const tampered = { ...s, mac: s.mac.slice(0, -1) + (s.mac.slice(-1) === "0" ? "1" : "0") };
  writeStore(d, tampered);
  const r = await readProjectTrustStore(d);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.reason, "forged");
});

test("testReadTrustStore_macAndRootBothChecked", async () => {
  // REQ-10 (both-checks G+H): wrong-MAC-valid-root → forged AND valid-MAC-wrong-root → forged.
  // Proves BOTH checks execute; ORDERING G-before-H is UNGUARDED-IN-CI via the named manual grep.
  const d = tmpProject();
  // Sub-case 1: wrong MAC + valid root → forged (State G).
  const sGood = await mintStore(d, "tmux");
  const wrongMac = { ...sGood, mac: sGood.mac.slice(0, -1) + (sGood.mac.slice(-1) === "0" ? "1" : "0") };
  writeStore(d, wrongMac);
  const r1 = await readProjectTrustStore(d);
  assert.strictEqual(r1.ok, false);
  if (!r1.ok) assert.strictEqual(r1.reason, "forged");

  // Sub-case 2: valid MAC + wrong root → forged (State H).
  // Mint under project A, copy into project B with B's actual key (so MAC verifies), then read under B.
  const A = tmpProject(); const B = tmpProject();
  const rootA = projectRootSha256(A); const rootB = projectRootSha256(B);
  assert.notStrictEqual(rootA, rootB);
  const sA = await mintStore(A, "tmux"); writeStore(A, sA);
  const bDir = path.join(B, ".pi/trust"); mkdirSync(bDir, { recursive: true, mode: 0o700 });
  // B uses its OWN key so MAC of A's store fails under B (forces root check to be the discriminator).
  // To still pass MAC under B, we'd need B's key — but that defeats the test. Instead, the discriminating
  // inverse: mint under B with A's key (so MAC passes), but with A's root hash baked in — read under B → root mismatch.
  const bKey = await readOrCreateProjectTrustKey(B);
  // Build a store whose MAC verifies under bKey but whose projectRootSha256 is A's.
  const fakeRoot = { schemaVersion: 1, projectRootSha256: rootA, defaultBackend: "tmux", grantedAtMs: Date.now(), keyGenId: "UNUSED_IN_FIXTURE" };
  const fakeMac = signBgPayload(fakeRoot, bKey);
  const forgedStore = { ...fakeRoot, mac: fakeMac };
  writeStore(B, forgedStore);
  const r2 = await readProjectTrustStore(B);
  assert.strictEqual(r2.ok, false);
  if (!r2.ok) assert.strictEqual(r2.reason, "forged");
});

// --- Group 2 (2 tests; 1 verbatim + 1 contracted) ---

test("testProjectTrustKey_isDistinctFromSessionMac", async () => {
  const d = tmpProject();
  const projectKey = await readOrCreateProjectTrustKey(d);
  const sessionKey = await readOrCreateSessionMacKey();
  assert.notStrictEqual(projectKey.toString("hex"), sessionKey.toString("hex"));
});

test("testProjectTrustKey_symlinkGuard", async () => {
  // Red-then-green: a symlinked .trust.mac THROWS (assertNoSymlinkLocal propagates); a real key file does NOT throw.
  const d = tmpProject();
  // Ensure the directory exists with a real key first (so the symlink swap is the only variable).
  const realKey = await readOrCreateProjectTrustKey(d);
  const keyPath = path.join(d, ".pi/trust/.trust.mac");
  // GREEN: real file → no throw, returns a buffer.
  const k = await readProjectTrustKey(d);
  assert.ok(Buffer.isBuffer(k));
  assert.strictEqual(k.toString("hex"), realKey.toString("hex"));
  // RED: replace with a symlink → assertNoSymlinkLocal throws.
  const target = path.join(d, ".pi/trust/.real-key-target");
  writeFileSync(target, realKey.toString("hex") + "\n", { mode: 0o600 });
  rmSync(keyPath); symlinkSync(target, keyPath);
  let threw = false;
  try { await readProjectTrustKey(d); } catch (e) { threw = true; }
  assert.ok(threw, "symlinked .trust.mac must throw via assertNoSymlinkLocal");
});

// Run summary:
await new Promise((r) => setTimeout(r, 0));
process.on("exit", () => { console.log(`${passed}/${passed+failed} passing`); if (failed > 0 || process.env.BREAK === "1" && passed > 0) process.exit(1); });