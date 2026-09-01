import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadRegistryCatalog, REGISTRY_LAYERS, RegistryLoadError, type RegistryCatalog, type RegistryLayer, type RegistrySource } from "./registry.js";

export type ApprovedRegistrySourceKind = "file" | "git" | "http";

interface ApprovedRegistrySourceBase {
  readonly id: string;
  readonly layer: RegistryLayer;
  readonly type: ApprovedRegistrySourceKind;
  readonly overrides?: readonly string[];
}

export interface ApprovedFileRegistrySource extends ApprovedRegistrySourceBase {
  readonly type: "file";
  readonly root: string;
  readonly path: string;
}

export interface ApprovedGitRegistrySource extends ApprovedRegistrySourceBase {
  readonly type: "git";
  readonly repository: string;
  readonly revision: string;
  readonly path: string;
}

export interface ApprovedHttpRegistrySource extends ApprovedRegistrySourceBase {
  readonly type: "http";
  readonly url: string;
}

export type ApprovedRegistrySource = ApprovedFileRegistrySource | ApprovedGitRegistrySource | ApprovedHttpRegistrySource;

export interface ApprovedRegistrySourceLock {
  readonly sourceId: string;
  readonly sourceUri: string;
  readonly sha256: string;
  readonly fetchedAt: string;
  readonly revision: string;
  readonly cachePath?: string;
}

export interface ApprovedRegistrySourcesConfig {
  readonly format: "capykit.registrySources.v0.1";
  readonly sources: readonly ApprovedRegistrySource[];
  readonly locks: readonly ApprovedRegistrySourceLock[];
}

export interface RegistrySourceMutationResult {
  readonly config: ApprovedRegistrySourcesConfig;
  readonly source: ApprovedRegistrySource;
  readonly lock: ApprovedRegistrySourceLock;
  readonly catalog: RegistryCatalog;
}

export interface RegistrySourceSyncResult {
  readonly config: ApprovedRegistrySourcesConfig;
  readonly updated: readonly ApprovedRegistrySourceLock[];
  readonly catalog: RegistryCatalog;
}

export interface RegistrySourceInspection {
  readonly format: "capykit.registrySources.inspect.v0.1";
  readonly sources: ReadonlyArray<ApprovedRegistrySource & { readonly lock?: ApprovedRegistrySourceLock | undefined }>;
  readonly precedence: ReadonlyArray<{ readonly toolId: string; readonly sourceId: string; readonly layer: RegistryLayer; readonly revision: string; readonly sha256: string; readonly overridden: readonly string[] }>;
}

export interface RegistrySourceAddOptions {
  readonly configPath: string;
  readonly source: ApprovedRegistrySource;
  readonly now?: () => Date;
}

export interface RegistrySourceSyncOptions {
  readonly configPath: string;
  readonly ids?: readonly string[];
  readonly offline?: boolean;
  readonly now?: () => Date;
}

const emptyConfig: ApprovedRegistrySourcesConfig = { format: "capykit.registrySources.v0.1", sources: [], locks: [] };

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function assertSourceId(id: string): void {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(id)) throw new RegistryLoadError(`Registry source ID ${JSON.stringify(id)} must be lowercase, stable, and namespaced with '.', '_' or '-'.`);
}

function assertLayer(layer: RegistryLayer): void {
  if (!REGISTRY_LAYERS.includes(layer)) throw new RegistryLoadError(`Unsupported registry source layer ${JSON.stringify(layer)}.`);
}

function assertOverrides(overrides: readonly string[] | undefined): void {
  if (overrides !== undefined && overrides.some((id) => typeof id !== "string" || id.length === 0)) throw new RegistryLoadError("Registry source overrides must contain only non-empty tool IDs.");
}

function assertRelativePath(path: string, label: string): void {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/u).includes("..")) throw new RegistryLoadError(`${label} must be root-relative without traversal.`);
}

function assertGitPath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes(":") || path.includes("\0") || path.split("/").includes("..")) throw new RegistryLoadError("Git registry path must be repository-relative POSIX without traversal.");
}

function assertApprovedSource(source: ApprovedRegistrySource): void {
  assertSourceId(source.id);
  assertLayer(source.layer);
  assertOverrides(source.overrides);
  if (source.type === "file") {
    if (!isAbsolute(source.root)) throw new RegistryLoadError("Local registry source root must be absolute.");
    assertRelativePath(source.path, "Local registry source path");
    return;
  }
  if (source.type === "git") {
    if (!isAbsolute(source.repository)) throw new RegistryLoadError("Git registry source repository must be absolute.");
    if (source.revision.length === 0) throw new RegistryLoadError("Git registry source revision must be non-empty.");
    assertGitPath(source.path);
    return;
  }
  assertSafeHttpsUrl(source.url);
}

async function readConfig(configPath: string): Promise<ApprovedRegistrySourcesConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ApprovedRegistrySourcesConfig>;
    if (parsed.format !== "capykit.registrySources.v0.1" || !Array.isArray(parsed.sources) || !Array.isArray(parsed.locks)) throw new RegistryLoadError("Registry sources config has unsupported format.");
    const config = { format: parsed.format, sources: parsed.sources as ApprovedRegistrySource[], locks: parsed.locks as ApprovedRegistrySourceLock[] } as const;
    for (const source of config.sources) assertApprovedSource(source);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig;
    if (error instanceof RegistryLoadError) throw error;
    throw new RegistryLoadError("Unable to read registry sources config.", { cause: error });
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${String(process.pid)}.tmp`);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function withSource(config: ApprovedRegistrySourcesConfig, source: ApprovedRegistrySource, lock: ApprovedRegistrySourceLock): ApprovedRegistrySourcesConfig {
  const sources = config.sources.filter((entry) => entry.id !== source.id);
  const locks = config.locks.filter((entry) => entry.sourceId !== source.id);
  return { format: config.format, sources: [...sources, source].sort(compareApprovedSources), locks: [...locks, lock].sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en-US")) };
}

function compareApprovedSources(left: ApprovedRegistrySource, right: ApprovedRegistrySource): number {
  const rankDifference = REGISTRY_LAYERS.indexOf(left.layer) - REGISTRY_LAYERS.indexOf(right.layer);
  return rankDifference === 0 ? left.id.localeCompare(right.id, "en-US") : rankDifference;
}

function cacheRelativePath(sourceId: string): string {
  return join("sources", `${sourceId}.registry.json`);
}

function cachePath(configPath: string, sourceId: string): string {
  return resolve(dirname(configPath), cacheRelativePath(sourceId));
}

function toLoaderSource(configPath: string, source: ApprovedRegistrySource, lock?: ApprovedRegistrySourceLock): RegistrySource {
  if (source.type === "file") return source;
  if (source.type === "git") return { ...source, revision: lock?.revision ?? source.revision };
  const cached = lock?.cachePath ?? cacheRelativePath(source.id);
  const loaderSource = { id: source.id, layer: source.layer, type: "file" as const, root: dirname(resolve(dirname(configPath), cached)), path: basename(cached) };
  return source.overrides === undefined ? loaderSource : { ...loaderSource, overrides: source.overrides };
}

function toSingleSourceForLock(source: ApprovedFileRegistrySource | ApprovedGitRegistrySource, lock?: ApprovedRegistrySourceLock): RegistrySource {
  if (source.type === "file") return { id: source.id, layer: source.layer, type: "file", root: source.root, path: source.path };
  return { id: source.id, layer: source.layer, type: "git", repository: source.repository, revision: lock?.revision ?? source.revision, path: source.path };
}

function assertSameOrigin(previous: URL, next: URL): void {
  if (next.origin !== previous.origin) throw new RegistryLoadError("HTTP registry redirects must stay on the original origin.");
}

function assertSafeHttpsUrl(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch (error) { throw new RegistryLoadError("HTTP registry source URL must be a valid HTTPS URL.", { cause: error }); }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new RegistryLoadError("HTTP registry source URL must be HTTPS without credentials, fragments, localhost, or .local hosts.");
  }
  if (/^[0-9a-f:.]+$/iu.test(hostname) && isNonPublicAddress(hostname)) throw new RegistryLoadError("HTTP registry source URL resolves to a non-public literal address.");
  return parsed;
}

const blockedAddresses = (() => {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const [network, prefix, type] of [
    ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"], ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.168.0.0", 16, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
    ["::", 96, "ipv6"], ["::1", 128, "ipv6"], ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
  ] as const) (type === "ipv4" ? ipv4 : ipv6).addSubnet(network, prefix, type);
  return { ipv4, ipv6 };
})();

function isNonPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, "");
  const version = isIP(normalized);
  if (version === 0) return true;
  return version === 4 ? blockedAddresses.ipv4.check(normalized, "ipv4") : blockedAddresses.ipv6.check(normalized, "ipv6");
}

async function assertPublicResolution(url: URL): Promise<void> {
  const entries = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (entries.length === 0 || entries.some(({ address }) => isNonPublicAddress(address))) throw new RegistryLoadError("HTTP registry source resolved to a non-public address.");
}

async function fetchHttpsRegistry(url: string): Promise<{ readonly content: string; readonly finalUrl: string }> {
  let current = assertSafeHttpsUrl(url);
  const origin = current;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    await assertPublicResolution(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 5000);
    try {
      const response = await fetch(current, { redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location === null) throw new RegistryLoadError("HTTP registry redirect did not include a location.");
        const next = assertSafeHttpsUrl(new URL(location, current).href);
        assertSameOrigin(origin, next);
        current = next;
        continue;
      }
      if (!response.ok) throw new RegistryLoadError(`HTTP registry source returned status ${String(response.status)}.`);
      const content = await response.text();
      if (Buffer.byteLength(content, "utf8") > 10 * 1024 * 1024) throw new RegistryLoadError("HTTP registry source exceeded the maximum response size.");
      return { content, finalUrl: current.href };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new RegistryLoadError("HTTP registry source exceeded the maximum redirect count.");
}

async function materializeHttpSource(configPath: string, source: ApprovedHttpRegistrySource, fetchedAt: string, offline: boolean, existingLock?: ApprovedRegistrySourceLock): Promise<ApprovedRegistrySourceLock> {
  const absoluteCache = cachePath(configPath, source.id);
  if (offline) {
    if (existingLock === undefined) throw new RegistryLoadError(`HTTP registry source ${JSON.stringify(source.id)} cannot sync offline without a last known-good cache.`);
    await stat(absoluteCache);
    return existingLock;
  }
  const { content, finalUrl } = await fetchHttpsRegistry(source.url);
  await mkdir(dirname(absoluteCache), { recursive: true });
  const temporary = `${absoluteCache}.${String(process.pid)}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  const candidateLock: ApprovedRegistrySourceLock = { sourceId: source.id, sourceUri: finalUrl, sha256: sha256(content), fetchedAt, revision: sha256(content), cachePath: cacheRelativePath(source.id) };
  await loadRegistryCatalog([toLoaderSource(configPath, source, candidateLock)], { now: () => new Date(fetchedAt) });
  await rename(temporary, absoluteCache);
  return candidateLock;
}

async function resolveSourceLock(configPath: string, source: ApprovedRegistrySource, fetchedAt: string, offline: boolean, existingLock?: ApprovedRegistrySourceLock): Promise<ApprovedRegistrySourceLock> {
  assertApprovedSource(source);
  if (source.type === "http") return materializeHttpSource(configPath, source, fetchedAt, offline, existingLock);
  const catalog = await loadRegistryCatalog([toSingleSourceForLock(source, existingLock)], { now: () => new Date(fetchedAt) });
  const provenance = catalog.sources.find(({ sourceId }) => sourceId === source.id);
  if (provenance === undefined) throw new RegistryLoadError(`Registry source ${JSON.stringify(source.id)} did not produce provenance.`);
  return { sourceId: source.id, sourceUri: provenance.sourceUri, sha256: provenance.sha256, fetchedAt: provenance.fetchedAt, revision: provenance.revision };
}

async function loadCatalogForConfig(configPath: string, config: ApprovedRegistrySourcesConfig): Promise<RegistryCatalog> {
  return loadRegistryCatalog(config.sources.map((source) => toLoaderSource(configPath, source, config.locks.find(({ sourceId }) => sourceId === source.id))));
}

export async function addRegistrySource(options: RegistrySourceAddOptions): Promise<RegistrySourceMutationResult> {
  const config = await readConfig(options.configPath);
  const fetchedAt = (options.now?.() ?? new Date()).toISOString();
  const lock = await resolveSourceLock(options.configPath, options.source, fetchedAt, false, config.locks.find(({ sourceId }) => sourceId === options.source.id));
  const nextConfig = withSource(config, options.source, lock);
  const catalog = await loadCatalogForConfig(options.configPath, nextConfig);
  await atomicWriteJson(options.configPath, nextConfig);
  return { config: nextConfig, source: options.source, lock, catalog };
}

export async function removeRegistrySource(configPath: string, id: string): Promise<ApprovedRegistrySourcesConfig> {
  const config = await readConfig(configPath);
  const source = config.sources.find((entry) => entry.id === id);
  const nextConfig = { format: config.format, sources: config.sources.filter((entry) => entry.id !== id), locks: config.locks.filter((entry) => entry.sourceId !== id) } as const;
  const catalog = await loadCatalogForConfig(configPath, nextConfig);
  void catalog;
  await atomicWriteJson(configPath, nextConfig);
  if (source?.type === "http") await rm(cachePath(configPath, id), { force: true });
  return nextConfig;
}

export async function syncRegistrySources(options: RegistrySourceSyncOptions): Promise<RegistrySourceSyncResult> {
  const config = await readConfig(options.configPath);
  const selected = new Set(options.ids ?? config.sources.map(({ id }) => id));
  const fetchedAt = (options.now?.() ?? new Date()).toISOString();
  const locks = new Map(config.locks.map((lock) => [lock.sourceId, lock]));
  const updated: ApprovedRegistrySourceLock[] = [];
  for (const source of config.sources) {
    if (!selected.has(source.id)) continue;
    const nextLock = await resolveSourceLock(options.configPath, source, fetchedAt, options.offline === true, locks.get(source.id));
    locks.set(source.id, nextLock);
    updated.push(nextLock);
  }
  const nextConfig = { format: config.format, sources: config.sources, locks: [...locks.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en-US")) } as const;
  const catalog = await loadCatalogForConfig(options.configPath, nextConfig);
  await atomicWriteJson(options.configPath, nextConfig);
  return { config: nextConfig, updated, catalog };
}

export async function inspectRegistrySources(configPath: string): Promise<RegistrySourceInspection> {
  const config = await readConfig(configPath);
  const catalog = await loadCatalogForConfig(configPath, config);
  return {
    format: "capykit.registrySources.inspect.v0.1",
    sources: config.sources.map((source) => ({ ...source, lock: config.locks.find(({ sourceId }) => sourceId === source.id) })),
    precedence: catalog.tools.map((tool) => ({ toolId: tool.id, sourceId: tool.provenance.sourceId, layer: tool.provenance.layer, revision: tool.provenance.revision, sha256: tool.provenance.sha256, overridden: tool.overridden.map(({ sourceId }) => sourceId) })),
  };
}

export async function loadRegistryCatalogForSourcesConfig(configPath: string): Promise<RegistryCatalog> {
  const config = await readConfig(configPath);
  return loadCatalogForConfig(configPath, config);
}

export async function registrySourcesConfigExists(configPath: string): Promise<boolean> {
  try {
    await access(configPath, constants.R_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new RegistryLoadError("Unable to access registry sources config.", { cause: error });
  }
}

export function defaultRegistrySourcesConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeDirectory = process.env.HOME !== undefined && process.env.HOME.length > 0 ? process.env.HOME : homedir();
  const baseDirectory = xdgConfigHome !== undefined && xdgConfigHome.length > 0 ? xdgConfigHome : resolve(homeDirectory, ".config");
  return registrySourcesConfigPath(resolve(baseDirectory, "capykit"));
}

export function registrySourcesConfigPath(baseDirectory: string, relativePath = "registry-sources.json"): string {
  if (!isAbsolute(baseDirectory)) throw new RegistryLoadError("Registry source config base directory must be absolute.");
  assertRelativePath(relativePath, "Registry source config path");
  const resolved = resolve(baseDirectory, relativePath);
  const contained = relative(resolve(baseDirectory), resolved);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) throw new RegistryLoadError("Registry source config path resolves outside its base directory.");
  return resolved;
}
