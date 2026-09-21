import {
  addRegistrySource,
  applyEnvironmentProfile,
  CAPYKIT_VERSION,
  checkCommandAvailability,
  defaultRegistrySourcesConfigPath,
  discoverHostRegistry,
  doctorRegistryFile,
  generateDiscoveryAdapterBundle,
  inspectRegistrySources,
  inspectEnvironmentProfile,
  loadConfiguredRegistryCatalog,
  loadRegistryCatalog,
  removeRegistrySource,
  searchRegistryTools,
  syncRegistrySources,
  type ApprovedRegistrySource,
  type CommandAvailabilityReport,
  type RegistryCatalog,
  type RegistryLayer,
  type ResolvedRegistryTool,
} from "../core/index.js";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function helpText(): string {
  return `capykit ${CAPYKIT_VERSION}\n\nUsage: capykit <command>\n\nCommands:\n  help                       Show this help\n  version                    Print the version\n  completion <shell>         Print shell completion for bash, zsh, or fish\n  doctor <registry.json>     Validate a registry and print capykit.registryDoctor.v0.1 JSON\n  adapters [registry.json]   Export discovery adapters (defaults to configured sources)\n  discover host --json       Generate a host registry from live discovery\n  sources <action>           Add, remove, sync, or inspect approved registry sources\n  tools [list|search|show|check]  Find tools and inspect invocation details\n  profile [inspect|apply]    Set up a portable registry, skills, and dependencies\n`;
}

const completionCommands = ["help", "version", "completion", "doctor", "adapters", "discover", "sources", "tools", "profile"] as const;

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
  return "Usage: capykit adapters [<registry.json> | --config <path>]\n";
}

function discoverUsage(): string {
  return "Usage: capykit discover host --json [--path <path>]\n";
}

function sourcesUsage(): string {
  return [
    "Usage:",
    "  capykit sources add --config <path> --id <id> --layer <layer> --file-root <root> --file-path <path> [--override <tool>]...",
    "  capykit sources add --config <path> --id <id> --layer <layer> --git-repository <repo> --git-revision <rev> --git-path <path> [--override <tool>]...",
    "  capykit sources add --config <path> --id <id> --layer <layer> --http-url <url> [--override <tool>]...",
    "  capykit sources remove --config <path> --id <id>",
    "  capykit sources sync --config <path> [--id <id>]... [--offline]",
    "  capykit sources inspect [--config <path>] [--json]",
    "",
  ].join("\n");
}

function toolsUsage(): string {
  return [
    "Usage:",
    "  capykit tools [list] [--config <path>] [--json] [--check] [--path <path>]",
    "  capykit tools check [--config <path>] [--json] [--path <path>]",
    "  capykit tools search <query> [--config <path>] [--json] [--check] [--path <path>]",
    "  capykit tools show <tool-id> [--config <path>] [--json] [--check] [--path <path>]",
    "",
  ].join("\n");
}

function profileUsage(): string {
  return [
    "Usage:",
    "  capykit profile inspect <profile.json> [--config <path>] [--skills-dir <path>] [--path <path>] [--json]",
    "  capykit profile apply <profile.json> [--config <path>] [--skills-dir <path>] [--path <path>] [--install-tools] [--json]",
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

function resolveConfigPath(parsed: ParsedFlags): string {
  return flag(parsed, "--config") ?? defaultRegistrySourcesConfigPath();
}

interface ToolSummary {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly summary: string;
  readonly sourceId: string;
  readonly layer: RegistryLayer;
  readonly access: "unverified";
  readonly availability?: ToolAvailabilitySummary;
}

interface ToolAvailabilitySummary {
  readonly status: "unchecked" | CommandAvailabilityReport["status"];
  readonly checked: boolean;
  readonly command: string | undefined;
  readonly reason: "not_requested" | "no_cli_command" | CommandAvailabilityReport["reason"];
}

function toolCommand(tool: ResolvedRegistryTool): string {
  const interfaces = Array.isArray(tool.record.interfaces) ? tool.record.interfaces : [];
  for (const entry of interfaces) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (candidate.type === "cli" && typeof candidate.command === "string") return candidate.command;
  }
  return "-";
}

function toolSummary(tool: ResolvedRegistryTool): ToolSummary {
  return {
    id: tool.id,
    name: typeof tool.record.name === "string" ? tool.record.name : tool.id,
    command: toolCommand(tool),
    summary: typeof tool.record.summary === "string" ? tool.record.summary : "",
    sourceId: tool.provenance.sourceId,
    layer: tool.provenance.layer,
    access: "unverified",
  };
}

async function toolAvailability(command: string, check: boolean, path: string | undefined): Promise<ToolAvailabilitySummary> {
  if (!check) return { status: "unchecked", checked: false, command: command === "-" ? undefined : command, reason: "not_requested" };
  if (command === "-") return { status: "skipped", checked: false, command: undefined, reason: "no_cli_command" };
  return path === undefined ? checkCommandAvailability(command) : checkCommandAvailability(command, { path });
}

async function toolSummaryWithAvailability(tool: ResolvedRegistryTool, check: boolean, path: string | undefined): Promise<ToolSummary> {
  const summary = toolSummary(tool);
  return { ...summary, availability: await toolAvailability(summary.command, check, path) };
}

function formatToolsHuman(tools: readonly ToolSummary[]): string {
  if (tools.length === 0) return "No tools found.\n";
  return `${tools.map((tool) => {
    const availability = tool.availability === undefined ? "" : `\t${tool.availability.status}`;
    return `${tool.id}\t${tool.command}${availability}\t${tool.summary}`;
  }).join("\n")}\n`;
}

async function writeToolsList(catalog: RegistryCatalog, configPath: string, options: { readonly json: boolean; readonly check: boolean; readonly path: string | undefined }, query?: string): Promise<void> {
  const tools = await Promise.all(catalog.tools.map((tool) => toolSummaryWithAvailability(tool, options.check, options.path)));
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ format: query === undefined ? "capykit.tools.list.v0.1" : "capykit.tools.search.v0.1", ...(query === undefined ? {} : { query, count: tools.length }), configPath, availability: { checked: options.check, pathSource: options.path === undefined ? "process" : "option" }, tools }, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatToolsHuman(tools));
  if (query !== undefined && tools.length > 0) process.stdout.write("Inspect a match with capykit tools show <tool-id> --check, reusing any --config and --path options.\n");
}

async function writeToolShow(tool: ResolvedRegistryTool, configPath: string, options: { readonly json: boolean; readonly check: boolean; readonly path: string | undefined }): Promise<void> {
  const summary = await toolSummaryWithAvailability(tool, options.check, options.path);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ format: "capykit.tools.show.v0.1", configPath, availability: { checked: options.check, pathSource: options.path === undefined ? "process" : "option" }, tool: { ...summary, record: tool.record, provenance: tool.provenance } }, null, 2)}\n`);
    return;
  }
  const availability = summary.availability === undefined ? [] : [`availability: ${summary.availability.status}`];
  const details = ["interfaces", "authentication", "safety", "examples", "documentation"].map((field) => `${field}: ${JSON.stringify(tool.record[field], null, 2)}`);
  process.stdout.write([summary.id, `command: ${summary.command}`, ...availability, "access: unverified (command presence does not verify access)", `summary: ${summary.summary}`, `source: ${summary.sourceId} (${summary.layer})`, ...details, ""].join("\n"));
}

async function runSources(argv: readonly string[]): Promise<number> {
  const action = argv[0];
  if (action === undefined) { process.stderr.write(sourcesUsage()); return 2; }
  const parsed = parseFlags(argv.slice(1), ["--offline", "--json"]);
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
      const result = await inspectRegistrySources(resolveConfigPath(parsed));
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

async function runTools(argv: readonly string[]): Promise<number> {
  const first = argv[0];
  const action = first === undefined || first.startsWith("--") ? "list" : first;
  if (!["list", "check", "show", "search"].includes(action)) { process.stderr.write(`Unknown tools action: ${action}\n\n${toolsUsage()}`); return 2; }
  const needsValue = action === "show" || action === "search";
  if (needsValue && (argv[1] === undefined || argv[1].startsWith("--") || argv[1].trim().length === 0)) { process.stderr.write(toolsUsage()); return 2; }
  const flagOffset = first === undefined || first.startsWith("--") ? 0 : needsValue ? 2 : 1;
  const parsed = parseFlags(argv.slice(flagOffset), ["--json", "--check"]);
  if (parsed.error !== undefined) { process.stderr.write(`${parsed.error}\n\n${toolsUsage()}`); return 2; }
  if ([...parsed.values.keys()].some((key) => !["--config", "--path"].includes(key)) || parsed.repeated.size > 0) { process.stderr.write(`Unknown or repeated tools option.\n\n${toolsUsage()}`); return 2; }
  try {
    const configPath = resolveConfigPath(parsed);
    const catalog = await loadConfiguredRegistryCatalog(configPath);
    const options = { json: parsed.switches.has("--json"), check: parsed.switches.has("--check") || action === "check", path: flag(parsed, "--path") };
    if (action === "list" || action === "check") {
      await writeToolsList(catalog, configPath, options);
      return 0;
    }
    if (action === "search") {
      const query = argv[1] as string;
      await writeToolsList({ ...catalog, tools: searchRegistryTools(catalog.tools, query) }, configPath, options, query);
      return 0;
    }
    if (action === "show") {
      const toolId = argv[1];
      if (toolId === undefined || toolId.startsWith("--")) { process.stderr.write(toolsUsage()); return 2; }
      const tool = catalog.tools.find(({ id }) => id === toolId);
      if (tool === undefined) { process.stderr.write(`Tool not found: ${toolId}\n`); return 1; }
      await writeToolShow(tool, configPath, options);
      return 0;
    }
    process.stderr.write(`Unknown tools action: ${action}\n\n${toolsUsage()}`);
    return 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runAdapters(argv: readonly string[]): Promise<number> {
  const registryPath = argv[0]?.startsWith("--") ? undefined : argv[0];
  const parsed = parseFlags(registryPath === undefined ? argv : argv.slice(1));
  if (parsed.error !== undefined || parsed.repeated.size > 0 || [...parsed.values.keys()].some((key) => key !== "--config") || (registryPath !== undefined && parsed.values.size > 0)) {
    process.stderr.write(adaptersUsage());
    return 2;
  }
  try {
    const absolutePath = registryPath === undefined ? undefined : resolve(registryPath);
    const catalog = absolutePath === undefined
      ? await loadConfiguredRegistryCatalog(resolveConfigPath(parsed))
      : await loadRegistryCatalog([{ id: basename(absolutePath), layer: "user", type: "file", root: dirname(absolutePath), path: basename(absolutePath) }]);
    process.stdout.write(`${JSON.stringify(generateDiscoveryAdapterBundle(catalog), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runProfile(argv: readonly string[]): Promise<number> {
  const [action, profilePath] = argv;
  if (!["inspect", "apply"].includes(action ?? "") || profilePath === undefined || profilePath.startsWith("--") || profilePath.trim().length === 0) { process.stderr.write(profileUsage()); return 2; }
  const parsed = parseFlags(argv.slice(2), action === "apply" ? ["--json", "--install-tools"] : ["--json"]);
  if (parsed.error !== undefined || parsed.repeated.size > 0 || [...parsed.values.keys()].some((key) => !["--config", "--skills-dir", "--path"].includes(key))) { process.stderr.write(profileUsage()); return 2; }
  const configPath = flag(parsed, "--config");
  const skillsDirectory = flag(parsed, "--skills-dir");
  const path = flag(parsed, "--path");
  if (configPath?.trim() === "" || skillsDirectory?.trim() === "") { process.stderr.write(profileUsage()); return 2; }
  const options = { ...(configPath === undefined ? {} : { configPath }), ...(skillsDirectory === undefined ? {} : { skillsDirectory }), ...(path === undefined ? {} : { path }) };
  try {
    const report = action === "apply"
      ? await applyEnvironmentProfile(profilePath, { ...options, installTools: parsed.switches.has("--install-tools") })
      : await inspectEnvironmentProfile(profilePath, options);
    if (parsed.switches.has("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      const lines = [
        `${report.profile.name} (${report.profile.id}@${report.profile.version}) — ${action === "apply" ? "applied" : "installation plan"}`,
        `Sources: ${report.configPath}`,
        ...report.skills.map((skill) => `Skill ${skill.id}: ${skill.destination}`),
        ...report.tools.map((tool) => `Tool ${tool.command}: ${tool.availability.status}; version and access unverified${tool.instructions === undefined ? "" : ` — ${tool.instructions}`}`),
        ...(report.npm.packages.length === 0 ? [] : [`Pinned dependencies (--install-tools): ${report.npm.packages.join(", ")}`, `Dependency PATH: ${report.npm.binPath}`]),
        ...report.connections.map((connection) => `Setup ${connection.id}: ${connection.summary}\n${connection.instructions}`),
        `Capykit MCP connection: ${JSON.stringify(report.mcp)}`,
        ...report.nextSteps,
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runDiscover(argv: readonly string[]): Promise<number> {
  const target = argv[0];
  if (target !== "host") { process.stderr.write(discoverUsage()); return 2; }
  const parsed = parseFlags(argv.slice(1), ["--json"]);
  if (parsed.error !== undefined) { process.stderr.write(`${parsed.error}\n\n${discoverUsage()}`); return 2; }
  if (!parsed.switches.has("--json")) { process.stderr.write(discoverUsage()); return 2; }
  const path = flag(parsed, "--path");
  const registry = await discoverHostRegistry(path === undefined ? {} : { path });
  process.stdout.write(`${JSON.stringify(registry, null, 2)}\n`);
  return 0;
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
  if (command === "adapters") return 0;
  if (command === "doctor") {
    const parsed = parseDoctorArgs(argv.slice(1));
    if (parsed.registryPath === undefined || parsed.error !== undefined) {
      process.stderr.write(`${parsed.error ?? "Missing registry path."}\n\n${doctorUsage()}`);
      return 2;
    }
    return 0;
  }
  if (command === "sources") return 0;
  if (command === "discover") return 0;
  if (command === "tools") return 0;
  if (command === "profile") return 0;
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`); return 2;
}

export async function runAsync(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "help";
  if (command === "sources") return runSources(argv.slice(1));
  if (command === "discover") return runDiscover(argv.slice(1));
  if (command === "tools") return runTools(argv.slice(1));
  if (command === "profile") return runProfile(argv.slice(1));
  if (command === "adapters") return runAdapters(argv.slice(1));
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
