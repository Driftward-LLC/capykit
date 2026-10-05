import { invoke, PilotError } from "./pilot.mjs";

// Explicit operator probe, not an authenticated Capykit endpoint. Uses only a
// fresh, dedicated token supplied for this trial; never discovers host accounts.
try {
  const [provider, resource, number] = process.argv.slice(2);
  if (!["github", "google-drive"].includes(provider) || !resource) throw new PilotError("USAGE: npm run live -- github owner/repo issue-number | google-drive file-id");
  const variable = provider === "github" ? "CAPYKIT_POC_GITHUB_TOKEN" : "CAPYKIT_POC_GOOGLE_TOKEN";
  const token = process.env[variable];
  if (!token) throw new PilotError(`MISSING_${variable}`);
  // Do not inherit credentials into the connector subprocess.
  delete process.env[variable];
  const action = provider === "github" ? "github.issue.read" : "google-drive.file.metadata";
  const expiresAt = Date.now() + 60000;
  const context = {
    principal: { id: "operator", workspaceId: "operator-trial", active: true },
    connections: [{ id: "trial", workspaceId: "operator-trial", provider, resources: [resource], token, expiresAt, active: true, generation: 1 }],
    grants: [{ principalId: "operator", workspaceId: "operator-trial", connectionId: "trial", action, resources: [resource], expiresAt, active: true }],
  };
  const outcome = await invoke(context, { action, connectionId: "trial", resource, issueNumber: Number(number) });
  // A live check reports success and connector identity, not private content.
  console.log(JSON.stringify({ connector: outcome.connector, transport: outcome.transport, status: "passed" }));
} catch (error) {
  console.error(error instanceof PilotError ? error.code : "CONNECTOR_FAILED");
  process.exitCode = 1;
}
