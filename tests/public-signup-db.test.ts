import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedDatabase } from "../src/hosted/db.js";
import { CapabilityStore } from "../src/hosted/capabilities.js";
import type { VerifiedIdentity } from "../src/hosted/identity.js";
const databaseUrl = process.env.CAPYKIT_TEST_POSTGRES_URL;
describe.skipIf(!databaseUrl)("public signup through restricted PostgreSQL runtime", () => {
  const schema = `capykit_signup_${randomUUID().replaceAll("-", "")}`, role = `${schema}_runtime`;
  const admin = new Pool({ connectionString: databaseUrl });
  const scoped = new URL(databaseUrl ?? "postgres://localhost/test"); scoped.searchParams.set("options", `-c search_path=${schema},public`);
  const db = new Pool({ connectionString: scoped.toString() });
  const restricted = new URL(scoped); restricted.searchParams.set("options", `-c search_path=${schema},public -c role=${role}`);
  const runtime = createHostedDatabase(restricted.toString()); if (!runtime?.provisionIdentity) throw new Error("Expected signup runtime");
  const provision = runtime.provisionIdentity.bind(runtime);
  function identity(email = "customer@example.test"): VerifiedIdentity { return { provider: "gotrue", subject: randomUUID(), email }; }
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    for (const name of ["001_hosted_workspace_identity.sql", "002_hosted_database_access.sql", "003_hosted_capabilities.sql", "004_hosted_connections.sql", "005_hosted_grants.sql", "006_hosted_app_connections.sql", "007_public_google_signup.sql"]) await db.query((await readFile(new URL(`../scripts/migrations/${name}`, import.meta.url), "utf8")).replaceAll("capykit_runtime", role));
  });
  afterAll(async () => { await runtime.close(); await db.end(); await admin.query(`drop schema ${schema} cascade; drop role ${role}`); await admin.end(); });
  it("creates one workspace/owner under concurrent callbacks, without granting direct identity writes", async () => {
    const user = identity(); await Promise.all(Array.from({ length: 10 }, () => provision(user)));
    const context = await runtime.resolveContext(user); expect(context?.membership).toMatchObject({ role: "owner", principalKind: "human", active: true });
    expect((await db.query("select count(*)::int as count from identity_bindings where provider_subject=$1", [user.subject])).rows[0]).toEqual({ count: 1 });
    const memberships = await db.query("select count(*)::int as count from workspace_memberships where principal_id=$1", [context?.membership.principalId]); expect(memberships.rows[0]).toEqual({ count: 1 });
    await expect(runtime.pool.query("insert into workspaces(slug,name) values('forged','Forged')")).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.pool.query("update workspace_memberships set role='owner'")).rejects.toMatchObject({ code: "42501" });
  });
  it("keeps same-email and external-domain customers isolated from each other's capabilities", async () => {
    const first = identity("same@example.test"), second = identity("same@example.test"), outsider = identity("customer@outside.test");
    await Promise.all([first, second, outsider].map(provision));
    const a = await runtime.resolveContext(first), b = await runtime.resolveContext(second), c = await runtime.resolveContext(outsider);
    if (!a || !b || !c) throw new Error("Missing test context");
    expect(new Set([a.membership.workspaceId, b.membership.workspaceId, c.membership.workspaceId]).size).toBe(3);
    await db.query("insert into capabilities(workspace_id,slug,name,kind,created_by_principal_id) values($1,'private','Private','function',$2)", [a.membership.workspaceId, a.membership.principalId]);
    const capabilities = new CapabilityStore(runtime.pool);
    expect(await capabilities.list(a)).toHaveLength(1); expect(await capabilities.list(b)).toEqual([]); expect(await capabilities.list(c)).toEqual([]);
  });
  it("retains returning members' existing role and workspace instead of promoting them", async () => {
    const user = identity(); await provision(user); const before = await runtime.resolveContext(user);
    await db.query("update workspace_memberships set role='member' where principal_id=$1", [before?.membership.principalId]);
    await provision({ ...user, email: "updated@outside.test" });
    expect((await runtime.resolveContext(user))?.membership).toMatchObject({ workspaceId: before?.membership.workspaceId, principalId: before?.membership.principalId, role: "member" });
  });
  it("cannot reactivate revoked identities, memberships, workspaces or agents", async () => {
    for (const mutation of ["update principals set active=false where id=$1", "update workspace_memberships set active=false where principal_id=$1", "update identity_bindings set verified_at=null where principal_id=$1", "update principals set kind='agent' where id=$1", "update workspaces set active=false where id=(select workspace_id from principals where id=$1)"]) {
      const user = identity(); await provision(user); const before = await runtime.resolveContext(user); await db.query(mutation, [before?.membership.principalId]);
      await expect(provision(user)).rejects.toMatchObject({ code: "42501" });
      expect((await db.query("select count(*)::int as count from identity_bindings where provider_subject=$1", [user.subject])).rows[0]).toEqual({ count: 1 });
    }
  });
  it("rejects malformed identities atomically and does not resolve untrusted temp tables", async () => {
    const before = (await db.query<{ count: string }>("select count(*) from workspaces")).rows[0];
    for (const user of [identity("invalid"), { ...identity(), subject: "00000000-0000-0000-0000-000000000000" }]) await expect(provision(user)).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select count(*) from workspaces")).rows[0]).toEqual(before);
    const client = await runtime.pool.connect();
    try {
      await client.query("create temp table identity_bindings (provider text, provider_subject text)");
      const user = identity(); await client.query("select provision_google_workspace($1::uuid,$2)", [user.subject, user.email]);
      expect(await runtime.resolveContext(user)).toBeDefined();
    } finally { await client.query("drop table pg_temp.identity_bindings"); client.release(); }
  });
});
