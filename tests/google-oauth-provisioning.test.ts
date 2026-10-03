import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const directories: string[] = [];
const origin = "https://capykit.example.test:19121";
const callback = `${origin}/v1/connections/google/callback`;
const client = { web: { project_id: "capykit-preview", client_id: "123-preview.apps.googleusercontent.com", client_secret: "test-secret-1234", auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token", redirect_uris: [callback] } };
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(input: unknown = client) {
  const directory = await mkdtemp(join(tmpdir(), "capykit-google-config-")); directories.push(directory);
  const source = join(directory, "download.json"), target = join(directory, "google.env");
  await writeFile(source, JSON.stringify(input), { mode: 0o600 });
  const run = (changes: Record<string, string> = {}) => spawnSync(process.execPath, ["scripts/configure-google-oauth.mjs"], { encoding: "utf8", timeout: 5000, env: { ...process.env, CAPYKIT_PUBLIC_BASE_URL: origin, CAPYKIT_GOOGLE_CLIENT_FILE: source, CAPYKIT_GOOGLE_ENV_FILE: target, ...changes } });
  return { source, target, directory, run };
}
describe.skipIf(process.platform === "win32")("operator Google OAuth import", () => {
  it("imports Google's Web client, writes a private env file and generates a durable encryption key without printing credentials", async () => {
    const { target, run } = await fixture(); const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "configured", callbackUrl: callback, restartRequired: true, encryptionKeyPreserved: false });
    const contents = await readFile(target, "utf8");
    expect(contents).toContain(`CAPYKIT_GOOGLE_CLIENT_ID=${client.web.client_id}`);
    expect(contents).toContain(`CAPYKIT_GOOGLE_CLIENT_SECRET=${client.web.client_secret}`);
    const key = contents.match(/^CAPYKIT_GOOGLE_ENCRYPTION_KEY=(.+)$/mu)?.[1] ?? "";
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(result.stdout + result.stderr).not.toContain(client.web.client_secret);
    expect(result.stdout + result.stderr).not.toContain(key);
  });
  it("refuses overlapping imports without removing another operator's lock", async () => {
    const { target, run } = await fixture();
    await writeFile(`${target}.lock`, "", { mode: 0o600 });
    expect(run().status).toBe(1);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(`${target}.lock`, "utf8")).toBe("");
  });
  it("preserves the encryption key while rotating the same client's secret", async () => {
    const { target, source, run } = await fixture(); expect(run().status).toBe(0);
    const before = await readFile(target, "utf8");
    await writeFile(source, JSON.stringify({ web: { ...client.web, client_secret: "rotated-secret-12" } }));
    const result = run(); expect(result.status).toBe(0);
    const after = await readFile(target, "utf8");
    expect(after.split("CAPYKIT_GOOGLE_ENCRYPTION_KEY=")[1]).toEqual(before.split("CAPYKIT_GOOGLE_ENCRYPTION_KEY=")[1]);
    expect(after).toContain("rotated-secret-12");
    expect(result.stdout + result.stderr).not.toContain("rotated-secret-12");
  });
  it.each([
    { installed: client.web },
    { web: { ...client.web, redirect_uris: [`${origin}/wrong`] } },
    { web: { ...client.web, redirect_uris: [callback.replace(":19121", "")] } },
    { web: { ...client.web, client_secret: "secret\nCAPYKIT_AUTH_URL=http://evil" } },
    { web: { ...client.web, auth_uri: "https://evil.test" } },
  ])("rejects invalid Web clients without creating configuration", async input => {
    const { target, run } = await fixture(input); const result = run(); expect(result.status).toBe(1);
    expect(result.stdout).toBe(""); expect(result.stderr).not.toContain(client.web.client_secret);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a different client, a malformed existing key and permissive/symlink targets without changing prior data", async () => {
    const { target, run, directory } = await fixture();
    const valid = `CAPYKIT_GOOGLE_CLIENT_ID=${client.web.client_id}\nCAPYKIT_GOOGLE_CLIENT_SECRET=${client.web.client_secret}\nCAPYKIT_GOOGLE_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\n`;
    for (const old of [valid.replace(client.web.client_id, "different.apps.googleusercontent.com"), valid.replace(/CAPYKIT_GOOGLE_ENCRYPTION_KEY=.+/u, "CAPYKIT_GOOGLE_ENCRYPTION_KEY=invalid")]) {
      await writeFile(target, old, { mode: 0o600 }); expect(run().status).toBe(1); expect(await readFile(target, "utf8")).toBe(old);
    }
    await rm(target); await writeFile(target, valid, { mode: 0o644 }); expect(run().status).toBe(1); expect(await readFile(target, "utf8")).toBe(valid);
    await rm(target); const real = join(directory, "real.env"); await writeFile(real, valid, { mode: 0o600 }); await symlink(real, target);
    expect(run().status).toBe(1); expect(await readFile(real, "utf8")).toBe(valid);
  });
});

it.skipIf(process.platform !== "win32")("refuses importing credentials on Windows without POSIX permissions", async () => {
  const { target, run } = await fixture();
  const result = run();
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain(client.web.client_secret);
  await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});
