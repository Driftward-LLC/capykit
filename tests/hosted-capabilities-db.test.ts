import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityStore } from "../src/hosted/capabilities.js";
import { validateArtifact } from "../src/hosted/artifacts.js";
import type { AuthenticatedContext } from "../src/hosted/identity.js";

const databaseUrl = process.env.CAPYKIT_TEST_POSTGRES_URL;
const file = (path: string, contents: string | Buffer, executable = false) => ({ path, contentBase64: Buffer.from(contents).toString("base64"), executable, type: "file" as const });
const functionUpload = { files: [file("index.mjs", "export async function handler(input, { github }) { return github.listIssues(input); }\n")] };
const skillUpload = { files: [
  file("SKILL.md", "---\nname: complete-skill\ndescription: Read the complete fixture.\n---\nUse scripts/check.sh and references/guide.md.\n"),
  file("scripts/check.sh", "#!/bin/sh\nprintf 'artifact-only\\n'\n", true),
  file("references/guide.md", "Read this supporting reference.\n"),
  file("assets/data.bin", Buffer.from([0, 255, 128, 42, 10])),
] };

describe.skipIf(databaseUrl === undefined)("private PostgreSQL capability store", () => {
  const schema = `capykit_artifacts_${randomUUID().replaceAll("-", "")}`;
  const role = `${schema}_runtime`;
  const browser = `${schema}_browser`;
  const admin = new Pool({ connectionString: databaseUrl });
  const scoped = new URL(databaseUrl ?? "postgres://localhost/capykit_test");
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  const ownerDb = new Pool({ connectionString: scoped.toString() });
  const runtimeUrl = new URL(scoped);
  runtimeUrl.searchParams.set("options", `-c search_path=${schema},public -c role=${role}`);
  const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 5 });
  const store = new CapabilityStore(runtime);
  let owner: AuthenticatedContext;
  let other: AuthenticatedContext;
  let member: AuthenticatedContext;
  let agent: AuthenticatedContext;

  async function actor(workspaceId: string = randomUUID(), kind: "human" | "agent" = "human", membershipRole: "owner" | "member" = "owner"): Promise<AuthenticatedContext> {
    await ownerDb.query("insert into workspaces (id, slug, name) values ($1, $2, 'Fixture') on conflict do nothing", [workspaceId, randomUUID()]);
    const principalId = randomUUID();
    const subject = randomUUID();
    await ownerDb.query("insert into principals (id, workspace_id, kind, display_name) values ($1, $2, $3, 'Fixture')", [principalId, workspaceId, kind]);
    await ownerDb.query("insert into workspace_memberships (workspace_id, principal_id, role) values ($1, $2, $3)", [workspaceId, principalId, membershipRole]);
    await ownerDb.query("insert into identity_bindings (principal_id, provider, provider_subject, email, verified_at) values ($1, 'gotrue', $2, 'owner@example.test', now())", [principalId, subject]);
    return { identity: { provider: "gotrue", subject, email: "owner@example.test" }, membership: { workspaceId, principalId, principalKind: kind, role: membershipRole, active: true } };
  }
  async function capability(kind: "skill" | "function" = "skill", context = owner) {
    const created = await store.create(context, { slug: `fixture-${randomUUID()}`, name: "Complete artifact", kind });
    const artifact = kind === "skill" ? skillUpload : functionUpload;
    const draft = await store.saveDraft(context, created.id, { version: "1.0.0", artifact });
    if (draft.draft === null) throw new Error("Expected draft");
    return { ...created, digest: draft.draft.digest, upload: artifact };
  }
  async function publish(kind: "skill" | "function" = "skill", context = owner) {
    const created = await capability(kind, context);
    await store.publish(context, created.id, { version: "1.0.0", digest: created.digest });
    return created;
  }

  beforeAll(async () => {
    await admin.query(`create schema ${schema}; create role ${browser} nologin`);
    const migrations = await Promise.all(["001_hosted_workspace_identity.sql", "002_hosted_database_access.sql", "003_hosted_capabilities.sql"].map(async (name) =>
      (await readFile(new URL(`../scripts/migrations/${name}`, import.meta.url), "utf8")).replaceAll("capykit_runtime", role).replaceAll("'anon'", `'${browser}'`),
    ));
    await ownerDb.query(`begin; ${migrations.join("\n")} commit;`);
    await ownerDb.query(`begin; ${migrations[2] ?? ""} commit;`);
    owner = await actor();
    other = await actor();
    member = await actor(owner.membership.workspaceId, "human", "member");
    agent = await actor(owner.membership.workspaceId, "agent", "owner");
  });
  afterAll(async () => {
    await runtime.end();
    await ownerDb.end();
    await admin.query(`drop schema if exists ${schema} cascade; drop role if exists ${role}, ${browser}`);
    await admin.end();
  });

  it("durably publishes complete binary skills and fixed-contract function bytes, with no original directory", async () => {
    for (const kind of ["skill", "function"] as const) {
      const created = await capability(kind);
      const inspected = await store.detail(owner, created.id);
      expect(inspected.draft?.files.every((entry) => !("contentBase64" in entry))).toBe(true);
      expect(inspected.draft?.kind).toBe(kind);
      await expect(store.download(owner, created.id, "1.0.0")).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
      await store.publish(owner, created.id, { version: "1.0.0", digest: created.digest });
      const reopened = new Pool({ connectionString: runtimeUrl.toString() });
      try {
        const downloaded = await new CapabilityStore(reopened).download(owner, created.id, "1.0.0");
        expect(downloaded.artifact).toEqual(validateArtifact(kind, created.upload));
        expect(downloaded.format).toBe("capykit.artifact.v1");
        expect(downloaded.guidance.length).toBeGreaterThan(0);
        expect((await store.detail(owner, created.id)).draft).toBeNull();
      } finally { await reopened.end(); }
    }
  });

  it("makes concurrent duplicate publication idempotent and preserves old versions and immutable bytes", async () => {
    const created = await capability();
    const results = await Promise.all([1, 2, 3].map(() => store.publish(owner, created.id, { version: "1.0.0", digest: created.digest })));
    expect(results.every((result) => result.versions.length === 1)).toBe(true);
    const before = await store.download(owner, created.id, "1.0.0");
    expect((await ownerDb.query("select * from capability_audit where capability_id = $1 and action = 'published'", [created.id])).rowCount).toBe(1);
    await expect(store.publish(owner, created.id, { version: "1.0.0", digest: "0".repeat(64) })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(store.saveDraft(owner, created.id, { version: "1.0.0", artifact: skillUpload })).rejects.toMatchObject({ code: "CONFLICT" });
    const next = await store.saveDraft(owner, created.id, { version: "1.0.1", artifact: { files: [...skillUpload.files, file("new.txt", "new version")] } });
    expect(next.draft?.digest).not.toBe(created.digest);
    await expect(store.publish(owner, created.id, { version: "1.0.1", digest: created.digest })).rejects.toMatchObject({ code: "CONFLICT" });
    if (next.draft === null) throw new Error("Expected draft");
    await store.publish(owner, created.id, { version: "1.0.1", digest: next.draft.digest });
    expect(await store.download(owner, created.id, "1.0.0")).toEqual(before);
    await expect(ownerDb.query("update capability_versions set version = 'changed' where capability_id = $1", [created.id])).rejects.toMatchObject({ code: "23514" });
    await expect(ownerDb.query("update capability_artifact_files set content = 'changed' where capability_id = $1", [created.id])).rejects.toMatchObject({ code: "23514" });
    await expect(ownerDb.query("delete from capability_artifact_files where capability_id = $1", [created.id])).rejects.toMatchObject({ code: "23514" });
    await expect(ownerDb.query("insert into capability_artifact_files (workspace_id, capability_id, artifact_id, path, content) select workspace_id, capability_id, artifact_id, 'unexpected', 'bytes' from capability_versions where capability_id = $1 limit 1", [created.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back interrupted upload metadata and bytes, retaining only the last complete draft", async () => {
    const created = await capability();
    const previous = await store.detail(owner, created.id);
    await ownerDb.query(`create function reject_fixture_audit() returns trigger language plpgsql as $$ begin
      if new.capability_id = '${created.id}'::uuid and new.action = 'draft_saved' then raise exception 'Injected storage failure'; end if;
      return new; end $$; create trigger reject_fixture_audit before insert on capability_audit for each row execute function reject_fixture_audit()`);
    try {
      await expect(store.saveDraft(owner, created.id, { version: "2", artifact: skillUpload })).rejects.toThrow("Injected storage failure");
      expect(await store.detail(owner, created.id)).toEqual(previous);
      expect((await ownerDb.query("select * from capability_artifacts where capability_id = $1", [created.id])).rowCount).toBe(1);
      expect((await ownerDb.query("select * from capability_artifact_files where capability_id = $1", [created.id])).rowCount).toBe(skillUpload.files.length);
    } finally { await ownerDb.query("drop trigger reject_fixture_audit on capability_audit; drop function reject_fixture_audit()"); }
    await store.saveDraft(owner, created.id, { version: "2", artifact: skillUpload });
    expect((await ownerDb.query("select * from capability_artifacts where capability_id = $1", [created.id])).rowCount).toBe(1);
    expect((await ownerDb.query("select * from capability_artifact_files where capability_id = $1", [created.id])).rowCount).toBe(skillUpload.files.length);
  });

  it("fails closed on missing, corrupt, or substituted durable bytes before publish and download", async () => {
    const draft = await capability();
    await ownerDb.query("delete from capability_artifact_files where capability_id = $1 and path = 'assets/data.bin'", [draft.id]);
    await expect(store.publish(owner, draft.id, { version: "1.0.0", digest: draft.digest })).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT", statusCode: 500 });
    expect((await store.detail(owner, draft.id)).versions).toHaveLength(0);
    for (const mode of ["missing", "corrupt", "metadata"] as const) {
      const created = await publish();
      await ownerDb.query("alter table capability_artifact_files disable trigger user; alter table capability_artifacts disable trigger user");
      try {
        if (mode === "missing") await ownerDb.query("delete from capability_artifact_files where capability_id = $1 and path = 'assets/data.bin'", [created.id]);
        else if (mode === "corrupt") await ownerDb.query("update capability_artifact_files set content = $2 where capability_id = $1 and path = 'assets/data.bin'", [created.id, Buffer.from("corrupted")]);
        else await ownerDb.query("update capability_artifacts set metadata = 'null'::jsonb where capability_id = $1", [created.id]);
      } finally { await ownerDb.query("alter table capability_artifact_files enable trigger user; alter table capability_artifacts enable trigger user"); }
      await expect(store.download(owner, created.id, "1.0.0")).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT", statusCode: 500 });
      await expect(store.publish(owner, created.id, { version: "1.0.0", digest: created.digest })).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });
    }
  });

  it("denies recipients without grants, distinguishes 403 from 404, and rechecks current identity state", async () => {
    const created = await publish();
    const foreign = await publish("skill", other);
    for (const context of [member, agent]) {
      await expect(store.list(context)).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      await expect(store.create(context, { slug: "denied", name: "Denied", kind: "skill" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.detail(context, created.id)).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      await expect(store.download(context, created.id, "1.0.0")).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      await expect(store.saveDraft(context, created.id, { version: "2", artifact: skillUpload })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.publish(context, created.id, { version: "1.0.0", digest: created.digest })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.delete(context, created.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(store.detail(context, foreign.id)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    }
    await expect(store.download(owner, foreign.id, "1.0.0")).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await expect(store.detail(owner, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const [table, column, id] of [["workspace_memberships", "principal_id", owner.membership.principalId], ["principals", "id", owner.membership.principalId], ["workspaces", "id", owner.membership.workspaceId]] as const) {
      await ownerDb.query(`update ${table} set active = false where ${column} = $1`, [id]);
      try { await expect(store.download(owner, created.id, "1.0.0")).rejects.toMatchObject({ code: "MEMBERSHIP_INACTIVE", statusCode: 401 }); }
      finally { await ownerDb.query(`update ${table} set active = true where ${column} = $1`, [id]); }
    }
    await expect(store.download({ ...owner, identity: { ...owner.identity, subject: randomUUID() } }, created.id, "1.0.0")).rejects.toMatchObject({ code: "MEMBERSHIP_INACTIVE" });
    await expect(store.list({ ...member, membership: { ...member.membership, role: "owner" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("enforces RLS without transaction identity, browser isolation, compound ownership and identity read-only access", async () => {
    const created = await publish();
    expect((await runtime.query("select * from capability_artifact_files")).rows).toEqual([]);
    expect((await runtime.query("select * from capabilities")).rows).toEqual([]);
    await expect(runtime.query("update workspaces set active = false")).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query("update capabilities set kind = 'function'")).rejects.toMatchObject({ code: "42501" });
    await expect(ownerDb.query("insert into capabilities (workspace_id, slug, name, kind, created_by_principal_id) values ($1, 'foreign', 'Foreign', 'skill', $2)", [owner.membership.workspaceId, other.membership.principalId])).rejects.toMatchObject({ code: "23503" });
    await expect(ownerDb.query("insert into capability_artifacts (workspace_id, capability_id, digest, byte_count, file_count, metadata) values ($1, $2, $3, 1, 1, '{}')", [other.membership.workspaceId, created.id, "0".repeat(64)])).rejects.toMatchObject({ code: "23503" });
    await admin.query(`grant usage on schema ${schema} to ${browser}; grant select on ${schema}.capability_artifact_files to ${browser}`);
    const client = await admin.connect();
    try {
      await client.query(`set role ${browser}`);
      expect((await client.query(`select * from ${schema}.capability_artifact_files`)).rows).toEqual([]);
    } finally { await client.query("reset role"); client.release(); }
  });

  it("invalidates downloads before removing bytes and retains only immutable metadata and audit references", async () => {
    const created = await publish();
    await store.saveDraft(owner, created.id, { version: "2", artifact: skillUpload });
    await store.delete(owner, created.id);
    await expect(store.download(owner, created.id, "1.0.0")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.detail(owner, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await store.list(owner)).some((row) => row.id === created.id)).toBe(false);
    expect((await ownerDb.query("select * from capability_artifact_files where capability_id = $1", [created.id])).rowCount).toBe(0);
    expect((await ownerDb.query("select * from capability_drafts where capability_id = $1", [created.id])).rowCount).toBe(0);
    expect((await ownerDb.query("select * from capability_versions where capability_id = $1", [created.id])).rowCount).toBe(1);
    const events = (await ownerDb.query<{ action: string; actor_principal_id: string }>("select * from capability_audit where capability_id = $1", [created.id])).rows;
    expect(events.map((row) => row.action)).toContain("deleted");
    expect((await ownerDb.query("select digest from capability_audit where capability_id = $1 and action = 'deleted'", [created.id])).rows.every((row: { digest: string | null }) => row.digest === created.digest)).toBe(true);
    expect(events.every((row) => row.actor_principal_id === owner.membership.principalId && !Object.hasOwn(row, "content"))).toBe(true);
  });

  it("rejects unknown request fields and malformed identifiers without changing records", async () => {
    const created = await capability();
    await expect(store.create(owner, { slug: "invalid", name: "Invalid", kind: "skill", grant: true })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(store.saveDraft(owner, created.id, { version: "2", artifact: skillUpload, schema: {} })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(store.publish(owner, created.id, { version: "1.0.0", digest: created.digest, grant: true })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(store.detail(owner, "not-an-id")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(store.download(owner, created.id, "../../x")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
