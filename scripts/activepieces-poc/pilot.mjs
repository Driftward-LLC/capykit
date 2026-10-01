import { fork } from "node:child_process";

export const actions = Object.freeze({
  "github.issue.read": { provider: "github", package: "@activepieces/piece-github", version: "0.9.0", action: "get_issue_ai" },
  "google-drive.file.metadata": { provider: "google-drive", package: "@activepieces/piece-google-drive", version: "0.11.0", action: "drive_get_file" },
});

export class PilotError extends Error {
  constructor(code) { super(code); this.name = "PilotError"; this.code = code; }
}
const deny = (code) => { throw new PilotError(code); };

function validate(request) {
  if (!request || !Object.hasOwn(actions, request.action)) deny("ACTION_NOT_ALLOWED");
  if (typeof request.connectionId !== "string" || typeof request.resource !== "string") deny("INVALID_INPUT");
  if (request.action === "github.issue.read") {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(request.resource)
      || [".", ".."].includes(request.resource.split("/")[1])
      || !Number.isSafeInteger(request.issueNumber) || request.issueNumber < 1) deny("INVALID_INPUT");
  } else if (!/^[A-Za-z0-9_-]{1,200}$/.test(request.resource)) deny("INVALID_INPUT");
}

// Only a trusted backend/harness may supply this context. It is NOT an HTTP
// authorization layer: production must resolve identity and grants from the DB.
function authorize(context, request) {
  const principal = context.principal;
  if (!principal?.active) deny("PRINCIPAL_INACTIVE");
  const connection = context.connections.find((c) => c.workspaceId === principal.workspaceId && c.id === request.connectionId);
  if (!connection) deny("CONNECTION_NOT_FOUND");
  if (!connection.active) deny("CONNECTION_INACTIVE");
  if (connection.provider !== actions[request.action].provider) deny("PROVIDER_MISMATCH");
  const now = Date.now();
  // One current grant must cover the whole operation; never combine grants.
  const grant = context.grants.find((g) => g.active && g.workspaceId === principal.workspaceId
    && g.principalId === principal.id && g.connectionId === connection.id
    && g.action === request.action && g.resources.includes(request.resource)
    && Number.isFinite(g.expiresAt) && g.expiresAt > now);
  if (!grant || !connection.resources.includes(request.resource)) deny("FORBIDDEN");
  if (typeof connection.token !== "string" || connection.token.length === 0 || connection.token.length > 16384
    || /\s/.test(connection.token) || !Number.isFinite(connection.expiresAt) || connection.expiresAt <= now) deny("CONNECTION_EXPIRED");
  return connection;
}

function execute(request, token, fixture, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Fresh process per action: no ambient host credentials, no package logs.
    // This bounds lifetime; it is not a security sandbox for untrusted code.
    const child = fork(new URL("./worker.mjs", import.meta.url), [], {
      env: {}, execArgv: ["--max-old-space-size=128"], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      error ? reject(new PilotError(error)) : resolve(value);
    };
    const timer = setTimeout(() => finish("CONNECTOR_TIMEOUT"), timeoutMs);
    child.once("error", () => finish("CONNECTOR_FAILED"));
    child.once("exit", () => finish("CONNECTOR_FAILED"));
    child.once("message", (message) => {
      if (!message?.ok) return finish("PROVIDER_REQUEST_FAILED");
      const json = JSON.stringify(message.result);
      if (!json || Buffer.byteLength(json) > 32768 || json.includes(token)) return finish("INVALID_PROVIDER_RESULT");
      finish(null, message.result);
    });
    child.send({ request, token, fixture }, (error) => { if (error) finish("CONNECTOR_FAILED"); });
  });
}

export async function invoke(context, request, { fixture, timeoutMs = 15000 } = {}) {
  validate(request);
  // Snapshot input before awaiting so callers cannot change the authorized target.
  request = { action: request.action, connectionId: request.connectionId, resource: request.resource, issueNumber: request.issueNumber };
  const connection = authorize(context, request);
  const principalId = context.principal.id;
  const workspaceId = context.principal.workspaceId;
  const generation = connection.generation;
  const result = await execute(request, connection.token, fixture, timeoutMs);
  if (context.principal.id !== principalId || context.principal.workspaceId !== workspaceId) deny("PRINCIPAL_CHANGED");
  const current = authorize(context, request);
  if (current !== connection || current.generation !== generation) deny("CONNECTION_INACTIVE");
  return { connector: actions[request.action], transport: fixture ? "fixture" : "live", result };
}
