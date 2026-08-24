import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadRegistryCatalog, REGISTRY_LAYERS, RegistryLoadError, type RegistryCatalog, type RegistryLayer, type RegistrySource } from "./registry.js";

const execFileAsync = promisify(execFile);
const sourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const defaultConfigPath = ".capykit/sources.json";

export type RegistryManagedSourceType = "local" | "git" | "http";

export interface RegistrySourceLock {
  readonly revision: string;
  readonly sha256: string;
  readonly syncedAt: string;
  readonly sourceUri: string;
}

interface ManagedSourceBase {
  readonly id: string;
  readonly layer: RegistryLayer;
  readonly type: RegistryManagedSourceType;
  readonly overrides?: readonly string[];
  readonly lock?: RegistrySourceLock;
}

export interface ManagedLocalRegistrySource extends ManagedSourceBase {
  readonly type: "local";
  readonly root: string;
  readonly path: string;
}

export interface ManagedGitRegistrySource extends ManagedSourceBase {
  readonly type: "git";
  readonly repository: string;
  readonly revision: string;
  readonly path: string;
}

export interface ManagedHttpRegistrySource extends ManagedSourceBase {
  readonly type: "http";
  readonly url: string;
  readonly cachePath?: string;
}

export type ManagedRegistrySource = ManagedLocalRegistrySource | ManagedGitRegistrySource | ManagedHttpRegistrySource;

export interface RegistrySourceConfig {
  readonly format: "capykit.registrySources.v0.1";
  readonly sources: readonly ManagedRegistrySource[];
}

export interface RegistrySourceInspection {
  readonly format: "capykit.registrySources.inspect.v0.1";
  readonly configPath: string;
  readonly sources: readonly ManagedRegistrySource[];
  readonly precedence: readonly { readonly id: string; readonly layer: RegistryLayer; readonly rank: number; readonly type: RegistryManagedSourceType; readonly locked: boolean; readonly sourceUri?: string; readonly revision?: string; readonly sha256?: string }[];
  readonly catalog?: RegistryCatalog;
}

export interface AddRegistrySourceInput {
  readonly id: string;
  readonly layer: RegistryLayer;
  readonly type: RegistryManagedSourceType;
  readonly root?: string;
  readonly repository?: string;
  readonly revision?: string;
  readonly path?: string;
  readonly url?: string;
  readonly cachePath?: string;
  readonly overrides?: readonly string[];
}

export interface SyncRegistrySourcesOptions {
  readonly offline?: boolean;
  readonly now?: () => Date;
}

function checksum(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function sortedSources(sources: readonly ManagedRegistrySource[]): ManagedRegistrySource[] {
  return [...sources].sort((left, right) => {
    const rank = REGISTRY_LAYERS.indexOf(left.layer) - REGISTRY_LAYERS.indexOf(right.layer);
    return rank === 0 ? left.id.localeCompare(right.id, "en-US") : rank;
  });
}

function assertSourceId(id: string): void {
  if (!sourceIdPattern.test(id)) throw new RegistryLoadError(`Registry source ID ${JSON.stringify(id)} must start with an ASCII letter or digit and contain only letters, digits, '.', '_', or '-'.`);
}

function assertLayer(layer: RegistryLayer): void {
  if (!REGISTRY_LAYERS.includes(layer)) throw new RegistryLoadError(`Unsupported registry source layer ${JSON.stringify(layer)}.`);
}

function assertAbsolute(path: string, label: string): void {
  if (!isAbsolute(path)) throw new RegistryLoadError(`${label} must be absolute; received ${JSON.stringify(path)}.`);
}

function assertRelative(path: string, label: string): void {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/u).includes("..")) throw new RegistryLoadError(`${label} must be root-relative without traversal; received ${JSON.stringify(path)}.`);
}

function assertGitPath(path: string): void {
  if (path.length === 0 || posix.isAbsolute(path) || path.includes("\0") || path.includes(":") || path.includes("\\") || path.split("/").includes("..")) throw new RegistryLoadError(`Git registry path must be repository-relative POSIX without traversal; received ${JSON.stringify(path)}.`);
}

function assertHttpUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new RegistryLoadError("HTTP registry sources must use HTTPS URLs.");
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") throw new RegistryLoadError("HTTP registry source URLs must not contain credentials or fragments.");
}

function validateManagedSource(source: ManagedRegistrySource): void {
  assertSourceId(source.id);
  assertLayer(source.layer);
  if (source.overrides !== undefined && source.overrides.some((id) => typeof id !== "string" || id.length === 0)) throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} overrides must contain non-empty tool IDs.`);
  if (source.type === "local") {
    assertAbsolute(source.root, `Registry source ${JSON.stringify(source.id)} root`);
    assertRelative(source.path, `Registry source ${JSON.stringify(source.id)} path`);
    return;
  }
  if (source.type === "git") {
    assertAbsolute(source.repository, `Git registry source ${JSON.stringify(source.id)} repository`);
    assertGitPath(source.path);
    if (source.revision.length === 0) throw new RegistryLoadError(`Git registry source ${JSON.stringify(source.id)} revision must be non-empty.`);
    return;
  }
  assertHttpUrl(source.url);
  if (source.cachePath !== undefined) assertRelative(source.cachePath, `HTTP registry source ${JSON.stringify(source.id)} cache path`);
}

function validateConfig(config: RegistrySourceConfig): void {
  const ids = new Set<string>();
  for (const source of config.sources) {
    validateManagedSource(source);
    if (ids.has(source.id)) throw new RegistryLoadError(`Registry source ID ${JSON.stringify(source.id)} is declared more than once.`);
    ids.add(source.id);
  }
}

export function resolveRegistrySourceConfigPath(configPath = defaultConfigPath): string {
  return resolve(configPath);
}

export async function readRegistrySourceConfig(configPath?: string): Promise<RegistrySourceConfig> {
  const absoluteConfigPath = resolveRegistrySourceConfigPath(configPath);
  try {
    const parsed = JSON.parse(await readFile(absoluteConfigPath, "utf8")) as RegistrySourceConfig;
    validateConfig(parsed);
    return parsed;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") return { format: "capykit.registrySources.v0.1", sources: [] };
    if (error instanceof RegistryLoadError) throw error;
    throw new RegistryLoadError(`Unable to read registry source config ${JSON.stringify(absoluteConfigPath)}.`, { cause: error });
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${String(process.pid)}.tmp`);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeRegistrySourceConfig(config: RegistrySourceConfig, configPath?: string): Promise<RegistrySourceConfig> {
  validateConfig(config);
  const normalized = { format: "capykit.registrySources.v0.1" as const, sources: sortedSources(config.sources) };
  await atomicWriteJson(resolveRegistrySourceConfigPath(configPath), normalized);
  return normalized;
}

export function managedSourceFromInput(input: AddRegistrySourceInput): ManagedRegistrySource {
  assertSourceId(input.id);
  assertLayer(input.layer);
  const base = input.overrides === undefined ? { id: input.id, layer: input.layer } : { id: input.id, layer: input.layer, overrides: input.overrides };
  if (input.type === "local") {
    if (input.root === undefined || input.path === undefined) throw new RegistryLoadError("Local registry sources require --root and --path.");
    return { ...base, type: "local", root: input.root, path: input.path };
  }
  if (input.type === "git") {
    if (input.repository === undefined || input.revision === undefined || input.path === undefined) throw new RegistryLoadError("Git registry sources require --repository, --revision, and --path.");
    return { ...base, type: "git", repository: input.repository, revision: input.revision, path: input.path };
  }
  if (input.url === undefined) throw new RegistryLoadError("HTTP registry sources require --url.");
  return input.cachePath === undefined ? { ...base, type: "http", url: input.url } : { ...base, type: "http", url: input.url, cachePath: input.cachePath };
}

export async function addRegistrySource(configPath: string | undefined, input: AddRegistrySourceInput): Promise<RegistrySourceConfig> {
  const config = await readRegistrySourceConfig(configPath);
  const source = managedSourceFromInput(input);
  validateManagedSource(source);
  if (config.sources.some(({ id }) => id === source.id)) throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} already exists.`);
  return writeRegistrySourceConfig({ ...config, sources: [...config.sources, source] }, configPath);
}

export async function removeRegistrySource(configPath: string | undefined, id: string): Promise<RegistrySourceConfig> {
  const config = await readRegistrySourceConfig(configPath);
  const sources = config.sources.filter((source) => source.id !== id);
  if (sources.length === config.sources.length) throw new RegistryLoadError(`Registry source ${JSON.stringify(id)} does not exist.`);
  return writeRegistrySourceConfig({ ...config, sources }, configPath);
}

async function readLocalSource(source: ManagedLocalRegistrySource): Promise<{ content: string; uri: string; revision: string }> {
  const root = resolve(source.root);
  const path = resolve(root, source.path);
  const contained = relative(root, path);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} resolves outside its configured root.`);
  const content = await readFile(path, "utf8");
  const digest = checksum(content);
  return { content, uri: pathToFileURL(path).href, revision: digest };
}

async function readGitSource(source: ManagedGitRegistrySource): Promise<{ content: string; uri: string; revision: string }> {
  const commit = (await execFileAsync("git", ["-C", source.repository, "rev-parse", "--verify", "--end-of-options", `${source.revision}^{commit}`], { encoding: "utf8", maxBuffer: 1024 })).stdout.trim();
  const content = (await execFileAsync("git", ["-C", source.repository, "show", "--end-of-options", `${commit}:${source.path}`], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })).stdout;
  return { content, uri: `git+${pathToFileURL(resolve(source.repository)).href}?revision=${encodeURIComponent(commit)}#${encodeURIComponent(source.path)}`, revision: commit };
}

async function readHttpSource(configDirectory: string, source: ManagedHttpRegistrySource, offline: boolean): Promise<{ content: string; uri: string; revision: string }> {
  const cachePath = resolve(configDirectory, source.cachePath ?? join("sources", `${source.id}.registry.json`));
  if (offline) {
    const content = await readFile(cachePath, "utf8");
    return { content, uri: pathToFileURL(cachePath).href, revision: checksum(content) };
  }
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) throw new RegistryLoadError(`Unable to fetch HTTP registry source ${JSON.stringify(source.id)}: ${String(response.status)} ${response.statusText}.`);
  const content = await response.text();
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, content, { encoding: "utf8", mode: 0o600 });
  return { content, uri: source.url, revision: checksum(content) };
}

export async function syncRegistrySources(configPath?: string, options: SyncRegistrySourcesOptions = {}): Promise<RegistrySourceConfig> {
  const absoluteConfigPath = resolveRegistrySourceConfigPath(configPath);
  const config = await readRegistrySourceConfig(configPath);
  const syncedAt = (options.now?.() ?? new Date()).toISOString();
  const nextSources: ManagedRegistrySource[] = [];
  for (const source of sortedSources(config.sources)) {
    const resolved = source.type === "local"
      ? await readLocalSource(source)
      : source.type === "git"
        ? await readGitSource(source)
        : await readHttpSource(dirname(absoluteConfigPath), source, options.offline === true);
    const lock = { revision: resolved.revision, sha256: checksum(resolved.content), syncedAt, sourceUri: resolved.uri };
    nextSources.push({ ...source, lock });
  }
  return writeRegistrySourceConfig({ ...config, sources: nextSources }, configPath);
}

function toRegistrySource(configDirectory: string, source: ManagedRegistrySource): RegistrySource {
  const withOverrides = <T extends RegistrySource>(registrySource: T): T => source.overrides === undefined ? registrySource : { ...registrySource, overrides: source.overrides };
  if (source.type === "local") return withOverrides({ id: source.id, layer: source.layer, type: "file", root: source.root, path: source.path });
  if (source.type === "git") return withOverrides({ id: source.id, layer: source.layer, type: "git", repository: source.repository, revision: source.lock?.revision ?? source.revision, path: source.path });
  if (source.lock === undefined) throw new RegistryLoadError(`HTTP registry source ${JSON.stringify(source.id)} must be synced before it can be loaded or inspected with catalog details.`);
  return withOverrides({ id: source.id, layer: source.layer, type: "file", root: configDirectory, path: source.cachePath ?? join("sources", `${source.id}.registry.json`) });
}

export async function inspectRegistrySources(configPath?: string, includeCatalog = true): Promise<RegistrySourceInspection> {
  const absoluteConfigPath = resolveRegistrySourceConfigPath(configPath);
  const config = await readRegistrySourceConfig(configPath);
  const sources = sortedSources(config.sources);
  const precedence = sources.map((source) => {
    const base = { id: source.id, layer: source.layer, rank: REGISTRY_LAYERS.indexOf(source.layer), type: source.type, locked: source.lock !== undefined };
    return source.lock === undefined ? base : { ...base, sourceUri: source.lock.sourceUri, revision: source.lock.revision, sha256: source.lock.sha256 };
  });
  if (!includeCatalog || sources.length === 0) return { format: "capykit.registrySources.inspect.v0.1", configPath: absoluteConfigPath, sources, precedence };
  const registrySources = sources.map((source) => toRegistrySource(dirname(absoluteConfigPath), source));
  const catalog = await loadRegistryCatalog(registrySources);
  return { format: "capykit.registrySources.inspect.v0.1", configPath: absoluteConfigPath, sources, precedence, catalog };
}
