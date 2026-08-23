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
    expect(first.files[0]?.content).toContain("Before implementation:");
    expect(first.files[1]?.content).toContain("capykit.codexDiscovery.v0.1");
    expect(first.files[2]?.content).toContain("Capykit discovery reference");
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
        references: [{ kind: "environment", name: "EXAMPLE_FILESYSTEM_API_KEY" }],
      }],
    });
    expect(JSON.stringify(filesystem)).not.toMatch(/secret|token|credential-value/iu);
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
