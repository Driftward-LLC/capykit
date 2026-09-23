import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHostedConfig, type HostedConfig } from "../src/hosted/config.js";
import type { DatabaseReadiness } from "../src/hosted/db.js";
import type { AuthenticatedContext } from "../src/hosted/identity.js";
import { createHostedServer } from "../src/hosted/server.js";

const origin = "https://capykit.example.test";
const config: HostedConfig = loadHostedConfig({
  CAPYKIT_PUBLIC_BASE_URL: origin, DATABASE_URL: "postgres://unused",
  CAPYKIT_AUTH_URL: "http://auth:9999",
});
const identity = { provider: "gotrue" as const, subject: "owner-1", email: "owner@example.test" };
const context: AuthenticatedContext = {
  identity, membership: { workspaceId: "workspace-a", principalId: "owner-1", principalKind: "human", role: "owner", active: true },
};
const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
function fixture(overrides: { config?: HostedConfig; consoleDirectory?: string } = {}) {
  const pool = new Pool();
  const database = {
    pool, close: () => pool.end(),
    readiness: vi.fn((): Promise<DatabaseReadiness> => Promise.resolve({ status: "ready", reason: "ok" })),
    resolveContext: vi.fn((): Promise<AuthenticatedContext | undefined> => Promise.resolve(context)),
  };
  const auth = {
    requestOtp: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    verifyOtp: vi.fn((): Promise<string | undefined> => Promise.resolve("verified-token")),
    verifyBearer: vi.fn((token: string) => Promise.resolve(token === "verified-token" ? identity : undefined)),
  };
  const app = createHostedServer({ config, database, auth, ...overrides });
  apps.push(app);
  return { app, auth, database };
}

describe("hosted HTTP boundaries", () => {
  it("verifies an email code before issuing private session cookies and resolving current identity", async () => {
    const { app, auth, database } = fixture();
    const request = await app.inject({ method: "POST", url: "/v1/auth/otp", headers: { origin }, payload: { email: "Owner@example.test" } });
    expect(request.statusCode).toBe(202);
    expect(auth.requestOtp).toHaveBeenCalledWith("owner@example.test", origin);
    const verified = await app.inject({ method: "POST", url: "/v1/auth/verify", headers: { origin }, payload: { email: identity.email, token: "123456" } });
    expect(verified.statusCode).toBe(200);
    expect(verified.body).not.toContain("verified-token");
    expect(auth.verifyBearer).toHaveBeenCalledWith("verified-token");
    expect(verified.cookies.find(({ name }) => name === "capykit_session")).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    const cookie = verified.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const me = await app.inject({ url: "/v1/me", headers: { cookie, "x-workspace-id": "workspace-b", "x-request-id": "untrusted-supplied-id" } });
    expect(me.statusCode).toBe(200);
    expect(me.json<unknown>()).toEqual({ identity: { email: identity.email, principalKind: "human" }, workspace: { id: "workspace-a", role: "owner" } });
    expect(me.headers["x-request-id"]).not.toBe("untrusted-supplied-id");
    expect(database.resolveContext).toHaveBeenCalledTimes(2);
    database.resolveContext.mockResolvedValueOnce(undefined);
    expect((await app.inject({ url: "/v1/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("rejects expired codes, forged tokens, unknown identities, and inactive membership without cookies", async () => {
    const { app, auth, database } = fixture();
    auth.verifyOtp.mockResolvedValueOnce(undefined);
    const invalid = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email: identity.email, token: "654321" } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.cookies).toHaveLength(0);
    expect((await app.inject({ url: "/v1/me", headers: { authorization: "Bearer forged" } })).statusCode).toBe(401);
    database.resolveContext.mockResolvedValueOnce(undefined);
    expect((await app.inject({ method: "POST", url: "/v1/auth/session", headers: { authorization: "Bearer verified-token" } })).statusCode).toBe(401);
    database.resolveContext.mockResolvedValueOnce({ ...context, membership: { ...context.membership, active: false } });
    const inactive = await app.inject({ method: "POST", url: "/v1/auth/session", headers: { authorization: "Bearer verified-token" } });
    expect(inactive.statusCode).toBe(401);
    expect(inactive.cookies).toHaveLength(0);
  });

  it("requires same-origin CSRF for cookie-authenticated mutations, including session renewal", async () => {
    const { app, auth } = fixture();
    const cookie = "capykit_session=verified-token; capykit_csrf=csrf-proof";
    for (const headers of [
      { cookie }, { cookie, origin }, { cookie, origin, "x-csrf-token": "wrong" },
      { cookie, origin: "https://other.example.test", "x-csrf-token": "csrf-proof" },
    ]) {
      expect((await app.inject({ method: "POST", url: "/v1/auth/session", headers })).statusCode).toBe(403);
    }
    const renewed = await app.inject({ method: "POST", url: "/v1/auth/session", headers: { cookie, origin, "x-csrf-token": "csrf-proof" } });
    expect(renewed.statusCode).toBe(200);
    const csrf = renewed.cookies.find(({ name }) => name === "capykit_csrf")?.value ?? "";
    expect(csrf).not.toBe("");
    const newCookie = renewed.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const logout = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie: newCookie, origin, "x-csrf-token": csrf } });
    expect(logout.statusCode).toBe(200);
    expect(logout.cookies).toHaveLength(2);
    expect(logout.cookies.every(({ value }) => value === "")).toBe(true);
    expect(auth.signOut).toHaveBeenCalledWith("verified-token");
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", headers: { origin: "https://other.example.test" }, payload: { email: identity.email, token: "123456" } })).statusCode).toBe(403);
  });

  it("validates OTP inputs and callback origins without leaking submitted data", async () => {
    const { app, auth } = fixture();
    for (const redirectTo of ["not a URL", "https://capykit.example.test.evil.test", "https://user:password@capykit.example.test"]) {
      const reply = await app.inject({ method: "POST", url: "/v1/auth/otp", payload: { email: identity.email, redirectTo } });
      expect(reply.statusCode).toBe(400);
      expect(reply.body).not.toContain(redirectTo);
    }
    expect(auth.requestOtp).not.toHaveBeenCalled();
    const malformed = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email: identity.email, token: "SENTINEL_BAD_CODE" } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain("SENTINEL");
  });

  it("reports unavailable configuration/database with a failing HTTP readiness status", async () => {
    const { app, database } = fixture();
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
    database.readiness.mockResolvedValueOnce({ status: "unavailable", reason: "connection_failed" });
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(503);
    database.readiness.mockRejectedValueOnce(new Error("SENTINEL_DATABASE_DETAIL"));
    const failure = await app.inject({ url: "/health/ready" });
    expect(failure.statusCode).toBe(500);
    expect(failure.body).not.toContain("SENTINEL");
    const incomplete = fixture({ config: { ...config, authUrl: undefined } });
    const unready = await incomplete.app.inject({ url: "/health/ready" });
    expect(unready.statusCode).toBe(503);
    expect(unready.json<unknown>()).toMatchObject({ status: "unavailable", missing: ["CAPYKIT_AUTH_URL"] });
    const unconfigured = createHostedServer({ config: loadHostedConfig({}) });
    apps.push(unconfigured);
    expect((await unconfigured.inject({ url: "/health/ready" })).statusCode).toBe(503);
    expect((await unconfigured.inject({ url: "/health/live" })).statusCode).toBe(200);
  });

  it("sanitizes database and provider errors and returns server-generated request IDs", async () => {
    const { app, database, auth } = fixture();
    database.resolveContext.mockRejectedValueOnce(new Error("SENTINEL_PRIVATE_DATABASE_DETAIL"));
    auth.requestOtp.mockRejectedValueOnce(new Error("SENTINEL_PROVIDER_TOKEN"));
    const failures = [
      await app.inject({ url: "/v1/me", headers: { authorization: "Bearer verified-token" } }),
      await app.inject({ method: "POST", url: "/v1/auth/otp", payload: { email: identity.email } }),
    ];
    for (const response of failures) {
      expect(response.statusCode).toBe(500);
      expect(response.json<unknown>()).toEqual({ error: { code: "INTERNAL_ERROR", requestId: response.headers["x-request-id"] } });
      expect(response.body).not.toContain("SENTINEL");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("serves the console and assets without allowing traversal or serving other files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capykit-console-"));
    directories.push(directory);
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), '<script type="module" src="/assets/index-test.js"></script>');
    await writeFile(join(directory, "assets/index-test.js"), "document.title = 'Console';");
    await writeFile(join(directory, "private.txt"), "SENTINEL_PRIVATE_FILE");
    const { app } = fixture({ consoleDirectory: directory });
    const template = await app.inject({ url: "/auth/email-template" });
    expect(template.statusCode).toBe(200);
    expect(template.headers["content-type"]).toContain("text/html");
    expect(template.body).toContain("{{ .Token }}");
    expect(template.body).not.toContain("{{ .ConfirmationURL }}");
    const root = await app.inject({ url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("/assets/index-test.js");
    const asset = await app.inject({ url: "/assets/index-test.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    for (const url of ["/assets/missing.js", "/assets/..%2Fprivate.txt", "/assets/index-test.js.map", "/private.txt"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body).not.toContain("SENTINEL");
    }
  });

  it("rejects invalid/public insecure deployment URLs without echoing configuration values", () => {
    for (const value of ["bad-SENTINEL", "https://user:SENTINEL@example.test", "http://public.example.test", "https://example.test/path"]) {
      expect(() => loadHostedConfig({ CAPYKIT_PUBLIC_BASE_URL: value })).toThrow(/Hosted URLs/u);
    }
    expect(loadHostedConfig({ CAPYKIT_PUBLIC_BASE_URL: "https://capykit.example.test/" }).publicBaseUrl).toBe(origin);
    expect(loadHostedConfig({ CAPYKIT_PUBLIC_BASE_URL: "http://localhost:3000" }).secureCookies).toBe(false);
    expect(loadHostedConfig({ CAPYKIT_AUTH_URL: "http://auth:9999/" }).authUrl).toBe("http://auth:9999");
    for (const value of ["invalid-provider-url", "ftp://auth:9999", "http://user:secret@auth:9999", "http://auth:9999/path", "http://auth:9999?secret=value", "http://auth:9999#fragment"]) {
      expect(() => loadHostedConfig({ CAPYKIT_AUTH_URL: value })).toThrow(/Authentication URL/u);
    }
  });
});
