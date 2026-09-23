import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Operator-only: never give the normal API these database-owner/signing secrets.
const env = process.env;
const required = ["DATABASE_URL", "CAPYKIT_AUTH_URL", "CAPYKIT_AUTH_JWT_SECRET",
  "CAPYKIT_BOOTSTRAP_OWNER_EMAIL", "CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG",
  "CAPYKIT_BOOTSTRAP_WORKSPACE_NAME"];
const missing = required.filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(2);
}

try {
  const email = env.CAPYKIT_BOOTSTRAP_OWNER_EMAIL.trim().toLowerCase();
  const origin = new URL(env.CAPYKIT_AUTH_URL);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Invalid auth origin");
  if (env.CAPYKIT_AUTH_JWT_SECRET.length < 32) throw new Error("Signing secret is too short");
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role: "service_role", aud: "authenticated", iat: now, exp: now + 120 })}`;
  const token = `${payload}.${createHmac("sha256", env.CAPYKIT_AUTH_JWT_SECRET).update(payload).digest("base64url")}`;
  async function admin(path, method = "GET", body) {
    const response = await fetch(new URL(path, origin), {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Auth administration failed");
    return response.json();
  }
  let user;
  for (let page = 1; ; page++) {
    const result = await admin(`/admin/users?page=${page}&per_page=100`);
    if (!Array.isArray(result.users)) throw new Error("Invalid user list");
    user = result.users.find((entry) => entry.email?.toLowerCase() === email);
    if (user || result.users.length < 100) break;
  }
  if (user === undefined) user = await admin("/admin/users", "POST", { email, email_confirm: true });
  if (typeof user.id !== "string" || !user.email_confirmed_at || (user.banned_until && Date.parse(user.banned_until) > Date.now())) throw new Error("Owner must be active and verified");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./bootstrap-hosted-owner.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 30000,
    env: { ...env, CAPYKIT_BOOTSTRAP_AUTH_USER_ID: user.id, CAPYKIT_BOOTSTRAP_OWNER_EMAIL: email },
  });
  if (result.status !== 0) throw new Error("Workspace bootstrap failed");
  const identity = JSON.parse(result.stdout);
  console.log(JSON.stringify({ status: "provisioned", workspaceId: identity.workspaceId, principalId: identity.principalId }));
} catch {
  console.error("Owner provisioning failed; inspect the auth/database configuration without printing credentials.");
  process.exitCode = 1;
}
