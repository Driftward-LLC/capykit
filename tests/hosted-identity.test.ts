import { describe, expect, it } from "vitest";
import { canManageWorkspace, canReadWorkspaceScopedRecord, workspaceScopedStatus, type AuthenticatedContext } from "../src/hosted/identity.js";

const owner: AuthenticatedContext = {
  identity: { provider: "supabase", subject: "user-1", email: "owner@example.com" },
  membership: { workspaceId: "workspace-a", principalId: "principal-1", principalKind: "human", role: "owner", active: true },
};

const agent: AuthenticatedContext = {
  identity: { provider: "supabase", subject: "agent-1", email: "agent@example.com" },
  membership: { workspaceId: "workspace-a", principalId: "principal-2", principalKind: "agent", role: "member", active: true },
};

describe("hosted workspace identity", () => {
  it("limits workspace management to active human owners", () => {
    expect(canManageWorkspace(owner.membership)).toBe(true);
    expect(canManageWorkspace(agent.membership)).toBe(false);
  });

  it("hides cross-workspace records", () => {
    expect(canReadWorkspaceScopedRecord(owner, { workspaceId: "workspace-a" })).toBe(true);
    expect(canReadWorkspaceScopedRecord(owner, { workspaceId: "workspace-b" })).toBe(false);
    expect(workspaceScopedStatus(owner, { workspaceId: "workspace-b" })).toBe(404);
  });

  it("denies inactive memberships before record lookup", () => {
    const inactive = { ...owner, membership: { ...owner.membership, active: false } };
    expect(workspaceScopedStatus(inactive, { workspaceId: "workspace-a" })).toBe(401);
  });
});
