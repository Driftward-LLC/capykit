import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_NOT_FOUND, EXIT_SUCCESS, EXIT_USAGE, helpText, run } from "../src/cli/index.js";

const fixture = new URL("./fixtures/registries/builtin.registry.json", import.meta.url).pathname;
const examplesFixture = new URL("../examples/all-interfaces.registry.json", import.meta.url).pathname;

afterEach(() => vi.restoreAllMocks());

function capture() {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
  return { stdout: () => stdout, stderr: () => stderr };
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

describe("discovery CLI", () => {
  it("renders documented help and exit codes", () => {
    expect(helpText()).toContain("list                  List discovered tools");
    expect(helpText()).toContain("0 success");
    expect(helpText()).toContain("3 requested command completed but found no matching tool");
  });

  it("rejects unknown commands and cwd-dependent registry paths", async () => {
    await expect(run(["missing"])).rejects.toMatchObject({ exitCode: EXIT_USAGE });
    await expect(run(["list", "--registry", "relative.registry.json"])).rejects.toMatchObject({ exitCode: EXIT_USAGE });
  });

  it("lists tools with deterministic human and JSON output from arbitrary cwd", async () => {
    const originalCwd = process.cwd();
    const otherCwd = await mkdtemp(join(tmpdir(), "capykit-cli-cwd-"));
    process.chdir(otherCwd);
    try {
      const human = capture();
      await expect(run(["list", "--registry", fixture])).resolves.toBe(EXIT_SUCCESS);
      expect(human.stdout()).toBe("shared-tool\tShared tool\tbuiltin definition\n");
      vi.restoreAllMocks();

      const json = capture();
      await expect(run(["list", "--registry", fixture, "--json"])).resolves.toBe(EXIT_SUCCESS);
      const payload = parseJson(json.stdout());
      expect(payload).toMatchObject([{ id: "shared-tool", name: "Shared tool", summary: "builtin definition", source: "cli-001" }]);
      expect(Array.isArray(payload) && Array.isArray((payload[0] as { tags?: unknown }).tags) ? (payload[0] as { tags: string[] }).tags : []).toEqual(expect.arrayContaining(["interfaces.type:cli", "scope.platforms:linux", "capability:inspect"]));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("shows one tool and returns not-found with JSON when absent", async () => {
    const shown = capture();
    await expect(run(["show", "shared-tool", "--registry", fixture])).resolves.toBe(EXIT_SUCCESS);
    expect(shown.stdout()).toContain("shared-tool\n  name: Shared tool");
    vi.restoreAllMocks();

    const missing = capture();
    await expect(run(["show", "missing-tool", "--registry", fixture, "--json"])).resolves.toBe(EXIT_NOT_FOUND);
    expect(parseJson(missing.stdout())).toEqual({ error: "not_found", toolId: "missing-tool" });
  });

  it("prints examples with deterministic JSON support", async () => {
    const human = capture();
    await expect(run(["examples", "jq", "--registry", examplesFixture])).resolves.toBe(EXIT_SUCCESS);
    expect(human.stdout()).toContain("List item names");
    expect(human.stdout()).toContain("interface: jq-cli");
    vi.restoreAllMocks();

    const json = capture();
    await expect(run(["examples", "jq", "--registry", examplesFixture, "--json"])).resolves.toBe(EXIT_SUCCESS);
    expect(parseJson(json.stdout())).toEqual({ toolId: "jq", examples: [{ title: "List item names", interfaceId: "jq-cli", usage: "jq -r '.items[].name' input.json" }] });
  });

  it("searches deterministically by query, field, tag, and capability", async () => {
    const byField = capture();
    await expect(run(["search", "definition", "--registry", fixture, "--field", "status=active"])).resolves.toBe(EXIT_SUCCESS);
    expect(byField.stdout()).toBe("shared-tool\tShared tool\tbuiltin definition\n");
    vi.restoreAllMocks();

    const byTag = capture();
    await expect(run(["search", "--registry", fixture, "--tag", "interface:cli", "--json"])).resolves.toBe(EXIT_SUCCESS);
    const byTagPayload = parseJson(byTag.stdout());
    expect(Array.isArray(byTagPayload) ? byTagPayload.map((tool) => (tool as { id: string }).id) : []).toEqual(["shared-tool"]);
    vi.restoreAllMocks();

    const byCapability = capture();
    await expect(run(["search", "--registry", fixture, "--capability", "inspect"])).resolves.toBe(EXIT_SUCCESS);
    expect(byCapability.stdout()).toContain("shared-tool");
    vi.restoreAllMocks();

    const missing = capture();
    await expect(run(["search", "--registry", fixture, "--capability", "missing-capability", "--json"])).resolves.toBe(EXIT_NOT_FOUND);
    expect(parseJson(missing.stdout())).toEqual([]);
  });
});
