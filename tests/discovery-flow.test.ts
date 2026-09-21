import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAsync } from "../src/cli/index.js";
import { loadConfiguredRegistryCatalog, searchRegistryTools, toolCapabilities, type DiscoveryAdapterBundle } from "../src/core/index.js";

const examples = fileURLToPath(new URL("../examples/", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/registries/", import.meta.url));

describe("task discovery through configured sources", () => {
  let directory: string;
  let configPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "capykit-task-discovery-"));
    vi.stubEnv("XDG_CONFIG_HOME", directory);
    configPath = join(directory, "capykit", "registry-sources.json");
    await mkdir(dirname(configPath));
    await writeFile(configPath, JSON.stringify({
      format: "capykit.registrySources.v0.1",
      sources: [{ id: "examples", layer: "user", type: "file", root: examples, path: "all-interfaces.registry.json" }],
      locks: [],
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("finds task keywords across capabilities, API operations, and examples without matching unrelated tasks", async () => {
    const catalog = await loadConfiguredRegistryCatalog();
    for (const [query, id] of [
      ["  JSON   filter ", "jq"], ["CURRENT status", "example-status-api"],
      ["GET /api/status", "example-status-api"], ["sources research", "example-research-skill"],
      ["approved file", "example-filesystem-mcp"], ["local document", "example-indexer"],
      ["list names", "jq"],
    ]) {
      expect(searchRegistryTools(catalog.tools, query as string).map((tool) => tool.id)).toEqual([id]);
    }
    expect(searchRegistryTools(catalog.tools, "json deployment")).toEqual([]);
    expect(searchRegistryTools(catalog.tools, "")).toEqual(catalog.tools);
    const api = catalog.tools.find(({ id }) => id === "example-status-api");
    if (api === undefined) throw new Error("Missing API fixture");
    expect(toolCapabilities(api.record)).toEqual([expect.objectContaining({ name: "get-status", method: "GET", path: "/api/status", usage: "GET https://status.example.com/api/status" })]);
    expect(toolCapabilities({ id: "versioned-api", interfaces: [{ id: "api", type: "api", baseUrl: "https://status.example.com/v1/", operations: [{ id: "status", method: "GET", path: "/status", summary: "Status" }] }] })[0]?.usage).toBe("GET https://status.example.com/v1/status");
  });

  it("searches the default catalog with command checks and returns an explicit empty result for no match", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runAsync(["tools", "search", "json filter", "--json", "--check", "--path", directory])).toBe(0);
    const result = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as unknown;
    expect(result).toMatchObject({ format: "capykit.tools.search.v0.1", count: 1, tools: [{ id: "jq", access: "unverified", availability: { status: "unavailable", reason: "missing_on_path" } }] });
    expect(await runAsync(["tools", "search", "no-such-capability", "--json"])).toBe(0);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({ count: 0, tools: [] });
  });

  it("prints invocation, safety, and authentication details for people", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    for (const [id, expected] of [
      ["jq", "jq -r"], ["example-status-api", "https://status.example.com"],
      ["example-research-skill", "skills/research/SKILL.md"], ["example-indexer", "example-indexer.service"],
    ]) {
      expect(await runAsync(["tools", "show", id as string])).toBe(0);
      const output = String(stdout.mock.calls.at(-1)?.[0]);
      expect(output).toContain(expected);
      expect(output).toContain("authentication:");
      expect(output).toContain("safety:");
      expect(output).toContain("access: unverified");
    }
  });

  it("uses the effective override for search and adapters, with default and explicit configurations", async () => {
    const alternate = join(directory, "alternate.json");
    await writeFile(alternate, JSON.stringify({ format: "capykit.registrySources.v0.1", sources: [
      { id: "builtin", layer: "builtin", type: "file", root: fixtures, path: "builtin.registry.json" },
      { id: "user", layer: "user", type: "file", root: fixtures, path: "user.registry.json", overrides: ["shared-tool"] },
    ], locks: [] }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runAsync(["tools", "search", "user definition", "--config", alternate, "--json"])).toBe(0);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({ count: 1, tools: [{ id: "shared-tool", sourceId: "user" }] });
    expect(await runAsync(["adapters"])).toBe(0);
    expect((JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as DiscoveryAdapterBundle).generatedFrom.toolCount).toBe(5);
    expect(await runAsync(["adapters", "--config", alternate])).toBe(0);
    const bundle = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as DiscoveryAdapterBundle;
    expect(bundle.generatedFrom.toolCount).toBe(1);
    expect(bundle.files[0]?.content).toContain("user definition");
  });

  it("rejects invalid discovery arguments and missing configurations without silently falling back", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const argv of [
      ["tools", "search"], ["tools", "search", " "], ["tools", "search", "json", "--unknown", "yes"],
      ["adapters", join(examples, "all-interfaces.registry.json"), "--config", configPath],
      ["adapters", "--config"], ["adapters", "--unknown", configPath],
    ]) expect(await runAsync(argv)).toBe(2);
    expect(await runAsync(["tools", "search", "json", "--config", join(directory, "absent.json")])).toBe(1);
    expect(await runAsync(["adapters", "--config", join(directory, "absent.json")])).toBe(1);
    vi.stubEnv("XDG_CONFIG_HOME", join(directory, "absent"));
    await expect(loadConfiguredRegistryCatalog()).rejects.toThrow("No registry sources config found");
  });
});
