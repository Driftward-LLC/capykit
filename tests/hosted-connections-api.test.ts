import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHostedServer } from "../src/hosted/server.js";
import { createHostedDatabase } from "../src/hosted/db.js";
import { loadHostedConfig } from "../src/hosted/config.js";
import { GithubError, GithubProvider, type GithubConfig, type InstallationCandidate } from "../src/hosted/github.js";
import type { ConnectionRecord, PendingConnectionSetup } from "../src/hosted/connections.js";

const databaseUrl = process.env.CAPYKIT_TEST_POSTGRES_URL;
const origin = "https://capykit.example.test";
const githubConfig: GithubConfig = {
  appId: "42", appSlug: "capykit-test", clientId: "Iv1.test", clientSecret: "CLIENT_SECRET_SENTINEL", privateKey: "PRIVATE_KEY_SENTINEL",
  webhookSecret: "http-test-webhook-secret-at-least-32-characters", encryptionKey: Buffer.alloc(32, 6), keyVersion: "v1", callbackUrl: `${origin}/v1/connections/github/callback`,
};
interface Started { connectionId: string; setupId: string; authorizationUrl: string; installationUrl: string }
const cookie = "capykit_session=owner; capykit_csrf=csrf-test";
const browserHeaders = { cookie, origin, "x-csrf-token": "csrf-test" };
const ownerHeaders = { authorization: "Bearer owner" };

describe.skipIf(databaseUrl === undefined)("GitHub connection HTTP and PostgreSQL boundary", () => {
  const schema = `capykit_connections_api_${randomUUID().replaceAll("-", "")}`;
  const runtimeRole = `${schema}_runtime`;
  const admin = new Pool({ connectionString: databaseUrl });
  const scoped = new URL(databaseUrl ?? "postgres://localhost/capykit_test");
  scoped.searchParams.set("options", `-c search_path=${schema},public -c role=${runtimeRole}`);
  const identities = new Map<string, { provider: "gotrue"; subject: string; email: string }>();
  const workspaces = [randomUUID(), randomUUID()];
  const apps: FastifyInstance[] = [];
  const github = new GithubProvider(githubConfig, vi.fn<typeof fetch>().mockRejectedValue(new Error("Live GitHub calls forbidden in HTTP tests")));
  const exchange = vi.spyOn(github, "exchange").mockResolvedValue({ accessToken: "USER_TOKEN_SENTINEL", refreshToken: "REFRESH_TOKEN_SENTINEL", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const revoke = vi.spyOn(github, "revokeUserToken").mockResolvedValue(undefined);
  vi.spyOn(github, "user").mockResolvedValue({ id: "300", login: "owner" });
  const candidates = vi.spyOn(github, "candidates");
  const recheck = vi.spyOn(github, "recheck");
  let directory: string;
  let app: FastifyInstance;
  let ownerPrincipal: string;
  let nextInstallation = 100;

  function server(configured = true): FastifyInstance {
    const database = createHostedDatabase(scoped.toString());
    if (!database) throw new Error("Missing disposable test database");
    const result = createHostedServer({ database, consoleDirectory: directory,
      config: loadHostedConfig({ DATABASE_URL: scoped.toString(), CAPYKIT_PUBLIC_BASE_URL: origin, CAPYKIT_AUTH_URL: "http://auth:9999" }),
      ...(configured ? { githubConfig, githubProvider: github } : {}),
      auth: { verifyBearer: (token) => Promise.resolve(identities.get(token)), verifyOtp: () => Promise.resolve(undefined), requestOtp: async () => {}, signOut: async () => {} },
    });
    apps.push(result);
    return result;
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "capykit-connections-api-"));
    await writeFile(join(directory, "index.html"), '<!doctype html><html><head><title>Capykit</title></head><body><div id="app"></div><script src="/assets/main.js"></script></body></html>');
    await admin.query(`create schema ${schema}`);
    const client = await admin.connect();
    try {
      await client.query(`set search_path=${schema},public`);
      for (const name of ["001_hosted_workspace_identity.sql", "002_hosted_database_access.sql", "003_hosted_capabilities.sql", "004_hosted_connections.sql"]) {
        await client.query((await readFile(new URL(`../scripts/migrations/${name}`, import.meta.url), "utf8")).replaceAll("capykit_runtime", runtimeRole));
      }
      for (const id of workspaces) await client.query("insert into workspaces(id,slug,name) values($1,$2,'Connection HTTP test')", [id, id]);
      for (const [token, workspace, kind, role] of [
        ["owner", workspaces[0], "human", "owner"], ["member", workspaces[0], "human", "member"],
        ["agent", workspaces[0], "agent", "owner"], ["other-owner", workspaces[1], "human", "owner"],
      ]) {
        if (!token) throw new Error("Invalid identity fixture");
        const id = randomUUID();
        const subject = randomUUID();
        if (token === "owner") ownerPrincipal = id;
        identities.set(token, { provider: "gotrue", subject, email: `${token}@example.test` });
        await client.query("insert into principals(id,workspace_id,kind,display_name) values($1,$2,$3,$4)", [id, workspace, kind, token]);
        await client.query("insert into workspace_memberships(workspace_id,principal_id,role) values($1,$2,$3)", [workspace, id, role]);
        await client.query("insert into identity_bindings(principal_id,provider,provider_subject,email,verified_at) values($1,'gotrue',$2,$3,now())", [id, subject, `${token}@example.test`]);
      }
    } finally { client.release(); }
    app = server();
  });
  afterAll(async () => {
    for (const instance of apps) await instance.close();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.query(`drop role if exists ${runtimeRole}`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  function noCredentials(body: string): void {
    for (const secret of ["USER_TOKEN_SENTINEL", "REFRESH_TOKEN_SENTINEL", "CLIENT_SECRET_SENTINEL", "PRIVATE_KEY_SENTINEL", "PROVIDER_DETAIL_SENTINEL"]) expect(body).not.toContain(secret);
  }
  async function start(): Promise<Started> {
    const response = await app.inject({ method: "POST", url: "/v1/connections/github/start", headers: browserHeaders, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    noCredentials(response.body);
    return response.json<Started>();
  }
  async function activeConnection(): Promise<ConnectionRecord> {
    const installationId = String(nextInstallation++);
    const candidate: InstallationCandidate = { installationId, account: { id: "200", login: "test-team", type: "Organization" }, repositories: [{ id: "123", fullName: "test-team/repo", url: "https://github.com/test-team/repo", admin: true }], permissions: { issues: "read", metadata: "read" } };
    candidates.mockResolvedValueOnce([candidate]);
    recheck.mockResolvedValueOnce(candidate);
    const started = await start();
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const callback = await app.inject({ method: "POST", url: "/v1/connections/github/callback", headers: browserHeaders, payload: { code: "TEST_AUTHORIZATION_CODE", state } });
    expect(callback.statusCode, callback.body).toBe(200);
    noCredentials(callback.body);
    const pending = callback.json<PendingConnectionSetup>();
    expect(pending.setupId).toBe(started.setupId);
    expect(pending.candidates).toEqual([candidate]);
    const inspect = await app.inject({ url: `/v1/connections/github/pending/${pending.setupId}`, headers: browserHeaders });
    expect(inspect.statusCode, inspect.body).toBe(200);
    noCredentials(inspect.body);
    const confirmed = await app.inject({ method: "POST", url: "/v1/connections/github/confirm", headers: browserHeaders, payload: { setupId: pending.setupId, installationId, repositoryIds: ["123"], consent: true } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    noCredentials(confirmed.body);
    const result = confirmed.json<ConnectionRecord>();
    expect(result).toMatchObject({ id: started.connectionId, status: "active", installationId, repositories: [{ id: "123", fullName: "test-team/repo" }] });
    expect(revoke).toHaveBeenCalledWith("USER_TOKEN_SENTINEL");
    return result;
  }

  it("serves a static callback without cookies or reflected OAuth data before authenticated same-origin continuation", async () => {
    const before = exchange.mock.calls.length;
    const callback = await app.inject({ url: "/v1/connections/github/callback?code=AUTHORIZATION_CODE_SENTINEL&state=STATE_SENTINEL", headers: { referer: "https://github.com/", "sec-fetch-site": "cross-site" } });
    expect(callback.statusCode).toBe(200);
    expect(callback.headers["content-type"]).toContain("text/html");
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(callback.headers["referrer-policy"]).toBe("no-referrer");
    expect(callback.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(callback.body).toBe((await app.inject({ url: "/" })).body);
    expect(callback.body).not.toMatch(/AUTHORIZATION_CODE_SENTINEL|STATE_SENTINEL/u);
    expect(exchange.mock.calls.length).toBe(before);
    const anonymous = await app.inject({ method: "POST", url: "/v1/connections/github/callback", payload: { code: "TEST_AUTHORIZATION_CODE", state: "A".repeat(43) } });
    expect(anonymous.statusCode).toBe(401);
  });

  it("connects, inspects, persists across server restart and disconnects through authenticated browser requests", async () => {
    const connected = await activeConnection();
    const listed = await app.inject({ url: "/v1/connections", headers: browserHeaders });
    expect(listed.json<{ configured: boolean }>().configured).toBe(true);
    expect(listed.json<{ connections: ConnectionRecord[] }>().connections.some((entry) => entry.id === connected.id && entry.status === "active")).toBe(true);
    noCredentials(listed.body);
    await app.close(); app = server();
    const detail = await app.inject({ url: `/v1/connections/${connected.id}`, headers: browserHeaders });
    expect(detail.json<ConnectionRecord>().status).toBe("active");
    expect(detail.headers["cache-control"]).toBe("no-store");
    noCredentials(detail.body);
    const deletion = await app.inject({ method: "DELETE", url: `/v1/connections/${connected.id}`, headers: browserHeaders });
    expect(deletion.statusCode).toBe(204);
    expect((await app.inject({ url: `/v1/connections/${connected.id}`, headers: browserHeaders })).json<ConnectionRecord>().status).toBe("revoked");
  });

  it("requires CSRF/origin for cookie mutations and denies inactive, member, agent and foreign-workspace requests", async () => {
    for (const headers of [{ cookie, origin }, { cookie, origin: "https://evil.example", "x-csrf-token": "csrf-test" }, { cookie, "x-csrf-token": "csrf-test" }]) {
      const denied = await app.inject({ method: "POST", url: "/v1/connections/github/start", headers, payload: {} });
      expect(denied.statusCode).toBe(403);
      expect(denied.json<{ error: { code: string } }>().error.code).toBe("CSRF_REQUIRED");
    }
    const started = await start();
    for (const token of ["member", "agent", "other-owner"]) {
      const headers = { authorization: `Bearer ${token}` };
      const expected = token === "other-owner" ? 404 : 403;
      expect((await app.inject({ url: `/v1/connections/${started.connectionId}`, headers })).statusCode).toBe(expected);
      expect((await app.inject({ method: "DELETE", url: `/v1/connections/${started.connectionId}`, headers })).statusCode).toBe(expected);
      expect((await app.inject({ method: "POST", url: "/v1/connections/github/start", headers, payload: { connectionId: started.connectionId } })).statusCode).toBe(expected);
      if (token !== "other-owner") expect((await app.inject({ url: "/v1/connections", headers })).statusCode).toBe(403);
    }
    await admin.query(`update ${schema}.workspace_memberships set active=false where principal_id=$1`, [ownerPrincipal]);
    try { expect((await app.inject({ url: "/v1/connections", headers: ownerHeaders })).statusCode).toBe(401); }
    finally { await admin.query(`update ${schema}.workspace_memberships set active=true where principal_id=$1`, [ownerPrincipal]); }
    expect((await app.inject({ method: "DELETE", url: `/v1/connections/github/pending/${started.setupId}`, headers: browserHeaders })).statusCode).toBe(204);
  });

  it("reports absent configuration while preserving authenticated metadata browsing and refusing setup/webhooks", async () => {
    const unavailable = server(false);
    const listed = await unavailable.inject({ url: "/v1/connections", headers: ownerHeaders });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ configured: boolean; installationUrl: null }>()).toMatchObject({ configured: false, installationUrl: null });
    const start = await unavailable.inject({ method: "POST", url: "/v1/connections/github/start", headers: ownerHeaders, payload: {} });
    expect(start.statusCode).toBe(503);
    expect(start.json<{ error: { code: string } }>().error.code).toBe("CONFIGURATION_UNAVAILABLE");
    expect((await unavailable.inject({ method: "POST", url: "/v1/webhooks/github", payload: {} })).statusCode).toBe(503);
  });

  it("authenticates exact raw webhook bytes, validates headers/JSON and preserves normal API JSON parsing", async () => {
    const connected = await activeConnection();
    const raw = ` { "action": "suspend", "installation": { "id": ${connected.installationId ?? "0"} } } `;
    const signedHeaders = (body: string) => ({ "content-type": "application/json", "x-github-event": "installation", "x-github-delivery": randomUUID(), "x-hub-signature-256": `sha256=${createHmac("sha256", githubConfig.webhookSecret).update(body).digest("hex")}` });
    expect((await app.inject({ method: "POST", url: "/v1/webhooks/github", headers: { "content-type": "application/json" }, payload: raw })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/webhooks/github", headers: signedHeaders(raw.trim()), payload: raw })).statusCode).toBe(401);
    const invalidHeader = await app.inject({ method: "POST", url: "/v1/webhooks/github", headers: { ...signedHeaders(raw), "x-github-event": "invalid event" }, payload: raw });
    expect(invalidHeader.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/webhooks/github", headers: signedHeaders("{"), payload: "{" })).statusCode).toBe(400);
    const accepted = await app.inject({ method: "POST", url: "/v1/webhooks/github", headers: signedHeaders(raw), payload: raw });
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect((await app.inject({ url: `/v1/connections/${connected.id}`, headers: ownerHeaders })).json<ConnectionRecord>().status).toBe("suspended");
    const oversized = " ".repeat(1024 * 1024 + 1);
    expect((await app.inject({ method: "POST", url: "/v1/webhooks/github", headers: signedHeaders(oversized), payload: oversized })).statusCode).toBe(413);
    // Child-plugin raw parsing must not leak into authenticated application routes.
    const started = await start();
    expect((await app.inject({ method: "DELETE", url: `/v1/connections/github/pending/${started.setupId}`, headers: browserHeaders })).statusCode).toBe(204);
  });

  it("returns stable safe provider errors and consumes a failed callback without echoing credentials or details", async () => {
    const started = await start();
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const error = new GithubError("GITHUB_RATE_LIMITED", 429);
    error.message = "PROVIDER_DETAIL_SENTINEL USER_TOKEN_SENTINEL";
    exchange.mockRejectedValueOnce(error);
    const failed = await app.inject({ method: "POST", url: "/v1/connections/github/callback", headers: browserHeaders, payload: { code: "TEST_AUTHORIZATION_CODE", state } });
    expect(failed.statusCode, failed.body).toBe(429);
    expect(failed.json<{ error: { code: string; requestId: string } }>().error).toEqual({ code: "GITHUB_RATE_LIMITED", requestId: failed.headers["x-request-id"] });
    noCredentials(failed.body);
    const replay = await app.inject({ method: "POST", url: "/v1/connections/github/callback", headers: browserHeaders, payload: { code: "TEST_AUTHORIZATION_CODE", state } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe("CONNECT_STATE_INVALID");
  });
});
