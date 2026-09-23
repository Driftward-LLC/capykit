import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionStore, type ConnectionProvider, type AuthorizedConnectionAccess } from "../src/hosted/connections.js";
import { GithubError, type GithubConfig, type InstallationCandidate } from "../src/hosted/github.js";
import type { AuthenticatedContext } from "../src/hosted/identity.js";

const databaseUrl = process.env.CAPYKIT_TEST_POSTGRES_URL;
const session = randomBytes(32).toString("hex");
const config: GithubConfig = { appId: "123", appSlug: "capykit-test", clientId: "fixture", clientSecret: randomBytes(32).toString("hex"), privateKey: "unused-test-provider", webhookSecret: randomBytes(32).toString("hex"), encryptionKey: randomBytes(32), keyVersion: "v1", callbackUrl: "https://capykit.example.test/v1/connections/github/callback" };

describe.skipIf(databaseUrl === undefined)("transactional GitHub connections in PostgreSQL", () => {
  const schema = `capykit_connections_${randomUUID().replaceAll("-", "")}`;
  const role = `${schema}_runtime`;
  const browser = `${schema}_browser`;
  const admin = new Pool({ connectionString: databaseUrl });
  const scoped = new URL(databaseUrl ?? "postgres://localhost/capykit_test");
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  const ownerDb = new Pool({ connectionString: scoped.toString() });
  const runtimeUrl = new URL(scoped);
  runtimeUrl.searchParams.set("options", `-c search_path=${schema},public -c role=${role}`);
  const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 5 });
  let owner: AuthenticatedContext;
  let other: AuthenticatedContext;
  let member: AuthenticatedContext;
  let agent: AuthenticatedContext;
  let installation = 100;
  let candidate: InstallationCandidate;
  let temporaryToken: string;
  let installationToken: string;
  const provider = {
    authorizationUrl: vi.fn((state: string, challenge: string) => `https://github.com/login/oauth/authorize?state=${state}&code_challenge=${challenge}`),
    installationUrl: vi.fn(() => "https://github.com/apps/capykit-test/installations/new"),
    exchange: vi.fn<ConnectionProvider["exchange"]>(() => Promise.resolve({ accessToken: temporaryToken, refreshToken: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 600_000).toISOString() })),
    user: vi.fn<ConnectionProvider["user"]>(() => Promise.resolve({ id: "7", login: "owner" })),
    candidates: vi.fn<ConnectionProvider["candidates"]>(() => Promise.resolve([structuredClone(candidate)])),
    recheck: vi.fn<ConnectionProvider["recheck"]>((...args) => Promise.resolve({ ...structuredClone(candidate), repositories: candidate.repositories.filter((repository) => args[3].includes(repository.id)) })),
    revokeUserToken: vi.fn<ConnectionProvider["revokeUserToken"]>(() => Promise.resolve()),
    mint: vi.fn<ConnectionProvider["mint"]>(() => Promise.resolve({ token: installationToken, expiresAt: new Date(Date.now() + 3_500_000).toISOString() })),
    revokeInstallationToken: vi.fn<ConnectionProvider["revokeInstallationToken"]>(() => Promise.resolve()),
  };
  const store = new ConnectionStore(runtime, provider, config);
  async function actor(workspaceId: string = randomUUID(), kind: "human" | "agent" = "human", membershipRole: "owner" | "member" = "owner"): Promise<AuthenticatedContext> {
    await ownerDb.query("insert into workspaces (id,slug,name) values ($1,$2,'Fixture') on conflict do nothing", [workspaceId, randomUUID()]);
    const principalId = randomUUID();
    const subject = randomUUID();
    await ownerDb.query("insert into principals (id,workspace_id,kind,display_name) values ($1,$2,$3,'Fixture')", [principalId, workspaceId, kind]);
    await ownerDb.query("insert into workspace_memberships (workspace_id,principal_id,role) values ($1,$2,$3)", [workspaceId, principalId, membershipRole]);
    await ownerDb.query("insert into identity_bindings (principal_id,provider,provider_subject,email,verified_at) values ($1,'gotrue',$2,'owner@example.test',now())", [principalId, subject]);
    return { identity: { provider: "gotrue", subject, email: "owner@example.test" }, membership: { workspaceId, principalId, principalKind: kind, role: membershipRole, active: true } };
  }
  async function start(context = owner, connectionId?: string) {
    const started = await store.start(context, session, randomUUID(), connectionId ? { connectionId } : {});
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    return { ...started, state };
  }
  async function pending(context = owner, connectionId?: string) {
    const started = await start(context, connectionId);
    const result = await store.callback(context, session, randomUUID(), { state: started.state, code: randomBytes(20).toString("hex") });
    return { ...started, ...result };
  }
  async function active(context = owner, repositoryIds = ["11", "12"]) {
    const setup = await pending(context);
    return store.confirm(context, session, randomUUID(), { setupId: setup.setupId, installationId: candidate.installationId, repositoryIds, consent: true });
  }
  function access(connectionId: string, repositoryIds = ["11"]): AuthorizedConnectionAccess {
    return { workspaceId: owner.membership.workspaceId, connectionId, repositoryIds, permission: "github.issues.list.v1" };
  }
  beforeAll(async () => {
    await admin.query(`create schema ${schema}; create role ${browser} nologin`);
    const migrations = await Promise.all(["001_hosted_workspace_identity.sql", "002_hosted_database_access.sql", "003_hosted_capabilities.sql", "004_hosted_connections.sql"].map(async (name) => (await readFile(new URL(`../scripts/migrations/${name}`, import.meta.url), "utf8")).replaceAll("capykit_runtime", role).replaceAll("'anon'", `'${browser}'`)));
    await ownerDb.query(`begin; ${migrations.join("\n")} commit;`);
    await ownerDb.query(`begin; ${migrations[3] ?? ""} commit;`);
    owner = await actor(); other = await actor();
    member = await actor(owner.membership.workspaceId, "human", "member");
    agent = await actor(owner.membership.workspaceId, "agent", "owner");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    temporaryToken = randomBytes(32).toString("hex"); installationToken = randomBytes(32).toString("hex");
    candidate = { installationId: String(++installation), account: { id: "5", login: "fixture-org", type: "Organization" }, repositories: [
      { id: "11", fullName: "fixture-org/one", url: "https://github.com/fixture-org/one", admin: true },
      { id: "12", fullName: "fixture-org/two", url: "https://github.com/fixture-org/two", admin: true },
      { id: "13", fullName: "fixture-org/member", url: "https://github.com/fixture-org/member", admin: false },
    ], permissions: { issues: "read", metadata: "read" } };
  });
  afterAll(async () => {
    await runtime.end(); await ownerDb.end();
    await admin.query(`drop schema if exists ${schema} cascade; drop role if exists ${role}, ${browser}`);
    await admin.end();
  });

  it("persists encrypted one-use setup, binds session/workspace, and stores only consented metadata after confirmation", async () => {
    const started = await start();
    const before = (await ownerDb.query<{ pkce_encrypted: { version: string } | null; tokens_encrypted: { version: string }; state_hash: string | null }>("select * from connection_setups where id = $1", [started.setupId])).rows[0];
    expect(before?.pkce_encrypted?.version).toBe("v1");
    expect(JSON.stringify(before)).not.toContain(started.state);
    expect(JSON.stringify(before)).not.toContain(session);
    await expect(store.callback(owner, "another-session", "test", { state: started.state, code: "code" })).rejects.toMatchObject({ code: "CONNECT_STATE_INVALID" });
    await expect(store.callback(other, session, "test", { state: started.state, code: "code" })).rejects.toMatchObject({ code: "CONNECT_STATE_INVALID" });
    const checked = await store.callback(owner, session, "test", { state: started.state, code: "code" });
    expect(checked.candidates[0]?.repositories.map((entry) => entry.id)).toEqual(["11", "12"]);
    await expect(store.callback(owner, session, "test", { state: started.state, code: "code" })).rejects.toMatchObject({ code: "CONNECT_STATE_INVALID" });
    const after = (await ownerDb.query<{ pkce_encrypted: { version: string } | null; tokens_encrypted: { version: string }; state_hash: string | null }>("select * from connection_setups where id = $1", [started.setupId])).rows[0];
    expect(after?.pkce_encrypted).toBeNull(); expect(after?.state_hash).toBeNull();
    expect(after?.tokens_encrypted.version).toBe("v1");
    expect(JSON.stringify(after)).not.toContain(temporaryToken);
    const reopened = new ConnectionStore(runtime, provider, config);
    expect(await reopened.pending(owner, session, started.setupId)).toEqual(checked);
    const confirmed = await reopened.confirm(owner, session, "test", { setupId: started.setupId, installationId: candidate.installationId, repositoryIds: ["11"], consent: true });
    expect(confirmed.status).toBe("active");
    expect(confirmed.repositories.map((repository) => repository.id)).toEqual(["11"]);
    expect(confirmed.uninstallUrl).toBe(`https://github.com/organizations/fixture-org/settings/installations/${candidate.installationId}`);
    expect(provider.revokeUserToken).toHaveBeenCalledWith(temporaryToken);
    expect((await ownerDb.query<{ pkce_encrypted: { version: string } | null; tokens_encrypted: { version: string }; state_hash: string | null }>("select * from connection_setups where id = $1", [started.setupId])).rowCount).toBe(0);
    expect(JSON.stringify(confirmed)).not.toContain(temporaryToken);
    expect(await new ConnectionStore(runtime).detail(owner, confirmed.id)).toEqual(confirmed);
  });

  it("enforces owner-only management, current identity, and scoped 403/404 lookups", async () => {
    const connection = await active();
    for (const context of [member, agent]) {
      await expect(store.list(context)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.start(context, session, "test", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.detail(context, connection.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.disconnect(context, "test", connection.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.detail(context, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(store.detail(other, connection.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.start(other, session, "test", { connectionId: connection.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.list({ ...owner, identity: { ...owner.identity, subject: randomUUID() } })).rejects.toMatchObject({ code: "MEMBERSHIP_INACTIVE" });
    await expect(store.list({ ...member, membership: { ...member.membership, role: "owner" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const [table, column, value] of [["workspace_memberships", "principal_id", owner.membership.principalId], ["principals", "id", owner.membership.principalId], ["workspaces", "id", owner.membership.workspaceId]] as const) {
      await ownerDb.query(`update ${table} set active = false where ${column} = $1`, [value]);
      try { await expect(store.detail(owner, connection.id)).rejects.toMatchObject({ code: "MEMBERSHIP_INACTIVE" }); }
      finally { await ownerDb.query(`update ${table} set active = true where ${column} = $1`, [value]); }
    }
    expect((await runtime.query("select * from provider_connections")).rows).toEqual([]);
    expect((await runtime.query("select * from connection_setups")).rows).toEqual([]);
    await expect(runtime.query("update workspaces set active = false")).rejects.toMatchObject({ code: "42501" });
    await admin.query(`grant usage on schema ${schema} to ${browser}; grant select on ${schema}.connection_setups to ${browser}`);
    const client = await admin.connect();
    try { await client.query(`set role ${browser}`); expect((await client.query(`select * from ${schema}.connection_setups`)).rows).toEqual([]); }
    finally { await client.query("reset role"); client.release(); }
  });

  it("requires selected eligible repositories and fresh administrator, account, and user proof", async () => {
    let setup = await pending();
    const confirmation = { setupId: setup.setupId, installationId: candidate.installationId, repositoryIds: ["11"], consent: true };
    for (const changed of [{ installationId: "99999" }, { repositoryIds: ["11", "13"] }, { repositoryIds: ["11", "14"] }, { consent: false }]) {
      await expect(store.confirm(owner, session, "test", { ...confirmation, ...changed })).rejects.toBeDefined();
      expect((await store.detail(owner, setup.connectionId)).status).toBe("pending");
    }
    provider.recheck.mockResolvedValueOnce({ ...candidate, repositories: candidate.repositories.map((repo) => ({ ...repo, admin: false })) });
    await expect(store.confirm(owner, session, "test", confirmation)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await store.detail(owner, setup.connectionId)).status).toBe("reconnect_required");
    expect((await ownerDb.query("select * from connection_setups where id = $1", [setup.setupId])).rowCount).toBe(0);
    setup = await pending();
    provider.recheck.mockResolvedValueOnce({ ...candidate, account: { ...candidate.account, id: "999" } });
    await expect(store.confirm(owner, session, "test", { ...confirmation, setupId: setup.setupId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    setup = await pending();
    provider.user.mockResolvedValueOnce({ id: "12345", login: "different" });
    await expect(store.confirm(owner, session, "test", { ...confirmation, setupId: setup.setupId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(provider.revokeUserToken).toHaveBeenCalled();
  });

  it("bounds both ten-minute phases and removes tampered, failed-exchange, and cancelled credentials", async () => {
    const first = await start();
    await ownerDb.query("update connection_setups set expires_at = now() - interval '1 second' where id = $1", [first.setupId]);
    await expect(store.callback(owner, session, "test", { state: first.state, code: "code" })).rejects.toMatchObject({ code: "CONNECT_SETUP_EXPIRED" });
    expect(provider.exchange).not.toHaveBeenCalled();
    const second = await pending();
    await ownerDb.query("update connection_setups set expires_at = now() - interval '1 second' where id = $1", [second.setupId]);
    await expect(store.pending(owner, session, second.setupId)).rejects.toMatchObject({ code: "CONNECT_SETUP_EXPIRED" });
    const tampered = await pending();
    await ownerDb.query("update connection_setups set tokens_encrypted = jsonb_set(tokens_encrypted, '{ciphertext}', '\"invalid\"'::jsonb) where id = $1", [tampered.setupId]);
    await expect(store.pending(owner, session, tampered.setupId)).rejects.toMatchObject({ code: "CONNECT_STATE_INVALID" });
    expect((await store.detail(owner, tampered.connectionId)).status).toBe("reconnect_required");
    const failed = await start();
    provider.exchange.mockRejectedValueOnce(new GithubError("GITHUB_AUTHORIZATION_FAILED", 400));
    await expect(store.callback(owner, session, "test", { state: failed.state, code: "code" })).rejects.toMatchObject({ code: "GITHUB_AUTHORIZATION_FAILED" });
    await expect(store.callback(owner, session, "test", { state: failed.state, code: "code" })).rejects.toMatchObject({ code: "CONNECT_STATE_INVALID" });
    const cancelled = await pending();
    await store.cancel(owner, session, "test", cancelled.setupId);
    for (const setup of [first, second, tampered, failed, cancelled]) expect((await ownerDb.query("select * from connection_setups where id = $1", [setup.setupId])).rowCount).toBe(0);
  });

  it("atomically binds installations across workspaces and preserves binding after disconnect", async () => {
    const a = await pending(owner); const b = await pending(other);
    const body = { installationId: candidate.installationId, repositoryIds: ["11"], consent: true };
    const results = await Promise.allSettled([store.confirm(owner, session, "test", { ...body, setupId: a.setupId }), store.confirm(other, session, "test", { ...body, setupId: b.setupId })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "CONFLICT" });
    const winner = results[0].status === "fulfilled" ? owner : other;
    const winnerId = winner === owner ? a.connectionId : b.connectionId;
    await store.disconnect(winner, "test", winnerId);
    const loser = winner === owner ? other : owner;
    const retry = await pending(loser);
    await expect(store.confirm(loser, session, "test", { ...body, setupId: retry.setupId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(ownerDb.query("delete from provider_connections where id = $1", [winnerId])).rejects.toMatchObject({ code: "23514" });
    await expect(ownerDb.query("update provider_connections set installation_id = null where id = $1", [winnerId])).rejects.toMatchObject({ code: "23514" });
  });

  it("commits local disconnect before remote cleanup and rejects late callback/confirmation", async () => {
    const connection = await active();
    const setup = await pending(owner, connection.id);
    provider.revokeUserToken.mockImplementationOnce(async () => {
      expect((await store.detail(owner, connection.id)).status).toBe("revoked");
      await expect(store.assertConnectionAccess(access(connection.id))).rejects.toMatchObject({ code: "CONNECTION_INACTIVE" });
      expect((await ownerDb.query("select * from connection_setups where id = $1", [setup.setupId])).rowCount).toBe(0);
      throw new Error("Provider unreachable");
    });
    await store.disconnect(owner, "test", connection.id);
    expect((await store.detail(owner, connection.id)).status).toBe("revoked");
    await expect(store.confirm(owner, session, "test", { setupId: setup.setupId, installationId: candidate.installationId, repositoryIds: ["11"], consent: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await ownerDb.query("select * from connection_audit where connection_id = $1 and action = 'provider_cleanup_failed'", [connection.id])).rowCount).toBe(1);
  });

  it("mints only current allowed repository subsets and rejects late results, revoking memory-only tokens", async () => {
    const connection = await active();
    await expect(store.withInstallationToken(access(connection.id, ["13"]), () => Promise.resolve("never"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(provider.mint).not.toHaveBeenCalled();
    const result = await store.withInstallationToken(access(connection.id), async (_token, assertAccess) => { await assertAccess(); return "result"; });
    expect(result).toBe("result");
    expect(provider.mint).toHaveBeenCalledWith(candidate.installationId, ["11"]);
    expect(provider.revokeInstallationToken).toHaveBeenCalledWith(installationToken);
    await expect(store.withInstallationToken(access(connection.id), async () => { await store.disconnect(owner, "test", connection.id); return "late result"; })).rejects.toMatchObject({ code: "CONNECTION_INACTIVE" });
    expect(provider.revokeInstallationToken).toHaveBeenCalledTimes(2);
    const metadata = JSON.stringify((await ownerDb.query("select * from provider_connections where id = $1", [connection.id])).rows);
    expect(metadata).not.toContain(installationToken); expect(metadata).not.toContain(temporaryToken);
  });

  it("rechecks after token mint and fails closed for provider authorization failures but not rate limits", async () => {
    const connection = await active();
    provider.mint.mockRejectedValueOnce(new GithubError("GITHUB_RATE_LIMITED", 429));
    await expect(store.withInstallationToken(access(connection.id), () => Promise.resolve("never"))).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
    expect((await store.detail(owner, connection.id)).status).toBe("active");
    provider.mint.mockRejectedValueOnce(new GithubError("GITHUB_ACCESS_REVOKED", 403));
    await expect(store.withInstallationToken(access(connection.id), () => Promise.resolve("never"))).rejects.toMatchObject({ code: "GITHUB_ACCESS_REVOKED" });
    expect((await store.detail(owner, connection.id)).status).toBe("reconnect_required");
    candidate.installationId = String(++installation);
    const next = await active();
    const run = vi.fn(() => Promise.resolve("never"));
    provider.mint.mockImplementationOnce(async () => { await store.disconnect(owner, "test", next.id); return { token: installationToken, expiresAt: new Date(Date.now() + 600_000).toISOString() }; });
    await expect(store.withInstallationToken(access(next.id), run)).rejects.toMatchObject({ code: "CONNECTION_INACTIVE" });
    expect(run).not.toHaveBeenCalled(); expect(provider.revokeInstallationToken).toHaveBeenCalledWith(installationToken);
  });

  it("deduplicates installation events, removes repositories, ignores additions and personal authorization revocation", async () => {
    const connection = await active();
    const install = { id: Number(candidate.installationId) };
    await store.webhook("github_app_authorization", randomUUID(), { action: "revoked" });
    await store.webhook("installation_repositories", randomUUID(), { action: "added", installation: install, repositories_added: [{ id: 13 }] });
    expect((await store.detail(owner, connection.id)).repositories.map((repo) => repo.id)).toEqual(["11", "12"]);
    const delivery = randomUUID();
    const removal = { action: "removed", installation: install, repositories_removed: [{ id: 11 }] };
    await store.webhook("installation_repositories", delivery, removal);
    await store.webhook("installation_repositories", delivery, removal);
    expect((await store.detail(owner, connection.id)).repositories.map((repo) => repo.id)).toEqual(["12"]);
    expect((await ownerDb.query("select * from connection_audit where connection_id = $1 and action = 'repositories_removed'", [connection.id])).rowCount).toBe(1);
    await expect(store.assertConnectionAccess(access(connection.id, ["11"]))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await store.webhook("installation", randomUUID(), { action: "suspend", installation: install });
    expect((await store.detail(owner, connection.id)).status).toBe("suspended");
    await store.webhook("installation", randomUUID(), { action: "unsuspend", installation: install });
    expect((await store.detail(owner, connection.id)).status).toBe("reconnect_required");
    await store.webhook("installation", randomUUID(), { action: "deleted", installation: install });
    await store.webhook("installation", randomUUID(), { action: "unsuspend", installation: install });
    expect((await store.detail(owner, connection.id)).status).toBe("revoked");
  });

  it("does not let provider proof fetched before a signed event restore authority", async () => {
    const setup = await pending();
    provider.recheck.mockImplementationOnce(async () => {
      await store.webhook("installation", randomUUID(), { action: "suspend", installation: { id: Number(candidate.installationId) } });
      return structuredClone(candidate);
    });
    await expect(store.confirm(owner, session, "test", { setupId: setup.setupId, installationId: candidate.installationId, repositoryIds: ["11"], consent: true })).rejects.toMatchObject({ code: "CONNECT_STATE_INVALID" });
    expect((await store.detail(owner, setup.connectionId)).status).toBe("reconnect_required");
    expect((await ownerDb.query("select * from connection_setups where id = $1", [setup.setupId])).rowCount).toBe(0);
  });

  it("cleans expired secrets and 30-day audits in bounded batches even when provider cleanup fails", async () => {
    const a = await pending(); const b = await pending();
    await ownerDb.query("update connection_setups set expires_at = now() - interval '1 second' where id = any($1::uuid[])", [[a.setupId, b.setupId]]);
    await ownerDb.query("insert into connection_audit(workspace_id,connection_id,request_id,action,created_at) values ($1,$2,'old','setup_started',now() - interval '31 days')", [owner.membership.workspaceId, a.connectionId]);
    await expect(ownerDb.query("update connection_audit set action = 'setup_failed' where connection_id = $1", [a.connectionId])).rejects.toMatchObject({ code: "23514" });
    provider.revokeUserToken.mockRejectedValueOnce(new Error("Provider unavailable"));
    const result = await new ConnectionStore(runtime, provider, config).cleanup(1);
    expect(result.expiredSetups).toBe(1); expect(result.auditRecords).toBe(1);
    expect((await ownerDb.query("select * from connection_setups where id = any($1::uuid[])", [[a.setupId, b.setupId]])).rowCount).toBe(1);
    await store.cleanup(100);
    expect((await ownerDb.query("select * from connection_setups where id = any($1::uuid[])", [[a.setupId, b.setupId]])).rowCount).toBe(0);
    const audits = JSON.stringify((await ownerDb.query("select * from connection_audit")).rows);
    expect(audits).not.toContain(temporaryToken); expect(audits).not.toContain(session);
    expect((await store.detail(owner, a.connectionId)).status).toBe("reconnect_required");
    expect((await store.detail(owner, b.connectionId)).status).toBe("reconnect_required");
  });

  it("retains active installation consent after failed personal-token cleanup and adds repositories only through fresh consent", async () => {
    const setup = await pending();
    provider.revokeUserToken.mockRejectedValueOnce(new Error("Provider unavailable"));
    const connection = await store.confirm(owner, session, "test", { setupId: setup.setupId, installationId: candidate.installationId, repositoryIds: ["11"], consent: true });
    expect(connection.status).toBe("active");
    expect(connection.consentByPrincipalId).toBe(owner.membership.principalId);
    expect((await ownerDb.query("select * from connection_setups where id = $1", [setup.setupId])).rowCount).toBe(0);
    await store.assertConnectionAccess(access(connection.id));
    await expect(store.assertConnectionAccess(access(connection.id, ["12"]))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const renewal = await pending(owner, connection.id);
    await expect(store.assertConnectionAccess(access(connection.id))).rejects.toMatchObject({ code: "CONNECTION_INACTIVE" });
    const updated = await store.confirm(owner, session, "test", { setupId: renewal.setupId, installationId: candidate.installationId, repositoryIds: ["11", "12"], consent: true });
    expect(updated.repositories.map((repo) => repo.id)).toEqual(["11", "12"]);
    await store.assertConnectionAccess(access(connection.id, ["12"]));
  });

  it("removes credentials after owner revocation during provider setup and uses fresh nonces on each attempt", async () => {
    const a = await start(); const b = await start();
    const encrypted = (await ownerDb.query<{ pkce_encrypted: { nonce: string } }>("select pkce_encrypted from connection_setups where id = any($1::uuid[])", [[a.setupId, b.setupId]])).rows;
    expect(encrypted[0]?.pkce_encrypted.nonce).not.toBe(encrypted[1]?.pkce_encrypted.nonce);
    provider.candidates.mockImplementationOnce(async () => {
      await ownerDb.query("update workspace_memberships set active = false where principal_id = $1", [owner.membership.principalId]);
      return [structuredClone(candidate)];
    });
    try {
      await expect(store.callback(owner, session, "test", { state: a.state, code: "code" })).rejects.toMatchObject({ code: "MEMBERSHIP_INACTIVE" });
      expect((await ownerDb.query("select * from connection_setups where id = $1", [a.setupId])).rowCount).toBe(0);
      expect(provider.revokeUserToken).toHaveBeenCalledWith(temporaryToken);
    } finally { await ownerDb.query("update workspace_memberships set active = true where principal_id = $1", [owner.membership.principalId]); }
    await store.cancel(owner, session, "test", b.setupId);
  });

  it("rejects unknown fields, invalid IDs, and incomplete consent without mutating records", async () => {
    await expect(store.start(owner, session, "test", { url: "https://example.test" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(store.detail(owner, "not-an-id")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const setup = await pending();
    await expect(store.confirm(owner, session, "test", { setupId: setup.setupId, installationId: candidate.installationId, repositoryIds: ["11", "11"], consent: true })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(store.confirm(owner, session, "test", { setupId: setup.setupId, installationId: candidate.installationId, repositoryIds: ["11"], consent: true, scopes: ["repo"] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(store.pending(owner, "other-session", setup.setupId)).rejects.toMatchObject({ code: "CONNECT_STATE_INVALID" });
    expect((await store.detail(owner, setup.connectionId)).status).toBe("pending");
    await store.cancel(owner, session, "test", setup.setupId);
  });
});
