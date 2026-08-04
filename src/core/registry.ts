import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REGISTRY_LAYERS = ["builtin", "organization", "host", "user"] as const;

export type RegistryLayer = (typeof REGISTRY_LAYERS)[number];

export interface RegistryTool extends Record<string, unknown> {
  readonly id: string;
}

export interface RegistryDocument extends Record<string, unknown> {
  readonly schemaVersion: string;
  readonly registry: { readonly id: string; readonly name: string; readonly [key: string]: unknown };
  readonly tools: readonly RegistryTool[];
}

interface RegistrySourceBase {
  readonly id: string;
  readonly layer: RegistryLayer;
  /** Tool IDs this source intentionally replaces from a lower-precedence layer. */
  readonly overrides?: readonly string[];
}

export interface LocalFileRegistrySource extends RegistrySourceBase {
  readonly type: "file";
  /** Absolute operator-configured root used for path containment. */
  readonly root: string;
  /** Root-relative path. Absolute paths, traversal, and symlink escapes are rejected. */
  readonly path: string;
}

export interface GitRegistrySource extends RegistrySourceBase {
  readonly type: "git";
  /** Absolute path to a local Git work tree or bare repository. */
  readonly repository: string;
  /** Immutable commit/tag or an explicitly chosen branch reference. */
  readonly revision: string;
  /** Repository-relative POSIX path to the registry document. */
  readonly path: string;
}

export type RegistrySource = LocalFileRegistrySource | GitRegistrySource;

export type RegistryTrustTier = "bundled" | "operator-approved";

export interface SourceProvenance {
  readonly sourceId: string;
  readonly layer: RegistryLayer;
  readonly sourceUri: string;
  readonly trustTier: RegistryTrustTier;
  readonly sha256: string;
  readonly fetchedAt: string;
  readonly revision: string;
  readonly registryId: string;
}

export interface ResolvedRegistryTool {
  readonly id: string;
  readonly record: RegistryTool;
  readonly provenance: SourceProvenance;
  /** Earlier records replaced by explicit overrides, oldest first. */
  readonly overridden: readonly SourceProvenance[];
}

export interface RegistryCatalog {
  readonly tools: readonly ResolvedRegistryTool[];
  readonly sources: readonly SourceProvenance[];
}

export class RegistryLoadError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryLoadError";
  }
}

export class RegistryConflictError extends RegistryLoadError {
  public readonly toolId: string;
  public readonly sourceIds: readonly string[];

  public constructor(toolId: string, sourceIds: readonly string[], message: string) {
    super(message);
    this.name = "RegistryConflictError";
    this.toolId = toolId;
    this.sourceIds = sourceIds;
  }
}

interface LoadedSource {
  readonly source: RegistrySource;
  readonly document: RegistryDocument;
  readonly provenance: SourceProvenance;
}

const layerRank = new Map<RegistryLayer, number>(REGISTRY_LAYERS.map((layer, index) => [layer, index]));

function checksum(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function requireAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new RegistryLoadError(`${label} must be absolute; received ${JSON.stringify(path)}. Relative paths are rejected so registry loading is independent of cwd.`);
  }
}

function requireRelativePath(path: string, label: string): void {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/u).includes("..")) {
    throw new RegistryLoadError(`${label} must be a non-empty root-relative path without null bytes or '..' traversal segments; received ${JSON.stringify(path)}.`);
  }
}

function requireGitPath(path: string): void {
  if (path.length === 0 || posix.isAbsolute(path) || path.split("/").includes("..") || path.includes(":") || path.includes("\\") || path.includes("\0")) {
    throw new RegistryLoadError(`Git registry path must be a non-empty repository-relative POSIX path without '..', ':', backslashes, or null bytes; received ${JSON.stringify(path)}.`);
  }
}

const forbiddenKey = /(^|[_-])(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|session[_-]?(cookie|token)|private[_-]?key|token|secret|password|passwd|cookie|authorization)([_-].*|$)/iu;
const forbiddenValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(^|\s)(Bearer|Basic)\s+\S+|(^|[^A-Za-z0-9])(gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA|ASIA)[A-Za-z0-9_-]+|https:\/\/(discord(app)?\.com)(:0*443)?\/api\/webhooks\/[0-9]+\/\S+|https:\/\/hooks\.slack\.com(:0*443)?\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/iu;

function rejectCredentials(value: unknown, sourceId: string, path = "$"): void {
  if (typeof value === "string" && forbiddenValue.test(value)) {
    throw new RegistryLoadError(`Registry source ${JSON.stringify(sourceId)} contains forbidden credential-like material at ${path}; the value was redacted.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      rejectCredentials(entry, sourceId, `${path}/${String(index)}`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}/${key}`;
    if (forbiddenKey.test(key)) {
      throw new RegistryLoadError(`Registry source ${JSON.stringify(sourceId)} contains forbidden credential-like key at ${entryPath}; the value was redacted.`);
    }
    rejectCredentials(entry, sourceId, entryPath);
  }
}

function parseDocument(content: string, sourceId: string): RegistryDocument {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new RegistryLoadError(`Registry source ${JSON.stringify(sourceId)} is not valid JSON.`, { cause: error });
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RegistryLoadError(`Registry source ${JSON.stringify(sourceId)} must contain a JSON object.`);
  }

  const candidate = value as Record<string, unknown>;
  const registry = candidate.registry;
  if (
    candidate.schemaVersion !== "0.1.0" ||
    typeof registry !== "object" ||
    registry === null ||
    Array.isArray(registry) ||
    typeof (registry as Record<string, unknown>).id !== "string" ||
    typeof (registry as Record<string, unknown>).name !== "string" ||
    !Array.isArray(candidate.tools)
  ) {
    throw new RegistryLoadError(`Registry source ${JSON.stringify(sourceId)} must use schemaVersion "0.1.0" and contain registry identity and tools.`);
  }

  rejectCredentials(candidate, sourceId);

  const seen = new Set<string>();
  for (const [index, tool] of candidate.tools.entries()) {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool) || typeof (tool as Record<string, unknown>).id !== "string") {
      throw new RegistryLoadError(`Registry source ${JSON.stringify(sourceId)} has a tool without a stable string id at index ${String(index)}.`);
    }
    const id = (tool as Record<string, unknown>).id as string;
    if (seen.has(id)) {
      throw new RegistryConflictError(id, [sourceId], `Registry source ${JSON.stringify(sourceId)} declares tool ${JSON.stringify(id)} more than once; tool IDs must be unique within a source.`);
    }
    seen.add(id);
  }

  return candidate as RegistryDocument;
}

async function loadSource(source: RegistrySource, fetchedAt: string): Promise<LoadedSource> {
  let content: string;
  let sourceUri: string;
  let revision: string | undefined;

  try {
    if (source.type === "file") {
      requireAbsolutePath(source.root, `Registry source ${JSON.stringify(source.id)} root`);
      requireRelativePath(source.path, `Registry source ${JSON.stringify(source.id)} path`);
      const canonicalRoot = await realpath(source.root);
      const canonicalPath = await realpath(resolve(canonicalRoot, source.path));
      const containedPath = relative(canonicalRoot, canonicalPath);
      if (containedPath === ".." || containedPath.startsWith(`..${sep}`) || isAbsolute(containedPath)) {
        throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} resolves outside its configured root.`);
      }
      const handle = await open(canonicalPath, "r");
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} must resolve to a regular file.`);
        content = await handle.readFile("utf8");
        const after = await handle.stat();
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} changed while it was being read; retry with stable source bytes.`);
        }
      } finally {
        await handle.close();
      }
      sourceUri = pathToFileURL(canonicalPath).href;
    } else {
      requireAbsolutePath(source.repository, `Git registry source ${JSON.stringify(source.id)} repository`);
      requireGitPath(source.path);
      const canonicalRepository = await realpath(source.repository);
      const revisionResult = await execFileAsync("git", ["-C", canonicalRepository, "rev-parse", "--verify", "--end-of-options", `${source.revision}^{commit}`], {
        encoding: "utf8",
        maxBuffer: 1024,
      });
      revision = revisionResult.stdout.trim();
      const result = await execFileAsync("git", ["-C", canonicalRepository, "show", "--end-of-options", `${revision}:${source.path}`], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      content = result.stdout;
      const repositoryUri = pathToFileURL(canonicalRepository).href;
      sourceUri = `git+${repositoryUri}?revision=${encodeURIComponent(revision)}#${encodeURIComponent(source.path)}`;
    }
  } catch (error) {
    if (error instanceof RegistryLoadError) throw error;
    throw new RegistryLoadError(`Unable to read registry source ${JSON.stringify(source.id)} (${source.type}).`, { cause: error });
  }

  const document = parseDocument(content, source.id);
  const sha256 = checksum(content);
  return {
    source,
    document,
    provenance: {
      sourceId: source.id,
      layer: source.layer,
      sourceUri,
      trustTier: source.layer === "builtin" ? "bundled" : "operator-approved",
      sha256,
      fetchedAt,
      revision: revision ?? sha256,
      registryId: document.registry.id,
    },
  };
}

function compareSources(left: RegistrySource, right: RegistrySource): number {
  const rankDifference = (layerRank.get(left.layer) ?? -1) - (layerRank.get(right.layer) ?? -1);
  return rankDifference === 0 ? left.id.localeCompare(right.id, "en-US") : rankDifference;
}

function validateSources(sources: readonly RegistrySource[]): void {
  const ids = new Set<string>();
  for (const source of sources) {
    if (typeof source.id !== "string" || source.id.trim().length === 0) throw new RegistryLoadError("Registry source IDs must be non-empty strings.");
    if (ids.has(source.id)) throw new RegistryLoadError(`Registry source ID ${JSON.stringify(source.id)} is declared more than once.`);
    if (!layerRank.has(source.layer)) throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} has unsupported layer ${JSON.stringify(source.layer)}.`);
    const sourceType: unknown = source.type;
    if (sourceType !== "file" && sourceType !== "git") throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} has unsupported type ${JSON.stringify(sourceType)}.`);
    if (source.overrides !== undefined && (!Array.isArray(source.overrides) || source.overrides.some((id) => typeof id !== "string" || id.length === 0))) {
      throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} overrides must contain only non-empty tool IDs.`);
    }
    ids.add(source.id);
  }
}

export interface RegistryLoadOptions {
  /** Injectable clock for reproducible catalogs and tests. */
  readonly now?: () => Date;
}

/**
 * Load and resolve registry layers with fixed precedence:
 * builtin < organization < host < user. Input order and process cwd never
 * affect the result. A higher layer must name every replaced tool in its
 * `overrides` list; same-layer collisions are always errors.
 */
export async function loadRegistryCatalog(sources: readonly RegistrySource[], options: RegistryLoadOptions = {}): Promise<RegistryCatalog> {
  validateSources(sources);
  const orderedSources = [...sources].sort(compareSources);
  const loadedSources: LoadedSource[] = [];
  const fetchedAt = (options.now?.() ?? new Date()).toISOString();
  for (const source of orderedSources) loadedSources.push(await loadSource(source, fetchedAt));

  const resolved = new Map<string, ResolvedRegistryTool>();
  for (const loaded of loadedSources) {
    const overrides = new Set(loaded.source.overrides ?? []);
    const documentIds = new Set(loaded.document.tools.map((tool) => tool.id));
    for (const overrideId of overrides) {
      if (!documentIds.has(overrideId)) {
        throw new RegistryLoadError(`Registry source ${JSON.stringify(loaded.source.id)} lists override ${JSON.stringify(overrideId)} but does not declare that tool.`);
      }
    }

    for (const record of loaded.document.tools) {
      const existing = resolved.get(record.id);
      if (existing === undefined) {
        if (overrides.has(record.id)) {
          throw new RegistryConflictError(record.id, [loaded.source.id], `Registry source ${JSON.stringify(loaded.source.id)} declares override ${JSON.stringify(record.id)}, but no lower-precedence record exists.`);
        }
        resolved.set(record.id, { id: record.id, record, provenance: loaded.provenance, overridden: [] });
        continue;
      }

      if (existing.provenance.layer === loaded.source.layer) {
        throw new RegistryConflictError(
          record.id,
          [existing.provenance.sourceId, loaded.source.id],
          `Tool ${JSON.stringify(record.id)} is declared by same-precedence ${loaded.source.layer} sources ${JSON.stringify(existing.provenance.sourceId)} and ${JSON.stringify(loaded.source.id)}. Move one record to another layer or remove the duplicate; same-layer overrides are not allowed.`,
        );
      }
      if (!overrides.has(record.id)) {
        throw new RegistryConflictError(
          record.id,
          [existing.provenance.sourceId, loaded.source.id],
          `Tool ${JSON.stringify(record.id)} from ${JSON.stringify(loaded.source.id)} conflicts with lower-precedence source ${JSON.stringify(existing.provenance.sourceId)}. Add ${JSON.stringify(record.id)} to ${JSON.stringify(loaded.source.id)}.overrides to replace it explicitly.`,
        );
      }
      resolved.set(record.id, {
        id: record.id,
        record,
        provenance: loaded.provenance,
        overridden: [...existing.overridden, existing.provenance],
      });
    }
  }

  return {
    tools: [...resolved.values()].sort((left, right) => left.id.localeCompare(right.id, "en-US")),
    sources: loadedSources.map(({ provenance }) => provenance),
  };
}

/** Resolve a path against an explicit base directory without consulting cwd. */
export function registryPath(baseDirectory: string, relativePath: string): string {
  requireAbsolutePath(baseDirectory, "Registry base directory");
  requireRelativePath(relativePath, "Registry relative path");
  const resolvedBase = resolve(baseDirectory);
  const resolvedPath = resolve(resolvedBase, relativePath);
  const containedPath = relative(resolvedBase, resolvedPath);
  if (containedPath === ".." || containedPath.startsWith(`..${sep}`) || isAbsolute(containedPath)) {
    throw new RegistryLoadError("Registry relative path resolves outside the configured base directory.");
  }
  return resolvedPath;
}
