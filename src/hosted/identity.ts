export type PrincipalKind = "human" | "agent";
export type MembershipRole = "owner" | "member";

export interface VerifiedIdentity {
  readonly provider: "gotrue";
  readonly subject: string;
  readonly email: string;
}

export interface WorkspaceMembership {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly role: MembershipRole;
  readonly active: boolean;
}

export interface AuthenticatedContext {
  readonly identity: VerifiedIdentity;
  readonly membership: WorkspaceMembership;
}

export type StableErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_INVALID"
  | "CSRF_REQUIRED"
  | "MEMBERSHIP_INACTIVE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "ARTIFACT_CORRUPT"
  | "CONFLICT"
  | "ARTIFACT_BUSY"
  | "GITHUB_NOT_CONFIGURED"
  | "GITHUB_UNAVAILABLE"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_AUTHORIZATION_FAILED"
  | "GITHUB_ACCESS_REVOKED"
  | "GITHUB_INSTALLATION_INVALID"
  | "GITHUB_PERMISSION_MISMATCH"
  | "GITHUB_REPOSITORY_FORBIDDEN"
  | "GITHUB_RESPONSE_INVALID"
  | "GITHUB_RESPONSE_LIMIT"
  | "GITHUB_RESULT_LIMIT"
  | "GITHUB_TOKEN_SCOPE_INVALID"
  | "CONNECT_STATE_INVALID"
  | "CONNECT_SETUP_EXPIRED"
  | "CONNECTION_INACTIVE"
  | "WEBHOOK_INVALID"
  | "INTERNAL_ERROR"
  | "CONFIGURATION_UNAVAILABLE";

export function stableError(code: StableErrorCode, requestId: string): { readonly error: { readonly code: StableErrorCode; readonly requestId: string } } {
  return { error: { code, requestId } };
}

export function canManageWorkspace(membership: WorkspaceMembership): boolean {
  return membership.active && membership.principalKind === "human" && membership.role === "owner";
}

export function canReadWorkspaceScopedRecord(context: AuthenticatedContext, record: { readonly workspaceId: string }): boolean {
  return context.membership.active && context.membership.workspaceId === record.workspaceId;
}

export function workspaceScopedStatus(context: AuthenticatedContext, record: { readonly workspaceId: string } | undefined): 200 | 401 | 404 {
  if (!context.membership.active) return 401;
  if (record === undefined || record.workspaceId !== context.membership.workspaceId) return 404;
  return 200;
}
