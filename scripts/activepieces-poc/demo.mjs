import { pathToFileURL } from "node:url";
import { invoke } from "./pilot.mjs";

export function example() {
  const expiresAt = Date.now() + 60000;
  return {
    principal: { id: "pilot-agent", workspaceId: "pilot-workspace", active: true },
    connections: [
      { id: "github-pilot", workspaceId: "pilot-workspace", provider: "github", resources: ["example/project"], token: "fixture-github-token", expiresAt, active: true, generation: 1 },
      { id: "drive-pilot", workspaceId: "pilot-workspace", provider: "google-drive", resources: ["pilot-file"], token: "fixture-drive-token", expiresAt, active: true, generation: 1 },
    ],
    grants: [
      { principalId: "pilot-agent", workspaceId: "pilot-workspace", connectionId: "github-pilot", action: "github.issue.read", resources: ["example/project"], expiresAt, active: true },
      { principalId: "pilot-agent", workspaceId: "pilot-workspace", connectionId: "drive-pilot", action: "google-drive.file.metadata", resources: ["pilot-file"], expiresAt, active: true },
    ],
  };
}
export const githubRequest = { action: "github.issue.read", connectionId: "github-pilot", resource: "example/project", issueNumber: 1 };
export const driveRequest = { action: "google-drive.file.metadata", connectionId: "drive-pilot", resource: "pilot-file" };
export const githubFixture = { body: { number: 1, title: "Review connector trial", state: "open" } };
export const driveFixture = { body: { id: "pilot-file", name: "Connector trial", mimeType: "application/vnd.google-apps.document" } };

export async function demo() {
  const context = example();
  const reads = [await invoke(context, githubRequest, { fixture: githubFixture }), await invoke(context, driveRequest, { fixture: driveFixture })];
  const checks = [];
  for (const [name, change] of [
    ["other workspace", (c) => { c.principal.workspaceId = "other-workspace"; }],
    ["ungranted principal", (c) => { c.principal.id = "other-agent"; }],
    ["revoked grant", (c) => { c.grants[0].active = false; }],
    ["disconnected account", (c) => { c.connections[0].active = false; }],
  ]) {
    const denied = example(); change(denied);
    try {
      await invoke(denied, githubRequest, { fixture: githubFixture });
      throw new Error("Expected denial");
    } catch (error) {
      if (!["CONNECTION_NOT_FOUND", "FORBIDDEN", "CONNECTION_INACTIVE"].includes(error.code)) throw error;
      checks.push({ name, denied: true, code: error.code });
    }
  }
  return { mode: "Real Activepieces connector code; fixture HTTP responses; in-memory policy trial, not production authentication.", reads, checks };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await demo(), null, 2)); }
  catch { console.error("Connector demo failed. Run npm test for diagnostics."); process.exitCode = 1; }
}
