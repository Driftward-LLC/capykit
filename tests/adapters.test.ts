import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { discoveryAdapterTools, generateDiscoveryAdapterBundle, loadRegistryCatalog, type RegistrySource } from "../src/core/index.js";
import { runAsync } from "../src/cli/index.js";

const examples = fileURLToPath(new URL("../examples/", import.meta.url));
const exampleRegistry = fileURLToPath(new URL("../examples/all-interfaces.registry.json", import.meta.url));

function exampleSource(): RegistrySource {
  return { id: "examples", layer: "builtin", type: "file", root: examples, path: "all-interfaces.registry.json" };
}

describe("platform discovery adapters", () => {
  it("generates deterministic AGENTS, Codex, and Hermes exports from catalog metadata", async () => {
    const catalog = await loadRegistryCatalog([exampleSource()], { now: () => new Date("2026-08-04T00:00:00Z") });
    const first = generateDiscoveryAdapterBundle(catalog);
    const second = generateDiscoveryAdapterBundle(catalog);

    expect(first).toEqual(second);
    expect(first.format).toBe("capykit.discoveryAdapters.v0.1");
    expect(first.catalogDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.files.map(({ path }) => path)).toEqual(["AGENTS.md", ".codex/capykit.discovery.json", ".hermes/references/capykit-discovery.md"]);
    expect(first.files[0]?.content).toContain('capykit tools search "<task keywords>"');
    expect(first.files[0]?.content).toContain("capykit tools show <id> --json --check");
    expect(first.files[0]?.content).not.toContain("update the catalog first");
    expect(first.files[1]?.content).toContain("capykit.codexDiscovery.v0.1");
    expect(first.files[2]?.content).toContain("Capykit discovery reference");
  });

  it("preserves invocation details and safety for all five interfaces in Codex and Hermes exports", async () => {
    const catalog = await loadRegistryCatalog([exampleSource()]);
    const bundle = generateDiscoveryAdapterBundle(catalog);
    const exported = JSON.parse(bundle.files.find(({ path }) => path === ".codex/capykit.discovery.json")?.content ?? "{}") as { tools: Record<string, unknown>[] };
    const hermes = bundle.files.find(({ path }) => path === ".hermes/references/capykit-discovery.md")?.content ?? "";
    const hermesRecords = [...hermes.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => JSON.parse(match[1] ?? "{}") as Record<string, unknown>);

    for (const { record } of catalog.tools) {
      const tool = exported.tools.find(({ id }) => id === record.id);
      expect(tool).toMatchObject({
        authentication: record.authentication,
        safety: record.safety,
        examples: record.examples,
        documentation: record.documentation,
      });
      for (const iface of record.interfaces as Record<string, unknown>[]) {
        expect((tool?.interfaces as Record<string, unknown>[]).find(({ id }) => id === iface.id)).toMatchObject(iface);
      }
      expect(hermesRecords).toContainEqual({
        interfaces: tool?.interfaces,
        authentication: tool?.authentication,
        safety: tool?.safety,
        examples: tool?.examples,
        documentation: tool?.documentation,
      });
      expect(hermes).toContain(`capykit tools show ${record.id} --json --check`);
    }
  });

  it("retains HTTP MCP endpoints and command arguments without reordering invocation text", async () => {
    const catalog = await loadRegistryCatalog([exampleSource()]);
    const interfaces = [{
      id: "remote-mcp", type: "mcp", transport: "http", serverName: "remote", url: "https://example.com/mcp",
      capabilities: [{ name: "read-file", summary: "Read a file.", usage: 'read_file({"path":"/example/path"})' }],
    }, {
      id: "local-mcp", type: "mcp", transport: "stdio", serverName: "local", command: 'local-mcp --root "/example/path with spaces" --readonly',
      capabilities: [{ name: "read-file", summary: "Read a file." }],
    }, {
      id: "local-cli", type: "cli", command: "local-cli --format json",
      capabilities: [{ name: "list", summary: "List files.", usage: 'local-cli --format json list "/example/path with spaces"' }],
    }];
    const changed = { ...catalog, tools: catalog.tools.map((tool) => tool.id === "jq" ? { ...tool, record: { ...tool.record, interfaces } } : tool) };

    expect(discoveryAdapterTools(changed).find(({ id }) => id === "jq")?.interfaces).toEqual(expect.arrayContaining(interfaces));
  });

  it("keeps credential boundaries as references instead of generated values", async () => {
    const catalog = await loadRegistryCatalog([exampleSource()], { now: () => new Date("2026-08-04T00:00:00Z") });
    const tools = discoveryAdapterTools(catalog);
    const filesystem = tools.find(({ id }) => id === "example-filesystem-mcp");

    expect(filesystem?.authentication).toEqual({
      mode: "required",
      requirements: [{
        id: "filesystem-access",
        type: "api-key",
        description: "Access is supplied by the host environment.",
        references: [{ kind: "environment", name: "EXAMPLE_FILESYSTEM_API_KEY" }],
      }],
    });
    expect(JSON.stringify(filesystem)).not.toMatch(/secret|token|credential-value/iu);
    vi.stubEnv("EXAMPLE_FILESYSTEM_API_KEY", "credential-value-not-for-export");
    try {
      const bundle = JSON.stringify(generateDiscoveryAdapterBundle(catalog));
      expect(bundle).toContain("EXAMPLE_FILESYSTEM_API_KEY");
      expect(bundle).not.toContain("credential-value-not-for-export");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("changes the adapter digest when source catalog metadata changes", async () => {
    const catalog = await loadRegistryCatalog([exampleSource()], { now: () => new Date("2026-08-04T00:00:00Z") });
    const changed = {
      ...catalog,
      tools: catalog.tools.map((tool) => tool.id === "jq" ? { ...tool, record: { ...tool.record, summary: "Transform JSON with changed metadata." } } : tool),
    };

    expect(generateDiscoveryAdapterBundle(changed).catalogDigest).not.toBe(generateDiscoveryAdapterBundle(catalog).catalogDigest);
  });

  it("prints the generated adapter bundle from the CLI", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await runAsync(["adapters", exampleRegistry])).toBe(0);
    const output = String(stdout.mock.calls[0]?.[0] ?? "");
    expect(JSON.parse(output)).toEqual(expect.objectContaining({ format: "capykit.discoveryAdapters.v0.1" }));
    expect(stderr).not.toHaveBeenCalled();
  });
});
