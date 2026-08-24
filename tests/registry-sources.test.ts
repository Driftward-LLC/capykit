import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addRegistrySource, inspectRegistrySources, removeRegistrySource, syncRegistrySources, type RegistrySourceConfig } from "../src/core/index.js";
import { runAsync } from "../src/cli/index.js";

const execFileAsync = promisify(execFile);
const fixtures = fileURLToPath(new URL("./fixtures/registries/", import.meta.url));
const fixture = (name: string): string => join(fixtures, `${name}.registry.json`);

describe.sequential("registry source management", () => {
  let temporaryDirectory: string;
  let configPath: string;
  let gitRepository: string;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "capykit-sources-"));
    configPath = join(temporaryDirectory, "sources.json");
    gitRepository = join(temporaryDirectory, "registry-repository");
    await execFileAsync("git", ["init", "--quiet", gitRepository]);
    await cp(fixture("user"), join(gitRepository, "registry.json"));
    await execFileAsync("git", ["-C", gitRepository, "add", "registry.json"]);
    await execFileAsync("git", ["-C", gitRepository, "-c", "user.name=Capykit tests", "-c", "user.email=capykit-tests@example.invalid", "commit", "--quiet", "-m", "Add registry fixture"]);
  });

  afterAll(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("adds, syncs, inspects, and removes local sources with atomic config writes", async () => {
    await addRegistrySource(configPath, { id: "builtin-local", type: "local", layer: "builtin", root: fixtures, path: "builtin.registry.json" });
    const synced = await syncRegistrySources(configPath, { now: () => new Date("2026-08-24T00:00:00Z") });

    expect(synced.sources[0]).toMatchObject({ id: "builtin-local", lock: { syncedAt: "2026-08-24T00:00:00.000Z" } });
    expect(JSON.stringify(await readFile(configPath, "utf8"))).not.toContain(".tmp");

    const inspection = await inspectRegistrySources(configPath);
    expect(inspection.precedence).toEqual([expect.objectContaining({ id: "builtin-local", layer: "builtin", rank: 0, locked: true })]);
    expect(inspection.catalog?.tools.map(({ id }) => id)).toEqual(["shared-tool"]);

    const removed = await removeRegistrySource(configPath, "builtin-local");
    expect(removed.sources).toEqual([]);
  });

  it("locks Git sources to immutable commits for deterministic offline behavior", async () => {
    await addRegistrySource(configPath, { id: "git-user", type: "git", layer: "user", repository: gitRepository, revision: "HEAD", path: "registry.json" });
    const synced = await syncRegistrySources(configPath, { now: () => new Date("2026-08-24T00:00:00Z") });
    const source = synced.sources[0];

    expect(source).toMatchObject({ id: "git-user", type: "git" });
    expect(source?.lock?.revision).toMatch(/^[a-f0-9]{40}$/u);
    expect(source?.lock?.sourceUri).toContain("git+file:");
    await removeRegistrySource(configPath, "git-user");
  });

  it("caches HTTPS sources so offline sync reuses approved bytes", async () => {
    const content = await readFile(fixture("builtin"), "utf8");
    const server = createServer((request, response) => {
      if (request.url === "/registry.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(content);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP test server");

    try {
      await expect(addRegistrySource(configPath, { id: "http-registry", type: "http", layer: "organization", url: `http://127.0.0.1:${String(address.port)}/registry.json` })).rejects.toThrow(/HTTPS/u);
      const config: RegistrySourceConfig = {
        format: "capykit.registrySources.v0.1",
        sources: [{ id: "cached-http", type: "http", layer: "organization", url: "https://registry.example.test/registry.json", cachePath: "cache/cached.registry.json" }],
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      await mkdir(join(temporaryDirectory, "cache"));
      await writeFile(join(temporaryDirectory, "cache", "cached.registry.json"), content, "utf8");
      const synced = await syncRegistrySources(configPath, { offline: true, now: () => new Date("2026-08-24T00:00:00Z") });
      expect(synced.sources[0]?.lock?.sourceUri).toContain("cached.registry.json");
    } finally {
      server.close();
    }
  });

  it("exposes registry source commands through the async CLI", async () => {
    const cliConfig = join(temporaryDirectory, "cli-sources.json");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runAsync(["registry", "source", "add", "local", "cli-local", "--layer", "builtin", "--root", fixtures, "--path", "builtin.registry.json", "--config", cliConfig])).toBe(0);
      expect(await runAsync(["registry", "source", "sync", "--config", cliConfig])).toBe(0);
      expect(await runAsync(["registry", "source", "inspect", "--config", cliConfig])).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("capykit.registrySources.inspect.v0.1"));
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
