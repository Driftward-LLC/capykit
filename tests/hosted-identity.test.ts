import { describe, expect, it } from "vitest";
import { authenticatedContext, AuthError, InMemoryIdentityStore, requireOwner, requireSameWorkspace } from "../src/app/identity.js";
const store = new InMemoryIdentityStore({ principals: [{ workspaceId: "workspace-a", principalId: "owner-a", kind: "human", displayName: "Owner A", active: true }, { workspaceId: "workspace-a", principalId: "agent-a", kind: "agent", displayName: "Agent A", active: true }, { workspaceId: "workspace-b", principalId: "owner-b", kind: "human", displayName: "Owner B", active: true }, { workspaceId: "workspace-a", principalId: "inactive-a", kind: "human", displayName: "Inactive", active: true }], memberships: [{ workspaceId: "workspace-a", principalId: "owner-a", role: "owner", active: true }, { workspaceId: "workspace-a", principalId: "agent-a", role: "member", active: true }, { workspaceId: "workspace-b", principalId: "owner-b", role: "owner", active: true }, { workspaceId: "workspace-a", principalId: "inactive-a", role: "member", active: false }] });
describe("hosted identity authorization", () => {
  it("derives workspace and role from active membership", async () => { const context = await authenticatedContext(store, "owner-a", "req-1"); expect(context.workspaceId).toBe("workspace-a"); expect(context.membership.role).toBe("owner"); });
  it("rejects forged or inactive sessions", async () => { await expect(authenticatedContext(store, undefined)).rejects.toMatchObject({ code: "unauthenticated" }); await expect(authenticatedContext(store, "missing")).rejects.toMatchObject({ code: "unauthenticated" }); await expect(authenticatedContext(store, "inactive-a")).rejects.toMatchObject({ code: "membership_inactive" }); });
  it("keeps workspace and owner boundaries explicit", async () => {
    const owner = await authenticatedContext(store, "owner-a");
    const agent = await authenticatedContext(store, "agent-a");
    expect(() => { requireSameWorkspace(owner, "workspace-b"); }).toThrow(AuthError);
    expect(() => { requireOwner(agent); }).toThrow(AuthError);
    expect(() => { requireOwner(owner); }).not.toThrow();
  });
});
