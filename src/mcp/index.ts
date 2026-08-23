import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { dirname, basename } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CAPYKIT_VERSION, loadRegistryCatalog, normalizeQuery, type RegistryCatalog, type RegistrySource, type ResolvedRegistryTool } from "../core/index.js";

export type McpAudience = "agent" | "human";
export type McpVisibility = "public" | "organization" | "host" | "user";

export interface CreateServerOptions {
  readonly catalog?: RegistryCatalog;
  readonly sources?: readonly RegistrySource[];
  readonly allowedVisibilities?: readonly McpVisibility[];
  readonly defaultAudience?: McpAudience;
  readonly now?: () => Date;
}

interface ToolScope {
  readonly visibility: McpVisibility;
  readonly audiences: readonly McpAudience[];
}

interface FilterOptions {
  readonly audience?: McpAudience | undefined;
  readonly visibility?: McpVisibility | undefined;
}

interface ToolSummary {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly visibility: McpVisibility;
  readonly audiences: readonly McpAudience[];
  readonly interfaceTypes: readonly string[];
  readonly lifecycleStatus: string | undefined;
}

interface CapabilityRecord {
  readonly toolId: string;
  readonly toolName: string;
  readonly interfaceId: string;
  readonly interfaceType: string;
  readonly name: string;
  readonly summary: string;
}

const audienceSchema = z.enum(["agent", "human"]).optional();
const visibilitySchema = z.enum(["public", "organization", "host", "user"]).optional();

const filterSchema = {
  audience: audienceSchema.describe("Audience to expose records for. Defaults to the server's configured audience."),
  visibility: visibilitySchema.describe("Optional exact scope visibility filter, further constrained by the server's allowed visibilities."),
};

function textJson(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolScope(tool: ResolvedRegistryTool): ToolScope {
  const scope = recordObject(tool.record.scope);
  const visibility = stringProperty(scope ?? {}, "visibility");
  const audiencesValue = scope?.audiences;
  const audiences = Array.isArray(audiencesValue)
    ? audiencesValue.filter((entry): entry is McpAudience => entry === "agent" || entry === "human")
    : [];
  return {
    visibility: visibility === "organization" || visibility === "host" || visibility === "user" ? visibility : "public",
    audiences: audiences.length > 0 ? audiences : ["agent"],
  };
}

function lifecycleStatus(tool: ResolvedRegistryTool): string | undefined {
  const lifecycle = recordObject(tool.record.lifecycle);
  return lifecycle === undefined ? undefined : stringProperty(lifecycle, "status");
}

function interfaces(tool: ResolvedRegistryTool): readonly Record<string, unknown>[] {
  const value = tool.record.interfaces;
  return Array.isArray(value) ? value.flatMap((entry) => {
    const object = recordObject(entry);
    return object === undefined ? [] : [object];
  }) : [];
}

function capabilityRecords(toolId: string, toolName: string, interfaceId: string, interfaceType: string, values: unknown): readonly CapabilityRecord[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const entry = recordObject(value);
    const name = entry === undefined ? undefined : stringProperty(entry, "name") ?? stringProperty(entry, "id");
    if (name === undefined) return [];
    const summary = entry === undefined ? "" : stringProperty(entry, "summary") ?? "";
    return [{ toolId, toolName, interfaceId, interfaceType, name, summary }];
  });
}

function visibleTools(catalog: RegistryCatalog, serverOptions: Required<Pick<CreateServerOptions, "allowedVisibilities" | "defaultAudience">>, filter: FilterOptions): readonly ResolvedRegistryTool[] {
  const requestedAudience = filter.audience ?? serverOptions.defaultAudience;
  return catalog.tools.filter((tool) => {
    const scope = toolScope(tool);
    if (!serverOptions.allowedVisibilities.includes(scope.visibility)) return false;
    if (filter.visibility !== undefined && filter.visibility !== scope.visibility) return false;
    return scope.audiences.includes(requestedAudience);
  });
}

function summarizeTool(tool: ResolvedRegistryTool): ToolSummary {
  const scope = toolScope(tool);
  return {
    id: tool.id,
    name: typeof tool.record.name === "string" ? tool.record.name : tool.id,
    summary: typeof tool.record.summary === "string" ? tool.record.summary : "",
    visibility: scope.visibility,
    audiences: scope.audiences,
    interfaceTypes: [...new Set(interfaces(tool).map((entry) => stringProperty(entry, "type")).filter((entry): entry is string => entry !== undefined))].sort((left, right) => left.localeCompare(right, "en-US")),
    lifecycleStatus: lifecycleStatus(tool),
  };
}

export function searchCatalogTools(catalog: RegistryCatalog, serverOptions: Required<Pick<CreateServerOptions, "allowedVisibilities" | "defaultAudience">>, query: string, filter: FilterOptions = {}): readonly ToolSummary[] {
  const normalized = normalizeQuery(query);
  return visibleTools(catalog, serverOptions, filter)
    .map(summarizeTool)
    .filter((tool) => normalized.length === 0 || [tool.id, tool.name, tool.summary, ...tool.interfaceTypes].some((value) => normalizeQuery(value).includes(normalized)))
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

export function getCatalogTool(catalog: RegistryCatalog, serverOptions: Required<Pick<CreateServerOptions, "allowedVisibilities" | "defaultAudience">>, id: string, filter: FilterOptions = {}): { readonly tool: ResolvedRegistryTool["record"]; readonly provenance: ResolvedRegistryTool["provenance"] } | undefined {
  const tool = visibleTools(catalog, serverOptions, filter).find((entry) => entry.id === id);
  return tool === undefined ? undefined : { tool: tool.record, provenance: tool.provenance };
}

export function listCatalogCapabilities(catalog: RegistryCatalog, serverOptions: Required<Pick<CreateServerOptions, "allowedVisibilities" | "defaultAudience">>, filter: FilterOptions = {}): readonly CapabilityRecord[] {
  return visibleTools(catalog, serverOptions, filter).flatMap((tool) => {
    const toolName = typeof tool.record.name === "string" ? tool.record.name : tool.id;
    return interfaces(tool).flatMap((iface) => {
      const interfaceId = stringProperty(iface, "id") ?? "default";
      const interfaceType = stringProperty(iface, "type") ?? "unknown";
      return [...capabilityRecords(tool.id, toolName, interfaceId, interfaceType, iface.capabilities), ...capabilityRecords(tool.id, toolName, interfaceId, interfaceType, iface.operations)];
    });
  }).sort((left, right) => `${left.toolId}:${left.interfaceId}:${left.name}`.localeCompare(`${right.toolId}:${right.interfaceId}:${right.name}`, "en-US"));
}

export function checkCatalogAvailability(catalog: RegistryCatalog, serverOptions: Required<Pick<CreateServerOptions, "allowedVisibilities" | "defaultAudience">>, id: string | undefined, filter: FilterOptions = {}): readonly unknown[] {
  return visibleTools(catalog, serverOptions, filter)
    .filter((tool) => id === undefined || tool.id === id)
    .map((tool) => ({
      toolId: tool.id,
      available: true,
      status: "catalog-record-present",
      checkedBy: "capykit-mcp-read-only",
      note: "Runtime health checks are reported as catalog metadata only; the MCP server does not execute commands, mutate state, or probe network services.",
      healthChecks: Array.isArray(tool.record.healthChecks) ? tool.record.healthChecks : [],
    }))
    .sort((left, right) => left.toolId.localeCompare(right.toolId, "en-US"));
}

function registrySourceFromFile(registryFile: string): RegistrySource {
  return { id: basename(registryFile), layer: "user", type: "file", root: dirname(registryFile), path: basename(registryFile) };
}

function sourcesFromEnvironment(): readonly RegistrySource[] {
  const registryFile = process.env.CAPYKIT_REGISTRY_FILE;
  return registryFile === undefined || registryFile.length === 0 ? [] : [registrySourceFromFile(registryFile)];
}

function parseMainArgs(argv: readonly string[]): { readonly registryFile?: string; readonly error?: string } {
  let registryFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--registry") {
      const value = argv[index + 1];
      if (value === undefined) return { error: "Missing value for --registry." };
      registryFile = value;
      index += 1;
      continue;
    }
    return registryFile === undefined ? { error: `Unknown capykit-mcp option: ${argument ?? ""}` } : { registryFile, error: `Unknown capykit-mcp option: ${argument ?? ""}` };
  }
  return registryFile === undefined ? {} : { registryFile };
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: "capykit", version: CAPYKIT_VERSION });
  const serverOptions: Required<Pick<CreateServerOptions, "allowedVisibilities" | "defaultAudience">> = {
    allowedVisibilities: options.allowedVisibilities ?? ["public"],
    defaultAudience: options.defaultAudience ?? "agent",
  };
  async function catalog(): Promise<RegistryCatalog> {
    if (options.catalog !== undefined) return options.catalog;
    const sources = options.sources ?? sourcesFromEnvironment();
    if (sources.length === 0) return { tools: [], sources: [] };
    return loadRegistryCatalog(sources, options.now === undefined ? {} : { now: options.now });
  }

  server.registerTool("search_tools", {
    title: "Search Capykit tools",
    description: "Search read-only Capykit catalog tool summaries filtered by configured visibility and audience.",
    inputSchema: { query: z.string().optional().describe("Case-insensitive search text."), ...filterSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, audience, visibility }) => textJson({ tools: searchCatalogTools(await catalog(), serverOptions, query ?? "", { audience, visibility }) }));

  server.registerTool("get_tool", {
    title: "Get a Capykit tool",
    description: "Return one read-only catalog record and provenance if it passes visibility and audience filters.",
    inputSchema: { id: z.string().min(1).describe("Stable Capykit tool ID."), ...filterSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, audience, visibility }) => textJson({ result: getCatalogTool(await catalog(), serverOptions, id, { audience, visibility }) ?? null }));

  server.registerTool("list_capabilities", {
    title: "List Capykit capabilities",
    description: "List deterministic capability summaries from visible catalog interfaces.",
    inputSchema: filterSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ audience, visibility }) => textJson({ capabilities: listCatalogCapabilities(await catalog(), serverOptions, { audience, visibility }) }));

  server.registerTool("check_availability", {
    title: "Check catalog availability",
    description: "Report visible catalog records and health-check metadata without executing checks.",
    inputSchema: { id: z.string().min(1).optional().describe("Optional stable Capykit tool ID."), ...filterSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, audience, visibility }) => textJson({ checks: checkCatalogAvailability(await catalog(), serverOptions, id, { audience, visibility }) }));

  return server;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseMainArgs(argv);
  if (parsed.error !== undefined) throw new Error(`${parsed.error}\nUsage: capykit-mcp [--registry <registry.json>]`);
  const options = parsed.registryFile === undefined ? {} : { sources: [registrySourceFromFile(parsed.registryFile)] };
  await createServer(options).connect(new StdioServerTransport());
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  try { return realpathSync(entryPath) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isDirectExecution()) main().catch((error: unknown) => { process.stderr.write(`capykit-mcp failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });