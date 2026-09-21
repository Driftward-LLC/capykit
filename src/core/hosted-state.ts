export type HostedPrincipalKind = "human" | "agent";
export type HostedMembershipRole = "owner" | "admin" | "member" | "agent";

export interface HostedWorkspaceRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: "active" | "disabled";
}

export interface HostedPrincipalRow {
  readonly id: string;
  readonly kind: HostedPrincipalKind;
  readonly externalSubject: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
}

export interface HostedMembershipRow {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly role: HostedMembershipRole;
  readonly status: "active" | "disabled";
}

export interface HostedStateSnapshot {
  readonly workspaces: readonly HostedWorkspaceRow[];
  readonly principals: readonly HostedPrincipalRow[];
  readonly memberships: readonly HostedMembershipRow[];
}

export interface HostedSessionContext {
  readonly principal: HostedPrincipalRow;
  readonly memberships: readonly HostedMembershipRow[];
  readonly activeWorkspaceId: string;
}

export interface HostedSessionRequest {
  readonly externalSubject: string;
  readonly requestedWorkspaceId?: string | undefined;
}

export class HostedAccessError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_principal" | "inactive_principal" | "no_active_membership" | "workspace_forbidden",
  ) {
    super(message);
    this.name = "HostedAccessError";
  }
}

export function createHostedSessionContext(state: HostedStateSnapshot, request: HostedSessionRequest): HostedSessionContext {
  const principal = state.principals.find((entry) => entry.externalSubject === request.externalSubject);
  if (principal === undefined) throw new HostedAccessError("Authenticated subject is not a hosted principal.", "unknown_principal");
  if (principal.status !== "active") throw new HostedAccessError("Hosted principal is disabled.", "inactive_principal");

  const memberships = state.memberships.filter((membership) => membership.principalId === principal.id && membership.status === "active");
  if (memberships.length === 0) throw new HostedAccessError("Hosted principal has no active workspace membership.", "no_active_membership");

  const activeWorkspaceId = request.requestedWorkspaceId ?? memberships[0]?.workspaceId;
  if (activeWorkspaceId === undefined || !memberships.some((membership) => membership.workspaceId === activeWorkspaceId)) {
    throw new HostedAccessError("Requested workspace is not available to the authenticated principal.", "workspace_forbidden");
  }

  const workspace = state.workspaces.find((entry) => entry.id === activeWorkspaceId);
  if (workspace?.status !== "active") throw new HostedAccessError("Requested workspace is not active.", "workspace_forbidden");

  return { principal, memberships, activeWorkspaceId };
}

export function requireHostedWorkspaceAccess(session: HostedSessionContext, workspaceId: string): HostedMembershipRow {
  const membership = session.memberships.find((entry) => entry.workspaceId === workspaceId && entry.status === "active");
  if (membership === undefined) throw new HostedAccessError("Workspace access denied for authenticated principal.", "workspace_forbidden");
  return membership;
}

export interface HostedWorkspaceRecord {
  readonly id: string;
  readonly workspaceId: string;
}

export function selectHostedWorkspaceRecords<T extends HostedWorkspaceRecord>(session: HostedSessionContext, records: readonly T[]): T[] {
  return records.filter((record) => record.workspaceId === session.activeWorkspaceId);
}
