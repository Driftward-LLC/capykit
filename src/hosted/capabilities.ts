import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { artifactSummary, validateArtifact, verifyArtifact, type CapabilityKind, type ValidatedArtifact } from "./artifacts.js";
import type { AuthenticatedContext } from "./identity.js";
import { authorizeWorkspace, requireWorkspaceOwner } from "./workspace-access.js";

export class CapabilityError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "MEMBERSHIP_INACTIVE" | "ARTIFACT_CORRUPT", readonly statusCode: number) {
    super(code);
    this.name = "CapabilityError";
  }
}

type ArtifactSummary = ReturnType<typeof artifactSummary>;
export interface CapabilityRecord {
  id: string;
  slug: string;
  name: string;
  kind: CapabilityKind;
  createdAt: string;
}
export interface CapabilityDetail extends CapabilityRecord {
  draft: (ArtifactSummary & { version: string; updatedAt: string }) | null;
  versions: (ArtifactSummary & { version: string; publishedAt: string })[];
}
export interface CapabilityDownload {
  format: "capykit.artifact.v1";
  capability: Omit<CapabilityRecord, "createdAt">;
  version: string;
  artifact: ValidatedArtifact;
  guidance: string[];
}

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const digestPattern = /^[0-9a-f]{64}$/;
function objectKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new CapabilityError("INVALID_REQUEST", 400);
  }
}
function requireRecord(record: CapabilityRecord | undefined): CapabilityRecord {
  if (record === undefined) throw new CapabilityError("NOT_FOUND", 404);
  return record;
}
function versionIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !versionPattern.test(value)) throw new CapabilityError("INVALID_REQUEST", 400);
}

/** The single hosted artifact authorization seam. ENG-124 may add exact-version
 * recipient grants here; until then every content operation requires an owner. */
export class CapabilityStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(context: AuthenticatedContext, id: string | undefined, run: (client: PoolClient, record?: CapabilityRecord) => Promise<T>): Promise<T> {
    if (!context.membership.active) throw new CapabilityError("MEMBERSHIP_INACTIVE", 401);
    if (id !== undefined && !idPattern.test(id)) throw new CapabilityError("INVALID_REQUEST", 400);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const actor = await authorizeWorkspace(client, context);
      const { workspaceId } = actor;
      let record: CapabilityRecord | undefined;
      if (id !== undefined) {
        record = (await client.query<CapabilityRecord>(
          `select id, slug, name, kind, created_at::text as "createdAt" from capabilities
           where workspace_id = $1 and id = $2 and deleted_at is null`, [workspaceId, id],
        )).rows[0];
        if (record === undefined) throw new CapabilityError("NOT_FOUND", 404);
      }
      requireWorkspaceOwner(actor);
      if (id !== undefined) {
        // Serialize publication, replacement, deletion and downloads of one
        // capability. A delete committed first can never hand out its bytes.
        const locked = await client.query("select id from capabilities where workspace_id = $1 and id = $2 and deleted_at is null for update", [workspaceId, id]);
        if (locked.rows.length !== 1) throw new CapabilityError("NOT_FOUND", 404);
      }
      const result = await run(client, record);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new CapabilityError("CONFLICT", 409);
      throw error;
    } finally {
      client.release();
    }
  }

  private async audit(client: PoolClient, context: AuthenticatedContext, id: string, action: string, version: string | null = null, digest: string | null = null): Promise<void> {
    await client.query(
      "insert into capability_audit (workspace_id, capability_id, actor_principal_id, action, version, digest) values ($1, $2, $3, $4, $5, $6)",
      [context.membership.workspaceId, id, context.membership.principalId, action, version, digest],
    );
  }

  private async describe(client: PoolClient, workspaceId: string, record: CapabilityRecord): Promise<CapabilityDetail> {
    const drafts = await client.query<{ metadata: ArtifactSummary; version: string; updatedAt: string }>(
      `select a.metadata, d.version, d.updated_at::text as "updatedAt" from capability_drafts d
       join capability_artifacts a on a.workspace_id = d.workspace_id and a.capability_id = d.capability_id and a.id = d.artifact_id
       where d.workspace_id = $1 and d.capability_id = $2`, [workspaceId, record.id],
    );
    const versions = await client.query<{ metadata: ArtifactSummary; version: string; publishedAt: string }>(
      `select a.metadata, v.version, v.published_at::text as "publishedAt" from capability_versions v
       join capability_artifacts a on a.workspace_id = v.workspace_id and a.capability_id = v.capability_id and a.id = v.artifact_id
       where v.workspace_id = $1 and v.capability_id = $2 order by v.published_at desc, v.version`, [workspaceId, record.id],
    );
    const draft = drafts.rows[0];
    return { ...record, draft: draft === undefined ? null : { ...draft.metadata, version: draft.version, updatedAt: draft.updatedAt }, versions: versions.rows.map((row) => ({ ...row.metadata, version: row.version, publishedAt: row.publishedAt })) };
  }

  private async readArtifact(client: PoolClient, workspaceId: string, id: string, artifactId: string): Promise<ValidatedArtifact> {
    const row = (await client.query<{ metadata: ArtifactSummary | null; digest: string; byteCount: number; fileCount: number }>(
      `select metadata, digest, byte_count as "byteCount", file_count as "fileCount" from capability_artifacts
       where workspace_id = $1 and capability_id = $2 and id = $3`, [workspaceId, id, artifactId],
    )).rows[0];
    const stored = await client.query<{ path: string; content: Buffer }>(
      "select path, content from capability_artifact_files where workspace_id = $1 and capability_id = $2 and artifact_id = $3", [workspaceId, id, artifactId],
    );
    try {
      if (row === undefined || row.metadata === null || !Array.isArray(row.metadata.files) || row.metadata.files.length !== stored.rows.length || row.metadata.digest !== row.digest || row.metadata.byteCount !== row.byteCount || row.metadata.fileCount !== row.fileCount) throw new Error("Invalid artifact record");
      const bytes = new Map(stored.rows.map((file) => [file.path, file.content]));
      const files = row.metadata.files.map((file) => ({ ...file, contentBase64: bytes.get(file.path)?.toString("base64") }));
      return verifyArtifact({ ...row.metadata, files });
    } catch { throw new CapabilityError("ARTIFACT_CORRUPT", 500); }
  }

  async list(context: AuthenticatedContext): Promise<CapabilityRecord[]> {
    return this.transaction(context, undefined, async (client) => (await client.query<CapabilityRecord>(
      `select id, slug, name, kind, created_at::text as "createdAt" from capabilities
       where workspace_id = $1 and deleted_at is null order by created_at desc, id`, [context.membership.workspaceId],
    )).rows);
  }

  async create(context: AuthenticatedContext, input: unknown): Promise<CapabilityDetail> {
    objectKeys(input, ["slug", "name", "kind"]);
    if (typeof input.slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 80 || typeof input.name !== "string" || input.name.trim().length < 1 || input.name.trim().length > 120 || (input.kind !== "skill" && input.kind !== "function")) throw new CapabilityError("INVALID_REQUEST", 400);
    const { slug, name, kind } = input;
    return this.transaction(context, undefined, async (client) => {
      const record = (await client.query<CapabilityRecord>(
        `insert into capabilities (workspace_id, slug, name, kind, created_by_principal_id) values ($1, $2, $3, $4, $5)
         returning id, slug, name, kind, created_at::text as "createdAt"`,
        [context.membership.workspaceId, slug, name.trim(), kind, context.membership.principalId],
      )).rows[0];
      if (record === undefined) throw new Error("Capability creation failed");
      await this.audit(client, context, record.id, "created");
      return { ...record, draft: null, versions: [] };
    });
  }

  async detail(context: AuthenticatedContext, id: string): Promise<CapabilityDetail> {
    return this.transaction(context, id, (client, record) => this.describe(client, context.membership.workspaceId, requireRecord(record)));
  }

  async saveDraft(context: AuthenticatedContext, id: string, input: unknown): Promise<CapabilityDetail> {
    objectKeys(input, ["version", "artifact"]);
    versionIdentifier(input.version);
    const version = input.version;
    return this.transaction(context, id, async (client, record) => {
      const workspaceId = context.membership.workspaceId;
      const existing = await client.query("select version from capability_versions where workspace_id = $1 and capability_id = $2 and version = $3", [workspaceId, id, input.version]);
      if (existing.rows.length !== 0) throw new CapabilityError("CONFLICT", 409);
      const artifact = validateArtifact(requireRecord(record).kind, input.artifact);
      const previous = (await client.query<{ artifact_id: string }>("select artifact_id from capability_drafts where workspace_id = $1 and capability_id = $2", [workspaceId, id])).rows[0];
      const artifactId = randomUUID();
      await client.query(
        "insert into capability_artifacts (workspace_id, capability_id, id, digest, byte_count, file_count, metadata) values ($1, $2, $3, $4, $5, $6, $7)",
        [workspaceId, id, artifactId, artifact.digest, artifact.byteCount, artifact.fileCount, artifactSummary(artifact)],
      );
      // One bounded statement persists all bytes. The entire upload and draft
      // reference commit together, so interrupted requests leave no orphan.
      await client.query(
        `insert into capability_artifact_files (workspace_id, capability_id, artifact_id, path, content)
         select $1, $2, $3, f.path, decode(f.content, 'base64') from jsonb_to_recordset($4::jsonb) as f(path text, content text)`,
        [workspaceId, id, artifactId, JSON.stringify(artifact.files.map((file) => ({ path: file.path, content: file.contentBase64 })))],
      );
      await client.query(
        `insert into capability_drafts (workspace_id, capability_id, version, artifact_id, updated_by_principal_id)
         values ($1, $2, $3, $4, $5) on conflict (workspace_id, capability_id) do update
         set version = excluded.version, artifact_id = excluded.artifact_id, updated_by_principal_id = excluded.updated_by_principal_id, updated_at = now()`,
        [workspaceId, id, input.version, artifactId, context.membership.principalId],
      );
      if (previous !== undefined) await client.query("delete from capability_artifacts where workspace_id = $1 and capability_id = $2 and id = $3", [workspaceId, id, previous.artifact_id]);
      await this.audit(client, context, id, "draft_saved", version, artifact.digest);
      return this.describe(client, workspaceId, requireRecord(record));
    });
  }

  async publish(context: AuthenticatedContext, id: string, input: unknown): Promise<CapabilityDetail> {
    objectKeys(input, ["version", "digest"]);
    versionIdentifier(input.version);
    if (typeof input.digest !== "string" || !digestPattern.test(input.digest)) throw new CapabilityError("INVALID_REQUEST", 400);
    const version = input.version;
    return this.transaction(context, id, async (client, record) => {
      const workspaceId = context.membership.workspaceId;
      const existing = (await client.query<{ artifact_id: string; digest: string }>(
        `select v.artifact_id, a.digest from capability_versions v join capability_artifacts a
         on a.workspace_id = v.workspace_id and a.capability_id = v.capability_id and a.id = v.artifact_id
         where v.workspace_id = $1 and v.capability_id = $2 and v.version = $3`, [workspaceId, id, input.version],
      )).rows[0];
      if (existing !== undefined) {
        if (existing.digest !== input.digest) throw new CapabilityError("CONFLICT", 409);
        await this.readArtifact(client, workspaceId, id, existing.artifact_id);
        return this.describe(client, workspaceId, requireRecord(record));
      }
      const draft = (await client.query<{ artifact_id: string; version: string }>("select artifact_id, version from capability_drafts where workspace_id = $1 and capability_id = $2", [workspaceId, id])).rows[0];
      if (draft === undefined || draft.version !== input.version) throw new CapabilityError("CONFLICT", 409);
      const artifact = await this.readArtifact(client, workspaceId, id, draft.artifact_id);
      if (artifact.digest !== input.digest || artifact.kind !== requireRecord(record).kind) throw new CapabilityError("CONFLICT", 409);
      await client.query(
        "insert into capability_versions (workspace_id, capability_id, version, artifact_id, published_by_principal_id) values ($1, $2, $3, $4, $5)",
        [workspaceId, id, input.version, draft.artifact_id, context.membership.principalId],
      );
      await client.query("delete from capability_drafts where workspace_id = $1 and capability_id = $2", [workspaceId, id]);
      await this.audit(client, context, id, "published", version, artifact.digest);
      return this.describe(client, workspaceId, requireRecord(record));
    });
  }

  async download(context: AuthenticatedContext, id: string, version: string): Promise<CapabilityDownload> {
    versionIdentifier(version);
    return this.transaction(context, id, async (client, record) => {
      const published = (await client.query<{ artifact_id: string }>(
        "select artifact_id from capability_versions where workspace_id = $1 and capability_id = $2 and version = $3", [context.membership.workspaceId, id, version],
      )).rows[0];
      if (published === undefined) throw new CapabilityError("NOT_FOUND", 404);
      const artifact = await this.readArtifact(client, context.membership.workspaceId, id, published.artifact_id);
      if (artifact.kind !== requireRecord(record).kind) throw new CapabilityError("ARTIFACT_CORRUPT", 500);
      return {
        format: "capykit.artifact.v1", capability: { id, slug: requireRecord(record).slug, name: requireRecord(record).name, kind: requireRecord(record).kind }, version, artifact,
        guidance: requireRecord(record).kind === "skill"
          ? ["Decode every contentBase64 file to its relative path in a new directory; preserve executable flags where supported.", "Read SKILL.md before using supporting scripts. Retrieval does not execute any file.", "This exact version is an owner download. Publishing creates no execution or recipient grant."]
          : ["index.mjs is stored with the reviewed github.issues.list.v1 contract.", "Execution requires the hosted runner and an explicit exact-version grant; publication does not execute code or grant provider access."],
      };
    });
  }

  async delete(context: AuthenticatedContext, id: string): Promise<void> {
    return this.transaction(context, id, async (client) => {
      const workspaceId = context.membership.workspaceId;
      // All authorization paths reject this marker. ENG-124 must revoke any
      // future grants in this same transaction before removing content.
      await client.query("update capabilities set deleted_at = now() where workspace_id = $1 and id = $2", [workspaceId, id]);
      const deletedArtifacts = await client.query<{ version: string; digest: string }>(
        `select v.version, a.digest from capability_versions v join capability_artifacts a
         on a.workspace_id = v.workspace_id and a.capability_id = v.capability_id and a.id = v.artifact_id
         where v.workspace_id = $1 and v.capability_id = $2
         union all
         select d.version, a.digest from capability_drafts d join capability_artifacts a
         on a.workspace_id = d.workspace_id and a.capability_id = d.capability_id and a.id = d.artifact_id
         where d.workspace_id = $1 and d.capability_id = $2`, [workspaceId, id],
      );
      if (deletedArtifacts.rows.length === 0) await this.audit(client, context, id, "deleted");
      for (const artifact of deletedArtifacts.rows) await this.audit(client, context, id, "deleted", artifact.version, artifact.digest);
      await client.query("delete from capability_drafts where workspace_id = $1 and capability_id = $2", [workspaceId, id]);
      await client.query("delete from capability_artifact_files where workspace_id = $1 and capability_id = $2", [workspaceId, id]);
      await client.query("delete from capability_artifacts a where a.workspace_id = $1 and a.capability_id = $2 and not exists (select 1 from capability_versions v where v.workspace_id = a.workspace_id and v.capability_id = a.capability_id and v.artifact_id = a.id)", [workspaceId, id]);
    });
  }
}
