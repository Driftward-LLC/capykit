import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedDatabase } from "../src/hosted/db.js";
import type { VerifiedIdentity } from "../src/hosted/identity.js";

// Opt in with an isolated PostgreSQL database. Each run owns only a random schema.
const databaseUrl = process.env.CAPYKIT_TEST_POSTGRES_URL;
const execute = promisify(execFile);

describe.skipIf(databaseUrl === undefined)("hosted PostgreSQL boundaries", () => {
  const schema = `capykit_test_${randomUUID().replaceAll("-", "")}`;
  const runtimeRole = `${schema}_runtime`;
  const browserRole = `${schema}_browser`;
  const url = new URL(databaseUrl ?? "postgres://localhost/capykit_test");
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const scopedUrl = url.toString();
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  const database = createHostedDatabase(scopedUrl);
  if (database === undefined) throw new Error("Expected configured test database");

  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    expect(await database.readiness()).toEqual({ status: "unavailable", reason: "connection_failed" });
    const migration = await readFile(new URL("../scripts/migrations/001_hosted_workspace_identity.sql", import.meta.url), "utf8");
    const access = (await readFile(new URL("../scripts/migrations/002_hosted_database_access.sql", import.meta.url), "utf8"))
      .replaceAll("capykit_runtime", runtimeRole).replaceAll("'anon'", `'${browserRole}'`);
    await admin.query(`create role ${browserRole} nologin`);
    await database.pool.query(`begin; ${migration}\n${access}\ncommit;`);
    await database.pool.query(`begin; ${migration}\n${access}\ncommit;`);
    expect(await database.readiness()).toEqual({ status: "ready", reason: "ok" });
  });

  afterAll(async () => {
    await database.close();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.query(`drop role if exists ${runtimeRole}, ${browserRole}`);
    await admin.end();
  });

  async function bootstrap(slug: string, subject: string, email = "owner@example.test"): Promise<{ workspaceId: string; principalId: string }> {
    const { stdout } = await execute(process.execPath, ["scripts/bootstrap-hosted-owner.mjs"], {
      env: {
        ...process.env,
        DATABASE_URL: scopedUrl,
        CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG: slug,
        CAPYKIT_BOOTSTRAP_WORKSPACE_NAME: "Test workspace",
        CAPYKIT_BOOTSTRAP_SUPABASE_USER_ID: subject,
        CAPYKIT_BOOTSTRAP_OWNER_EMAIL: email,
      },
    });
    return JSON.parse(stdout) as { workspaceId: string; principalId: string };
  }

  it("bootstraps once, reruns without duplicates, and survives a new database connection", async () => {
    const subject = randomUUID();
    const slug = randomUUID();
    const initial = await bootstrap(slug, subject);
    expect(await bootstrap(slug, subject, "updated@example.test")).toEqual(initial);
    const count = await database.pool.query<{ count: string }>("select count(*) from principals where workspace_id = $1", [initial.workspaceId]);
    expect(count.rows[0]?.count).toBe("1");
    const binding = await database.pool.query<{ email: string }>("select email from identity_bindings where principal_id = $1", [initial.principalId]);
    expect(binding.rows[0]?.email).toBe("updated@example.test");
    const reopened = createHostedDatabase(scopedUrl);
    if (reopened === undefined) throw new Error("Expected configured test database");
    try {
      const context = await reopened.resolveContext({ provider: "supabase", subject, email: "updated@example.test" });
      expect(context?.membership).toEqual({ ...initial, active: true, principalKind: "human", role: "owner" });
    } finally {
      await reopened.close();
    }
  });

  it("restricts runtime to identity reads and denies browser access even if table grants are restored", async () => {
    const subject = randomUUID();
    const owner = await bootstrap(randomUUID(), subject);
    const runtimeUrl = new URL(scopedUrl);
    runtimeUrl.searchParams.set("options", `-c search_path=${schema},public -c role=${runtimeRole}`);
    const runtime = createHostedDatabase(runtimeUrl.toString());
    if (runtime === undefined) throw new Error("Expected configured runtime database");
    try {
      expect(await runtime.readiness()).toEqual({ status: "ready", reason: "ok" });
      expect((await runtime.resolveContext({ provider: "supabase", subject, email: "owner@example.test" }))?.membership.workspaceId).toBe(owner.workspaceId);
      await expect(runtime.pool.query("update workspaces set active = false")).rejects.toMatchObject({ code: "42501" });
      await expect(runtime.pool.query("select * from capability_publications")).rejects.toMatchObject({ code: "42501" });
      await expect(runtime.pool.query("create table unexpected_table (id integer)")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await runtime.close();
    }
    const protectedTables = await database.pool.query<{ relrowsecurity: boolean; can_select: boolean }>(
      `select c.relrowsecurity, has_table_privilege($1, c.oid, 'select') as can_select
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $2 and c.relkind = 'r'`, [browserRole, schema],
    );
    expect(protectedTables.rows).toHaveLength(5);
    expect(protectedTables.rows.every((table) => table.relrowsecurity && !table.can_select)).toBe(true);
    await admin.query(`grant usage on schema ${schema} to ${browserRole}; grant select on ${schema}.workspaces to ${browserRole}`);
    const client = await admin.connect();
    try {
      await client.query(`set role ${browserRole}`);
      expect((await client.query(`select * from ${schema}.workspaces`)).rows).toEqual([]);
    } finally {
      await client.query("reset role");
      client.release();
    }
  });

  it("rejects revoked principals, workspaces, memberships, and unverified bindings", async () => {
    const subject = randomUUID();
    const owner = await bootstrap(randomUUID(), subject);
    const identity: VerifiedIdentity = { provider: "supabase", subject, email: "owner@example.test" };
    expect(await database.resolveContext(identity)).toBeDefined();
    for (const [table, column, id] of [
      ["principals", "id", owner.principalId],
      ["workspaces", "id", owner.workspaceId],
      ["workspace_memberships", "principal_id", owner.principalId],
    ] as const) {
      await database.pool.query(`update ${table} set active = false where ${column} = $1`, [id]);
      expect(await database.resolveContext(identity)).toBeUndefined();
      await database.pool.query(`update ${table} set active = true where ${column} = $1`, [id]);
      expect(await database.resolveContext(identity)).toBeDefined();
    }
    await database.pool.query("update identity_bindings set verified_at = null where principal_id = $1", [owner.principalId]);
    expect(await database.resolveContext(identity)).toBeUndefined();
    expect(await database.resolveContext({ ...identity, subject: randomUUID() })).toBeUndefined();
  });

  it("rolls back attempts to bootstrap an identity into a different workspace", async () => {
    const subject = randomUUID();
    const owner = await bootstrap(randomUUID(), subject);
    const otherSlug = randomUUID();
    await expect(bootstrap(otherSlug, subject)).rejects.toThrow("Owner identity must be an active human in the selected workspace");
    const result = await database.pool.query("select id from workspaces where slug = $1", [otherSlug]);
    expect(result.rows).toHaveLength(0);
    const context = await database.resolveContext({ provider: "supabase", subject, email: "owner@example.test" });
    expect(context?.membership.workspaceId).toBe(owner.workspaceId);
  });

  it("does not restore disabled workspace, principal, or membership access during bootstrap", async () => {
    const subject = randomUUID();
    const slug = randomUUID();
    const owner = await bootstrap(slug, subject);
    await database.pool.query("update workspaces set active = false where id = $1", [owner.workspaceId]);
    await expect(bootstrap(slug, subject)).rejects.toThrow("Cannot bootstrap an inactive workspace");
    await database.pool.query("update workspaces set active = true where id = $1", [owner.workspaceId]);
    await database.pool.query("update principals set active = false where id = $1", [owner.principalId]);
    await expect(bootstrap(slug, subject)).rejects.toThrow("Owner identity must be an active human in the selected workspace");
    await database.pool.query("update principals set active = true where id = $1", [owner.principalId]);
    await database.pool.query("update workspace_memberships set active = false where principal_id = $1", [owner.principalId]);
    await expect(bootstrap(slug, subject)).rejects.toThrow("Cannot bootstrap an inactive membership");
    const membership = await database.pool.query<{ active: boolean }>("select active from workspace_memberships where principal_id = $1", [owner.principalId]);
    expect(membership.rows[0]?.active).toBe(false);
  });

  it("enforces workspace boundaries for memberships, principal creators, and publications", async () => {
    const first = await bootstrap(randomUUID(), randomUUID());
    const second = await bootstrap(randomUUID(), randomUUID());
    await expect(database.pool.query(
      "insert into workspace_memberships (workspace_id, principal_id, role) values ($1, $2, 'member')",
      [second.workspaceId, first.principalId],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(database.pool.query(
      "insert into principals (workspace_id, kind, display_name, created_by_principal_id) values ($1, 'agent', 'Foreign creator', $2)",
      [second.workspaceId, first.principalId],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(database.pool.query(
      "insert into capability_publications (workspace_id, created_by_principal_id, name) values ($1, $2, 'Foreign publisher')",
      [second.workspaceId, first.principalId],
    )).rejects.toMatchObject({ code: "23503" });
  });
});
