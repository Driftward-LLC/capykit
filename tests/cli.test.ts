import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_NOT_FOUND, EXIT_SUCCESS, EXIT_USAGE, helpText, run } from "../src/cli/index.js";

const fixture = fileURLToPath(new URL("./fixtures/registries/builtin.registry.json", import.meta.url));
const examplesFixture = fileURLToPath(new URL("../examples/all-interfaces.registry.json", import.meta.url));

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

  it("rejects unknown commands, invalid arity, command-specific filters, and cwd-dependent registry paths", async () => {
    await expect(run(["missing"])).rejects.toMatchObject({ exitCode: EXIT_USAGE });
    await expect(run(["list", "unexpected-tool-id"])).rejects.toMatchObject({ exitCode: EXIT_USAGE });
    await expect(run(["show", "shared-tool", "extra-tool-id"])).rejects.toMatchObject({ exitCode: EXIT_USAGE });
    await expect(run(["examples", "shared-tool", "--tag", "interface:cli"])).rejects.toMatchObject({ exitCode: EXIT_USAGE });
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
      expect(payload).toMatchObject([{ id: "shared-tool", name: "Shared tool", summary: "builtin definition" }]);
      const first = Array.isArray(payload) ? payload[0] as { source?: unknown; tags?: unknown } : {};
      expect(first.source).toMatch(/^cli-user-[a-f0-9]{16}$/u);
      expect(Array.isArray(first.tags) ? first.tags : []).toEqual(expect.arrayContaining(["interfaces.type:cli", "scope.platforms:linux", "capability:inspect"]));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("derives stable source IDs and accepts explicit registry layers independent of argument order", async () => {
    const firstOrder = capture();
    await expect(run(["list", "--registry", `builtin=${fixture}`, "--registry", `user=${examplesFixture}`, "--json"])).resolves.toBe(EXIT_SUCCESS);
    const firstPayload = parseJson(firstOrder.stdout());
    vi.restoreAllMocks();

    const secondOrder = capture();
    await expect(run(["list", "--registry", `user=${examplesFixture}`, "--registry", `builtin=${fixture}`, "--json"])).resolves.toBe(EXIT_SUCCESS);
    const secondPayload = parseJson(secondOrder.stdout());
    expect(secondPayload).toEqual(firstPayload);
    const shared = Array.isArray(firstPayload) ? firstPayload.find((tool) => (tool as { id?: string }).id === "shared-tool") as { source?: unknown } | undefined : undefined;
    expect(shared?.source).toMatch(/^cli-builtin-[a-f0-9]{16}$/u);
  });

  it("shows one tool and returns not-found with JSON when absent", async () => {
    const shown = capture();
    await expect(run(["show", "shared-tool", "--registry", fixture])).resolves.toBe(EXIT_SUCCESS);
    expect(shown.stdout()).toContain("shared-tool\n  name: Shared tool");
    expect(shown.stdout()).toContain("authentication:");
    expect(shown.stdout()).toContain("capabilities");
    expect(shown.stdout()).toContain("provenance:");
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
