import { describe, expect, it } from "vitest";
import {
  createHostedSessionContext,
  HostedAccessError,
  requireHostedWorkspaceAccess,
  selectHostedWorkspaceRecords,
  type HostedStateSnapshot,
} from "../src/core/index.js";

const hostedState: HostedStateSnapshot = {
  workspaces: [
    { id: "workspace-a", slug: "pilot", name: "Pilot", status: "active" },
    { id: "workspace-b", slug: "second", name: "Second", status: "active" },
  ],
  principals: [
    { id: "human-a", kind: "human", externalSubject: "otp:derek@example.invalid", displayName: "Derek", status: "active" },
    { id: "agent-a", kind: "agent", externalSubject: "agent:capykit-bot", displayName: "Capykit Bot", status: "active" },
    { id: "human-b", kind: "human", externalSubject: "otp:other@example.invalid", displayName: "Other", status: "active" },
  ],
  memberships: [
    { workspaceId: "workspace-a", principalId: "human-a", role: "owner", status: "active" },
    { workspaceId: "workspace-a", principalId: "agent-a", role: "member", status: "active" },
    { workspaceId: "workspace-b", principalId: "human-b", role: "owner", status: "active" },
  ],
};

const records = [
  { id: "a-private-config", workspaceId: "workspace-a" },
  { id: "b-private-config", workspaceId: "workspace-b" },
] as const;

describe("hosted workspace access", () => {
  it("derives the active workspace from the supplied membership snapshot", () => {
    const session = createHostedSessionContext(hostedState, { externalSubject: "otp:derek@example.invalid" });

    expect(session.activeWorkspaceId).toBe("workspace-a");
    expect(session.principal.kind).toBe("human");
    expect(requireHostedWorkspaceAccess(session, "workspace-a").role).toBe("owner");
    expect(selectHostedWorkspaceRecords(session, records)).toEqual([records[0]]);
  });

  it("keeps agent principals distinct from human principals", () => {
    const session = createHostedSessionContext(hostedState, { externalSubject: "agent:capykit-bot" });

    expect(session.principal).toMatchObject({ id: "agent-a", kind: "agent" });
    expect(requireHostedWorkspaceAccess(session, "workspace-a").role).toBe("member");
  });

  it("rejects request-supplied workspace values without server-side membership", () => {
    expect(() => createHostedSessionContext(hostedState, {
      externalSubject: "otp:derek@example.invalid",
      requestedWorkspaceId: "workspace-b",
    })).toThrow(HostedAccessError);
  });

  it("prevents a second workspace from reading protected records", () => {
    const session = createHostedSessionContext(hostedState, { externalSubject: "otp:other@example.invalid" });

    expect(selectHostedWorkspaceRecords(session, records)).toEqual([records[1]]);
    expect(() => requireHostedWorkspaceAccess(session, "workspace-a")).toThrow(/Workspace access denied/u);
  });

  it.each([undefined, "workspace-b"])("excludes disabled workspaces when selecting %s", (requestedWorkspaceId) => {
    const state: HostedStateSnapshot = {
      ...hostedState,
      workspaces: hostedState.workspaces.map((workspace) => workspace.id === "workspace-a" ? { ...workspace, status: "disabled" } : workspace),
      memberships: [...hostedState.memberships, { workspaceId: "workspace-b", principalId: "human-a", role: "member", status: "active" }],
    };
    const session = createHostedSessionContext(state, { externalSubject: "otp:derek@example.invalid", requestedWorkspaceId });

    expect(session.activeWorkspaceId).toBe("workspace-b");
    expect(session.memberships.map((membership) => membership.workspaceId)).toEqual(["workspace-b"]);
    expect(selectHostedWorkspaceRecords(session, records)).toEqual([records[1]]);
    expect(() => requireHostedWorkspaceAccess(session, "workspace-a")).toThrow(/Workspace access denied/u);
    expect(() => createHostedSessionContext(state, {
      externalSubject: "otp:derek@example.invalid",
      requestedWorkspaceId: "workspace-a",
    })).toThrow(/Requested workspace is not available/u);
  });

  it.each(["disabled", "missing"] as const)("rejects a snapshot with only a %s workspace", (status) => {
    const state: HostedStateSnapshot = {
      ...hostedState,
      workspaces: status === "missing" ? [] : hostedState.workspaces.map((workspace) => ({ ...workspace, status })),
    };

    expect(() => createHostedSessionContext(state, { externalSubject: "otp:derek@example.invalid" }))
      .toThrow(/no active workspace membership/u);
  });

  it("rejects disabled membership and principal rows", () => {
    expect(() => createHostedSessionContext({
      ...hostedState,
      memberships: hostedState.memberships.map((membership) => ({ ...membership, status: "disabled" })),
    }, { externalSubject: "otp:derek@example.invalid" })).toThrow(/no active workspace membership/u);
    expect(() => createHostedSessionContext({
      ...hostedState,
      principals: hostedState.principals.map((principal) => ({ ...principal, status: "disabled" })),
    }, { externalSubject: "otp:derek@example.invalid" })).toThrow(/Hosted principal is disabled/u);
  });
});
