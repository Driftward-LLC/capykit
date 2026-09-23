import { Pool } from "pg";
import type { AuthenticatedContext, VerifiedIdentity, WorkspaceMembership } from "./identity.js";

export interface DatabaseReadiness {
  readonly status: "ready" | "unavailable";
  readonly reason: "ok" | "missing_configuration" | "connection_failed";
}

export interface HostedDatabase {
  readonly pool: Pool;
  close(): Promise<void>;
  readiness(): Promise<DatabaseReadiness>;
  resolveContext(identity: VerifiedIdentity): Promise<AuthenticatedContext | undefined>;
}

export function createHostedDatabase(databaseUrl: string | undefined): HostedDatabase | undefined {
  if (databaseUrl === undefined) return undefined;
  const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  return {
    pool,
    async close() { await pool.end(); },
    async readiness() {
      try {
        await pool.query(`select b.provider, b.provider_subject, b.verified_at,
                                 p.kind, p.active, m.role, m.active, w.active
                            from identity_bindings b
                            join principals p on p.id = b.principal_id
                            join workspace_memberships m on m.principal_id = p.id and m.workspace_id = p.workspace_id
                            join workspaces w on w.id = m.workspace_id
                           limit 0`);
        // Fail readiness before serving a release whose artifact migration is missing.
        await pool.query(`select c.id, d.version, v.version, a.digest, f.path, e.action
                            from capabilities c
                            left join capability_drafts d on d.workspace_id = c.workspace_id and d.capability_id = c.id
                            left join capability_versions v on v.workspace_id = c.workspace_id and v.capability_id = c.id
                            left join capability_artifacts a on a.workspace_id = c.workspace_id and a.capability_id = c.id
                            left join capability_artifact_files f on f.workspace_id = a.workspace_id and f.artifact_id = a.id
                            left join capability_audit e on e.workspace_id = c.workspace_id and e.capability_id = c.id
                           limit 0`);
        await pool.query(`select c.id, r.repository_id, s.phase, a.action, d.id, e.revision
                            from provider_connections c
                            left join connection_repositories r on r.workspace_id = c.workspace_id and r.connection_id = c.id
                            left join connection_setups s on s.workspace_id = c.workspace_id and s.connection_id = c.id
                            left join connection_audit a on a.workspace_id = c.workspace_id and a.connection_id = c.id
                            left join connection_webhook_deliveries d on false
                            left join connection_installation_events e on e.installation_id = c.installation_id
                           limit 0`);
        return { status: "ready", reason: "ok" };
      } catch {
        return { status: "unavailable", reason: "connection_failed" };
      }
    },
    async resolveContext(identity) {
      const result = await pool.query<WorkspaceMembership>(
        `select m.workspace_id as "workspaceId",
                m.principal_id as "principalId",
                p.kind as "principalKind",
                m.role,
                m.active
           from identity_bindings b
           join principals p on p.id = b.principal_id
           join workspace_memberships m on m.principal_id = p.id and m.workspace_id = p.workspace_id
           join workspaces w on w.id = m.workspace_id
          where b.provider = $1 and b.provider_subject = $2 and b.verified_at is not null
            and p.active and m.active and w.active
          order by m.created_at asc
          limit 1`,
        [identity.provider, identity.subject],
      );
      const membership = result.rows[0];
      return membership === undefined ? undefined : { identity, membership };
    },
  };
}

export async function checkDatabaseReadiness(database: HostedDatabase | undefined): Promise<DatabaseReadiness> {
  return database === undefined ? { status: "unavailable", reason: "missing_configuration" } : database.readiness();
}
