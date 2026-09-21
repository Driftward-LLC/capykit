import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommandAvailability, loadRegistryCatalog, RegistryLoadError, rejectCredentials, type RegistryDocument, type RegistryTool } from "./registry.js";
import { addRegistrySource, defaultRegistrySourcesConfigPath, inspectRegistrySources, validateFileRegistrySourceAddition, type ApprovedFileRegistrySource } from "./sources.js";
import { parseEnvironmentProfile, type EnvironmentProfile } from "./profile-schema.js";
import { installProfileDependencies, profileNpmInstallPlan } from "./profile-install.js";

export interface ProfileOptions {
  readonly configPath?: string;
  readonly skillsDirectory?: string;
  readonly path?: string;
}

export interface ProfileApplyOptions extends ProfileOptions {
  readonly installTools?: boolean;
  /** Test seam for the fixed npm installer; never populated from a profile. */
  readonly execFile?: (command: string, args: readonly string[]) => Promise<void>;
}

interface ProfileBundle {
  readonly profile: EnvironmentProfile;
  readonly registry: RegistryDocument;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly digest: string;
  readonly executables: ReadonlySet<string>;
}

const maxFileBytes = 8 * 1024 * 1024;
const maxBundleBytes = 32 * 1024 * 1024;
const maxFiles = 512;

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Reject symlinks at every bundle path component, including internal aliases. */
async function safePath(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes(":") || path.split("/").some((part) => part === ".." || part === "." || !part || /[<>"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) || Array.from(part).some((character) => character.charCodeAt(0) < 32))) throw new RegistryLoadError("Profile paths must be portable, relative, contained paths.");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new RegistryLoadError("Profile files and directories must not be symlinks.");
  }
  const canonical = await realpath(current);
  const within = relative(root, canonical);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new RegistryLoadError("Profile path escapes the bundle root.");
  return canonical;
}

async function readBundleFile(root: string, path: string, executables?: Set<string>): Promise<Buffer> {
  const file = await safePath(root, path);
  const before = await lstat(file);
  if (!before.isFile() || before.size > maxFileBytes) throw new RegistryLoadError("Profile entries must be regular files of at most 8 MiB.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new RegistryLoadError("Profile file changed while opening; retry with a stable bundle.");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > maxFileBytes || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) throw new RegistryLoadError("Profile file changed while reading; retry with a stable bundle.");
    if ((opened.mode & 0o111) !== 0) executables?.add(path);
    return bytes;
  } finally { await handle.close(); }
}

async function directoryFiles(root: string, path: string, files = new Map<string, Buffer>(), executables = new Set<string>(), depth = 0, budget = { entries: 0 }): Promise<Map<string, Buffer>> {
  if (depth > 32) throw new RegistryLoadError("Skill directory nesting exceeds 32 levels.");
  const directory = await safePath(root, path);
  if (!(await lstat(directory)).isDirectory()) throw new RegistryLoadError("A skill path must be a directory.");
  const names = (await readdir(directory)).sort();
  budget.entries += names.length;
  if (budget.entries > maxFiles * 2 + 2) throw new RegistryLoadError("Profile directory contains too many entries.");
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new RegistryLoadError("Profile directory entries collide on case-insensitive filesystems.");
  for (const name of names) {
    if (/^(?:\.env(?:\..*)?|\.npmrc|\.git|node_modules|credentials?\.json|cookies?\.json)$/iu.test(name)) throw new RegistryLoadError("Skill bundles must not contain credentials, environment files, or dependency directories.");
    const child = `${path}/${name}`;
    const info = await lstat(await safePath(root, child));
    if (info.isDirectory()) await directoryFiles(root, child, files, executables, depth + 1, budget);
    else {
      if (files.size >= maxFiles + 2) throw new RegistryLoadError("A profile may contain at most 512 files.");
      files.set(child, await readBundleFile(root, child, executables));
      if ([...files.values()].reduce((total, bytes) => total + bytes.length, 0) > maxBundleBytes + 2 * maxFileBytes) throw new RegistryLoadError("Profile bundle exceeds its size limit.");
    }
  }
  return files;
}

function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")) as unknown; } catch { throw new RegistryLoadError("Profile metadata is not valid JSON; contents redacted."); }
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];
}

async function readProfileBundle(profilePath: string): Promise<ProfileBundle> {
  const absolute = resolve(profilePath);
  const root = await realpath(dirname(absolute));
  const profile = parseEnvironmentProfile(parseJson(await readBundleFile(root, basename(absolute))));
  rejectCredentials(profile, "environment-profile");
  const registryBytes = await readBundleFile(root, profile.registry);
  const catalog = await loadRegistryCatalog([{ id: "profile.validation", layer: "user", type: "file", root, path: profile.registry }]);
  if (catalog.sources[0]?.sha256 !== `sha256:${digest(registryBytes)}`) throw new RegistryLoadError("Profile registry changed during validation.");
  const registry = parseJson(registryBytes) as RegistryDocument;
  if (profile.registry.toLowerCase() === "profile.json" || profile.registry.toLowerCase().startsWith("profile.json/")) throw new RegistryLoadError("profile.json is reserved for the portable manifest.");
  const executables = new Set<string>();
  const files = new Map<string, Buffer>([["profile.json", Buffer.from(`${JSON.stringify(profile, null, 2)}\n`)], [profile.registry, registryBytes]]);
  for (const skill of profile.skills) {
    const skillFiles = await directoryFiles(root, skill.path, new Map(), executables);
    const text = skillFiles.get(`${skill.path}/SKILL.md`)?.toString("utf8");
    const frontmatter = text?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
    const name = frontmatter?.match(/^name:\s*["']?([a-z0-9-]+)["']?\s*$/mu)?.[1];
    if (name !== skill.id || !/^description:\s*\S/mu.test(frontmatter ?? "")) throw new RegistryLoadError(`Skill ${skill.id} requires SKILL.md frontmatter with its matching name and a description.`);
    for (const [path, bytes] of skillFiles) {
      rejectCredentials(bytes.toString("utf8"), "environment-profile-skill");
      if (/(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/iu.test(bytes.toString("utf8"))) throw new RegistryLoadError("Skill contains a credential-like assignment; contents redacted.");
      if (files.has(path) || [...files.keys()].some((existing) => existing.toLowerCase() === path.toLowerCase() || existing.toLowerCase().startsWith(`${path.toLowerCase()}/`) || path.toLowerCase().startsWith(`${existing.toLowerCase()}/`))) throw new RegistryLoadError("Profile file paths collide.");
      files.set(path, bytes);
    }
  }
  if (files.size > maxFiles || [...files.values()].reduce((total, bytes) => total + bytes.length, 0) > maxBundleBytes) throw new RegistryLoadError("Profile exceeds its 512-file or 32 MiB limit.");
  const locations = new Set(profile.skills.map((skill) => `${skill.path}/SKILL.md`));
  for (const tool of registry.tools) for (const iface of objects(tool.interfaces)) {
    if (iface.type === "skill" && (typeof iface.location !== "string" || !locations.has(iface.location))) throw new RegistryLoadError("Every profile skill interface must reference a bundled skill's relative SKILL.md path.");
  }
  const hash = createHash("sha256");
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, "en-US"))) hash.update(JSON.stringify([path, bytes.length, executables.has(path)])).update(bytes);
  return { profile, registry, files, executables, digest: hash.digest("hex") };
}

function profilePaths(bundle: ProfileBundle, options: ProfileOptions) {
  const configPath = resolve(options.configPath ?? defaultRegistrySourcesConfigPath());
  const directory = join(dirname(configPath), "profiles", bundle.profile.id, bundle.profile.version);
  const toolsDirectory = join(dirname(configPath), "profile-tools", bundle.profile.id, bundle.profile.version);
  const skills = bundle.profile.skills.map((skill) => ({ ...skill, destination: options.skillsDirectory === undefined ? join(directory, "bundle", skill.path) : resolve(options.skillsDirectory, skill.id) }));
  return { configPath, directory, toolsDirectory, skills };
}

async function profileReport(bundle: ProfileBundle, options: ProfileOptions) {
  const paths = profilePaths(bundle, options);
  const npm = profileNpmInstallPlan(bundle.profile, paths.toolsDirectory);
  const path = [npm.binPath, options.path ?? process.env.PATH ?? ""].join(delimiter);
  const mcpEntry = fileURLToPath(new URL("./mcp.js", import.meta.url));
  const mcp = await exists(mcpEntry)
    ? { command: process.execPath, args: [mcpEntry, "--config", paths.configPath] }
    : { command: "capykit-mcp", args: ["--config", paths.configPath] };
  return {
    format: "capykit.profilePlan.v0.1" as const,
    profile: { id: bundle.profile.id, name: bundle.profile.name, version: bundle.profile.version, digest: bundle.digest },
    configPath: paths.configPath,
    directory: paths.directory,
    skills: paths.skills,
    tools: await Promise.all(bundle.profile.tools.map(async (tool) => ({ ...tool, availability: await checkCommandAvailability(tool.command, { path }), version: "unverified", access: "unverified" }))),
    npm,
    connections: bundle.profile.connections.map((connection) => ({ ...connection, status: "manual-setup" })),
    mcp,
    nextSteps: [...(npm.packages.length > 0 ? [`Add ${npm.binPath} to PATH when using dependencies installed by this profile.`] : []), ...(bundle.profile.connections.length > 0 ? ["Complete the listed connection steps in this environment; no credentials or logins are copied."] : []), "Configure your agent to load the installed skill directories or use the Capykit MCP command above."],
  };
}

export async function inspectEnvironmentProfile(profilePath: string, options: ProfileOptions = {}) {
  return profileReport(await readProfileBundle(profilePath), options);
}

async function privateDirectory(path: string): Promise<void> {
  if (await exists(path)) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RegistryLoadError("Profile destination must be a directory without symlinks.");
    return;
  }
  const parent = dirname(path);
  if (parent !== path) await privateDirectory(parent);
  await mkdir(path, { mode: 0o700 });
}

async function writeFiles(directory: string, files: ReadonlyMap<string, Buffer>, executables: ReadonlySet<string> = new Set()): Promise<void> {
  for (const [path, bytes] of files) {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: executables.has(path) ? 0o700 : 0o600 });
  }
}

function installedRegistry(bundle: ProfileBundle, skills: ReturnType<typeof profilePaths>["skills"]): RegistryDocument {
  const locations = new Map(skills.map((skill) => [`${skill.path}/SKILL.md`, join(skill.destination, "SKILL.md")]));
  return { ...bundle.registry, tools: bundle.registry.tools.map((tool): RegistryTool => ({
    ...tool, interfaces: objects(tool.interfaces).map((iface) => iface.type === "skill" ? { ...iface, location: locations.get(String(iface.location)) } : iface),
  })) };
}

async function matchesFiles(directory: string, files: ReadonlyMap<string, Buffer>, executables: ReadonlySet<string> = new Set()): Promise<boolean> {
  const parent = await realpath(dirname(directory));
  const actualExecutables = new Set<string>();
  const actual = await directoryFiles(parent, basename(directory), new Map(), actualExecutables);
  const expectedExecutables = new Set([...executables].map((path) => `${basename(directory)}/${path}`));
  const expected = new Map([...files].map(([path, bytes]) => [`${basename(directory)}/${path}`, bytes]));
  return actual.size === expected.size && [...actual].every(([path, bytes]) => expected.get(path)?.equals(bytes) && (process.platform === "win32" || actualExecutables.has(path) === expectedExecutables.has(path)));
}

export async function applyEnvironmentProfile(profilePath: string, options: ProfileApplyOptions = {}) {
  const bundle = await readProfileBundle(profilePath);
  const paths = profilePaths(bundle, options);
  await privateDirectory(dirname(paths.configPath));
  if (await exists(paths.configPath)) {
    const configInfo = await lstat(paths.configPath);
    if (!configInfo.isFile() || configInfo.isSymbolicLink()) throw new RegistryLoadError("Profile source configuration must be a regular file, not a symlink.");
  }
  // ponytail: serialize profile applies per config; other source edits should run separately.
  const lockPath = join(dirname(paths.configPath), ".profile-apply.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RegistryLoadError("A profile apply is already active for this configuration. If its process stopped, remove the stale .profile-apply.lock and retry.");
    throw error;
  }
  let staging: string | undefined;
  const createdSkills: string[] = [];
  let createdSnapshot = false;
  let activated = false;
  try {
    const sourceId = `profile.${bundle.profile.id}`;
    const inspection = await inspectRegistrySources(paths.configPath);
    const previous = inspection.sources.find(({ id }) => id === sourceId);
    if (previous !== undefined) {
      if (previous.type !== "file" || previous.path !== "registry.json" || dirname(previous.root) !== dirname(paths.directory)) throw new RegistryLoadError("The profile source ID belongs to another source; existing configuration was preserved.");
      const receipt = parseJson(await readBundleFile(await realpath(previous.root), "receipt.json")) as { id?: unknown; format?: unknown };
      if (receipt.id !== bundle.profile.id || receipt.format !== "capykit.profileInstall.v0.1") throw new RegistryLoadError("Existing profile source has no matching ownership receipt.");
    }
    await privateDirectory(dirname(paths.directory));
    const files = new Map<string, Buffer>([...bundle.files].map(([path, bytes]) => [`bundle/${path}`, bytes]));
    files.set("registry.json", Buffer.from(`${JSON.stringify(installedRegistry(bundle, paths.skills), null, 2)}\n`));
    files.set("receipt.json", Buffer.from(`${JSON.stringify({ format: "capykit.profileInstall.v0.1", id: bundle.profile.id, version: bundle.profile.version, digest: bundle.digest, skills: paths.skills }, null, 2)}\n`));
    const executables = new Set([...bundle.executables].map((path) => `bundle/${path}`));
    const alreadyInstalled = await exists(paths.directory);
    if (alreadyInstalled && !(await matchesFiles(paths.directory, files, executables))) throw new RegistryLoadError("This profile version is already installed with different bytes or destinations. Preserve local changes and publish a new profile version.");
    staging = await mkdtemp(join(dirname(paths.directory), ".staging-"));
    await writeFiles(staging, files, executables);
    const source: ApprovedFileRegistrySource = { id: sourceId, layer: "user", type: "file", root: paths.directory, path: "registry.json" };
    await validateFileRegistrySourceAddition(paths.configPath, { ...source, root: staging });
    const newSkills: typeof paths.skills = [];
    if (options.skillsDirectory !== undefined) {
      await privateDirectory(resolve(options.skillsDirectory));
      for (const skill of paths.skills) {
        const skillFiles = new Map([...bundle.files].filter(([path]) => path.startsWith(`${skill.path}/`)).map(([path, bytes]) => [path.slice(skill.path.length + 1), bytes]));
        if (await exists(skill.destination)) {
          if (!(await matchesFiles(skill.destination, skillFiles, new Set([...bundle.executables].filter((path) => path.startsWith(`${skill.path}/`)).map((path) => path.slice(skill.path.length + 1)))))) throw new RegistryLoadError(`Skill ${skill.id} already exists with different files; choose another skills directory or resolve the conflict manually.`);
        } else newSkills.push(skill);
      }
    }
    if (options.installTools) {
      await privateDirectory(paths.toolsDirectory);
      await installProfileDependencies(bundle.profile, paths.toolsDirectory, options.execFile === undefined ? {} : { execFile: options.execFile });
    }
    const report = await profileReport(bundle, options);
    if (!alreadyInstalled) { await rename(staging, paths.directory); staging = undefined; createdSnapshot = true; }
    for (const skill of newSkills) {
      const skillFiles = new Map([...bundle.files].filter(([path]) => path.startsWith(`${skill.path}/`)).map(([path, bytes]) => [path.slice(skill.path.length + 1), bytes]));
      const temporarySkill = await mkdtemp(join(dirname(skill.destination), ".capykit-skill-"));
      try { await writeFiles(temporarySkill, skillFiles, new Set([...bundle.executables].filter((path) => path.startsWith(`${skill.path}/`)).map((path) => path.slice(skill.path.length + 1)))); await rename(temporarySkill, skill.destination); createdSkills.push(skill.destination); }
      finally { await rm(temporarySkill, { recursive: true, force: true }); }
    }
    await addRegistrySource({ configPath: paths.configPath, source });
    activated = true;
    return { ...report, applied: true, dependenciesInstalled: options.installTools === true && bundle.profile.tools.some((tool) => tool.npm !== undefined) };
  } catch (error) {
    if (!activated) {
      for (const destination of createdSkills) await rm(destination, { recursive: true, force: true });
      if (createdSnapshot) await rm(paths.directory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
