import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthenticatedContext } from "./identity.js";
import { authorizeWorkspace, requireWorkspaceOwner } from "./workspace-access.js";

export class GrantError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONNECTION_INACTIVE", readonly statusCode: number) { super(code); this.name = "GrantError"; }
}
export interface Grant {
  id: string; recipientId: string; recipientName: string; capabilityId: string; capabilityName: string;
  version: string; action: "retrieve" | "invoke"; operation: string | null; connectionId: string | null;
  repositoryIds: string[]; connectionName: string | null; repositories: { id: string; name: string }[]; expiresAt: string; createdAt: string; revokedAt: string | null;
  status: "active" | "expired" | "revoked" | "unavailable";
}
export interface FunctionAccess {
  capabilityId: string; version: string; connectionId: string; repositoryIds: string[]; operation: "github.issues.list.v1";
}
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function id(value: unknown): asserts value is string { if (typeof value !== "string" || !idPattern.test(value)) throw new GrantError("INVALID_REQUEST", 400); }
function repositories(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500 || value.some(v => typeof v !== "string" || !/^[1-9][0-9]{0,19}$/u.test(v)) || new Set(value).size !== value.length) throw new GrantError("INVALID_REQUEST", 400);
}
const grantColumns = `g.id, g.recipient_principal_id as "recipientId", p.display_name as "recipientName", g.capability_id as "capabilityId", c.name as "capabilityName", g.version, g.action, g.operation, g.connection_id as "connectionId", g.repository_ids as "repositoryIds", g.expires_at::text as "expiresAt", g.created_at::text as "createdAt", g.revoked_at::text as "revokedAt",
  pc.account->>'login' as "connectionName", coalesce((select jsonb_agg(jsonb_build_object('id', wanted.id, 'name', coalesce(r.full_name,wanted.id)) order by wanted.id) from unnest(g.repository_ids) wanted(id) left join connection_repositories r on r.workspace_id = g.workspace_id and r.connection_id = g.connection_id and r.repository_id = wanted.id), '[]'::jsonb) as repositories,
  case when g.revoked_at is not null then 'revoked' when g.expires_at <= now() then 'expired'
    when not p.active or not m.active or c.deleted_at is not null or (g.action = 'invoke' and (pc.status is distinct from 'active' or exists (select 1 from unnest(g.repository_ids) wanted(id) where not exists (select 1 from connection_repositories r where r.workspace_id = g.workspace_id and r.connection_id = g.connection_id and r.repository_id = wanted.id)))) then 'unavailable' else 'active' end as status`;
const grantJoins = `join principals p on p.workspace_id = g.workspace_id and p.id = g.recipient_principal_id join workspace_memberships m on m.workspace_id = p.workspace_id and m.principal_id = p.id join capabilities c on c.workspace_id = g.workspace_id and c.id = g.capability_id left join provider_connections pc on pc.workspace_id = g.workspace_id and pc.id = g.connection_id`;

export class GrantStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(context: AuthenticatedContext, owner: boolean, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actor = await authorizeWorkspace(client, context);
      if (owner) requireWorkspaceOwner(actor);
      const result = await run(client);
      await client.query("commit"); return result;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
  async options(context: AuthenticatedContext) {
    return this.transaction(context, true, async client => {
      const workspace = context.membership.workspaceId;
      const users = (await client.query<{ id: string; name: string; email: string; role: string }>(`select p.id, p.display_name as name, b.email::text, m.role from principals p join workspace_memberships m on m.workspace_id = p.workspace_id and m.principal_id = p.id join identity_bindings b on b.principal_id = p.id and b.verified_at is not null where p.workspace_id = $1 and p.kind = 'human' and p.active and m.active order by p.display_name, p.id limit 201`, [workspace])).rows;
      const versions = (await client.query<{ capabilityId: string; name: string; kind: "skill" | "function"; version: string; operation: string | null }>(`select c.id as "capabilityId", c.name, c.kind, v.version, a.metadata->'contract'->>'id' as operation from capabilities c join capability_versions v on v.workspace_id = c.workspace_id and v.capability_id = c.id join capability_artifacts a on a.workspace_id = v.workspace_id and a.capability_id = v.capability_id and a.id = v.artifact_id where c.workspace_id = $1 and c.deleted_at is null order by c.name, v.published_at desc, c.id, v.version limit 201`, [workspace])).rows;
      const connections = (await client.query<{ id: string; name: string; repositories: { id: string; name: string }[] }>(`select c.id, c.account->>'login' as name, coalesce((select jsonb_agg(jsonb_build_object('id', r.repository_id, 'name', r.full_name) order by r.full_name) from connection_repositories r where r.workspace_id = c.workspace_id and r.connection_id = c.id), '[]'::jsonb) as repositories from provider_connections c where c.workspace_id = $1 and c.status = 'active' order by c.account->>'login', c.id limit 201`, [workspace])).rows;
      return { users: users.slice(0, 200), versions: versions.slice(0, 200), connections: connections.slice(0, 200), truncated: [users, versions, connections].some(rows => rows.length > 200) };
    });
  }
  async list(context: AuthenticatedContext, cursor?: string) {
    if (cursor !== undefined) id(cursor);
    return this.transaction(context, false, async client => {
      const records = (await client.query<Grant>(`select ${grantColumns} from capability_grants g ${grantJoins} where g.workspace_id = $1 and ($2::uuid is null or g.id > $2::uuid) order by g.id limit 51`, [context.membership.workspaceId, cursor ?? null])).rows;
      return { grants: records.slice(0, 50), nextCursor: records.length > 50 ? records[49]?.id ?? null : null };
    });
  }
  async create(context: AuthenticatedContext, input: unknown): Promise<Grant> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["recipientId", "capabilityId", "version", "connectionId", "repositoryIds", "expiresAt"].includes(k))) throw new GrantError("INVALID_REQUEST", 400);
    const body = input as Record<string, unknown>;
    id(body.recipientId); id(body.capabilityId);
    if (typeof body.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(body.version) || typeof body.expiresAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(body.expiresAt) || !Number.isFinite(Date.parse(body.expiresAt))) throw new GrantError("INVALID_REQUEST", 400);
    const canonicalExpiry = body.expiresAt.includes(".")
      ? body.expiresAt.replace(/\.(\d{1,3})Z$/u, (_, fraction: string) => `.${fraction.padEnd(3, "0")}Z`)
      : body.expiresAt.replace(/Z$/u, ".000Z");
    if (Date.parse(body.expiresAt) <= Date.now() || new Date(body.expiresAt).toISOString() !== canonicalExpiry) throw new GrantError("INVALID_REQUEST", 400);
    return this.transaction(context, true, async client => {
      const workspace = context.membership.workspaceId;
      const recipient = await client.query(`select p.id from principals p join workspace_memberships m on m.workspace_id = p.workspace_id and m.principal_id = p.id join identity_bindings b on b.principal_id = p.id and b.verified_at is not null where p.workspace_id = $1 and p.id = $2 and p.kind = 'human' and p.active and m.active`, [workspace, body.recipientId]);
      if (recipient.rows.length === 0) throw new GrantError("NOT_FOUND", 404);
      const capability = (await client.query<{ kind: string }>("select kind from capabilities where workspace_id = $1 and id = $2 and deleted_at is null for share", [workspace, body.capabilityId])).rows[0];
      if (!capability) throw new GrantError("NOT_FOUND", 404);
      const published = await client.query<{ operation: string | null }>(`select a.metadata->'contract'->>'id' as operation from capability_versions v join capability_artifacts a on a.workspace_id = v.workspace_id and a.capability_id = v.capability_id and a.id = v.artifact_id where v.workspace_id = $1 and v.capability_id = $2 and v.version = $3`, [workspace, body.capabilityId, body.version]);
      if (!published.rows[0]) throw new GrantError("NOT_FOUND", 404);
      const expires = await client.query<{ valid: boolean }>("select $1::timestamptz > now() and $1::timestamptz <= now() + interval '366 days' as valid", [body.expiresAt]);
      if (!expires.rows[0]?.valid) throw new GrantError("INVALID_REQUEST", 400);
      const invoke = capability.kind === "function";
      if (invoke) {
        id(body.connectionId); repositories(body.repositoryIds);
        if (published.rows[0].operation !== "github.issues.list.v1") throw new GrantError("INVALID_REQUEST", 400);
        await this.connection(client, workspace, body.connectionId, body.repositoryIds);
      } else if (body.connectionId !== undefined || body.repositoryIds !== undefined) throw new GrantError("INVALID_REQUEST", 400);
      const grantId = randomUUID();
      await client.query(`insert into capability_grants (workspace_id, id, recipient_principal_id, capability_id, version, action, operation, connection_id, repository_ids, expires_at, created_by_principal_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [workspace, grantId, body.recipientId, body.capabilityId, body.version, invoke ? "invoke" : "retrieve", invoke ? "github.issues.list.v1" : null, invoke ? body.connectionId : null, invoke ? body.repositoryIds : [], body.expiresAt, context.membership.principalId]);
      await client.query("insert into grant_audit (workspace_id, grant_id, actor_principal_id, action) values ($1,$2,$3,'created')", [workspace, grantId, context.membership.principalId]);
      const result = (await client.query<Grant>(`select ${grantColumns} from capability_grants g ${grantJoins} where g.workspace_id = $1 and g.id = $2`, [workspace, grantId])).rows[0];
      if (!result) throw new Error("Grant creation failed"); return result;
    });
  }
  async revoke(context: AuthenticatedContext, grantId: string): Promise<void> {
    id(grantId);
    await this.transaction(context, true, async client => {
      const workspace = context.membership.workspaceId;
      const result = await client.query("select revoked_at from capability_grants where workspace_id = $1 and id = $2 for update", [workspace, grantId]);
      if (!result.rows[0]) throw new GrantError("NOT_FOUND", 404);
      if ((result.rows[0] as { revoked_at: unknown }).revoked_at !== null) return;
      await client.query("update capability_grants set revoked_at = now() where workspace_id = $1 and id = $2", [workspace, grantId]);
      await client.query("insert into grant_audit (workspace_id, grant_id, actor_principal_id, action) values ($1,$2,$3,'revoked')", [workspace, grantId, context.membership.principalId]);
    });
  }
  private async connection(client: PoolClient, workspace: string, connectionId: string, repositoryIds: string[]): Promise<void> {
    const connection = (await client.query<{ status: string; installation_id: string | null }>("select status, installation_id from provider_connections where workspace_id = $1 and id = $2", [workspace, connectionId])).rows[0];
    if (!connection) throw new GrantError("NOT_FOUND", 404);
    if (connection.status !== "active" || !connection.installation_id) throw new GrantError("CONNECTION_INACTIVE", 403);
    const allowed = await client.query("select repository_id from connection_repositories where workspace_id = $1 and connection_id = $2 and repository_id = any($3::text[])", [workspace, connectionId, repositoryIds]);
    if (allowed.rows.length !== repositoryIds.length) throw new GrantError("FORBIDDEN", 403);
  }
  /** ENG-125 must bind this ID and revalidate it before idempotent responses,
   * dispatch, each provider call and result delivery; never substitute a grant. */
  async authorizeFunction(context: AuthenticatedContext, access: FunctionAccess, boundGrantId?: string): Promise<{ grantId: string }> {
    id(access.capabilityId); id(access.connectionId); repositories(access.repositoryIds);
    if (boundGrantId !== undefined) id(boundGrantId);
    const operation: unknown = access.operation;
    if (operation !== "github.issues.list.v1" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(access.version)) throw new GrantError("INVALID_REQUEST", 400);
    return this.transaction(context, false, async client => {
      const workspace = context.membership.workspaceId;
      const header = await client.query("select id from capabilities where workspace_id = $1 and id = $2 and deleted_at is null", [workspace, access.capabilityId]);
      if (!header.rows[0]) throw new GrantError("NOT_FOUND", 404);
      const result = await client.query<{ id: string }>(`select g.id from capability_grants g where g.workspace_id = $1 and g.recipient_principal_id = $2 and g.capability_id = $3 and g.version = $4 and g.action = 'invoke' and g.operation = $5 and g.connection_id = $6 and g.revoked_at is null and g.expires_at > now() and $7::text[] <@ g.repository_ids and ($8::uuid is null or g.id = $8::uuid) and capability_granted_version(g.workspace_id,g.capability_id,g.version) and not exists (select 1 from unnest(g.repository_ids) wanted(id) where not exists (select 1 from connection_repositories r where r.workspace_id = g.workspace_id and r.connection_id = g.connection_id and r.repository_id = wanted.id)) order by g.created_at, g.id limit 1`, [workspace, context.membership.principalId, access.capabilityId, access.version, access.operation, access.connectionId, access.repositoryIds, boundGrantId ?? null]);
      if (!result.rows[0]) throw new GrantError("FORBIDDEN", 403);
      await this.connection(client, workspace, access.connectionId, access.repositoryIds);
      return { grantId: result.rows[0].id };
    });
  }
}
