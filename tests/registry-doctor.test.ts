import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { doctorRegistryFile, type RegistryDoctorReport } from "../src/core/index.js";

const fixtures = fileURLToPath(new URL("./fixtures/registries/", import.meta.url));
const fixture = (name: string): string => join(fixtures, `${name}.registry.json`);

describe("registry doctor", () => {
  const temporaryDirectories: string[] = [];

  afterAll(async () => {
    await Promise.all(temporaryDirectories.map(async (directory) => {
      await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
    }));
  });

  async function tempdir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "capykit-doctor-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  it("returns a machine-readable report with record-level schema and secret failures without echoing credential contents", async () => {
    const directory = await tempdir();
    const registryPath = join(directory, "secret.registry.json");
    const secretValue = "Bearer should-not-appear-in-report";
    const document = JSON.parse(await readFile(fixture("builtin"), "utf8")) as Record<string, unknown>;
    document.registry = { id: "secret-fixture", name: "Secret fixture", homepage: secretValue };
    await writeFile(registryPath, JSON.stringify(document), "utf8");

    const report = await doctorRegistryFile(registryPath, { now: () => new Date("2026-08-15T00:00:00Z") });

    expect(report).toMatchObject<Partial<RegistryDoctorReport>>({
      format: "capykit.registryDoctor.v0.1",
      ok: false,
      checkedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(report.records).toHaveLength(1);
    expect(report.records[0]).toMatchObject({
      recordType: "registry",
      recordId: "secret.registry.json",
      severity: "error",
      code: "registry.load_failed",
    });
    expect(JSON.stringify(report)).not.toContain(secretValue);
  });

  it("checks executable, documentation, and health declarations using non-destructive mechanisms", async () => {
    const directory = await tempdir();
    const binDirectory = join(directory, "bin");
    await import("node:fs/promises").then(({ mkdir, writeFile: writeExecutable }) =>
      mkdir(binDirectory).then(() => writeExecutable(join(binDirectory, "safe-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })),
    );
    await access(join(binDirectory, "safe-tool"), constants.X_OK);

    const registryPath = join(directory, "doctor.registry.json");
    const document = JSON.parse(await readFile(fixture("builtin"), "utf8")) as Record<string, unknown>;
    const tools = document.tools as Record<string, unknown>[];
    const tool = tools[0] as Record<string, unknown>;
    tool.id = "doctor-tool";
    tool.interfaces = [{ id: "doctor-cli", type: "cli", command: "safe-tool", capabilities: [{ name: "inspect", summary: "Inspect safely." }] }];
    tool.healthChecks = [{ id: "safe-tool-present", kind: "command-available", command: "safe-tool" }];
    tool.documentation = [{ label: "Docs", url: "https://example.com/docs" }];
    await writeFile(registryPath, JSON.stringify(document), "utf8");

    const report = await doctorRegistryFile(registryPath, {
      approvedCommands: ["safe-tool"],
      path: binDirectory,
      now: () => new Date("2026-08-15T00:00:00Z"),
    });

    expect(report.ok).toBe(true);
    expect(report.records.map(({ code, status }) => `${code}:${status}`).sort()).toEqual([
      "documentation.url:pass",
      "executable.available:pass",
      "health.command_available:pass",
      "registry.load:pass",
    ]);
    expect(JSON.stringify(report)).not.toMatch(/TOKEN|SECRET|PASSWORD|should-not/u);
  });

  it("skips unavailable command checks unless the operator allowlist approves the executable", async () => {
    const directory = await tempdir();
    const registryPath = join(directory, "unapproved.registry.json");
    const document = JSON.parse(await readFile(fixture("builtin"), "utf8")) as Record<string, unknown>;
    const tools = document.tools as Record<string, unknown>[];
    const tool = tools[0] as Record<string, unknown>;
    tool.id = "unapproved-tool";
    tool.interfaces = [{ id: "unapproved-cli", type: "cli", command: "missing-tool", capabilities: [{ name: "inspect", summary: "Inspect safely." }] }];
    tool.healthChecks = [{ id: "missing-tool-present", kind: "command-available", command: "missing-tool" }];
    await writeFile(registryPath, JSON.stringify(document), "utf8");

    const report = await doctorRegistryFile(registryPath, { path: [directory, process.env.PATH ?? ""].join(delimiter) });

    expect(report.ok).toBe(true);
    expect(report.records.filter(({ status }) => status === "skipped").map(({ code }) => code).sort()).toEqual([
      "executable.available",
      "health.command_available",
    ]);
  });
});
