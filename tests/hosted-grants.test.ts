import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrantStore } from "../src/hosted/grants.js";
import { CapabilityStore } from "../src/hosted/capabilities.js";
import { createHostedServer } from "../src/hosted/server.js";
import { createHostedDatabase } from "../src/hosted/db.js";
import { loadHostedConfig } from "../src/hosted/config.js";
import type { AuthenticatedContext } from "../src/hosted/identity.js";

const databaseUrl = process.env.CAPYKIT_TEST_POSTGRES_URL;
const origin = "https://capykit.example.test";
describe.skipIf(!databaseUrl)("current exact-version user grants", () => {
  const schema = `grants_${randomUUID().replaceAll("-", "")}`;
  const role = `${schema}_runtime`;
  const admin = new Pool({ connectionString: databaseUrl });
  const scoped = new URL(databaseUrl ?? "postgresql://localhost/test");
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  const ownerDb = new Pool({ connectionString: scoped.toString() });
  const runtimeUrl = new URL(scoped); runtimeUrl.searchParams.set("options", `-c search_path=${schema},public -c role=${role}`);
  const runtime = new Pool({ connectionString: runtimeUrl.toString() });
  const grants = new GrantStore(runtime); const capabilities = new CapabilityStore(runtime);
  const identities = new Map<string, AuthenticatedContext>();
  let owner: AuthenticatedContext, member: AuthenticatedContext, denied: AuthenticatedContext, other: AuthenticatedContext;
  let skill: string, fn: string, connection: string, otherConnection: string;
  const database = createHostedDatabase(runtimeUrl.toString());
  const app = createHostedServer({ database, config: loadHostedConfig({ DATABASE_URL: runtimeUrl.toString(), CAPYKIT_PUBLIC_BASE_URL: origin, CAPYKIT_AUTH_URL: "http://auth:9999" }), auth: {
    verifyBearer: token => Promise.resolve(identities.get(token)?.identity),
    verifyOtp: () => Promise.resolve(undefined), refresh: () => Promise.resolve(undefined), requestOtp: async () => {}, signOut: async () => {},
  } });
  const expiresAt = () => new Date(Date.now() + 86400000).toISOString();
  async function actor(name: string, workspaceId: string = randomUUID(), membershipRole: "owner" | "member" = "owner") {
    await ownerDb.query("insert into workspaces (id,slug,name) values($1,$2,'Grant fixture') on conflict do nothing", [workspaceId, workspaceId]);
    const principalId = randomUUID(), subject = randomUUID();
    await ownerDb.query("insert into principals(id,workspace_id,kind,display_name) values($1,$2,'human',$3)", [principalId, workspaceId, name]);
    await ownerDb.query("insert into workspace_memberships(workspace_id,principal_id,role) values($1,$2,$3)", [workspaceId, principalId, membershipRole]);
    await ownerDb.query("insert into identity_bindings(principal_id,provider,provider_subject,email,verified_at) values($1,'gotrue',$2,$3,now())", [principalId, subject, `${name}@example.test`]);
    const context: AuthenticatedContext = { identity: { provider: "gotrue", subject, email: `${name}@example.test` }, membership: { workspaceId, principalId, role: membershipRole, principalKind: "human", active: true } };
    identities.set(name, context); return context;
  }
  async function publish(kind: "function" | "skill", context = owner) {
    const c = await capabilities.create(context, { slug: `fixture-${randomUUID()}`, name: `${kind} fixture`, kind });
    for (const version of ["1", "2"]) {
      const contents = kind === "function" ? "export async function handler(input, { github }) { return github.listIssues(input); }" : "---\nname: grant-fixture\ndescription: Complete granted skill\n---\nRead references/guide.md.\n";
      const files = [{ path: kind === "function" ? "index.mjs" : "SKILL.md", type: "file", executable: false, contentBase64: Buffer.from(contents).toString("base64") }, ...(kind === "skill" ? [{ path: "references/guide.md", type: "file", executable: false, contentBase64: Buffer.from("Supporting fixture content").toString("base64") }] : [])];
      const d = await capabilities.saveDraft(context, c.id, { version, artifact: { files } });
      await capabilities.publish(context, c.id, { version, digest: d.draft?.digest });
    }
    return c.id;
  }
  async function connected(context: AuthenticatedContext) {
    const id = randomUUID();
    await ownerDb.query("insert into provider_connections(workspace_id,id,status,installation_id,account,created_by_principal_id,consent_by_principal_id,consent_at) values($1,$2,'active',$3,'{\"login\":\"fixture\"}',$4,$4,now())", [context.membership.workspaceId,id,String(Math.floor(Math.random()*1e12)+1),context.membership.principalId]);
    for (const repo of ["101", "102", "103"]) await ownerDb.query("insert into connection_repositories values($1,$2,$3,$4,$5)", [context.membership.workspaceId,id,repo,`fixture/repo-${repo}`,`https://github.com/fixture/repo-${repo}`]);
    return id;
  }
  const skillInput = () => ({ recipientId: member.membership.principalId, capabilityId: skill, version: "1", expiresAt: expiresAt() });
  const fnInput = (repositoryIds = ["101"]) => ({ recipientId: member.membership.principalId, capabilityId: fn, version: "1", expiresAt: expiresAt(), connectionId: connection, repositoryIds });
  const access = (repositoryIds = ["101"]) => ({ capabilityId: fn, version: "1", connectionId: connection, repositoryIds, operation: "github.issues.list.v1" as const });
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    const migrations = await Promise.all(["001_hosted_workspace_identity.sql","002_hosted_database_access.sql","003_hosted_capabilities.sql","004_hosted_connections.sql","005_hosted_grants.sql"].map(async name => (await readFile(new URL(`../scripts/migrations/${name}`, import.meta.url), "utf8")).replaceAll("capykit_runtime",role)));
    await ownerDb.query(`begin; ${migrations.join("\n")} commit;`);
    await ownerDb.query(`begin; ${migrations[4] ?? ""} commit;`);
    owner = await actor("owner"); member = await actor("member", owner.membership.workspaceId,"member"); denied = await actor("denied",owner.membership.workspaceId,"member"); other = await actor("other");
    skill = await publish("skill"); fn = await publish("function"); connection = await connected(owner); otherConnection = await connected(other);
  });
  afterAll(async () => { await app.close(); await runtime.end(); await ownerDb.end(); await admin.query(`drop schema if exists ${schema} cascade; drop role if exists ${role}`); await admin.end(); });
  it("lists only invited active workspace humans and published version choices", async () => {
    const options = await grants.options(owner);
    expect(options.users.map(u=>u.id).sort()).toEqual([owner, member, denied].map(c=>c.membership.principalId).sort());
    expect(options.versions).toHaveLength(4); expect(options.connections.map(c=>c.id)).toEqual([connection]);
    await expect(grants.options(member)).rejects.toMatchObject({ code:"FORBIDDEN" });
    expect(await capabilities.list(member)).toEqual([]);
    await expect(grants.authorizeFunction(owner,access())).rejects.toMatchObject({code:"FORBIDDEN"});
  });
  it("grants an exact skill without exposing other versions, drafts, users or workspaces", async () => {
    const g = await grants.create(owner,skillInput()); expect(g.status).toBe("active");
    expect((await capabilities.list(member)).map(c=>c.id)).toEqual([skill]);
    expect((await capabilities.detail(member,skill)).versions.map(v=>v.version)).toEqual(["1"]);
    const downloaded = await capabilities.download(member,skill,"1"); expect(downloaded.artifact.files).toHaveLength(2);
    await expect(capabilities.download(member,skill,"2")).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(capabilities.detail(denied,skill)).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(capabilities.detail(other,skill)).rejects.toMatchObject({code:"NOT_FOUND"});
    expect((await grants.list(member)).grants.map(row=>row.id)).toEqual([g.id]); expect((await grants.list(denied)).grants).toEqual([]);
    await expect(grants.create(member,skillInput())).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(grants.revoke(member,g.id)).rejects.toMatchObject({code:"FORBIDDEN"});
    await grants.revoke(owner,g.id); await grants.revoke(owner,g.id);
    await expect(capabilities.download(member,skill,"1")).rejects.toMatchObject({code:"FORBIDDEN"}); expect(await capabilities.list(member)).toEqual([]);
    expect((await ownerDb.query("select action from grant_audit where grant_id=$1 order by created_at",[g.id])).rows.map((r:{action:string})=>r.action)).toEqual(["created","revoked"]);
  });
  it("rejects ID substitution, mutable drafts, invalid expiry and broader scopes", async () => {
    for (const change of [{recipientId:other.membership.principalId},{capabilityId:randomUUID()},{version:"draft"},{connectionId:otherConnection},{repositoryIds:["999"]},{repositoryIds:["101","101"]},{expiresAt:new Date(0).toISOString()},{workspaceId:other.membership.workspaceId}]) {
      await expect(grants.create(owner,{...fnInput(),...change})).rejects.toBeDefined();
    }
    await expect(grants.create(owner,{...skillInput(),connectionId:connection})).rejects.toMatchObject({code:"INVALID_REQUEST"});
    await expect(grants.create(other,fnInput())).rejects.toMatchObject({code:"NOT_FOUND"});
  });
  it("selects one entire function grant deterministically and cannot replace a bound revoked grant", async () => {
    const a = await grants.create(owner,fnInput(["101"])), b = await grants.create(owner,fnInput(["102"]));
    await expect(grants.authorizeFunction(member,access(["101","102"]))).rejects.toMatchObject({code:"FORBIDDEN"});
    const full = await grants.create(owner,fnInput(["101","102"])); const next = await grants.create(owner,fnInput(["101","102"]));
    await ownerDb.query("alter table capability_grants disable trigger grant_scope_immutable");
    try { await ownerDb.query("update capability_grants set created_at = '2026-09-01' where id=any($1::uuid[])", [[full.id,next.id]]); }
    finally { await ownerDb.query("alter table capability_grants enable trigger grant_scope_immutable"); }
    const expected = [full.id,next.id].sort()[0]; expect((await grants.authorizeFunction(member,access(["101","102"]))).grantId).toBe(expected);
    await expect(grants.authorizeFunction(member,{...access(),version:"2"})).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(grants.authorizeFunction(member,access(["103"]))).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(capabilities.download(member,fn,"1")).rejects.toMatchObject({code:"FORBIDDEN"});
    if (!expected) throw new Error("Expected grant"); await grants.revoke(owner,expected);
    await expect(grants.authorizeFunction(member,access(["101","102"]),expected)).rejects.toMatchObject({code:"FORBIDDEN"});
    expect((await grants.authorizeFunction(member,access(["101","102"]))).grantId).not.toBe(expected);
    for (const g of [a,b,full,next]) await grants.revoke(owner,g.id);
  });
  it("denies the next request after expiry, deactivation, repository removal and connection revocation", async () => {
    const g = await grants.create(owner,fnInput());
    await ownerDb.query("update principals set active=false where id=$1",[member.membership.principalId]);
    await expect(grants.authorizeFunction(member,access(),g.id)).rejects.toMatchObject({code:"MEMBERSHIP_INACTIVE"});
    await ownerDb.query("update principals set active=true where id=$1",[member.membership.principalId]);
    await ownerDb.query("delete from connection_repositories where connection_id=$1 and repository_id='101'",[connection]);
    await expect(grants.authorizeFunction(member,access(),g.id)).rejects.toMatchObject({code:"FORBIDDEN"});
    await ownerDb.query("insert into connection_repositories values($1,$2,'101','fixture/repo-101','https://github.com/fixture/repo-101')",[owner.membership.workspaceId,connection]);
    await ownerDb.query("update provider_connections set status='revoked' where id=$1",[connection]);
    await expect(grants.authorizeFunction(member,access(),g.id)).rejects.toMatchObject({code:"FORBIDDEN"});
    await ownerDb.query("update provider_connections set status='active' where id=$1",[connection]);
    await ownerDb.query("alter table capability_grants disable trigger grant_scope_immutable");
    try { await ownerDb.query("update capability_grants set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where id=$1",[g.id]); }
    finally { await ownerDb.query("alter table capability_grants enable trigger grant_scope_immutable"); }
    await expect(grants.authorizeFunction(member,access(),g.id)).rejects.toMatchObject({code:"FORBIDDEN"});
    expect((await grants.list(owner)).grants.find(row=>row.id===g.id)?.status).toBe("expired");
  });
  it("preserves immutable grant scope, browser table isolation and role checks", async () => {
    const g = await grants.create(owner,skillInput());
    await expect(ownerDb.query("update capability_grants set version='2' where id=$1",[g.id])).rejects.toMatchObject({code:"23514"});
    expect((await runtime.query("select * from capability_grants")).rows).toEqual([]);
    await expect(grants.create({...member,membership:{...member.membership,role:"owner"}},skillInput())).rejects.toMatchObject({code:"FORBIDDEN"});
    await grants.revoke(owner,g.id);
    await expect(ownerDb.query("update capability_grants set revoked_at=null where id=$1",[g.id])).rejects.toMatchObject({code:"23514"});
  });
  it("enforces cookie CSRF on management APIs and current recipient authorization on downloads", async () => {
    const options = await app.inject({url:"/v1/access/options",headers:{authorization:"Bearer owner"}}); expect(options.statusCode,options.body).toBe(200);
    const csrf = await app.inject({method:"POST",url:"/v1/grants",headers:{cookie:"capykit_session=owner",origin},payload:skillInput()}); expect(csrf.statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:"/v1/grants",headers:{authorization:"Bearer member"},payload:skillInput()})).statusCode).toBe(403);
    for (const invalidExpiry of ["2027-02-30T12:00:00Z", "0000-01-01T00:00:00Z"]) {
      const invalidDate = await app.inject({method:"POST",url:"/v1/grants",headers:{authorization:"Bearer owner"},payload:{...skillInput(),expiresAt:invalidExpiry}});
      expect(invalidDate.statusCode).toBe(400); expect(invalidDate.json<{error:{code:string}}>().error.code).toBe("INVALID_REQUEST");
    }
    const created = await app.inject({method:"POST",url:"/v1/grants",headers:{authorization:"Bearer owner"},payload:skillInput()}); expect(created.statusCode,created.body).toBe(201);
    const g = created.json<{id:string}>();
    const url = `/v1/capabilities/${skill}/versions/1/download`;
    expect((await app.inject({url,headers:{authorization:"Bearer member"}})).statusCode).toBe(200);
    expect((await app.inject({url,headers:{authorization:"Bearer denied"}})).statusCode).toBe(403);
    expect((await app.inject({method:"DELETE",url:`/v1/grants/${g.id}`,headers:{authorization:"Bearer owner"}})).statusCode).toBe(204);
    expect((await app.inject({url,headers:{authorization:"Bearer member"}})).statusCode).toBe(403);
    expect((await app.inject({url:"/v1/grants?cursor=bad",headers:{authorization:"Bearer owner"}})).statusCode).toBe(400);
  });
});
