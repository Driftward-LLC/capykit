import { CAPYKIT_VERSION, addRegistrySource, doctorRegistryFile, generateDiscoveryAdapterBundle, inspectRegistrySources, loadRegistryCatalog, removeRegistrySource, syncRegistrySources, type RegistryLayer, type RegistryManagedSourceType } from "../core/index.js";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function helpText(): string {
  return `capykit ${CAPYKIT_VERSION}\n\nUsage: capykit <command>\n\nCommands:\n  help                                      Show this help\n  version                                   Print the version\n  doctor <registry.json>                    Validate a registry and print capykit.registryDoctor.v0.1 JSON\n  adapters <registry.json>                  Print generated Codex, Hermes, and AGENTS discovery adapters as JSON\n  registry source add <local|git|http> ...  Add an approved registry source\n  registry source remove <id>               Remove an approved registry source\n  registry source sync                      Lock source revisions and cache HTTP sources\n  registry source inspect                   Print source precedence and provenance JSON\n`;
}

function doctorUsage(): string {
  return "Usage: capykit doctor <registry.json> [--allow-command <name>] [--path <path>]\n";
}

function adaptersUsage(): string {
  return "Usage: capykit adapters <registry.json>\n";
}

function registrySourceUsage(): string {
  return [
    "Usage: capykit registry source <add|remove|sync|inspect> [options]",
    "",
    "Commands:",
    "  registry source add local <id> --layer <layer> --root <absolute-dir> --path <registry.json> [--override <tool-id>]... [--config <path>]",
    "  registry source add git <id> --layer <layer> --repository <absolute-repo> --revision <rev> --path <registry.json> [--override <tool-id>]... [--config <path>]",
    "  registry source add http <id> --layer <layer> --url <https-url> [--cache-path <path>] [--override <tool-id>]... [--config <path>]",
    "  registry source remove <id> [--config <path>]",
    "  registry source sync [--offline] [--config <path>]",
    "  registry source inspect [--no-catalog] [--config <path>]",
    "",
  ].join("\n");
}

interface ParsedDoctorArgs {
  readonly registryPath: string | undefined;
  readonly approvedCommands: string[];
  readonly path: string | undefined;
  readonly error: string | undefined;
}

function parseDoctorArgs(argv: readonly string[]): ParsedDoctorArgs {
  const approvedCommands: string[] = [];
  let registryPath: string | undefined;
  let path: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-command") {
      const command = argv[index + 1];
      if (command === undefined) return { approvedCommands, path, registryPath, error: "Missing value for --allow-command." };
      approvedCommands.push(command);
      index += 1;
      continue;
    }
    if (argument === "--path") {
      path = argv[index + 1];
      if (path === undefined) return { approvedCommands, path, registryPath, error: "Missing value for --path." };
      index += 1;
      continue;
    }
    if (argument === undefined) return { approvedCommands, path, registryPath, error: "Missing doctor argument." };
    if (argument.startsWith("--")) return { approvedCommands, path, registryPath, error: `Unknown doctor option: ${argument}` };
    if (registryPath !== undefined) return { approvedCommands, path, registryPath, error: `Unexpected doctor argument: ${argument}` };
    registryPath = argument;
  }
  return { approvedCommands, path, registryPath, error: undefined };
}

interface ParsedOptions {
  readonly positionals: string[];
  readonly options: Map<string, string[]>;
  readonly error: string | undefined;
}

function parseOptions(argv: readonly string[], valueOptions: readonly string[]): ParsedOptions {
  const values = new Set(valueOptions);
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) return { positionals, options, error: "Missing argument." };
    if (!argument.startsWith("--")) { positionals.push(argument); continue; }
    const name = argument.slice(2);
    if (values.has(name)) {
      const value = argv[index + 1];
      if (value === undefined) return { positionals, options, error: `Missing value for ${argument}.` };
      options.set(name, [...options.get(name) ?? [], value]);
      index += 1;
      continue;
    }
    options.set(name, [...options.get(name) ?? [], "true"]);
  }
  return { positionals, options, error: undefined };
}

function option(options: Map<string, string[]>, name: string): string | undefined {
  return options.get(name)?.at(-1);
}

function requireOption(options: Map<string, string[]>, name: string): string {
  const value = option(options, name);
  if (value === undefined) throw new Error(`Missing required option --${name}.`);
  return value;
}

function parseLayer(value: string): RegistryLayer {
  if (["builtin", "organization", "host", "user"].includes(value)) return value as RegistryLayer;
  throw new Error(`Unsupported registry layer: ${value}`);
}

function parseSourceType(value: string): RegistryManagedSourceType {
  if (["local", "git", "http"].includes(value)) return value as RegistryManagedSourceType;
  throw new Error(`Unsupported registry source type: ${value}`);
}

async function runRegistrySource(argv: readonly string[]): Promise<number> {
  const action = argv[0];
  try {
    if (action === "add") {
      const parsed = parseOptions(argv.slice(1), ["config", "layer", "root", "path", "repository", "revision", "url", "cache-path", "override"]);
      if (parsed.error !== undefined) throw new Error(parsed.error);
      const [typeValue, id] = parsed.positionals;
      if (typeValue === undefined || id === undefined || parsed.positionals.length !== 2) throw new Error("Expected source type and ID for registry source add.");
      const type = parseSourceType(typeValue);
      const input: {
        id: string;
        type: RegistryManagedSourceType;
        layer: RegistryLayer;
        root?: string;
        path?: string;
        repository?: string;
        revision?: string;
        url?: string;
        cachePath?: string;
        overrides?: string[];
      } = {
        id,
        type,
        layer: parseLayer(requireOption(parsed.options, "layer")),
      };
      const root = option(parsed.options, "root");
      const path = option(parsed.options, "path");
      const repository = option(parsed.options, "repository");
      const revision = option(parsed.options, "revision");
      const url = option(parsed.options, "url");
      const cachePath = option(parsed.options, "cache-path");
      const overrides = parsed.options.get("override");
      if (root !== undefined) input.root = root;
      if (path !== undefined) input.path = path;
      if (repository !== undefined) input.repository = repository;
      if (revision !== undefined) input.revision = revision;
      if (url !== undefined) input.url = url;
      if (cachePath !== undefined) input.cachePath = cachePath;
      if (overrides !== undefined) input.overrides = overrides;
      const config = await addRegistrySource(option(parsed.options, "config"), input);
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      return 0;
    }
    if (action === "remove") {
      const parsed = parseOptions(argv.slice(1), ["config"]);
      if (parsed.error !== undefined) throw new Error(parsed.error);
      const [id] = parsed.positionals;
      if (id === undefined || parsed.positionals.length !== 1) throw new Error("Expected source ID for registry source remove.");
      const config = await removeRegistrySource(option(parsed.options, "config"), id);
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      return 0;
    }
    if (action === "sync") {
      const parsed = parseOptions(argv.slice(1), ["config"]);
      if (parsed.error !== undefined) throw new Error(parsed.error);
      if (parsed.positionals.length !== 0) throw new Error("Unexpected registry source sync argument.");
      const config = await syncRegistrySources(option(parsed.options, "config"), { offline: parsed.options.has("offline") });
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      return 0;
    }
    if (action === "inspect") {
      const parsed = parseOptions(argv.slice(1), ["config"]);
      if (parsed.error !== undefined) throw new Error(parsed.error);
      if (parsed.positionals.length !== 0) throw new Error("Unexpected registry source inspect argument.");
      const inspection = await inspectRegistrySources(option(parsed.options, "config"), !parsed.options.has("no-catalog"));
      process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
      return 0;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${registrySourceUsage()}`);
    return 2;
  }
  process.stderr.write(registrySourceUsage());
  return 2;
}

export function run(argv: readonly string[]): number {
  const command = argv[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(helpText()); return 0; }
  if (["version", "--version", "-v"].includes(command)) { process.stdout.write(`${CAPYKIT_VERSION}\n`); return 0; }
  if (command === "adapters") {
    const registryPath = argv[1];
    if (registryPath === undefined || argv.length !== 2) {
      process.stderr.write(adaptersUsage());
      return 2;
    }
    return 0;
  }
  if (command === "registry") {
    if (argv[1] !== "source") { process.stderr.write(registrySourceUsage()); return 2; }
    return 0;
  }
  if (command === "doctor") {
    const parsed = parseDoctorArgs(argv.slice(1));
    if (parsed.registryPath === undefined || parsed.error !== undefined) {
      process.stderr.write(`${parsed.error ?? "Missing registry path."}\n\n${doctorUsage()}`);
      return 2;
    }
    return 0;
  }
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`); return 2;
}

export async function runAsync(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "help";
  if (command === "registry" && argv[1] === "source") return runRegistrySource(argv.slice(2));
  if (command === "adapters") {
    const registryPath = argv[1];
    if (registryPath === undefined || argv.length !== 2) {
      process.stderr.write(adaptersUsage());
      return 2;
    }
    const absoluteRegistryPath = resolve(registryPath);
    const catalog = await loadRegistryCatalog([{ id: basename(absoluteRegistryPath), layer: "user", type: "file", root: dirname(absoluteRegistryPath), path: basename(absoluteRegistryPath) }]);
    process.stdout.write(`${JSON.stringify(generateDiscoveryAdapterBundle(catalog), null, 2)}\n`);
    return 0;
  }
  if (command !== "doctor") return run(argv);
  const parsed = parseDoctorArgs(argv.slice(1));
  if (parsed.registryPath === undefined || parsed.error !== undefined) {
    process.stderr.write(`${parsed.error ?? "Missing registry path."}\n\n${doctorUsage()}`);
    return 2;
  }
  const options = parsed.path === undefined ? { approvedCommands: parsed.approvedCommands } : { approvedCommands: parsed.approvedCommands, path: parsed.path };
  const report = await doctorRegistryFile(parsed.registryPath, options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  try { return realpathSync(entryPath) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isDirectExecution()) runAsync(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; }, (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
