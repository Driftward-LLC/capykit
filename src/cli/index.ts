import {
  addRegistrySource,
  CAPYKIT_VERSION,
  doctorRegistryFile,
  generateDiscoveryAdapterBundle,
  inspectRegistrySources,
  loadRegistryCatalog,
  removeRegistrySource,
  syncRegistrySources,
  type ApprovedRegistrySource,
  type RegistryLayer,
} from "../core/index.js";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function helpText(): string {
  return `capykit ${CAPYKIT_VERSION}\n\nUsage: capykit <command>\n\nCommands:\n  help                       Show this help\n  version                    Print the version\n  completion <shell>         Print shell completion for bash, zsh, or fish\n  doctor <registry.json>     Validate a registry and print capykit.registryDoctor.v0.1 JSON\n  adapters <registry.json>   Print generated Codex, Hermes, and AGENTS discovery adapters as JSON\n  sources <action>           Add, remove, sync, or inspect approved registry sources\n`;
}

const completionCommands = ["help", "version", "completion", "doctor", "adapters", "sources"] as const;

function completionUsage(): string {
  return "Usage: capykit completion <bash|zsh|fish>\n";
}

export function completionText(shell: string): string {
  const commands = completionCommands.join(" ");
  if (shell === "bash") {
    return [
      "_capykit() {",
      "  local cur=\"${COMP_WORDS[COMP_CWORD]}\"",
      `  COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )`,
      "}",
      "complete -F _capykit capykit",
      "",
    ].join("\n");
  }
  if (shell === "zsh") {
    return [
      "#compdef capykit",
      `local -a commands=(${completionCommands.map((command) => `'${command}'`).join(" ")})`,
      "_describe 'capykit command' commands",
      "",
    ].join("\n");
  }
  if (shell === "fish") {
    return completionCommands.map((command) => `complete -c capykit -f -a ${command}`).join("\n") + "\n";
  }
  throw new Error(`Unsupported completion shell: ${shell}`);
}

function doctorUsage(): string {
  return "Usage: capykit doctor <registry.json> [--allow-command <name>] [--path <path>]\n";
}

function adaptersUsage(): string {
  return "Usage: capykit adapters <registry.json>\n";
}

function sourcesUsage(): string {
  return [
    "Usage:",
    "  capykit sources add --config <path> --id <id> --layer <layer> --file-root <root> --file-path <path> [--override <tool>]...",
    "  capykit sources add --config <path> --id <id> --layer <layer> --git-repository <repo> --git-revision <rev> --git-path <path> [--override <tool>]...",
    "  capykit sources add --config <path> --id <id> --layer <layer> --http-url <url> [--override <tool>]...",
    "  capykit sources remove --config <path> --id <id>",
    "  capykit sources sync --config <path> [--id <id>]... [--offline]",
    "  capykit sources inspect --config <path>",
    "",
  ].join("\n");
}

interface ParsedDoctorArgs {
  readonly registryPath: string | undefined;
  readonly approvedCommands: string[];
  readonly path: string | undefined;
  readonly error: string | undefined;
}

interface ParsedFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
  readonly switches: ReadonlySet<string>;
  readonly error?: string | undefined;
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

function parseFlags(argv: readonly string[], switches: readonly string[] = []): ParsedFlags {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const switchSet = new Set(switches);
  const enabledSwitches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) return { values, repeated, switches: enabledSwitches, error: `Unexpected argument: ${argument ?? ""}` };
    if (switchSet.has(argument)) { enabledSwitches.add(argument); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return { values, repeated, switches: enabledSwitches, error: `Missing value for ${argument}.` };
    if (repeated.has(argument)) repeated.get(argument)?.push(value);
    else if (values.has(argument)) repeated.set(argument, [values.get(argument) as string, value]);
    else values.set(argument, value);
    index += 1;
  }
  return { values, repeated, switches: enabledSwitches };
}

function flag(parsed: ParsedFlags, name: string): string | undefined {
  return parsed.values.get(name);
}

function repeatedFlag(parsed: ParsedFlags, name: string): readonly string[] {
  return parsed.repeated.get(name) ?? (parsed.values.has(name) ? [parsed.values.get(name) as string] : []);
}

function requireFlag(parsed: ParsedFlags, name: string): string {
  const value = flag(parsed, name);
  if (value === undefined) throw new Error(`Missing required option ${name}.`);
  return value;
}

function parseLayer(value: string): RegistryLayer {
  if (["builtin", "organization", "host", "user"].includes(value)) return value as RegistryLayer;
  throw new Error(`Unsupported source layer: ${value}`);
}

function parseAddSource(parsed: ParsedFlags): ApprovedRegistrySource {
  const id = requireFlag(parsed, "--id");
  const layer = parseLayer(requireFlag(parsed, "--layer"));
  const overrides = repeatedFlag(parsed, "--override");
  const base = overrides.length === 0 ? { id, layer } : { id, layer, overrides };
  const fileRoot = flag(parsed, "--file-root");
  const gitRepository = flag(parsed, "--git-repository");
  const httpUrl = flag(parsed, "--http-url");
  const selected = [fileRoot, gitRepository, httpUrl].filter((value) => value !== undefined);
  if (selected.length !== 1) throw new Error("Choose exactly one source type: file, git, or http.");
  if (fileRoot !== undefined) return { ...base, type: "file", root: fileRoot, path: requireFlag(parsed, "--file-path") };
  if (gitRepository !== undefined) return { ...base, type: "git", repository: gitRepository, revision: requireFlag(parsed, "--git-revision"), path: requireFlag(parsed, "--git-path") };
  return { ...base, type: "http", url: requireFlag(parsed, "--http-url") };
}

async function runSources(argv: readonly string[]): Promise<number> {
  const action = argv[0];
  if (action === undefined) { process.stderr.write(sourcesUsage()); return 2; }
  const parsed = parseFlags(argv.slice(1), ["--offline"]);
  if (parsed.error !== undefined) { process.stderr.write(`${parsed.error}\n\n${sourcesUsage()}`); return 2; }
  try {
    if (action === "add") {
      const result = await addRegistrySource({ configPath: requireFlag(parsed, "--config"), source: parseAddSource(parsed) });
      process.stdout.write(`${JSON.stringify({ source: result.source, lock: result.lock, toolCount: result.catalog.tools.length }, null, 2)}\n`);
      return 0;
    }
    if (action === "remove") {
      const result = await removeRegistrySource(requireFlag(parsed, "--config"), requireFlag(parsed, "--id"));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (action === "sync") {
      const result = await syncRegistrySources({ configPath: requireFlag(parsed, "--config"), ids: repeatedFlag(parsed, "--id"), offline: parsed.switches.has("--offline") });
      process.stdout.write(`${JSON.stringify({ updated: result.updated, toolCount: result.catalog.tools.length }, null, 2)}\n`);
      return 0;
    }
    if (action === "inspect") {
      const result = await inspectRegistrySources(requireFlag(parsed, "--config"));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    process.stderr.write(`Unknown sources action: ${action}\n\n${sourcesUsage()}`);
    return 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function run(argv: readonly string[]): number {
  const command = argv[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(helpText()); return 0; }
  if (["version", "--version", "-v"].includes(command)) { process.stdout.write(`${CAPYKIT_VERSION}\n`); return 0; }
  if (["completion", "completions"].includes(command)) {
    const shell = argv[1];
    if (shell === undefined || argv.length !== 2) { process.stderr.write(completionUsage()); return 2; }
    try { process.stdout.write(completionText(shell)); return 0; } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${completionUsage()}`); return 2; }
  }
  if (command === "adapters") {
    const registryPath = argv[1];
    if (registryPath === undefined || argv.length !== 2) {
      process.stderr.write(adaptersUsage());
      return 2;
    }
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
  if (command === "sources") return 0;
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`); return 2;
}

export async function runAsync(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "help";
  if (command === "sources") return runSources(argv.slice(1));
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
