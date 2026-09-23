import { randomUUID } from "node:crypto";
import { Client } from "pg";

const env = process.env;
const required = ["DATABASE_URL", "CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG", "CAPYKIT_BOOTSTRAP_WORKSPACE_NAME", "CAPYKIT_BOOTSTRAP_AUTH_USER_ID", "CAPYKIT_BOOTSTRAP_OWNER_EMAIL"];
const missing = required.filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(2);
}

const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000 });
await client.connect();
try {
  await client.query("begin");
  const workspace = await client.query(
    `insert into workspaces (id, slug, name) values ($1, $2, $3)
     on conflict (slug) do update set name = excluded.name
     returning id, active`,
    [randomUUID(), env.CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG, env.CAPYKIT_BOOTSTRAP_WORKSPACE_NAME],
  );
  const resolvedWorkspaceId = workspace.rows[0].id;
  if (!workspace.rows[0].active) throw new Error("Cannot bootstrap an inactive workspace");
  const existingPrincipal = await client.query(
    `select p.id, p.workspace_id, p.kind, p.active
       from identity_bindings b join principals p on p.id = b.principal_id
      where b.provider = 'gotrue' and b.provider_subject = $1`,
    [env.CAPYKIT_BOOTSTRAP_AUTH_USER_ID],
  );
  const existing = existingPrincipal.rows[0];
  if (existing !== undefined && (existing.workspace_id !== resolvedWorkspaceId || existing.kind !== "human" || !existing.active)) {
    throw new Error("Owner identity must be an active human in the selected workspace");
  }
  const principal = existing ?? (await client.query(
    `insert into principals (id, workspace_id, kind, display_name)
     values ($1, $2, 'human', $3)
     returning id`,
    [randomUUID(), resolvedWorkspaceId, env.CAPYKIT_BOOTSTRAP_OWNER_EMAIL],
  )).rows[0];
  await client.query(
    `insert into identity_bindings (principal_id, provider, provider_subject, email, verified_at)
     values ($1, 'gotrue', $2, $3, now())
     on conflict (provider, provider_subject) do update set email = excluded.email, verified_at = excluded.verified_at`,
    [principal.id, env.CAPYKIT_BOOTSTRAP_AUTH_USER_ID, env.CAPYKIT_BOOTSTRAP_OWNER_EMAIL],
  );
  const membership = await client.query(
    `insert into workspace_memberships (workspace_id, principal_id, role, active)
     values ($1, $2, 'owner', true)
     on conflict (workspace_id, principal_id) do update set role = 'owner'
     returning active`,
    [resolvedWorkspaceId, principal.id],
  );
  if (!membership.rows[0].active) throw new Error("Cannot bootstrap an inactive membership");
  await client.query("commit");
  console.log(JSON.stringify({ workspaceId: resolvedWorkspaceId, principalId: principal.id }));
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}
