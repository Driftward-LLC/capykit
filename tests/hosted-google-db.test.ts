import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConnectionError } from "../src/hosted/connections.js";
import { GoogleConnections, type GoogleConfig } from "../src/hosted/google.js";
import type { AuthenticatedContext } from "../src/hosted/identity.js";
const databaseUrl=process.env.CAPYKIT_TEST_POSTGRES_URL;
describe.skipIf(!databaseUrl)("Google connections under real PostgreSQL RLS",()=>{
 const schema=`capykit_google_${randomUUID().replaceAll("-","")}`;const role=`${schema}_runtime`;
 const admin=new Pool({connectionString:databaseUrl});
 const scoped=new URL(databaseUrl??"postgres://localhost/test");scoped.searchParams.set("options",`-c search_path=${schema},public`);
 const db=new Pool({connectionString:scoped.toString()});
 const runtimeUrl=new URL(scoped);runtimeUrl.searchParams.set("options",`-c search_path=${schema},public -c role=${role}`);
 const runtime=new Pool({connectionString:runtimeUrl.toString()});
 const config:GoogleConfig={clientId:"fixture.apps.googleusercontent.com",clientSecret:randomBytes(32).toString("hex"),encryptionKey:randomBytes(32),keyVersion:"test",callbackUrl:"https://capykit.example.test/v1/connections/google/callback"};
 const refreshToken=randomBytes(32).toString("hex");
 const provider={authorizationUrl:(state:string,challenge:string)=>`https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}`,exchange:vi.fn(()=>Promise.resolve({refreshToken,subject:"123",email:"owner@example.test"})),refresh:vi.fn(()=>Promise.resolve(randomBytes(32).toString("hex")))};
 const store=new GoogleConnections(runtime,provider,config);
 async function actor(workspaceId: string=randomUUID(),roleName:"owner"|"member"="owner"):Promise<AuthenticatedContext>{
  await db.query("insert into workspaces(id,slug,name) values($1,$2,'Test') on conflict do nothing",[workspaceId,randomUUID()]);
  const principalId=randomUUID(),subject=randomUUID();
  await db.query("insert into principals(id,workspace_id,kind,display_name) values($1,$2,'human','Test')",[principalId,workspaceId]);
  await db.query("insert into workspace_memberships(workspace_id,principal_id,role) values($1,$2,$3)",[workspaceId,principalId,roleName]);
  await db.query("insert into identity_bindings(principal_id,provider,provider_subject,email,verified_at) values($1,'gotrue',$2,'test@example.test',now())",[principalId,subject]);
  return {identity:{provider:"gotrue",subject,email:"test@example.test"},membership:{workspaceId,principalId,principalKind:"human",role:roleName,active:true}};
 }
 async function started(context:AuthenticatedContext){const value=await store.start(context,"session");return {state:new URL(value.authorizationUrl).searchParams.get("state")??"",code:"one-use-code"};}
 beforeAll(async()=>{
  await admin.query(`create schema ${schema}`);
  for(const name of ["001_hosted_workspace_identity.sql","002_hosted_database_access.sql","003_hosted_capabilities.sql","004_hosted_connections.sql","005_hosted_grants.sql","006_hosted_app_connections.sql"]){await db.query((await readFile(new URL(`../scripts/migrations/${name}`,import.meta.url),"utf8")).replaceAll("capykit_runtime",role));}
 });
 afterAll(async()=>{await runtime.end();await db.end();await admin.query(`drop schema ${schema} cascade;drop role ${role}`);await admin.end();});
 it("binds state to workspace, session and principal, consumes once, and encrypts credentials",async()=>{
  const owner=await actor(),other=await actor(),coworker=await actor(owner.membership.workspaceId);
  const input=await started(owner);
  for(const [context,session] of [[other,"session"],[coworker,"session"],[owner,"different"]] as const)await expect(store.callback(context,session,input)).rejects.toMatchObject({code:"CONNECT_STATE_INVALID"});
  await store.callback(owner,"session",input);
  await expect(store.callback(owner,"session",input)).rejects.toMatchObject({code:"CONNECT_STATE_INVALID"});
  const row=(await db.query("select * from google_connections where workspace_id=$1",[owner.membership.workspaceId])).rows[0] as Record<string,unknown>;
  expect(JSON.stringify(row)).not.toContain(refreshToken);expect(row.state_hash).toBeNull();expect(row.verifier).toBeNull();
  expect(await store.detail(owner)).toMatchObject({connection:{status:"active",email:"owner@example.test"}});
  expect(JSON.stringify(await store.detail(owner))).not.toContain("refresh_token");
 });
 it("denies members, stale identity bindings and RLS access without workspace context",async()=>{
  const owner=await actor(),member=await actor(owner.membership.workspaceId,"member");
  await started(owner);
  await expect(store.start(member,"session")).rejects.toMatchObject({code:"FORBIDDEN"});
  await expect(store.detail({...owner,identity:{...owner.identity,subject:"wrong"}})).rejects.toMatchObject({code:"MEMBERSHIP_INACTIVE"});
  expect((await runtime.query("select * from google_connections")).rowCount).toBe(0);
  await expect(runtime.query("delete from app_connection_audit")).rejects.toMatchObject({code:"42501"});
 });
 it("rejects expired and superseded state",async()=>{
  const owner=await actor();const old=await started(owner);const current=await started(owner);
  await expect(store.callback(owner,"session",old)).rejects.toMatchObject({code:"CONNECT_STATE_INVALID"});
  await db.query("update google_connections set expires_at=now()-interval '1 second' where workspace_id=$1",[owner.membership.workspaceId]);
  await expect(store.callback(owner,"session",current)).rejects.toMatchObject({code:"CONNECT_STATE_INVALID"});
 });
 it("fences an in-flight read after disconnect and removes saved authority before cleanup",async()=>{
  const owner=await actor();await store.callback(owner,"session",await started(owner));
  await expect(store.withToken(owner,async(_token,check)=>{await store.disconnect(owner);await check();return "unreachable";})).rejects.toMatchObject({code:"CONNECTION_INACTIVE"});
  expect((await db.query("select refresh_token from google_connections where workspace_id=$1",[owner.membership.workspaceId])).rows[0]).toEqual({refresh_token:null});

  await expect(store.withToken(owner,()=>Promise.resolve("no"))).rejects.toMatchObject({code:"CONNECTION_INACTIVE"});
 });
 it("rechecks membership before output and rejects connection replacement during exchange",async()=>{
  const owner=await actor();await store.callback(owner,"session",await started(owner));
  await expect(store.withToken(owner,async()=>{await db.query("update workspace_memberships set active=false where principal_id=$1",[owner.membership.principalId]);return "private data";})).rejects.toMatchObject({code:"MEMBERSHIP_INACTIVE"});
  const second=await actor();const input=await started(second);
  provider.exchange.mockImplementationOnce(async()=>{await store.start(second,"session");return {refreshToken,subject:"123",email:"owner@example.test"};});
  await expect(store.callback(second,"session",input)).rejects.toMatchObject({code:"CONNECT_STATE_INVALID"});
  expect((await store.detail(second)).connection?.status).toBe("pending");
 });
 it("expires revoked refresh credentials, preserves active state on outages, and never revokes another workspace",async()=>{
  const owner=await actor(),other=await actor();
  await store.callback(owner,"session",await started(owner));await store.callback(other,"session",await started(other));
  provider.refresh.mockRejectedValueOnce(new ConnectionError("PROVIDER_UNAVAILABLE",502));
  await expect(store.withToken(owner,()=>Promise.resolve("no"))).rejects.toMatchObject({code:"PROVIDER_UNAVAILABLE"});
  expect((await store.detail(owner)).connection?.status).toBe("active");
  provider.refresh.mockRejectedValueOnce(new ConnectionError("PROVIDER_AUTHORIZATION_EXPIRED",502));
  await expect(store.withToken(owner,()=>Promise.resolve("no"))).rejects.toMatchObject({code:"PROVIDER_AUTHORIZATION_EXPIRED"});
  expect((await store.detail(owner)).connection?.status).toBe("reconnect_required");
  await store.disconnect(owner);
  expect(await store.withToken(other,()=>Promise.resolve("still works"))).toBe("still works");
 });
});
