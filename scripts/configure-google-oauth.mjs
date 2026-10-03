import { randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Operator-only import of Google's downloaded Web application JSON. Never log it.
// GOOGLE_CLIENT_FILE is a private file path, not a credential value in argv.
const env = process.env;
let temporary;
let lock;
try {
  // This Linux/Unix deployment helper relies on POSIX private-file permissions.
  if (process.platform === "win32") throw new Error("unsupported platform");
  const origin = new URL(env.CAPYKIT_PUBLIC_BASE_URL ?? "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("origin");
  const callbackUrl = `${origin.origin}/v1/connections/google/callback`;
  if (!env.CAPYKIT_GOOGLE_CLIENT_FILE || !env.CAPYKIT_GOOGLE_ENV_FILE) throw new Error("paths");
  const source = resolve(env.CAPYKIT_GOOGLE_CLIENT_FILE);
  const target = resolve(env.CAPYKIT_GOOGLE_ENV_FILE);
  if (source === target) throw new Error("paths");
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.size > 32 * 1024) throw new Error("source");
  const input = JSON.parse(await readFile(source, "utf8"));
  const web = input?.web;
  if (!web || input.installed || typeof web.project_id !== "string" || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(web.project_id) ||
      typeof web.client_id !== "string" || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(web.client_id) ||
      typeof web.client_secret !== "string" || !/^[A-Za-z0-9_-]{16,256}$/u.test(web.client_secret) ||
      web.auth_uri !== "https://accounts.google.com/o/oauth2/auth" || web.token_uri !== "https://oauth2.googleapis.com/token" ||
      !Array.isArray(web.redirect_uris) || !web.redirect_uris.includes(callbackUrl)) throw new Error("web client");
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory()) throw new Error("parent");
  // Serialize operator imports so concurrent setup cannot replace a new key.
  const lockPath = `${target}.lock`;
  lock = { path: lockPath, file: await open(lockPath, "wx", 0o600) };
  let old = "";
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.size > 32 * 1024 || (targetInfo.mode & 0o077) !== 0) throw new Error("target");
    old = await readFile(target, "utf8");
    if (!old.trim()) throw new Error("empty configuration");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const names = ["CAPYKIT_GOOGLE_CLIENT_ID", "CAPYKIT_GOOGLE_CLIENT_SECRET", "CAPYKIT_GOOGLE_ENCRYPTION_KEY"];
  const values = new Map();
  for (const line of old.split(/\r?\n/u)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const index = line.indexOf("=");
    const name = line.slice(0, index);
    if (index < 0 || !names.includes(name) || values.has(name)) throw new Error("existing configuration");
    values.set(name, line.slice(index + 1));
  }
  // Do not silently switch projects/clients or invalidate stored connection ciphertext.
  if (old && (values.size !== 3 || values.get(names[0]) !== web.client_id)) throw new Error("existing client");
  const encryptionKey = values.get(names[2]) ?? randomBytes(32).toString("base64");
  const keyBytes = Buffer.from(encryptionKey, "base64");
  if (keyBytes.length !== 32 || keyBytes.toString("base64") !== encryptionKey) throw new Error("existing key");
  const contents = `${names[0]}=${web.client_id}\n${names[1]}=${web.client_secret}\n${names[2]}=${encryptionKey}\n`;
  temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
  await rename(temporary, target);
  temporary = undefined;
  console.log(JSON.stringify({ status: "configured", callbackUrl, restartRequired: true, encryptionKeyPreserved: old !== "" }));
} catch {
  console.error("Google OAuth import failed. Run on Linux/Unix and provide a dedicated Google Web client JSON with the exact HTTPS callback and a private destination. Existing clients and encryption keys cannot be replaced implicitly. No credential values were printed.");
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { force: true });
  if (lock) { await lock.file.close(); await rm(lock.path); }
}
