import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkAvailability,
  createServer,
  getTool,
  listCapabilities,
  searchTools,
  type LoadedCatalogProvider,
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
  });

  it("checks catalog availability without executing commands or probes", async () => {
    const result = content(await checkAvailability(provider([exampleSource()]), { visibility: "organization", context: "example-org", toolId: "example-filesystem-mcp", interfaceId: "filesystem-mcp" }));

    expect(Array.isArray(result.checks)).toBe(true);
    const checks = result.checks as Record<string, unknown>[];
    expect(checks[0]).toEqual(expect.objectContaining({ toolId: "example-filesystem-mcp", available: true }));
    expect(checks[0]?.note).toEqual(expect.stringContaining("does not execute commands"));
    expect(checks[0]?.healthChecks).toEqual([expect.objectContaining({ status: "declared-not-executed" })]);
  });

  it("accepts a CLI-compatible registry file path for stdio startup configuration", () => {
    expect(createServer({ registryPath: fileURLToPath(new URL("./fixtures/registries/builtin.registry.json", import.meta.url)) })).toBeDefined();
  });
});
