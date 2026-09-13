import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { runAsync } from "../src/cli/index.js";
import { discoverHostRegistry, doctorRegistryFile } from "../src/core/index.js";

async function writeExecutable(directory: string, name: string): Promise<void> {
  await writeFile(join(directory, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

describe("host registry discovery", () => {
  it("emits a valid host registry from PATH commands, Codex MCP servers, Codex plugins, and bootstrap helpers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capykit-discovery-"));
    const binDirectory = join(directory, "bin");
    await mkdir(binDirectory);
    await Promise.all([
      writeExecutable(binDirectory, "alpha-tool"),
      writeExecutable(binDirectory, "codex"),
      writeExecutable(binDirectory, "openseo-env"),
      writeExecutable(binDirectory, "browserbase-env"),
    ]);

    const registry = await discoverHostRegistry({
      path: binDirectory,
      hostname: "fixture-host",
      now: () => new Date("2026-09-11T00:00:00Z"),
      execFile: (command, args) => {
        if (command !== "codex") throw new Error(`unexpected command: ${command}`);
        if (args.join(" ") === "mcp list") return Promise.resolve({ stdout: "filesystem\nlinear\n", stderr: "" });
        if (args.join(" ") === "mcp get filesystem") return Promise.resolve({ stdout: "Command: npx @modelcontextprotocol/server-filesystem /fixture-root\n", stderr: "" });
        if (args.join(" ") === "mcp get linear") return Promise.resolve({ stdout: '{"command":"linear-mcp","env":["LINEAR_API_KEY"]}', stderr: "" });
        if (args.join(" ") === "plugin list") return Promise.resolve({ stdout: "driftward-review\n", stderr: "" });
        throw new Error(`unexpected codex args: ${args.join(" ")}`);
      },
    });

    expect(registry.schemaVersion).toBe("0.1.0");
    expect(registry.registry).toMatchObject({ id: "fixture-host-generated", name: "Generated host registry for fixture-host" });
    expect((registry.extensions as Record<string, unknown> | undefined)?.["x-generated-source"]).toBe("live-host-discovery");
    expect(registry.tools.map((tool) => tool.id)).toEqual([
      "alpha-tool-cli",
      "browserbase-env-cli",
      "codex-cli",
      "codex-mcp-filesystem",
      "codex-mcp-linear",
      "codex-plugin-driftward-review",
      "openseo-env-cli",
    ]);

    const linear = registry.tools.find((tool) => tool.id === "codex-mcp-linear");
    expect(linear?.authentication).toEqual({
      mode: "required",
      requirements: [{
        id: "codex-mcp-linear-auth",
        type: "api-key",
        description: "Discovered credential references only; credential values are never read or emitted.",
        references: [{ kind: "environment", name: "LINEAR_API_KEY" }],
      }],
    });
    expect(JSON.stringify(registry)).not.toContain("secret");
    expect(JSON.stringify(registry)).not.toContain("/fixture-root");

    const registryPath = join(directory, "generated.registry.json");
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    const report = await doctorRegistryFile(registryPath, {
      approvedCommands: ["alpha-tool", "browserbase-env", "codex", "linear-mcp", "openseo-env"],
      path: binDirectory,
      now: () => new Date("2026-09-11T00:00:00Z"),
    });
    expect(report.ok).toBe(true);
  });

  it("prints JSON from capykit discover host --json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capykit-discovery-cli-"));
    await writeExecutable(directory, "example-tool");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runAsync(["discover", "host", "--json", "--path", directory])).resolves.toBe(0);

    expect(stderr).not.toHaveBeenCalled();
    const output = String(stdout.mock.calls[0]?.[0] ?? "");
    const registry = JSON.parse(output) as { schemaVersion?: string; tools?: Array<{ id: string }> };
    expect(registry.schemaVersion).toBe("0.1.0");
    expect(registry.tools?.map(({ id }) => id)).toEqual(["example-tool-cli"]);
  });

  it("does not execute discovered PATH commands while inspecting availability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capykit-discovery-safe-"));
    await writeExecutable(directory, "dangerous-tool");

    const registry = await discoverHostRegistry({
      path: [directory, process.env.PATH ?? ""].join(delimiter),
      hostname: "safe-host",
      execFile: () => { throw new Error("only codex discovery may execute an approved command"); },
    });

    expect(registry.tools.some(({ id }) => id === "dangerous-tool-cli")).toBe(true);
  });
});
