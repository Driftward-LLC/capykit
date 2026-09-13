import { execFile as nodeExecFile } from "node:child_process";
import { constants } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { delimiter } from "node:path";
import { hostname as osHostname } from "node:os";
import { promisify } from "node:util";
import type { RegistryDocument, RegistryTool } from "./registry.js";

const execFileAsync = promisify(nodeExecFile);
const executableName = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const envReferenceName = /^[A-Z][A-Z0-9_]*$/u;
const bootstrapHelperCommands = new Set(["browserbase-env", "openseo-env"]);

export interface HostDiscoveryExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostDiscoveryOptions {
  /** Operator-approved PATH to inspect for executable names. Discovered commands are not executed. */
  readonly path?: string;
  readonly hostname?: string;
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
  readonly command?: string;
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
  return normalized.length === 0 ? fallback : normalized;
}

async function executableAvailable(command: string, pathValue: string | undefined): Promise<boolean> {
  for (const directory of configuredPath(pathValue)) {
    try {
      const candidate = `${directory}/${command}`;
      await stat(candidate);
      await import("node:fs/promises").then(({ access }) => access(candidate, constants.X_OK));
      return true;
    } catch {
      // Keep looking on the next PATH entry.
    }
  }
  return false;
}

async function discoverPathCommands(pathValue: string | undefined): Promise<readonly DiscoveredCommand[]> {
  const commands = new Map<string, DiscoveredCommand>();
  for (const directory of configuredPath(pathValue)) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!executableName.test(entry)) continue;
      if (commands.has(entry)) continue;
      try {
        const candidate = `${directory}/${entry}`;
        const metadata = await stat(candidate);
        if (!metadata.isFile()) continue;
        await import("node:fs/promises").then(({ access }) => access(candidate, constants.X_OK));
        commands.set(entry, { command: entry, source: bootstrapHelperCommands.has(entry) ? "bootstrap-helper" : "path" });
      } catch {
        // Ignore non-executable or disappearing PATH entries.
      }
    }
  }
  return [...commands.values()].sort((left, right) => left.command.localeCompare(right.command, "en-US"));
}

async function runCodex(execFile: HostDiscoveryOptions["execFile"], args: readonly string[]): Promise<string | undefined> {
  try {
    const result = execFile === undefined ? await execFileAsync("codex", [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }) : await execFile("codex", args);
    return result.stdout;
  } catch {
    return undefined;
  }
}

function parseListOutput(output: string | undefined): readonly string[] {
  if (output === undefined) return [];
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => {
        if (typeof entry === "string") return entry;
        if (typeof entry !== "object" || entry === null || !("name" in entry)) return "";
        const name = (entry as { name?: unknown }).name;
        return typeof name === "string" ? name : "";
      }).filter((entry) => executableName.test(normalizeIdentifier(entry, "")));
    }
  } catch {
    // Fall back to line-oriented CLI output.
  }
  return trimmed.split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((entry) => entry.length > 0 && !["name", "server", "plugin", "---"].includes(entry.toLocaleLowerCase("en-US")));
}

function firstCommandToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim().split(/\s+/u)[0];
  return token !== undefined && executableName.test(token) ? token : undefined;
}

function collectEnvReferences(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const matches = value.match(/[A-Z][A-Z0-9_]{2,}/gu) ?? [];
    for (const match of matches) {
      if (envReferenceName.test(match) && !/(TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION)$/u.test(match)) found.add(match);
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectEnvReferences(entry, found);
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (["env", "environment", "envKeys", "envNames"].includes(key)) collectEnvReferences(entry, found);
    }
  }
  return found;
}

function parseMcpDetails(name: string, output: string | undefined): DiscoveredCodexMcpServer {
  if (output === undefined) return { name, envReferences: [] };
  try {
    const parsed = JSON.parse(output) as unknown;
    const command = typeof parsed === "object" && parsed !== null ? firstCommandToken((parsed as { command?: unknown }).command) : undefined;
    const envReferences = [...collectEnvReferences(parsed)].sort((left, right) => left.localeCompare(right, "en-US"));
    return command === undefined ? { name, envReferences } : { name, command, envReferences };
  } catch {
    const commandLine = output.split(/\r?\n/u).find((line) => /^\s*command\s*:/iu.test(line));
    const command = firstCommandToken(commandLine?.replace(/^\s*command\s*:\s*/iu, ""));
    const envReferences = [...collectEnvReferences(output)].sort((left, right) => left.localeCompare(right, "en-US"));
    return command === undefined ? { name, envReferences } : { name, command, envReferences };
  }
}

async function discoverCodex(pathValue: string | undefined, execFile: HostDiscoveryOptions["execFile"]): Promise<{ servers: readonly DiscoveredCodexMcpServer[]; plugins: readonly DiscoveredCodexPlugin[] }> {
  if (!(await executableAvailable("codex", pathValue))) return { servers: [], plugins: [] };
  const serverNames = parseListOutput(await runCodex(execFile, ["mcp", "list"]));
  const servers = await Promise.all(serverNames.map(async (name) => parseMcpDetails(name, await runCodex(execFile, ["mcp", "get", name]))));
  const plugins = parseListOutput(await runCodex(execFile, ["plugin", "list"])).map((name) => ({ name }));
  return {
    servers: servers.sort((left, right) => left.name.localeCompare(right.name, "en-US")),
    plugins: plugins.sort((left, right) => left.name.localeCompare(right.name, "en-US")),
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
    mode: "required",
    requirements: [{
      id: `${toolId}-auth`,
      type: "api-key",
      description: "Discovered credential references only; credential values are never read or emitted.",
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
    documentation: [{ label: "Generated host discovery", url: "https://github.com/Driftward-LLC/capykit#approved-registry-sources" }],
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
    interfaces: [{ id: "mcp", type: "mcp", transport: "stdio", serverName: serverId, ...(server.command === undefined ? {} : { command: server.command }), capabilities: [{ name: "use-mcp-server", summary: "Use the MCP tools exposed by this Codex server through Codex configuration." }] }],
    scope: hostScope(hostId),
    authentication: envAuthentication(toolId, server.envReferences),
    safety: { risk: "read-only", approval: "always", notes: "Generated MCP discovery records server metadata only; operators should annotate exact safety expectations separately." },
    lifecycle: { status: "active" },
    healthChecks: [{ id: "mcp-declared", kind: "mcp-initialize", interfaceId: "mcp" }],
    documentation: [{ label: "Codex MCP configuration", url: "https://github.com/openai/codex" }],
    relationships: [{ type: "requires", target: "codex-cli" }],
    examples: [{ title: "Inspect generated metadata", interfaceId: "mcp", usage: `capykit tools show ${toolId} --json` }],
    extensions: { "x-generated-fact-source": "codex-mcp" },
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
  for (const tool of tools) byId.set(tool.id, tool);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

export async function discoverHostRegistry(options: HostDiscoveryOptions = {}): Promise<RegistryDocument> {
  const hostName = options.hostname ?? osHostname();
  const hostId = normalizeIdentifier(hostName, "host");
  const pathCommands = await discoverPathCommands(options.path);
  const codex = await discoverCodex(options.path, options.execFile);
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const snapshot: DiscoverySnapshot = { commands: pathCommands, codexMcpServers: codex.servers, codexPlugins: codex.plugins };
  return {
    schemaVersion: "0.1.0",
    registry: {
      id: `${hostId}-generated`,
      name: `Generated host registry for ${hostName}`,
      description: "Generated-first host registry discovered from live command and Codex metadata without reading credential values.",
      homepage: "https://github.com/Driftward-LLC/capykit#approved-registry-sources",
      extensions: { "x-generated-source": "live-host-discovery" },
    },
    tools: registryTools(snapshot, hostId),
    extensions: {
      "x-generated-source": "live-host-discovery",
      "x-generated-at-unix-ms": Date.parse(generatedAt),
    },
  };
}
