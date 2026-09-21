import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkAvailability,
  createServer,
  getTool,
  listCapabilities,
  main,
  searchTools,
  type CapykitMcpServerOptions,
  type LoadedCatalogProvider,
  type McpCatalogFilters,
} from "../src/mcp/index.js";
import { loadRegistryCatalog, type RegistrySource } from "../src/core/index.js";

const fixtures = fileURLToPath(new URL("./fixtures/registries/", import.meta.url));
const examples = fileURLToPath(new URL("../examples/", import.meta.url));

function provider(sources: readonly RegistrySource[]): LoadedCatalogProvider {
  return { catalog: async () => loadRegistryCatalog(sources, { now: () => new Date("2026-08-04T00:00:00Z") }) };
}

function fixtureSource(name: string): RegistrySource {
  return { id: name, layer: "builtin", type: "file", root: fixtures, path: `${name}.registry.json` };
}

function exampleSource(): RegistrySource {
  return { id: "examples", layer: "builtin", type: "file", root: examples, path: "all-interfaces.registry.json" };
}

function content(result: { readonly structuredContent?: Record<string, unknown> | undefined }): Record<string, unknown> {
  if (result.structuredContent === undefined) throw new Error("expected structured content");
  return result.structuredContent;
}

async function callServer(options: CapykitMcpServerOptions, name: string, args: Record<string, unknown> = {}) {
  const server = createServer(options);
  const client = new Client({ name: "capykit-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
    await server.close();
  }
}

describe("read-only MCP server", () => {
  it("constructs the server with the four read-only catalog tools", () => {
    expect(createServer({ sources: [] })).toBeDefined();
  });

  it("searches deterministic visible tool summaries from the core catalog", async () => {
    const result = content(await searchTools(provider([fixtureSource("builtin")]), { query: "built" }));

    expect(result.count).toBe(1);
    expect(result.tools).toEqual([
      expect.objectContaining({ id: "shared-tool", name: "Shared tool", summary: "builtin definition" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("fetchedAt");
  });

  it("returns one visible tool and lists its interface capabilities", async () => {
    const catalog = provider([fixtureSource("builtin")]);

    const tool = content(await getTool(catalog, { id: "shared-tool" }));
    const capabilities = content(await listCapabilities(catalog, { toolId: "shared-tool" }));

    expect(tool.tool).toEqual(expect.objectContaining({ id: "shared-tool" }));
    expect(capabilities.capabilities).toEqual([
      expect.objectContaining({ toolId: "shared-tool", interfaceId: "shared-cli", name: "inspect" }),
    ]);
  });

  it("returns complete validated invocation details for every interface type", async () => {
    const catalog = provider([exampleSource()]);
    const loaded = await catalog.catalog();
    for (const tool of loaded.tools) {
      const scope = tool.record.scope as { visibility: McpCatalogFilters["visibility"]; contexts?: string[] };
      const result = content(await getTool(catalog, { id: tool.id, visibility: scope.visibility, context: scope.contexts?.[0] }));
      const { provenance, ...record } = result.tool as Record<string, unknown>;

      expect(record).toEqual(tool.record);
      expect(provenance).toEqual(expect.objectContaining({ sourceId: "examples" }));
      expect(provenance).not.toHaveProperty("sourceUri");
      expect(provenance).not.toHaveProperty("fetchedAt");
    }
  });

  it("finds API operations and examples with task keywords in any order", async () => {
    const catalog = provider([exampleSource()]);
    const result = content(await searchTools(catalog, { query: " GET   /api/status " }));
    const capabilities = content(await listCapabilities(catalog, { toolId: "example-status-api" }));
    const exampleResult = content(await searchTools(catalog, { query: "names list" }));

    expect(result.tools).toEqual([expect.objectContaining({ id: "example-status-api" })]);
    expect(capabilities.capabilities).toEqual([
      expect.objectContaining({ toolId: "example-status-api", interfaceId: "status-api", interfaceType: "api", name: "get-status", method: "GET", path: "/api/status", usage: "GET https://status.example.com/api/status" }),
    ]);
    expect(exampleResult.tools).toEqual([expect.objectContaining({ id: "jq" })]);
    expect(JSON.stringify(exampleResult)).not.toContain("jq -r '.items[].name' input.json");
  });

  it("enforces scope, audience, and context filters before disclosure", async () => {
    const catalog = provider([exampleSource()]);

    const defaultResult = content(await searchTools(catalog, { query: "filesystem" }));
    const missingContext = content(await searchTools(catalog, { visibility: "organization", query: "filesystem" }));
    const withContext = content(await searchTools(catalog, { visibility: "organization", context: "example-org", query: "filesystem" }));
    const humanAudience = content(await searchTools(catalog, { visibility: "organization", context: "example-org", audience: "human", query: "filesystem" }));

    expect(defaultResult.tools).toEqual([]);
    expect(missingContext.tools).toEqual([]);
    expect(withContext.tools).toEqual([expect.objectContaining({ id: "example-filesystem-mcp" })]);
    expect(humanAudience.tools).toEqual([]);
    expect(await getTool(catalog, { id: "example-filesystem-mcp" })).toEqual(expect.objectContaining({ isError: true }));
    expect(content(await listCapabilities(catalog, { toolId: "example-filesystem-mcp" })).capabilities).toEqual([]);
    expect(content(await checkAvailability(catalog, { toolId: "example-filesystem-mcp" })).checks).toEqual([]);
  });

  it("checks catalog availability without executing commands or probes", async () => {
    const result = content(await checkAvailability(provider([exampleSource()]), { visibility: "organization", context: "example-org", toolId: "example-filesystem-mcp", interfaceId: "filesystem-mcp" }));

    expect(Array.isArray(result.checks)).toBe(true);
    const checks = result.checks as Record<string, unknown>[];
    expect(checks[0]).toEqual(expect.objectContaining({ toolId: "example-filesystem-mcp", declared: true, available: null, status: "declared", access: "unverified" }));
    expect(checks[0]?.note).toEqual(expect.stringContaining("does not execute commands"));
    expect(checks[0]?.healthChecks).toEqual([expect.objectContaining({ status: "declared-not-executed" })]);
  });

  it("reports an undeclared interface as unavailable", async () => {
    const result = content(await checkAvailability(provider([fixtureSource("builtin")]), { toolId: "shared-tool", interfaceId: "missing-interface" }));
    expect(result.checks).toEqual([
      expect.objectContaining({ declared: false, available: false, status: "not-declared", access: "unverified", interfaces: [], healthChecks: [] }),
    ]);
  });

  it.each([
    ["--unknown"], ["registry.json"], ["--config"], ["--registry"],
    ["--config", "--registry", "registry.json"], ["--registry", ""],
    ["--config", "one.json", "--config", "two.json"],
    ["--registry", "one.json", "--registry", "two.json"],
    ["--config", "sources.json", "--registry", "registry.json"],
  ])("rejects invalid startup arguments %j", async (...args) => {
    await expect(main(args)).rejects.toThrow(/Unknown argument|Missing value|Duplicate option|either --config or --registry/u);
  });
});

describe.sequential("configured MCP catalog", () => {
  let temporaryDirectory: string;
  let configPath: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "capykit-mcp-sources-"));
    configPath = join(temporaryDirectory, "capykit", "registry-sources.json");
    vi.stubEnv("XDG_CONFIG_HOME", temporaryDirectory);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function writeSourcesConfig(path: string, sources: readonly RegistrySource[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ format: "capykit.registrySources.v0.1", sources, locks: [] }));
  }

  it("loads configured default sources through the MCP protocol and keeps scope filtering", async () => {
    await writeSourcesConfig(configPath, [exampleSource()]);
    const result = content(await callServer({}, "search_tools"));
    const hidden = await callServer({}, "get_tool", { id: "example-filesystem-mcp" });

    expect(result.tools).toEqual([
      expect.objectContaining({ id: "example-research-skill" }),
      expect.objectContaining({ id: "example-status-api" }),
      expect.objectContaining({ id: "jq" }),
    ]);
    expect(hidden.isError).toBe(true);
  });

  it("uses an explicit sources config instead of the default", async () => {
    await writeSourcesConfig(configPath, [fixtureSource("builtin")]);
    const overridePath = join(temporaryDirectory, "override.json");
    await writeSourcesConfig(overridePath, [exampleSource()]);
    const result = content(await callServer({ configPath: overridePath }, "get_tool", { id: "example-status-api" }));

    expect(result.tool).toEqual(expect.objectContaining({
      interfaces: [expect.objectContaining({ baseUrl: "https://status.example.com", operations: [expect.objectContaining({ method: "GET", path: "/api/status" })] })],
      examples: [expect.objectContaining({ usage: "GET /api/status" })],
    }));
  });

  it("preserves explicit registry paths and programmatic sources without a config", async () => {
    const registryPath = join(fixtures, "builtin.registry.json");
    const result = content(await callServer({ registryPath }, "get_tool", { id: "shared-tool" }));
    const empty = content(await callServer({ sources: [] }, "search_tools"));

    expect(result.tool).toEqual(expect.objectContaining({ interfaces: [expect.objectContaining({ command: "shared" })] }));
    expect(empty.tools).toEqual([]);
  });

  it("reports actionable errors for absent default or explicit config", async () => {
    for (const options of [{}, { configPath: join(temporaryDirectory, "missing.json") }]) {
      const result = await callServer(options, "search_tools");
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("No registry sources config found");
      expect(JSON.stringify(result.content)).toContain("capykit sources add");
    }
  });

  it("validates source records before disclosing invocation details", async () => {
    const invalidPath = join(temporaryDirectory, "invalid.registry.json");
    await writeFile(invalidPath, JSON.stringify({ schemaVersion: "0.1.0", registry: { id: "invalid", name: "Invalid" }, tools: [{ id: "unsafe", interfaces: [{ command: "unvalidated-command" }] }] }));
    const result = await callServer({ registryPath: invalidPath }, "get_tool", { id: "unsafe" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("canonical schema validation");
    expect(JSON.stringify(result.content)).not.toContain("unvalidated-command");
  });
});
