import type { PoolClient } from "pg";
import { canManageWorkspace, type AuthenticatedContext, type WorkspaceMembership } from "./identity.js";

export class HostedAccessError extends Error {
  constructor(readonly code: "MEMBERSHIP_INACTIVE" | "FORBIDDEN", readonly statusCode: number) {
    super(code);
    this.name = "HostedAccessError";
  }
}

/** Run inside a transaction. Identity comes from the verified request; authority
 * is read again from PostgreSQL, and pooled RLS settings expire at transaction end. */
export async function authorizeWorkspace(client: PoolClient, context: AuthenticatedContext): Promise<WorkspaceMembership> {
  if (!context.membership.active) throw new HostedAccessError("MEMBERSHIP_INACTIVE", 401);
  const { workspaceId, principalId } = context.membership;
  await client.query("select set_config('capykit.workspace_id', $1, true), set_config('capykit.principal_id', $2, true)", [workspaceId, principalId]);
  const result = await client.query<WorkspaceMembership>(
    `select m.workspace_id as "workspaceId", m.principal_id as "principalId",
            p.kind as "principalKind", m.role, m.active
       from workspace_memberships m
       join principals p on p.workspace_id = m.workspace_id and p.id = m.principal_id
       join workspaces w on w.id = m.workspace_id
       join identity_bindings b on b.principal_id = p.id
      where m.workspace_id = $1 and m.principal_id = $2
        and m.active and p.active and w.active and b.verified_at is not null
        and b.provider = $3 and b.provider_subject = $4`,
    [workspaceId, principalId, context.identity.provider, context.identity.subject],
  );
  const membership = result.rows[0];
  if (membership === undefined || result.rows.length !== 1) throw new HostedAccessError("MEMBERSHIP_INACTIVE", 401);
  return membership;
}

export function requireWorkspaceOwner(membership: WorkspaceMembership): void {
  if (!canManageWorkspace(membership)) throw new HostedAccessError("FORBIDDEN", 403);
}
