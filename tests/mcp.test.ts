import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { loadRegistryCatalog, type RegistryCatalog } from "../src/core/index.js";
import { checkCatalogAvailability, createServer, getCatalogTool, listCatalogCapabilities, searchCatalogTools } from "../src/mcp/index.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = fileURLToPath(new URL("./fixtures/registries/", import.meta.url));
const publicExample = fileURLToPath(new URL("../examples/all-interfaces.registry.json", import.meta.url));
const serverOptions = { allowedVisibilities: ["public"], defaultAudience: "agent" } as const;

async function publicCatalog(): Promise<RegistryCatalog> {
  return loadRegistryCatalog([{ id: "examples", layer: "builtin", type: "file", root: dirname(publicExample), path: "all-interfaces.registry.json" }], { now: () => new Date("2026-08-15T00:00:00Z") });
}

function parseResult(result: unknown): unknown {
  const object = typeof result === "object" && result !== null && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
  const content = object?.content;
  if (!Array.isArray(content)) throw new Error("missing MCP result content");
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) throw new Error("missing MCP text result");
  const text = (first as Record<string, unknown>).text;
  if (typeof text !== "string") throw new Error("missing MCP text payload");
  return JSON.parse(text) as unknown;
}

describe("MCP read-only catalog server", () => {
  it("constructs the read-only server", () => {
    expect(createServer()).toBeDefined();
  });

  it("searches and reads deterministic catalog records with scope and audience filtering", async () => {
    const catalog = await publicCatalog();

    expect(searchCatalogTools(catalog, serverOptions, "json").map(({ id }) => id)).toEqual(["jq"]);
    expect(getCatalogTool(catalog, serverOptions, "example-filesystem-mcp")).toBeUndefined();
    expect(listCatalogCapabilities(catalog, serverOptions).map(({ name }) => name)).toEqual(["research-topic", "get-status", "transform-json"]);
    expect(checkCatalogAvailability(catalog, serverOptions, "jq")).toMatchObject([{ toolId: "jq", available: true, status: "catalog-record-present" }]);
  });

  it("registers exactly the four read-only MCP tools and no execution or mutation tool", async () => {
    const server = createServer({
      sources: [{ id: "builtin", layer: "builtin", type: "file", root: fixtures, path: "builtin.registry.json" }],
      now: () => new Date("2026-08-15T00:00:00Z"),
    });
    const client = new Client({ name: "capykit-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name).sort()).toEqual(["check_availability", "get_tool", "list_capabilities", "search_tools"]);
      expect(listed.tools.map(({ name }) => name)).not.toContain("execute_tool");

      const result = await client.callTool({ name: "search_tools", arguments: { query: "shared" } }, CallToolResultSchema);
      expect(parseResult(result)).toMatchObject({ tools: [{ id: "shared-tool" }] });
    } finally {
      await client.close();
      await server.close();
    }
  });
});