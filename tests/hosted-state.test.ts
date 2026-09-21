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
    { workspaceId: "workspace-a", principalId: "agent-a", role: "agent", status: "active" },
    { workspaceId: "workspace-b", principalId: "human-b", role: "owner", status: "active" },
  ],
};

const records = [
  { id: "a-private-config", workspaceId: "workspace-a" },
  { id: "b-private-config", workspaceId: "workspace-b" },
] as const;

describe("hosted workspace access", () => {
  it("derives the active workspace from durable membership rows", () => {
    const session = createHostedSessionContext(hostedState, { externalSubject: "otp:derek@example.invalid" });

    expect(session.activeWorkspaceId).toBe("workspace-a");
    expect(session.principal.kind).toBe("human");
    expect(requireHostedWorkspaceAccess(session, "workspace-a").role).toBe("owner");
    expect(selectHostedWorkspaceRecords(session, records)).toEqual([records[0]]);
  });

  it("keeps agent principals distinct from human principals", () => {
    const session = createHostedSessionContext(hostedState, { externalSubject: "agent:capykit-bot" });

    expect(session.principal).toMatchObject({ id: "agent-a", kind: "agent" });
    expect(requireHostedWorkspaceAccess(session, "workspace-a").role).toBe("agent");
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
});
