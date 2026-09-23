import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { GithubError, pkce, seal, unseal, type GithubConfig, type GithubProvider, type InstallationCandidate } from "./github.js";
import type { AuthenticatedContext } from "./identity.js";
import { authorizeWorkspace, requireWorkspaceOwner } from "./workspace-access.js";

export class ConnectionError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); this.name = "ConnectionError"; }
}
export interface ConnectionRecord {
  id: string;
  status: "pending" | "active" | "suspended" | "reconnect_required" | "revoked";
  account: InstallationCandidate["account"] | null;
  installationId: string | null;
  repositories: { id: string; fullName: string; url: string }[];
  permissions: { issues: "read"; metadata: "read" };
  consentAt: string | null;
  consentByPrincipalId: string | null;
  uninstallUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PendingConnectionSetup { setupId: string; connectionId: string; candidates: InstallationCandidate[]; expiresAt: string }
export type ConnectionProvider = Pick<GithubProvider, "authorizationUrl" | "installationUrl" | "exchange" | "revokeUserToken" | "user" | "candidates" | "recheck" | "mint" | "revokeInstallationToken">;
/** Trusted backend input, never a browser request. ENG-124/125 must authorize
 * the caller/grant first and invoke assertAccess before each provider operation. */
export interface AuthorizedConnectionAccess { workspaceId: string; connectionId: string; repositoryIds: string[]; permission: "github.issues.list.v1" }
interface Header extends Omit<ConnectionRecord, "repositories" | "uninstallUrl"> { generation: number }
interface Setup {
  id: string; workspace_id: string; connection_id: string; principal_id: string; generation: number;
  session_hash: string; phase: "authorizing" | "exchanging" | "confirming";
  pkce_encrypted: unknown; tokens_encrypted: unknown; github_user_id: string | null;
  candidates: InstallationCandidate[] | null; expires_at: Date;
}
type UserTokens = Awaited<ReturnType<ConnectionProvider["exchange"]>>;
const columns = `id, status, generation, installation_id as "installationId", account, permissions,
  consent_at::text as "consentAt", consent_by_principal_id as "consentByPrincipalId", created_at::text as "createdAt", updated_at::text as "updatedAt"`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (code: string, status: number): never => { throw new ConnectionError(code, status); };
function identifier(value: unknown): asserts value is string { if (typeof value !== "string" || !uuidPattern.test(value)) fail("INVALID_REQUEST", 400); }
function providerId(value: unknown): string {
  const result = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== "string" || !/^[1-9][0-9]{0,15}$/.test(result) || !Number.isSafeInteger(Number(result))) return fail("INVALID_REQUEST", 400);
  return result;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) return fail("INVALID_REQUEST", 400);
  const result = value.map(providerId);
  if (new Set(result).size !== result.length) fail("INVALID_REQUEST", 400);
  return result;
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("INVALID_REQUEST", 400);
}
function requestIdentifier(value: string): string { return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : "internal"; }
function aad(setup: Pick<Setup, "workspace_id" | "id" | "session_hash">, kind: "pkce" | "tokens"): string { return JSON.stringify([setup.workspace_id, setup.id, setup.session_hash, kind]); }
function boundSession(setup: Setup, context: AuthenticatedContext, session: string): void {
  if (setup.principal_id !== context.membership.principalId || setup.session_hash !== hash(session)) fail("CONNECT_STATE_INVALID", 400);
}
const expired = (setup: Setup) => setup.expires_at.getTime() <= Date.now();

export class ConnectionStore {
  constructor(private readonly pool: Pool, private readonly provider?: ConnectionProvider, private readonly config?: GithubConfig) {}
  private configured(): { provider: ConnectionProvider; config: GithubConfig } {
    if (!this.provider || !this.config) return fail("CONFIGURATION_UNAVAILABLE", 503);
    return { provider: this.provider, config: this.config };
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>, context?: AuthenticatedContext): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (context === undefined) await client.query("select set_config('capykit.connection_system', 'on', true)");
      const result = await run(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") return fail("CONFLICT", 409);
      throw error;
    } finally { client.release(); }
  }
  private async owner<T>(context: AuthenticatedContext, id: string | undefined, run: (client: PoolClient, record?: Header) => Promise<T>, installationLock?: string): Promise<T> {
    if (id !== undefined) identifier(id);
    return this.transaction(async (client) => {
      const membership = await authorizeWorkspace(client, context);
      if (installationLock !== undefined) await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`capykit-installation:${installationLock}`]);
      let record: Header | undefined;
      if (id !== undefined) {
        record = (await client.query<Header>(`select ${columns} from provider_connections where workspace_id = $1 and id = $2`, [membership.workspaceId, id])).rows[0];
        if (!record) return fail("NOT_FOUND", 404);
      }
      requireWorkspaceOwner(membership);
      if (id !== undefined) {
        record = (await client.query<Header>(`select ${columns} from provider_connections where workspace_id = $1 and id = $2 for update`, [membership.workspaceId, id])).rows[0];
        if (!record) return fail("NOT_FOUND", 404);
      }
      return run(client, record);
    }, context);
  }
  private async audit(client: PoolClient, workspace: string, connection: string, actor: string | null, request: string, action: string, diagnostic: string | null = null): Promise<void> {
    await client.query("insert into connection_audit (workspace_id, connection_id, actor_principal_id, request_id, action, diagnostic) values ($1,$2,$3,$4,$5,$6)", [workspace, connection, actor, requestIdentifier(request), action, diagnostic]);
  }
  private async describe(client: PoolClient, workspace: string, header: Header): Promise<ConnectionRecord> {
    const repositories = (await client.query<ConnectionRecord["repositories"][number]>("select repository_id as id, full_name as \"fullName\", url from connection_repositories where workspace_id = $1 and connection_id = $2 order by full_name, repository_id", [workspace, header.id])).rows;
    const record = { id: header.id, status: header.status, account: header.account, installationId: header.installationId, permissions: header.permissions, consentAt: header.consentAt, consentByPrincipalId: header.consentByPrincipalId, createdAt: header.createdAt, updatedAt: header.updatedAt };
    const uninstallUrl = !record.account || !record.installationId ? null : record.account.type === "Organization"
      ? `https://github.com/organizations/${encodeURIComponent(record.account.login)}/settings/installations/${record.installationId}`
      : `https://github.com/settings/installations/${record.installationId}`;
    return { ...record, repositories, uninstallUrl };
  }
  private async setup(client: PoolClient, context: AuthenticatedContext, session: string, setupId: string): Promise<Setup> {
    const row = (await client.query<Setup>("select * from connection_setups where workspace_id = $1 and id = $2 for update", [context.membership.workspaceId, setupId])).rows[0];
    if (!row) return fail("NOT_FOUND", 404);
    boundSession(row, context, session);
    return row;
  }
  private decrypt(setup: Setup): UserTokens {
    const { config } = this.configured();
    return unseal<UserTokens>(config, setup.tokens_encrypted, aad(setup, "tokens"));
  }
  private pendingResult(setup: Setup): PendingConnectionSetup {
    return { setupId: setup.id, connectionId: setup.connection_id, candidates: setup.candidates ?? [], expiresAt: setup.expires_at.toISOString() };
  }
  private async revokeTemporary(setup: Setup, request: string, tokens?: UserTokens): Promise<void> {
    let failed = false;
    try {
      if (tokens === undefined && setup.tokens_encrypted !== null) tokens = this.decrypt(setup);
      if (tokens !== undefined) await this.configured().provider.revokeUserToken(tokens.accessToken);
    } catch { failed = true; }
    if (failed) await this.transaction((client) => this.audit(client, setup.workspace_id, setup.connection_id, setup.principal_id, request, "provider_cleanup_failed", "provider_cleanup_failed"));
  }
  /** Delete local credentials and authority before any remote cleanup attempt. */
  private async discard(setup: Setup, request: string, action: "setup_failed" | "setup_cancelled" | "setup_expired", diagnostic: string | null = null): Promise<boolean> {
    const removed = await this.transaction(async (client) => {
      await client.query("select id from provider_connections where workspace_id = $1 and id = $2 for update", [setup.workspace_id, setup.connection_id]);
      const result = await client.query<Setup>("delete from connection_setups where workspace_id = $1 and id = $2 returning *", [setup.workspace_id, setup.id]);
      if (!result.rows[0]) return undefined;
      await client.query("update provider_connections set status = 'reconnect_required', generation = generation + 1, updated_at = now() where workspace_id = $1 and id = $2 and generation = $3 and status = 'pending'", [setup.workspace_id, setup.connection_id, setup.generation]);
      await this.audit(client, setup.workspace_id, setup.connection_id, setup.principal_id, request, action, diagnostic);
      return result.rows[0];
    });
    if (removed) await this.revokeTemporary(removed, request);
    return removed !== undefined;
  }
  private async requireFresh(setup: Setup, request: string): Promise<void> {
    if (expired(setup)) { await this.discard(setup, request, "setup_expired", "expired"); fail("CONNECT_SETUP_EXPIRED", 410); }
  }
  async list(context: AuthenticatedContext): Promise<ConnectionRecord[]> {
    return this.owner(context, undefined, async (client) => {
      const rows = (await client.query<Header>(`select ${columns} from provider_connections where workspace_id = $1 order by created_at desc, id`, [context.membership.workspaceId])).rows;
      return Promise.all(rows.map((row) => this.describe(client, context.membership.workspaceId, row)));
    });
  }
  async detail(context: AuthenticatedContext, id: string): Promise<ConnectionRecord> {
    return this.owner(context, id, (client, record) => this.describe(client, context.membership.workspaceId, record ?? fail("INTERNAL_ERROR", 500)));
  }
  async start(context: AuthenticatedContext, session: string, request: string, input: unknown): Promise<{ connectionId: string; setupId: string; authorizationUrl: string; installationUrl: string }> {
    object(input, ["connectionId"]);
    if (input.connectionId !== undefined) identifier(input.connectionId);
    const verifier = pkce();
    const state = randomBytes(32).toString("base64url");
    let previous: Setup | undefined;
    const result = await this.owner(context, input.connectionId, async (client, existing) => {
      const { provider, config } = this.configured();
      const workspace = context.membership.workspaceId;
      const principal = context.membership.principalId;
      const connectionId = existing?.id ?? randomUUID();
      const generation = (existing?.generation ?? -1) + 1;
      if (existing) {
        previous = (await client.query<Setup>("delete from connection_setups where workspace_id = $1 and connection_id = $2 returning *", [workspace, connectionId])).rows[0];
        await client.query("update provider_connections set status = 'pending', generation = $3, updated_at = now() where workspace_id = $1 and id = $2", [workspace, connectionId, generation]);
      } else await client.query("insert into provider_connections (workspace_id,id,created_by_principal_id) values ($1,$2,$3)", [workspace, connectionId, principal]);
      const setupId = randomUUID();
      const sessionHash = hash(session);
      const encrypted = seal(config, { verifier: verifier.verifier }, aad({ workspace_id: workspace, id: setupId, session_hash: sessionHash }, "pkce"));
      await client.query("insert into connection_setups (workspace_id,id,connection_id,principal_id,generation,session_hash,state_hash,phase,pkce_encrypted,expires_at) values ($1,$2,$3,$4,$5,$6,$7,'authorizing',$8,now() + interval '10 minutes')", [workspace, setupId, connectionId, principal, generation, sessionHash, hash(state), encrypted]);
      await this.audit(client, workspace, connectionId, principal, request, "setup_started");
      return { connectionId, setupId, authorizationUrl: provider.authorizationUrl(state, verifier.challenge), installationUrl: provider.installationUrl() };
    });
    if (previous) await this.revokeTemporary(previous, request);
    return result;
  }
  async callback(context: AuthenticatedContext, session: string, request: string, input: unknown): Promise<PendingConnectionSetup> {
    object(input, ["state", "code"]);
    if (typeof input.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || typeof input.code !== "string" || input.code.length < 1 || input.code.length > 1024 || /[\r\n\0]/.test(input.code)) return fail("INVALID_REQUEST", 400);
    const { provider, config } = this.configured();
    const setup = await this.owner(context, undefined, async (client) => {
      const found = (await client.query<Setup>("select * from connection_setups where workspace_id = $1 and state_hash = $2 and phase = 'authorizing' for update", [context.membership.workspaceId, hash(input.state as string)])).rows[0];
      if (!found) return fail("CONNECT_STATE_INVALID", 400);
      boundSession(found, context, session);
      // Consume before exchanging the code. An unsuccessful exchange must also
      // require a new state and PKCE challenge, never a callback replay.
      await client.query("update connection_setups set phase = 'exchanging', state_hash = null, pkce_encrypted = null where workspace_id = $1 and id = $2", [found.workspace_id, found.id]);
      return found;
    });
    await this.requireFresh(setup, request);
    let tokens: UserTokens | undefined;
    try {
      const material = unseal<{ verifier: string }>(config, setup.pkce_encrypted, aad(setup, "pkce"));
      tokens = await provider.exchange(input.code, material.verifier);
      const user = await provider.user(tokens.accessToken);
      const candidates = (await provider.candidates(tokens.accessToken)).map((candidate) => ({ ...candidate, repositories: candidate.repositories.filter((repository) => repository.admin) })).filter((candidate) => candidate.repositories.length > 0);
      const result = await this.owner(context, setup.connection_id, async (client, record) => {
        const current = await this.setup(client, context, session, setup.id);
        if (record?.generation !== setup.generation || current.phase !== "exchanging" || expired(current)) return fail("CONNECT_STATE_INVALID", 400);
        return (await client.query<Setup>("update connection_setups set phase = 'confirming', tokens_encrypted = $3, github_user_id = $4, candidates = $5, expires_at = now() + interval '10 minutes' where workspace_id = $1 and id = $2 returning *", [setup.workspace_id, setup.id, seal(config, tokens, aad(setup, "tokens")), user.id, JSON.stringify(candidates)])).rows[0] ?? fail("INTERNAL_ERROR", 500);
      });
      await this.owner(context, setup.connection_id, (client) => this.audit(client, setup.workspace_id, setup.connection_id, setup.principal_id, request, "setup_verified"));
      return this.pendingResult(result);
    } catch (error) {
      await this.discard(setup, request, "setup_failed", "provider_failure");
      // If exchange succeeded but no encrypted row committed, still revoke the
      // only in-memory copy. Cleanup errors never cause credential retention.
      if (tokens !== undefined) await this.revokeTemporary({ ...setup, tokens_encrypted: null }, request, tokens);
      throw error;
    }
  }
  async pending(context: AuthenticatedContext, session: string, setupId: string): Promise<PendingConnectionSetup> {
    identifier(setupId);
    const setup = await this.owner(context, undefined, (client) => this.setup(client, context, session, setupId));
    await this.requireFresh(setup, "pending");
    if (setup.phase !== "confirming") return fail("CONNECT_STATE_INVALID", 400);
    try { this.decrypt(setup); }
    catch (error) { await this.discard(setup, "pending", "setup_failed", "credential_invalid"); throw error; }
    return this.pendingResult(setup);
  }
  private async fence(client: PoolClient, installationId: string): Promise<number> {
    // Only this backend lifecycle check temporarily reads the global event
    // counter; no global installation metadata is returned to the browser.
    await client.query("select set_config('capykit.connection_system', 'on', true)");
    try { return (await client.query<{ revision: number }>("select revision from connection_installation_events where installation_id = $1", [installationId])).rows[0]?.revision ?? 0; }
    finally { await client.query("select set_config('capykit.connection_system', 'off', true)"); }
  }
  async confirm(context: AuthenticatedContext, session: string, request: string, input: unknown): Promise<ConnectionRecord> {
    object(input, ["setupId", "installationId", "repositoryIds", "consent"]);
    identifier(input.setupId);
    const setupId = input.setupId;
    const installationId = providerId(input.installationId);
    const repositoryIds = ids(input.repositoryIds);
    if (input.consent !== true) return fail("INVALID_REQUEST", 400);
    const { provider } = this.configured();
    const setup = await this.owner(context, undefined, (client) => this.setup(client, context, session, setupId));
    await this.requireFresh(setup, request);
    if (setup.phase !== "confirming") return fail("CONNECT_STATE_INVALID", 400);
    const candidate = setup.candidates?.find((entry) => entry.installationId === installationId);
    if (!candidate || repositoryIds.some((id) => !candidate.repositories.some((repository) => repository.id === id && repository.admin))) return fail("FORBIDDEN", 403);
    let tokens: UserTokens;
    try { tokens = this.decrypt(setup); }
    catch (error) { await this.discard(setup, request, "setup_failed", "credential_invalid"); throw error; }
    try {
      const revision = await this.transaction((client) => this.fence(client, installationId));
      const user = await provider.user(tokens.accessToken);
      if (user.id !== setup.github_user_id) return fail("FORBIDDEN", 403);
      const verified = await provider.recheck(tokens.accessToken, installationId, candidate.account.id, repositoryIds);
      if (verified.installationId !== installationId || verified.account.id !== candidate.account.id || repositoryIds.some((id) => !verified.repositories.some((repository) => repository.id === id && repository.admin))) return fail("FORBIDDEN", 403);
      const record = await this.owner(context, setup.connection_id, async (client, connection) => {
        const current = await this.setup(client, context, session, setup.id);
        if (expired(current) || connection?.generation !== setup.generation || current.phase !== "confirming" || await this.fence(client, installationId) !== revision) return fail("CONNECT_STATE_INVALID", 400);
        if ((connection.installationId !== null && connection.installationId !== installationId) || (connection.account !== null && connection.account.id !== verified.account.id)) return fail("FORBIDDEN", 403);
        const updated = (await client.query<Header>(`update provider_connections set status = 'active', installation_id = $3, account = $4, consent_by_principal_id = $5, consent_at = now(), updated_at = now() where workspace_id = $1 and id = $2 returning ${columns}`, [setup.workspace_id, setup.connection_id, installationId, verified.account, context.membership.principalId])).rows[0] ?? fail("INTERNAL_ERROR", 500);
        await client.query("delete from connection_repositories where workspace_id = $1 and connection_id = $2", [setup.workspace_id, setup.connection_id]);
        const repositories = verified.repositories.filter((repository) => repositoryIds.includes(repository.id));
        await client.query("insert into connection_repositories (workspace_id,connection_id,repository_id,full_name,url) select $1,$2,r.id,r.\"fullName\",r.url from jsonb_to_recordset($3::jsonb) as r(id text, \"fullName\" text, url text)", [setup.workspace_id, setup.connection_id, JSON.stringify(repositories)]);
        await client.query("delete from connection_setups where workspace_id = $1 and id = $2", [setup.workspace_id, setup.id]);
        await this.audit(client, setup.workspace_id, setup.connection_id, setup.principal_id, request, "confirmed");
        return this.describe(client, setup.workspace_id, updated);
      }, installationId);
      await this.revokeTemporary({ ...setup, tokens_encrypted: null }, request, tokens);
      return record;
    } catch (error) {
      await this.discard(setup, request, "setup_failed", "authority_changed");
      throw error;
    }
  }
  async cancel(context: AuthenticatedContext, session: string, request: string, setupId: string): Promise<void> {
    identifier(setupId);
    const setup = await this.owner(context, undefined, (client) => this.setup(client, context, session, setupId));
    if (!await this.discard(setup, request, "setup_cancelled")) fail("NOT_FOUND", 404);
  }
  async disconnect(context: AuthenticatedContext, request: string, id: string): Promise<void> {
    const setup = await this.owner(context, id, async (client) => {
      await client.query("update provider_connections set status = 'revoked', generation = generation + 1, updated_at = now() where workspace_id = $1 and id = $2", [context.membership.workspaceId, id]);
      await client.query("delete from connection_repositories where workspace_id = $1 and connection_id = $2", [context.membership.workspaceId, id]);
      const removed = (await client.query<Setup>("delete from connection_setups where workspace_id = $1 and connection_id = $2 returning *", [context.membership.workspaceId, id])).rows[0];
      await this.audit(client, context.membership.workspaceId, id, context.membership.principalId, request, "disconnected");
      return removed;
    });
    if (setup) await this.revokeTemporary(setup, request);
  }
  async cleanup(limit = 50): Promise<{ expiredSetups: number; auditRecords: number; deliveries: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("INVALID_REQUEST", 400);
    const result = await this.transaction(async (client) => {
      // Match owner operations' connection-before-setup lock order. A busy
      // connection is skipped for the next bounded cleanup invocation.
      const candidates = (await client.query<{ workspace_id: string; id: string }>("select s.workspace_id, s.id from connection_setups s join provider_connections c on c.workspace_id = s.workspace_id and c.id = s.connection_id where s.expires_at <= now() order by s.expires_at limit $1 for update of c skip locked", [limit])).rows;
      const expiredSetups = (await client.query<Setup>("delete from connection_setups where (workspace_id,id) in (select x.workspace_id,x.id from jsonb_to_recordset($1::jsonb) as x(workspace_id uuid,id uuid)) and expires_at <= now() returning *", [JSON.stringify(candidates)])).rows;
      for (const setup of expiredSetups) {
        await client.query("update provider_connections set status = 'reconnect_required', generation = generation + 1, updated_at = now() where workspace_id = $1 and id = $2 and generation = $3 and status = 'pending'", [setup.workspace_id, setup.connection_id, setup.generation]);
        await this.audit(client, setup.workspace_id, setup.connection_id, setup.principal_id, "cleanup", "setup_expired", "expired");
      }
      const auditRecords = (await client.query("delete from connection_audit where (workspace_id,id) in (select workspace_id,id from connection_audit where created_at < now() - interval '30 days' order by created_at limit $1)", [limit])).rowCount ?? 0;
      const deliveries = (await client.query("delete from connection_webhook_deliveries where id in (select id from connection_webhook_deliveries where created_at < now() - interval '30 days' order by created_at limit $1)", [limit])).rowCount ?? 0;
      return { expiredSetups, auditRecords, deliveries };
    });
    for (const setup of result.expiredSetups) await this.revokeTemporary(setup, "cleanup");
    return { ...result, expiredSetups: result.expiredSetups.length };
  }
  /** Signature validation belongs to the raw-body HTTP boundary. Never call
   * this method with an unverified or reserialized webhook payload. */
  async webhook(event: string, delivery: string, payload: unknown): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(delivery)) return fail("INVALID_REQUEST", 400);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("INVALID_REQUEST", 400);
    const body = payload as Record<string, unknown>;
    if (event !== "installation" && event !== "installation_repositories") return;
    const installation = body.installation;
    if (!installation || typeof installation !== "object" || Array.isArray(installation)) return fail("INVALID_REQUEST", 400);
    const installationId = providerId((installation as Record<string, unknown>).id);
    const action = body.action;
    let status: ConnectionRecord["status"] | undefined;
    let removed: string[] = [];
    if (event === "installation") {
      if (action === "deleted") status = "revoked";
      else if (action === "suspend") status = "suspended";
      else if (action === "unsuspend") status = "reconnect_required";
      else return;
    } else {
      if (action !== "removed") return; // Provider additions never widen consent.
      if (!Array.isArray(body.repositories_removed) || body.repositories_removed.length > 500) return fail("INVALID_REQUEST", 400);
      removed = body.repositories_removed.map((repository: unknown) => providerId(repository && typeof repository === "object" ? (repository as Record<string, unknown>).id : undefined));
    }
    const expiredSetups = await this.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`capykit-installation:${installationId}`]);
      const accepted = await client.query("insert into connection_webhook_deliveries(id) values($1) on conflict do nothing returning id", [delivery]);
      if (accepted.rowCount === 0) return [];
      await client.query("insert into connection_installation_events(installation_id,action) values($1,$2) on conflict (installation_id) do update set revision = connection_installation_events.revision + 1, action = excluded.action, updated_at = now()", [installationId, `${event}.${action}`]);
      const connections = (await client.query<Header & { workspace_id: string }>(`select ${columns}, workspace_id from provider_connections where installation_id = $1 for update`, [installationId])).rows;
      const discarded: Setup[] = [];
      for (const connection of connections) {
        const workspace = connection.workspace_id;
        if (status !== undefined) {
          // Local disconnect stays revoked when a later unsuspend arrives.
          const next = connection.status === "revoked" ? "revoked" : status;
          await client.query("update provider_connections set status = $3, generation = generation + 1, updated_at = now() where workspace_id = $1 and id = $2", [workspace, connection.id, next]);
          await this.audit(client, workspace, connection.id, null, delivery, next, null);
        } else {
          await client.query("delete from connection_repositories where workspace_id = $1 and connection_id = $2 and repository_id = any($3::text[])", [workspace, connection.id, removed]);
          await client.query("update provider_connections set generation = generation + 1, updated_at = now(), status = case when status = 'pending' then 'reconnect_required' when status = 'active' and not exists (select 1 from connection_repositories where workspace_id = $1 and connection_id = $2) then 'reconnect_required' else status end where workspace_id = $1 and id = $2", [workspace, connection.id]);
          await this.audit(client, workspace, connection.id, null, delivery, "repositories_removed");
        }
        discarded.push(...(await client.query<Setup>("delete from connection_setups where workspace_id = $1 and connection_id = $2 returning *", [workspace, connection.id])).rows);
      }
      return discarded;
    });
    for (const setup of expiredSetups) await this.revokeTemporary(setup, delivery);
  }
  async assertConnectionAccess(access: AuthorizedConnectionAccess): Promise<{ installationId: string; generation: number }> {
    identifier(access.workspaceId); identifier(access.connectionId);
    const repositoryIds = ids(access.repositoryIds);
    const permission: unknown = access.permission;
    if (permission !== "github.issues.list.v1") return fail("FORBIDDEN", 403);
    return this.transaction(async (client) => {
      const connection = (await client.query<{ installation_id: string | null; status: string; generation: number }>("select c.installation_id, c.status, c.generation from provider_connections c join workspaces w on w.id = c.workspace_id and w.active where c.workspace_id = $1 and c.id = $2 for share of c", [access.workspaceId, access.connectionId])).rows[0];
      if (!connection) return fail("NOT_FOUND", 404);
      if (connection.status !== "active" || !connection.installation_id) return fail("CONNECTION_INACTIVE", 403);
      const allowed = (await client.query<{ repository_id: string }>("select repository_id from connection_repositories where workspace_id = $1 and connection_id = $2 and repository_id = any($3::text[])", [access.workspaceId, access.connectionId, repositoryIds])).rows;
      if (allowed.length !== repositoryIds.length) return fail("FORBIDDEN", 403);
      return { installationId: connection.installation_id, generation: connection.generation };
    });
  }
  async withInstallationToken<T>(access: AuthorizedConnectionAccess, run: (token: string, assertAccess: () => Promise<void>) => Promise<T>): Promise<T> {
    const { provider } = this.configured();
    const initial = await this.assertConnectionAccess(access);
    const assertAccess = async () => {
      const current = await this.assertConnectionAccess(access);
      if (current.generation !== initial.generation || current.installationId !== initial.installationId) fail("CONNECTION_INACTIVE", 403);
    };
    let token: string | undefined;
    try {
      const minted = await provider.mint(initial.installationId, [...access.repositoryIds]);
      token = minted.token;
      const remaining = Date.parse(minted.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 3_600_000 + 30_000) return fail("GITHUB_RESPONSE_INVALID", 502);
      await assertAccess();
      const result = await run(token, assertAccess);
      await assertAccess();
      return result;
    } catch (error) {
      if (error instanceof GithubError && ["GITHUB_ACCESS_REVOKED", "GITHUB_AUTHORIZATION_FAILED", "GITHUB_PERMISSION_MISMATCH", "GITHUB_INSTALLATION_INVALID", "GITHUB_REPOSITORY_FORBIDDEN"].includes(error.code)) {
        await this.transaction(async (client) => {
          const updated = await client.query("update provider_connections set status = 'reconnect_required', generation = generation + 1, updated_at = now() where workspace_id = $1 and id = $2 and generation = $3 and status = 'active' returning id", [access.workspaceId, access.connectionId, initial.generation]);
          if (updated.rowCount) await this.audit(client, access.workspaceId, access.connectionId, null, "provider", "reconnect_required", "provider_failure");
        });
      }
      throw error;
    } finally {
      if (token !== undefined) {
        try { await provider.revokeInstallationToken(token); }
        catch { await this.transaction((client) => this.audit(client, access.workspaceId, access.connectionId, null, "runtime-cleanup", "provider_cleanup_failed", "provider_cleanup_failed")); }
      }
    }
  }
}
