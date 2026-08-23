import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPYKIT_VERSION,
  loadRegistryCatalog,
  normalizeQuery,
  type RegistryCatalog,
  type RegistrySource,
  type RegistryTool,
  type ResolvedRegistryTool,
} from "../core/index.js";

type ScopeVisibility = "public" | "organization" | "team" | "personal" | "host";
type ScopeAudience = "agent" | "human";

interface ToolScope { readonly visibility?: unknown; readonly audiences?: unknown; readonly contexts?: unknown; }
interface ToolInterface extends Record<string, unknown> { readonly id?: unknown; readonly type?: unknown; readonly capabilities?: unknown; }
interface ToolHealthCheck extends Record<string, unknown> { readonly id?: unknown; readonly kind?: unknown; readonly interfaceId?: unknown; }

export interface McpCatalogFilters { readonly visibility?: ScopeVisibility | undefined; readonly audience?: ScopeAudience | undefined; readonly context?: string | undefined; }
export interface CapykitMcpServerOptions { readonly sources?: readonly RegistrySource[] | undefined; readonly registryPath?: string | undefined; readonly now?: (() => Date) | undefined; }

export interface LoadedCatalogProvider { readonly catalog: () => Promise<RegistryCatalog>; }
interface SearchToolsArgs extends McpCatalogFilters { readonly query?: string | undefined; }
interface GetToolArgs extends McpCatalogFilters { readonly id: string; }
interface ListCapabilitiesArgs extends McpCatalogFilters { readonly toolId?: string | undefined; }
interface CheckAvailabilityArgs extends McpCatalogFilters { readonly toolId?: string | undefined; readonly interfaceId?: string | undefined; }

const visibilityValues = ["public", "organization", "team", "personal", "host"] as const;
const audienceValues = ["agent", "human"] as const;
const filterShape = {
  visibility: z.enum(visibilityValues).optional().describe("Visibility to disclose. Defaults to public."),
  audience: z.enum(audienceValues).optional().describe("Audience to disclose for. Defaults to agent."),
  context: z.string().optional().describe("Organization, team, user, or host context required for non-public records."),
};

function registryFileSource(registryPath: string): RegistrySource {
  const absolutePath = resolve(registryPath);
  return { id: basename(absolutePath), layer: "user", type: "file", root: dirname(absolutePath), path: basename(absolutePath) };
}

function createCatalogProvider(options: CapykitMcpServerOptions): LoadedCatalogProvider {
  let catalogPromise: Promise<RegistryCatalog> | undefined;
  const sources = options.sources ?? (options.registryPath === undefined ? [] : [registryFileSource(options.registryPath)]);
  return {
    catalog: async () => {
      catalogPromise ??= loadRegistryCatalog(sources, options.now === undefined ? {} : { now: options.now });
      return catalogPromise;
    },
  };
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function toolScope(tool: RegistryTool): ToolScope {
  const scope = tool.scope;
  return typeof scope === "object" && scope !== null && !Array.isArray(scope) ? scope : {};
}

function matchesFilters(tool: RegistryTool, filters: McpCatalogFilters): boolean {
  const requestedVisibility = filters.visibility ?? "public";
  const requestedAudience = filters.audience ?? "agent";
  const scope = toolScope(tool);
  if (scope.visibility !== requestedVisibility) return false;
  if (!asStringArray(scope.audiences).includes(requestedAudience)) return false;
  if (requestedVisibility === "public") return true;
  const contexts = asStringArray(scope.contexts);
  return filters.context !== undefined && contexts.includes(filters.context);
}

function visibleTools(catalog: RegistryCatalog, filters: McpCatalogFilters): readonly ResolvedRegistryTool[] {
  return catalog.tools.filter((tool) => matchesFilters(tool.record, filters));
}

function toolInterfaces(tool: RegistryTool): readonly ToolInterface[] {
  return Array.isArray(tool.interfaces) ? tool.interfaces.filter((entry): entry is ToolInterface => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];
}

function toolHealthChecks(tool: RegistryTool): readonly ToolHealthCheck[] {
  return Array.isArray(tool.healthChecks) ? tool.healthChecks.filter((entry): entry is ToolHealthCheck => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];
}

function capabilitySummaries(tool: RegistryTool): readonly Record<string, unknown>[] {
  return toolInterfaces(tool).flatMap((toolInterface) => {
    const capabilities = Array.isArray(toolInterface.capabilities) ? toolInterface.capabilities : [];
    return capabilities.filter((capability): capability is Record<string, unknown> => typeof capability === "object" && capability !== null && !Array.isArray(capability)).map((capability) => {
      const summary: Record<string, unknown> = { ...capability, toolId: tool.id };
      if (typeof toolInterface.id === "string") summary.interfaceId = toolInterface.id;
      if (typeof toolInterface.type === "string") summary.interfaceType = toolInterface.type;
      return summary;
    });
  });
}

function publicToolSummary(tool: ResolvedRegistryTool): Record<string, unknown> {
  return {
    id: tool.id,
    name: tool.record.name,
    summary: tool.record.summary,
    scope: tool.record.scope,
    safety: tool.record.safety,
    lifecycle: tool.record.lifecycle,
    interfaces: toolInterfaces(tool.record).map((toolInterface) => ({ id: toolInterface.id, type: toolInterface.type, capabilities: toolInterface.capabilities })),
    documentation: tool.record.documentation,
    provenance: {
      sourceId: tool.provenance.sourceId,
      layer: tool.provenance.layer,
      registryId: tool.provenance.registryId,
      revision: tool.provenance.revision,
      sha256: tool.provenance.sha256,
    },
  };
}

function ok(structuredContent: Record<string, unknown>): CallToolResult {
  return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }] };
}

function notFound(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export async function searchTools(provider: LoadedCatalogProvider, args: SearchToolsArgs): Promise<CallToolResult> {
  const query = normalizeQuery(args.query ?? "");
  const tools = visibleTools(await provider.catalog(), args).filter((tool) => {
    if (query.length === 0) return true;
    const haystack = [tool.id, tool.record.name, tool.record.summary, ...capabilitySummaries(tool.record).flatMap((capability) => [capability.name, capability.summary])]
      .filter((value): value is string => typeof value === "string")
      .map(normalizeQuery)
      .join("\n");
    return haystack.includes(query);
  }).map(publicToolSummary);
  return ok({ tools, count: tools.length });
}

export async function getTool(provider: LoadedCatalogProvider, args: GetToolArgs): Promise<CallToolResult> {
  const tool = visibleTools(await provider.catalog(), args).find((candidate) => candidate.id === args.id);
  if (tool === undefined) return notFound(`No visible Capykit tool found for id ${JSON.stringify(args.id)}.`);
  return ok({ tool: publicToolSummary(tool) });
}

export async function listCapabilities(provider: LoadedCatalogProvider, args: ListCapabilitiesArgs): Promise<CallToolResult> {
  const tools = visibleTools(await provider.catalog(), args).filter((tool) => args.toolId === undefined || tool.id === args.toolId);
  const capabilities = tools.flatMap((tool) => capabilitySummaries(tool.record));
  return ok({ capabilities, count: capabilities.length });
}

export async function checkAvailability(provider: LoadedCatalogProvider, args: CheckAvailabilityArgs): Promise<CallToolResult> {
  const tools = visibleTools(await provider.catalog(), args).filter((tool) => args.toolId === undefined || tool.id === args.toolId);
  const checks = tools.flatMap((tool) => {
    const interfaces = toolInterfaces(tool.record);
    const interfaceIds = new Set(interfaces.map(({ id }) => id).filter((id): id is string => typeof id === "string"));
    const matchingInterfaces = args.interfaceId === undefined ? interfaces : interfaces.filter(({ id }) => id === args.interfaceId);
    const healthChecks = toolHealthChecks(tool.record).filter((healthCheck) => args.interfaceId === undefined || healthCheck.interfaceId === args.interfaceId);
    return [{
      toolId: tool.id,
      lifecycle: tool.record.lifecycle,
      authentication: tool.record.authentication,
      safety: tool.record.safety,
      interfaces: matchingInterfaces.map((toolInterface) => ({ id: toolInterface.id, type: toolInterface.type })),
      healthChecks: healthChecks.map((healthCheck) => ({ ...healthCheck, status: "declared-not-executed" })),
      available: matchingInterfaces.length > 0 && (args.interfaceId === undefined || interfaceIds.has(args.interfaceId)),
      note: "Read-only availability only reports catalog declarations; it does not execute commands, mutate state, or probe remote services.",
    }];
  });
  return ok({ checks, count: checks.length });
}

export function createServer(options: CapykitMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "capykit", version: CAPYKIT_VERSION });
  const provider = createCatalogProvider(options);
  server.registerTool("search_tools", {
    title: "Search Capykit tools",
    description: "Search the read-only Capykit catalog after scope and audience filtering.",
    inputSchema: { ...filterShape, query: z.string().optional() },
  }, async (args) => searchTools(provider, args));
  server.registerTool("get_tool", {
    title: "Get a Capykit tool",
    description: "Return one visible catalog tool by stable id.",
    inputSchema: { ...filterShape, id: z.string() },
  }, async (args) => getTool(provider, args));
  server.registerTool("list_capabilities", {
    title: "List Capykit capabilities",
    description: "List visible interface capabilities from the read-only catalog.",
    inputSchema: { ...filterShape, toolId: z.string().optional() },
  }, async (args) => listCapabilities(provider, args));
  server.registerTool("check_availability", {
    title: "Check catalog availability declarations",
    description: "Report deterministic availability metadata without executing checks.",
    inputSchema: { ...filterShape, toolId: z.string().optional(), interfaceId: z.string().optional() },
  }, async (args) => checkAvailability(provider, args));
  return server;
}

function parseArgs(argv: readonly string[]): CapykitMcpServerOptions {
  const registryFlagIndex = argv.indexOf("--registry");
  if (registryFlagIndex === -1) return {};
  const registryPath = argv[registryFlagIndex + 1];
  if (registryPath === undefined) throw new Error("Missing value for --registry.");
  return { registryPath };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--http")) {
    throw new Error("Streamable HTTP transport is deferred for v0.1; run capykit-mcp over stdio.");
  }
  await createServer(parseArgs(argv)).connect(new StdioServerTransport());
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  try { return realpathSync(entryPath) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isDirectExecution()) main().catch((error: unknown) => { process.stderr.write(`capykit-mcp failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
