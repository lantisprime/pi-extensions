// agents/lib/bg-trust.ts
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
// NOTE: assertNoSymlink + readUtf8FileNoSymlink are PRIVATE in bg-state.ts (L619, L742) and
// NOT exported. bg-trust.ts inlines local equivalents (assertNoSymlinkLocal / readUtf8FileNoSymlinkLocal)
// below — INV-2 forbids importing the private helpers. Only the EXPORTED signing primitives
// (signBgPayload/verifyBgPayloadMac/keyGenIdFromKey, bg-state.ts:203/207/214) are imported.
import { signBgPayload, verifyBgPayloadMac, keyGenIdFromKey } from "./bg-state.ts";

export const PROJECT_TRUST_SCHEMA_VERSION = 1;
export const PROJECT_TRUST_DIR = ".pi/trust";
export const PROJECT_TRUST_FILE = "default-backend.json";
export const PROJECT_TRUST_MAC_FILE = ".trust.mac";
export const PROJECT_TRUST_MAC_BYTES = 32;

const MAC_HEX_RE = /^[0-9a-f]{64}$/i;
const RESOLVE_ROOT_ERR = "resolveProjectRoot: no .pi or .git ancestor for ";

export type ProjectTrustStore = {
  schemaVersion: 1;
  projectRootSha256: string;
  defaultBackend: string;
  grantedAtMs: number;
  keyGenId: string;
  mac: string;
};

export type ProjectTrustReadResult =
  | { ok: true; store: ProjectTrustStore }
  | { ok: false; reason: "absent" | "forged" | "malformed" | "symlink" };

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function resolveProjectRoot(dir: string): string {
  // OD-1 resolved: nearest ancestor of fs.realpathSync(dir) containing .pi/ OR .git/ (whichever first walking up).
  let current = realpathSync(dir);
  while (true) {
    if (existsSync(path.join(current, ".pi"))) return current;
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(RESOLVE_ROOT_ERR + dir);
    current = parent;
  }
}

export function projectRootSha256(projectDir: string): string {
  return sha256Hex(resolveProjectRoot(projectDir));
}

function trustFilePath(projectDir: string): string {
  return path.join(projectDir, PROJECT_TRUST_DIR, PROJECT_TRUST_FILE);
}

function projectTrustMacPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_TRUST_DIR, PROJECT_TRUST_MAC_FILE);
}

function ensureProjectTrustDir(projectDir: string): string {
  const dir = path.join(projectDir, PROJECT_TRUST_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Local no-follow helpers — mirrors of the PRIVATE assertNoSymlink (bg-state.ts:619-625)
// and readUtf8FileNoSymlink (bg-state.ts:742-754). Inlined here because the originals
// are module-private in bg-state.ts (NOT exported) and INV-2 forbids importing private
// state. assertNoSymlinkLocal throws on symlink, no-ops on ENOENT. readUtf8FileNoSymlinkLocal
// opens with O_NOFOLLOW and optionally enforces 0o077 perms (requirePrivate).

async function assertNoSymlinkLocal(targetPath: string, label: string): Promise<void> {
  try {
    const s = await lstat(targetPath);
    if (s.isSymbolicLink()) throw new Error(`refusing symlinked ${label}: ${targetPath}`);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

async function readUtf8FileNoSymlinkLocal(
  filePath: string,
  label: string,
  options: { requirePrivate?: boolean } = {},
): Promise<string> {
  const handle = await open(filePath, constants.O_NOFOLLOW | constants.O_RDONLY);
  try {
    const s = await handle.stat();
    if (!s.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
    if (options.requirePrivate && (s.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be readable by group or others: ${filePath}`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

// READ-ONLY key read — used by readProjectTrustStore. Does NOT create (State E: absent
// key → ENOENT → caller maps to "forged"). Symlinked key → throws (propagates per the
// Contract error-codes table; distinct from the trust-file symlink → union value).
export async function readProjectTrustKey(projectDir: string): Promise<Buffer> {
  const keyPath = projectTrustMacPath(projectDir);
  await assertNoSymlinkLocal(keyPath, "project trust MAC key");
  const text = await readUtf8FileNoSymlinkLocal(keyPath, "project trust MAC key", { requirePrivate: true });
  return parseTrustMac(text, keyPath);
}

// readOrCreateProjectTrustKey is the WRITER-side (P5F-2 writeProjectTrustStore). Mirrors
// the session-MAC primitive at bg-state.ts:167-189 but delegates the READ path to
// readProjectTrustKey above; on ENOENT it mints a new key (0600, flag wx). Declared here
// for type-completeness — the READER never calls it.
export async function readOrCreateProjectTrustKey(
  projectDir: string,
  randomBytes: (size: number) => Buffer = cryptoRandomBytes,
): Promise<Buffer> {
  ensureProjectTrustDir(projectDir);
  try {
    return await readProjectTrustKey(projectDir);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const key = randomBytes(PROJECT_TRUST_MAC_BYTES);
  const text = `${key.toString("hex")}\n`;
  try {
    writeFileSync(projectTrustMacPath(projectDir), text, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return await readProjectTrustKey(projectDir);
    throw error;
  }
}

function parseTrustMac(text: string, keyPath: string): Buffer {
  const hex = text.trim();
  if (hex.length !== PROJECT_TRUST_MAC_BYTES * 2 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`project trust MAC key at ${keyPath} is malformed (expected ${PROJECT_TRUST_MAC_BYTES * 2} hex chars)`);
  }
  return Buffer.from(hex, "hex");
}

export async function readProjectTrustStore(projectDir: string): Promise<ProjectTrustReadResult> {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) {
    throw new TypeError("readProjectTrustStore: projectDir must be an absolute path");
  }
  const filePath = trustFilePath(projectDir);
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { ok: false, reason: "absent" };
    throw error;
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: "symlink" };
  let parsed: unknown;
  try {
    const raw = await readUtf8FileNoSymlinkLocal(filePath, "project trust store");
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isValidTrustStoreShape(parsed)) return { ok: false, reason: "malformed" };
  const store = parsed as ProjectTrustStore;
  // REQ-10: MAC verified BEFORE root compare (timing-oracle mitigation).
  if (!MAC_HEX_RE.test(store.mac)) return { ok: false, reason: "malformed" };
  let projectKey: Buffer;
  try {
    // READ-ONLY key read (does NOT create — State E: absent key → ENOENT → "forged").
    // The REQ-2 carve-out preserves the symlinked-key THROW (security boundary);
    // all other non-ENOENT failures (malformed content from parseTrustMac, EACCES/EPERM,
    // anything else) map to {ok:false, reason:"forged"} per REQ-1/REQ-3 fail-closed contract.
    projectKey = await readProjectTrustKey(projectDir);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { ok: false, reason: "forged" };
    if (error instanceof Error && error.message.startsWith("refusing symlinked ")) throw error;
    return { ok: false, reason: "forged" };
  }
  const { mac, ...storeWithoutMac } = store;
  if (!verifyBgPayloadMac(storeWithoutMac, projectKey, mac)) {
    return { ok: false, reason: "forged" };
  }
  if (store.projectRootSha256 !== projectRootSha256(projectDir)) {
    return { ok: false, reason: "forged" };
  }
  return { ok: true, store };
}

function isValidTrustStoreShape(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.schemaVersion === PROJECT_TRUST_SCHEMA_VERSION &&
    typeof o.projectRootSha256 === "string" &&
    typeof o.defaultBackend === "string" &&
    typeof o.grantedAtMs === "number" &&
    typeof o.keyGenId === "string" &&
    typeof o.mac === "string"
  );
}