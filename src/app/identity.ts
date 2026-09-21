import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export type PrincipalKind = "human" | "agent";
export type WorkspaceRole = "owner" | "member";

export interface Principal { readonly workspaceId: string; readonly principalId: string; readonly kind: PrincipalKind; readonly displayName: string; readonly active: boolean; }
export interface Membership { readonly workspaceId: string; readonly principalId: string; readonly role: WorkspaceRole; readonly active: boolean; }
export interface AuthenticatedContext { readonly requestId: string; readonly workspaceId: string; readonly principal: Principal; readonly membership: Membership; }
export interface IdentityStore { readonly resolvePrincipal: (sessionPrincipalId: string) => Promise<Principal | undefined>; readonly activeMembership: (workspaceId: string, principalId: string) => Promise<Membership | undefined>; readonly close?: () => Promise<void>; }

export class AuthError extends Error {
  constructor(readonly code: "unauthenticated" | "membership_inactive" | "forbidden" | "not_found") { super(code); }
}

export async function authenticatedContext(store: IdentityStore, sessionPrincipalId: string | undefined, requestId: string = randomUUID()): Promise<AuthenticatedContext> {
  if (sessionPrincipalId === undefined || sessionPrincipalId.length === 0) throw new AuthError("unauthenticated");
  const principal = await store.resolvePrincipal(sessionPrincipalId);
  if (principal === undefined || !principal.active) throw new AuthError("unauthenticated");
  const membership = await store.activeMembership(principal.workspaceId, principal.principalId);
  if (membership === undefined || !membership.active) throw new AuthError("membership_inactive");
  return { requestId, workspaceId: principal.workspaceId, principal, membership };
}

export function requireOwner(context: AuthenticatedContext): void { if (context.membership.role !== "owner") throw new AuthError("forbidden"); }
export function requireSameWorkspace(context: AuthenticatedContext, workspaceId: string): void { if (context.workspaceId !== workspaceId) throw new AuthError("not_found"); }

export class InMemoryIdentityStore implements IdentityStore {
  readonly principals = new Map<string, Principal>();
  readonly memberships = new Map<string, Membership>();
  constructor(seed: { readonly principals: readonly Principal[]; readonly memberships: readonly Membership[] }) {
    for (const principal of seed.principals) this.principals.set(principal.principalId, principal);
    for (const membership of seed.memberships) this.memberships.set(`${membership.workspaceId}:${membership.principalId}`, membership);
  }
  resolvePrincipal(sessionPrincipalId: string): Promise<Principal | undefined> { return Promise.resolve(this.principals.get(sessionPrincipalId)); }
  activeMembership(workspaceId: string, principalId: string): Promise<Membership | undefined> { return Promise.resolve(this.memberships.get(`${workspaceId}:${principalId}`)); }
}

export class PgIdentityStore implements IdentityStore {
  readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 }); }
  async resolvePrincipal(sessionPrincipalId: string): Promise<Principal | undefined> {
    const result = await this.pool.query<Principal>("select workspace_id as \"workspaceId\", principal_id as \"principalId\", kind, display_name as \"displayName\", active from app_principals where principal_id = $1", [sessionPrincipalId]);
    return result.rows[0];
  }
  async activeMembership(workspaceId: string, principalId: string): Promise<Membership | undefined> {
    const result = await this.pool.query<Membership>("select workspace_id as \"workspaceId\", principal_id as \"principalId\", role, active from app_memberships where workspace_id = $1 and principal_id = $2 and active = true", [workspaceId, principalId]);
    return result.rows[0];
  }
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> { const client = await this.pool.connect(); try { return await fn(client); } finally { client.release(); } }
  async close(): Promise<void> { await this.pool.end(); }
}
