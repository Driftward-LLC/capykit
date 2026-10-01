import { execFile as nodeExecFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, readdir, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { hostname as osHostname } from "node:os";
import { promisify } from "node:util";
import type { RegistryDocument, RegistryTool } from "./registry.js";

export const HOST_DISCOVERY_VERSION = 2;

const execFileAsync = promisify(nodeExecFile);
const executableName = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const envReferenceName = /^[A-Z][A-Z0-9_]*$/u;
const codexName = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const bootstrapHelperCommands = new Set(["browserbase-env", "openseo-env"]);

export interface HostDiscoveryExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostDiscoveryOptions {
  /** Operator-approved PATH to inspect for executable names. Discovered commands are not executed. */
  readonly path?: string;
  readonly hostname?: string;
  /** Explicitly allow Codex metadata commands to use configured authentication and contact providers. */
  readonly allowCodexAuth?: boolean;
  readonly now?: () => Date;
  /** Test seam for approved Codex metadata commands. */
  readonly execFile?: (command: string, args: readonly string[]) => Promise<HostDiscoveryExecResult>;
}

interface DiscoveredCommand {
  readonly command: string;
  readonly source: "path" | "bootstrap-helper";
}

interface DiscoveredCodexMcpServer {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly envReferences: readonly string[];
}

interface DiscoveredCodexPlugin {
  readonly name: string;
}

interface DiscoverySnapshot {
  readonly commands: readonly DiscoveredCommand[];
  readonly codexMcpServers: readonly DiscoveredCodexMcpServer[];
  readonly codexPlugins: readonly DiscoveredCodexPlugin[];
}

function configuredPath(pathValue: string | undefined): readonly string[] {
  return (pathValue ?? process.env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
}

function normalizeIdentifier(value: string, fallback: string): string {
  const normalized = value.toLocaleLowerCase("en-US").replaceAll(/[^a-z0-9._-]+/gu, "-").replaceAll(/^[^a-z]+|[-._]+$/gu, "").replaceAll(/[-._]{2,}/gu, "-");
  const base = normalized.length === 0 ? fallback : normalized;
  if (base === value && base.length <= 100) return base;
  // Keep IDs stable across ordering and avoid collisions from case, punctuation,
  // or truncation. Reserve space for tool prefixes and authentication suffixes.
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${base.slice(0, 87).replace(/[-._]+$/u, "")}-${digest}`;
}

async function executableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function codexExecutable(pathValue: string | undefined): Promise<string | undefined> {
  for (const directory of configuredPath(pathValue)) {
    const candidate = resolve(directory, "codex");
    if (await executableFile(candidate)) return candidate;
  }
  return undefined;
}

async function discoverPathCommands(pathValue: string | undefined): Promise<readonly DiscoveredCommand[]> {
  const commands = new Map<string, DiscoveredCommand>();
  for (const directory of configuredPath(pathValue)) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!executableName.test(entry.name)) continue;
        if (commands.has(entry.name)) continue;
        try {
          const candidate = join(directory, entry.name);
          if (!(await executableFile(candidate))) continue;
          commands.set(entry.name, { command: entry.name, source: bootstrapHelperCommands.has(entry.name) ? "bootstrap-helper" : "path" });
        } catch {
          // Ignore non-executable or disappearing PATH entries.
        }
      }
    } catch {
      continue;
    }
  }
  return [...commands.values()].sort((left, right) => left.command.localeCompare(right.command, "en-US"));
}

async function runCodex(command: string, execFile: HostDiscoveryOptions["execFile"], args: readonly string[]): Promise<string> {
  try {
    const result = execFile === undefined
      ? await execFileAsync(command, [...args], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000 })
      : await execFile(command, args);
    if (result.stderr.trim().length > 0) throw new Error("Codex metadata emitted diagnostics.");
    return result.stdout;
  } catch {
    // Child errors can contain raw configuration and output. Never attach them as causes.
    throw new Error("Codex metadata discovery failed; the registry was not generated.");
  }
}

function invalidMetadata(): never {
  throw new Error("Unsupported Codex metadata; the registry was not generated.");
}

function parseMcpNames(output: string): readonly string[] {
  if (output.trim() === "No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.") return [];
  const names = new Set<string>();
  let table = false;
  for (const line of output.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.length > 0)) {
    if (/^Name\s+(?:Command\s+Args\s+Env\s+Cwd|Url\s+Bearer Token Env Var)\s+Status\s+Auth$/u.test(line)) {
      table = true;
      continue;
    }
    const name = /^(\S+)\s{2,}\S/u.exec(line)?.[1];
    if (!table || name === undefined || !codexName.test(name) || names.has(name)) invalidMetadata();
    names.add(name);
  }
  if (!table || names.size === 0) invalidMetadata();
  return [...names];
}

function parseMcpDetails(name: string, output: string): DiscoveredCodexMcpServer | undefined {
  const lines = output.trimEnd().split(/\r?\n/u);
  if (lines.length === 1 && (lines[0] === `${name} (disabled)` || (lines[0]?.startsWith(`${name} (disabled: `) && lines[0].endsWith(")")))) return undefined;
  if (lines[0] !== name) invalidMetadata();
  const fields = new Map<string, string>();
  // Only these explicit metadata fields are read. Args, launchers, URLs, headers,
  // and arbitrary uppercase strings are never copied into generated records.
  for (const line of lines.slice(1)) {
    const field = /^ {2}(enabled|transport|env|bearer_token_env_var|env_http_headers): (.*)$/u.exec(line);
    if (field?.[1] === undefined || field[2] === undefined) continue;
    if (fields.has(field[1])) invalidMetadata();
    fields.set(field[1], field[2]);
  }
  if (fields.get("enabled") !== "true") invalidMetadata();
  const transport = fields.get("transport");
  if (transport !== "stdio" && transport !== "streamable_http") invalidMetadata();
  const envReferences = new Set<string>();
  function addReference(value: string): void {
    if (!envReferenceName.test(value)) invalidMetadata();
    envReferences.add(value);
  }
  const env = fields.get("env");
  if (transport === "stdio") {
    if (env === undefined) invalidMetadata();
    if (env !== "-") {
      for (const entry of env.split(", ")) {
        const name = /^([A-Za-z_][A-Za-z0-9_]*)=\*{5}$/u.exec(entry)?.[1];
        if (name === undefined) invalidMetadata();
        addReference(name);
      }
    }
  } else {
    const bearer = fields.get("bearer_token_env_var");
    const headers = fields.get("env_http_headers");
    if (bearer === undefined || headers === undefined) invalidMetadata();
    if (bearer !== "-") addReference(bearer);
    if (headers !== "-") {
      for (const entry of headers.split(", ")) {
        const name = /^[^=]+=(.*)$/u.exec(entry)?.[1];
        if (name === undefined) invalidMetadata();
        addReference(name);
      }
    }
  }
  return { name, transport: transport === "stdio" ? "stdio" : "http", envReferences: [...envReferences].sort() };
}

function parsePlugins(output: string): readonly DiscoveredCodexPlugin[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    invalidMetadata();
  }
  if (typeof parsed !== "object" || parsed === null || !("installed" in parsed) || !Array.isArray(parsed.installed)) invalidMetadata();
  const names = new Set<string>();
  for (const entry of parsed.installed as unknown[]) {
    if (typeof entry !== "object" || entry === null || !("pluginId" in entry) || typeof entry.pluginId !== "string"
      || !codexName.test(entry.pluginId) || !("installed" in entry) || entry.installed !== true
      || !("enabled" in entry) || typeof entry.enabled !== "boolean") invalidMetadata();
    if (entry.enabled) names.add(entry.pluginId);
  }
  return [...names].map((name) => ({ name }));
}

async function discoverCodex(pathValue: string | undefined, execFile: HostDiscoveryOptions["execFile"]): Promise<{ servers: readonly DiscoveredCodexMcpServer[]; plugins: readonly DiscoveredCodexPlugin[] }> {
  const command = await codexExecutable(pathValue);
  if (command === undefined) return { servers: [], plugins: [] };
  // MCP JSON includes unmasked credential values. Use the masked text format.
  const serverNames = parseMcpNames(await runCodex(command, execFile, ["mcp", "list"]));
  const servers: DiscoveredCodexMcpServer[] = [];
  // Keep subprocess concurrency bounded even for a large configured inventory.
  for (let index = 0; index < serverNames.length; index += 4) {
    const batch = await Promise.all(serverNames.slice(index, index + 4).map(async (name) =>
      parseMcpDetails(name, await runCodex(command, execFile, ["mcp", "get", name]))));
    for (const server of batch) if (server !== undefined) servers.push(server);
  }
  const plugins = parsePlugins(await runCodex(command, execFile, ["plugin", "list", "--json"]));
  return {
    servers: servers.sort((left, right) => left.name.localeCompare(right.name, "en-US")),
    plugins: [...plugins].sort((left, right) => left.name.localeCompare(right.name, "en-US")),
  };
}

function owner(): RegistryTool["owners"] {
  return [{ id: "host-operator", name: "Host operator" }];
}

function hostScope(hostId: string): RegistryTool["scope"] {
  return { visibility: "host", audiences: ["agent"], platforms: ["linux"], contexts: [hostId] };
}

function noAuthentication(): RegistryTool["authentication"] {
  return { mode: "none", requirements: [] };
}

function envAuthentication(toolId: string, envReferences: readonly string[]): RegistryTool["authentication"] {
  if (envReferences.length === 0) return noAuthentication();
  return {
    mode: "optional",
    requirements: [{
      id: `${toolId}-auth`,
      type: "other",
      description: "Environment reference names from Codex metadata; values are excluded from the catalog and access remains unverified.",
      references: envReferences.map((name) => ({ kind: "environment", name })),
    }],
  };
}

function defaultSafety(): RegistryTool["safety"] {
  return { risk: "executes-code", approval: "always", notes: "Generated discovery records command presence and metadata only; operators should annotate precise risk and approval expectations in higher-precedence registry sources." };
}

function commandTool(command: DiscoveredCommand, hostId: string): RegistryTool {
  const toolId = `${normalizeIdentifier(command.command, "command")}-cli`;
  return {
    id: toolId,
    name: command.command,
    summary: command.source === "bootstrap-helper" ? `Bootstrap-managed helper command discovered on PATH: ${command.command}.` : `Executable command discovered on PATH: ${command.command}.`,
    owners: owner(),
    interfaces: [{ id: "cli", type: "cli", command: command.command, capabilities: [{ name: "invoke-command", summary: "Invoke the discovered CLI command when separately authorized by the operator." }] }],
    scope: hostScope(hostId),
    authentication: noAuthentication(),
    safety: defaultSafety(),
    lifecycle: { status: "active" },
    healthChecks: [{ id: "command-available", kind: "command-available", command: command.command }],
    documentation: [{ label: "Generated host discovery", url: "https://github.com/Driftward-LLC/capykit/blob/main/docs/host-discovery.md" }],
    relationships: [],
    examples: [{ title: "Inspect generated metadata", interfaceId: "cli", usage: `capykit tools show ${toolId} --json` }],
    extensions: { "x-generated-fact-source": command.source },
  };
}

function mcpTool(server: DiscoveredCodexMcpServer, hostId: string): RegistryTool {
  const serverId = normalizeIdentifier(server.name, "server");
  const toolId = `codex-mcp-${serverId}`;
  return {
    id: toolId,
    name: `Codex MCP ${server.name}`,
    summary: `Codex MCP server discovered from codex mcp list: ${server.name}.`,
    owners: owner(),
    interfaces: [{ id: "codex", type: "cli", command: "codex", capabilities: [{ name: "use-mcp-server", summary: "Use this configured MCP server through Codex. Native MCP connection details require operator-reviewed annotations." }] }],
    scope: hostScope(hostId),
    authentication: envAuthentication(toolId, server.envReferences),
    safety: defaultSafety(),
    lifecycle: { status: "active" },
    healthChecks: [{ id: "codex-available", kind: "command-available", command: "codex" }],
    documentation: [{ label: "Codex MCP configuration", url: "https://github.com/openai/codex" }],
    relationships: [{ type: "requires", target: "codex-cli" }],
    examples: [{ title: "Inspect generated metadata", interfaceId: "codex", usage: `capykit tools show ${toolId} --json` }],
    extensions: { "x-generated-fact-source": "codex-mcp", "x-codex-mcp-server-name": server.name, "x-codex-mcp-transport": server.transport },
  };
}

function pluginTool(plugin: DiscoveredCodexPlugin, hostId: string): RegistryTool {
  const pluginId = normalizeIdentifier(plugin.name, "plugin");
  const toolId = `codex-plugin-${pluginId}`;
  return {
    id: toolId,
    name: `Codex plugin ${plugin.name}`,
    summary: `Codex plugin discovered from codex plugin list: ${plugin.name}.`,
    owners: owner(),
    interfaces: [{ id: "codex-plugin", type: "skill", format: "other", location: `codex plugin:${plugin.name}`, capabilities: [{ name: "extend-codex", summary: "Expose plugin-provided Codex behavior when configured on this host." }] }],
    scope: hostScope(hostId),
    authentication: noAuthentication(),
    safety: { risk: "executes-code", approval: "always", notes: "Generated plugin discovery records plugin presence only; operators should annotate exact safety expectations separately." },
    lifecycle: { status: "active" },
    healthChecks: [],
    documentation: [{ label: "Codex plugins", url: "https://github.com/openai/codex" }],
    relationships: [{ type: "requires", target: "codex-cli" }],
    examples: [{ title: "Inspect generated metadata", interfaceId: "codex-plugin", usage: `capykit tools show ${toolId} --json` }],
    extensions: { "x-generated-fact-source": "codex-plugin" },
  };
}

function registryTools(snapshot: DiscoverySnapshot, hostId: string): readonly RegistryTool[] {
  const tools = [
    ...snapshot.commands.map((command) => commandTool(command, hostId)),
    ...snapshot.codexMcpServers.map((server) => mcpTool(server, hostId)),
    ...snapshot.codexPlugins.map((plugin) => pluginTool(plugin, hostId)),
  ];
  const byId = new Map<string, RegistryTool>();
  for (const tool of tools) {
    if (byId.has(tool.id)) throw new Error("Discovered tool identifiers collide; the registry was not generated.");
    byId.set(tool.id, tool);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

export async function discoverHostRegistry(options: HostDiscoveryOptions = {}): Promise<RegistryDocument> {
  const hostName = options.hostname ?? osHostname();
  const hostId = normalizeIdentifier(hostName, "host");
  const pathCommands = await discoverPathCommands(options.path);
  const codex = options.allowCodexAuth === true
    ? await discoverCodex(options.path, options.execFile)
    : { servers: [], plugins: [] };
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const snapshot: DiscoverySnapshot = { commands: pathCommands, codexMcpServers: codex.servers, codexPlugins: codex.plugins };
  return {
    schemaVersion: "0.1.0",
    registry: {
      id: `${hostId}-generated`,
      name: `Generated host registry for ${hostName}`,
      description: "Generated PATH inventory with optional Codex metadata. Connection details and credential values are excluded from the catalog; consult discovery status for coverage.",
      homepage: "https://github.com/Driftward-LLC/capykit/blob/main/docs/host-discovery.md",
      extensions: { "x-generated-source": "live-host-discovery" },
    },
    tools: registryTools(snapshot, hostId),
    extensions: {
      "x-generated-source": "live-host-discovery",
      "x-host-discovery-version": HOST_DISCOVERY_VERSION,
      "x-codex-metadata-status": !pathCommands.some(({ command }) => command === "codex") ? "not-installed" : options.allowCodexAuth === true ? "collected" : "not-requested",
      "x-generated-at-unix-ms": Date.parse(generatedAt),
    },
  };
}
