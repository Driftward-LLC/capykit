import { randomUUID } from "node:crypto";
import { Client } from "pg";

const env = process.env;
const required = ["DATABASE_URL", "CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG", "CAPYKIT_BOOTSTRAP_WORKSPACE_NAME", "CAPYKIT_BOOTSTRAP_SUPABASE_USER_ID", "CAPYKIT_BOOTSTRAP_OWNER_EMAIL"];
const missing = required.filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(2);
}

const client = new Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  await client.query("begin");
  const workspace = await client.query(
    `insert into workspaces (id, slug, name) values ($1, $2, $3)
     on conflict (slug) do update set name = excluded.name
     returning id`,
    [randomUUID(), env.CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG, env.CAPYKIT_BOOTSTRAP_WORKSPACE_NAME],
  );
  const resolvedWorkspaceId = workspace.rows[0].id;
  const existingPrincipal = await client.query(
    `select principal_id as id from identity_bindings where provider = 'supabase' and provider_subject = $1`,
    [env.CAPYKIT_BOOTSTRAP_SUPABASE_USER_ID],
  );
  const principal = existingPrincipal.rows[0] ?? (await client.query(
    `insert into principals (id, workspace_id, kind, display_name)
     values ($1, $2, 'human', $3)
     returning id`,
    [randomUUID(), resolvedWorkspaceId, env.CAPYKIT_BOOTSTRAP_OWNER_EMAIL],
  )).rows[0];
  await client.query(
    `insert into identity_bindings (principal_id, provider, provider_subject, email, verified_at)
     values ($1, 'supabase', $2, $3, now())
     on conflict (provider, provider_subject) do update set email = excluded.email, verified_at = excluded.verified_at`,
    [principal.rows[0].id, env.CAPYKIT_BOOTSTRAP_SUPABASE_USER_ID, env.CAPYKIT_BOOTSTRAP_OWNER_EMAIL],
  );
  await client.query(
    `insert into workspace_memberships (workspace_id, principal_id, role, active)
     values ($1, $2, 'owner', true)
     on conflict (workspace_id, principal_id) do update set role = 'owner', active = true`,
    [resolvedWorkspaceId, principal.rows[0].id],
  );
  await client.query("commit");
  console.log(JSON.stringify({ workspaceId: resolvedWorkspaceId, principalId: principal.rows[0].id }));
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}
