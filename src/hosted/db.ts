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
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  return {
    pool,
    async close() { await pool.end(); },
    async readiness() {
      try {
        await pool.query("select 1");
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
           join workspace_memberships m on m.principal_id = p.id
          where b.provider = $1 and b.provider_subject = $2 and b.verified_at is not null
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
