import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadRegistryCatalog,
  registryPath,
  RegistryConflictError,
  RegistryLoadError,
  type RegistrySource,
} from "../src/core/index.js";

const execFileAsync = promisify(execFile);
const fixtures = fileURLToPath(new URL("./fixtures/registries/", import.meta.url));

function fixture(name: string): string {
  return join(fixtures, `${name}.registry.json`);
}

describe.sequential("layered registry loading", () => {
  let temporaryDirectory: string;
  let gitRepository: string;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "capykit-registry-"));
    gitRepository = join(temporaryDirectory, "registry-repository");
    await execFileAsync("git", ["init", "--quiet", gitRepository]);
    await cp(fixture("user"), join(gitRepository, "registry.json"));
    await execFileAsync("git", ["-C", gitRepository, "add", "registry.json"]);
    await execFileAsync("git", [
      "-C", gitRepository,
      "-c", "user.name=Capykit tests",
      "-c", "user.email=capykit-tests@example.invalid",
      "commit", "--quiet", "-m", "Add registry fixture",
    ]);
    await writeFile(join(gitRepository, "registry.json"), "working tree content must not be loaded\n", "utf8");
  });

  afterAll(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function sources(): RegistrySource[] {
    return [
      { id: "builtin", layer: "builtin", type: "file", root: fixtures, path: "builtin.registry.json" },
      { id: "organization", layer: "organization", type: "file", root: fixtures, path: "organization.registry.json", overrides: ["shared-tool"] },
      { id: "host", layer: "host", type: "file", root: fixtures, path: "host.registry.json", overrides: ["shared-tool"] },
      { id: "user", layer: "user", type: "git", repository: gitRepository, revision: "HEAD", path: "registry.json", overrides: ["shared-tool"] },
    ];
  }

  it("loads all layers with fixed precedence and provenance independent of input order", async () => {
    const options = { now: () => new Date("2026-08-04T00:00:00Z") };
    const ascending = await loadRegistryCatalog(sources(), options);
    const descending = await loadRegistryCatalog(sources().reverse(), options);

    expect(ascending.tools).toHaveLength(1);
    expect(ascending.tools[0]?.record.summary).toBe("user definition");
    expect(ascending.tools[0]?.provenance).toMatchObject({ sourceId: "user", layer: "user", trustTier: "operator-approved", registryId: "user-fixture", fetchedAt: "2026-08-04T00:00:00.000Z" });
    expect(ascending.tools[0]?.provenance.sourceUri).toMatch(/revision=[a-f0-9]{40}#registry.json/u);
    expect(ascending.tools[0]?.provenance.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(ascending.sources[0]?.trustTier).toBe("bundled");
    expect(ascending.tools[0]?.overridden.map(({ sourceId }) => sourceId)).toEqual(["builtin", "organization", "host"]);
    expect(ascending.sources.map(({ layer }) => layer)).toEqual(["builtin", "organization", "host", "user"]);
    expect(descending).toEqual(ascending);
  });

  it("requires an explicit override for every conflicting stable tool identity", async () => {
    const conflicting = sources();
    conflicting[1] = { id: "organization", layer: "organization", type: "file", root: fixtures, path: "organization.registry.json" };

    await expect(loadRegistryCatalog(conflicting)).rejects.toMatchObject({
      name: "RegistryConflictError",
      toolId: "shared-tool",
      sourceIds: ["builtin", "organization"],
    });
    await expect(loadRegistryCatalog(conflicting)).rejects.toThrow(/\.overrides to replace it explicitly/u);
  });

  it("rejects ambiguous same-layer collisions", async () => {
    await expect(loadRegistryCatalog([
      { id: "organization-a", layer: "organization", type: "file", root: fixtures, path: "organization.registry.json" },
      { id: "organization-b", layer: "organization", type: "file", root: fixtures, path: "host.registry.json" },
    ])).rejects.toBeInstanceOf(RegistryConflictError);
  });

  it("rejects cwd-dependent local and Git paths with actionable errors", async () => {
    await expect(loadRegistryCatalog([
      { id: "relative-file", layer: "builtin", type: "file", root: "relative-root", path: "registry.json" },
    ])).rejects.toThrow(/must be absolute.*independent of cwd/u);

    await expect(loadRegistryCatalog([
      { id: "relative-git", layer: "user", type: "git", repository: "repo", revision: "HEAD", path: "registry.json" },
    ])).rejects.toBeInstanceOf(RegistryLoadError);

    expect(() => registryPath(fixtures, "../outside.registry.json")).toThrow(/root-relative path/u);
    expect(() => registryPath(fixtures, "..\\outside.registry.json")).toThrow(/root-relative path/u);
  });

  it("rejects local-file symlink escapes from the configured root", async () => {
    const allowedRoot = join(temporaryDirectory, "allowed-root");
    const outsidePath = join(temporaryDirectory, "outside.registry.json");
    const linkedPath = join(allowedRoot, "linked.registry.json");
    await mkdir(allowedRoot);
    await cp(fixture("builtin"), outsidePath);
    try {
      await symlink(outsidePath, linkedPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(loadRegistryCatalog([
      { id: "escaped", layer: "builtin", type: "file", root: allowedRoot, path: "linked.registry.json" },
    ])).rejects.toThrow(/outside its configured root/u);
  });

  it("rejects credential-like content without repeating the value", async () => {
    const sourcePath = join(temporaryDirectory, "credential.registry.json");
    const secretValue = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const document = JSON.parse(await readFile(fixture("builtin"), "utf8")) as Record<string, unknown>;
    document.registry = { id: "credential-fixture", name: "Credential fixture", homepage: secretValue };
    await writeFile(sourcePath, JSON.stringify(document), "utf8");

    try {
      await loadRegistryCatalog([
        { id: "credential", layer: "builtin", type: "file", root: temporaryDirectory, path: "credential.registry.json" },
      ]);
      throw new Error("credential-like content was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryLoadError);
      expect(String(error)).toMatch(/forbidden credential-like material.*\$\/registry\/homepage.*redacted/u);
      expect(String(error)).not.toContain(secretValue);
    }
  });

  it("rejects schema-invalid local registry documents before activation with redacted paths", async () => {
    const sourcePath = join(temporaryDirectory, "missing-required.registry.json");
    const document = JSON.parse(await readFile(fixture("builtin"), "utf8")) as Record<string, unknown>;
    const tools = document.tools as Record<string, unknown>[];
    delete tools[0]?.summary;
    await writeFile(sourcePath, JSON.stringify(document), "utf8");

    await expect(loadRegistryCatalog([
      { id: "missing-required", layer: "builtin", type: "file", root: temporaryDirectory, path: "missing-required.registry.json" },
    ])).rejects.toThrow(/missing-required.*registry\.schema\.json.*\/tools\/0\/summary.*required.*redacted/u);
  });

  it("rejects unknown unnamespaced registry properties before activation", async () => {
    const sourcePath = join(temporaryDirectory, "unknown-property.registry.json");
    const document = JSON.parse(await readFile(fixture("builtin"), "utf8")) as Record<string, unknown>;
    document.notNamespaced = "must be rejected without echoing this value";
    await writeFile(sourcePath, JSON.stringify(document), "utf8");

    await expect(loadRegistryCatalog([
      { id: "unknown-property", layer: "builtin", type: "file", root: temporaryDirectory, path: "unknown-property.registry.json" },
    ])).rejects.toThrow(/unknown-property.*registry\.schema\.json.*\/notNamespaced.*additional properties.*redacted/u);
    await expect(loadRegistryCatalog([
      { id: "unknown-property", layer: "builtin", type: "file", root: temporaryDirectory, path: "unknown-property.registry.json" },
    ])).rejects.not.toThrow(/must be rejected without echoing this value/u);
  });

  it("rejects unsupported health check kinds including shell", async () => {
    const sourcePath = join(temporaryDirectory, "unsupported-health.registry.json");
    const document = JSON.parse(await readFile(fixture("builtin"), "utf8")) as Record<string, unknown>;
    const tools = document.tools as Record<string, unknown>[];
    const firstTool = tools[0];
    if (firstTool === undefined) throw new Error("fixture must include a tool");
    firstTool.healthChecks = [{ id: "unsafe-shell", kind: "shell", command: "exit 0" }];
    await writeFile(sourcePath, JSON.stringify(document), "utf8");

    await expect(loadRegistryCatalog([
      { id: "unsupported-health", layer: "builtin", type: "file", root: temporaryDirectory, path: "unsupported-health.registry.json" },
    ])).rejects.toThrow(/unsupported-health.*registry\.schema\.json.*\/tools\/0\/healthChecks\/0.*redacted/u);
  });

  it("rejects schema-invalid Git registry documents before activation", async () => {
    const document = JSON.parse(await readFile(fixture("user"), "utf8")) as Record<string, unknown>;
    const tools = document.tools as Record<string, unknown>[];
    delete tools[0]?.owners;
    await writeFile(join(gitRepository, "invalid.registry.json"), JSON.stringify(document), "utf8");
    await execFileAsync("git", ["-C", gitRepository, "add", "invalid.registry.json"]);
    await execFileAsync("git", [
      "-C", gitRepository,
      "-c", "user.name=Capykit tests",
      "-c", "user.email=capykit-tests@example.invalid",
      "commit", "--quiet", "-m", "Add schema-invalid registry fixture",
    ]);

    await expect(loadRegistryCatalog([
      { id: "invalid-git", layer: "user", type: "git", repository: gitRepository, revision: "HEAD", path: "invalid.registry.json" },
    ])).rejects.toThrow(/invalid-git.*registry\.schema\.json.*\/tools\/0\/owners.*required.*redacted/u);
  });

  it("rejects malformed source metadata at the loader boundary", async () => {
    await expect(loadRegistryCatalog([
      { id: "invalid-layer", layer: "remote", type: "file", root: fixtures, path: "builtin.registry.json" } as unknown as RegistrySource,
    ])).rejects.toThrow(/unsupported layer/u);
    await expect(loadRegistryCatalog([
      { id: "invalid-type", layer: "builtin", type: "https" } as unknown as RegistrySource,
    ])).rejects.toThrow(/unsupported type/u);
  });

  it("enforces semantic references after sources are combined", async () => {
    const sourcePath = join(temporaryDirectory, "semantic.registry.json");
    const document = JSON.parse(await readFile(fixture("builtin"), "utf8")) as Record<string, unknown>;
    const tools = document.tools as Record<string, unknown>[];
    const tool = tools[0] as Record<string, unknown>;
    tool.relationships = [{ type: "related-to", target: "missing-tool" }];
    await writeFile(sourcePath, JSON.stringify(document), "utf8");

    await expect(loadRegistryCatalog([
      { id: "semantic", layer: "builtin", type: "file", root: temporaryDirectory, path: "semantic.registry.json" },
    ])).rejects.toThrow(/relationship.*missing catalog tool/u);
  });

  it("rejects duplicate interface IDs within one tool", async () => {
    const sourcePath = join(temporaryDirectory, "duplicate-interface.registry.json");
    const document = JSON.parse(await readFile(fixture("builtin"), "utf8")) as Record<string, unknown>;
    const tools = document.tools as Record<string, unknown>[];
    const tool = tools[0] as Record<string, unknown>;
    const interfaces = tool.interfaces as Record<string, unknown>[];
    tool.interfaces = [interfaces[0], { ...interfaces[0] }];
    await writeFile(sourcePath, JSON.stringify(document), "utf8");

    await expect(loadRegistryCatalog([
      { id: "duplicate-interface", layer: "builtin", type: "file", root: temporaryDirectory, path: "duplicate-interface.registry.json" },
    ])).rejects.toMatchObject({ name: "RegistryConflictError", toolId: "shared-tool" });
  });
});
