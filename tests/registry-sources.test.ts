import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectRegistrySources, syncRegistrySources } from "../src/core/index.js";
import { runAsync } from "../src/cli/index.js";

const execFileAsync = promisify(execFile);
const fixtures = fileURLToPath(new URL("./fixtures/registries/", import.meta.url));

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe.sequential("registry source management", () => {
  let temporaryDirectory: string;
  let configPath: string;
  let gitRepository: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "capykit-sources-"));
    configPath = join(temporaryDirectory, "registry-sources.json");
    gitRepository = join(temporaryDirectory, "registry-repository");
    await execFileAsync("git", ["init", "--quiet", gitRepository]);
    await cp(join(fixtures, "user.registry.json"), join(gitRepository, "registry.json"));
    await execFileAsync("git", ["-C", gitRepository, "add", "registry.json"]);
    await execFileAsync("git", ["-C", gitRepository, "-c", "user.name=Capykit tests", "-c", "user.email=capykit-tests@example.invalid", "commit", "--quiet", "-m", "Add registry fixture"]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("adds, inspects, synchronizes, and removes an approved local file source", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runAsync(["sources", "add", "--config", configPath, "--id", "local.fixture", "--layer", "host", "--file-root", fixtures, "--file-path", "builtin.registry.json"])).resolves.toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    let config: { sources: Array<{ id?: string; type?: string }>; locks: Array<{ sourceId?: string; revision?: string; sha256?: string }> } = await readJson(configPath) as { sources: Array<{ id?: string; type?: string }>; locks: Array<{ sourceId?: string; revision?: string; sha256?: string }> };
    expect(config.sources).toEqual([expect.objectContaining({ id: "local.fixture", type: "file" })]);
    expect(config.locks[0]?.sourceId).toBe("local.fixture");
    expect(config.locks[0]?.revision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(config.locks[0]?.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);

    await expect(runAsync(["sources", "inspect", "--config", configPath])).resolves.toBe(0);
    const inspectOutput = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? "")) as { precedence: Array<{ toolId: string; sourceId: string }> };
    expect(inspectOutput.precedence).toEqual([{ toolId: "shared-tool", sourceId: "local.fixture", layer: "host", revision: config.locks[0]?.revision, sha256: config.locks[0]?.sha256, overridden: [] }]);

    await expect(runAsync(["sources", "sync", "--config", configPath, "--id", "local.fixture", "--offline"])).resolves.toBe(0);
    await expect(runAsync(["sources", "remove", "--config", configPath, "--id", "local.fixture"])).resolves.toBe(0);
    config = await readJson(configPath) as { sources: Array<{ id?: string; type?: string }>; locks: Array<{ sourceId?: string; revision?: string; sha256?: string }> };
    expect(config.sources).toEqual([]);
    expect(config.locks).toEqual([]);
  });

  it("locks Git sources to immutable commits and inspects effective precedence", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runAsync(["sources", "add", "--config", configPath, "--id", "builtin.fixture", "--layer", "builtin", "--file-root", fixtures, "--file-path", "builtin.registry.json"])).resolves.toBe(0);
    await expect(runAsync(["sources", "add", "--config", configPath, "--id", "git.fixture", "--layer", "user", "--git-repository", gitRepository, "--git-revision", "HEAD", "--git-path", "registry.json", "--override", "shared-tool"])).resolves.toBe(0);

    const inspection = await inspectRegistrySources(configPath);
    const gitSource = inspection.sources.find(({ id }) => id === "git.fixture");
    expect(gitSource?.lock?.revision).toMatch(/^[a-f0-9]{40}$/u);
    expect(inspection.precedence).toEqual([expect.objectContaining({ toolId: "shared-tool", sourceId: "git.fixture", layer: "user", overridden: ["builtin.fixture"] })]);
  });

  it("uses last known-good cached HTTP source bytes for deterministic offline sync", async () => {
    const cachePath = join(temporaryDirectory, "sources", "remote.fixture.registry.json");
    await mkdir(dirname(cachePath), { recursive: true });
    await cp(join(fixtures, "builtin.registry.json"), cachePath);
    await writeFile(configPath, `${JSON.stringify({
      format: "capykit.registrySources.v0.1",
      sources: [{ id: "remote.fixture", layer: "organization", type: "http", url: "https://registry.example.com/capykit/registry.json" }],
      locks: [{ sourceId: "remote.fixture", sourceUri: "https://registry.example.com/capykit/registry.json", sha256: "sha256:pending", fetchedAt: "2026-08-04T00:00:00.000Z", revision: "sha256:pending", cachePath: "sources/remote.fixture.registry.json" }],
    }, null, 2)}\n`, "utf8");

    const result = await syncRegistrySources({ configPath, offline: true, now: () => new Date("2026-08-05T00:00:00Z") });
    expect(result.updated).toHaveLength(1);
    expect(result.catalog.tools.map(({ id }) => id)).toEqual(["shared-tool"]);
  });
});

describe.sequential("default registry source discovery CLI", () => {
  let temporaryDirectory: string;
  let originalCwd: string;
  let originalHome: string | undefined;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    temporaryDirectory = await mkdtemp(join(tmpdir(), "capykit-default-sources-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function writeSourcesConfig(configPath: string, registryFile = "builtin.registry.json"): Promise<void> {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      format: "capykit.registrySources.v0.1",
      sources: [{ id: "default.fixture", layer: "user", type: "file", root: fixtures, path: registryFile }],
      locks: [],
    }, null, 2)}\n`, "utf8");
  }

  it("resolves the default XDG registry sources config for tools list from any cwd", async () => {
    const xdgHome = join(temporaryDirectory, "xdg");
    const configPath = join(xdgHome, "capykit", "registry-sources.json");
    await writeSourcesConfig(configPath);
    process.env.XDG_CONFIG_HOME = xdgHome;
    process.chdir(tmpdir());
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runAsync(["tools", "list"])).resolves.toBe(0);

    const output = String(stdout.mock.calls.at(-1)?.[0] ?? "");
    expect(stderr).not.toHaveBeenCalled();
    expect(output).toContain("shared-tool");
    expect(output).toContain("shared");
    expect(output).toContain("builtin definition");
  });

  it("treats capykit tools as a short alias for listing tools", async () => {
    const xdgHome = join(temporaryDirectory, "xdg");
    await writeSourcesConfig(join(xdgHome, "capykit", "registry-sources.json"));
    process.env.XDG_CONFIG_HOME = xdgHome;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runAsync(["tools"])).resolves.toBe(0);

    expect(String(stdout.mock.calls.at(-1)?.[0] ?? "")).toContain("shared-tool");
  });

  it("falls back to the home-directory config path when XDG_CONFIG_HOME is unset", async () => {
    const home = join(temporaryDirectory, "home");
    process.env.HOME = home;
    const homeConfigPath = join(home, ".config", "capykit", "registry-sources.json");
    await writeSourcesConfig(homeConfigPath);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runAsync(["tools", "list", "--json"])).resolves.toBe(0);

    const output = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? "")) as { configPath: string; tools: Array<{ id: string; command: string; summary: string }> };
    expect(output.configPath).toBe(homeConfigPath);
    expect(output.tools).toEqual([expect.objectContaining({ id: "shared-tool", command: "shared", summary: "builtin definition" })]);
  });

  it("lets explicit --config override the default config path", async () => {
    const xdgHome = join(temporaryDirectory, "xdg");
    await writeSourcesConfig(join(xdgHome, "capykit", "registry-sources.json"), "builtin.registry.json");
    const overridePath = join(temporaryDirectory, "override", "registry-sources.json");
    await writeSourcesConfig(overridePath, "user.registry.json");
    process.env.XDG_CONFIG_HOME = xdgHome;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runAsync(["tools", "list", "--config", overridePath, "--json"])).resolves.toBe(0);

    const output = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? "")) as { configPath: string; tools: Array<{ summary: string }> };
    expect(output.configPath).toBe(overridePath);
    expect(output.tools).toEqual([expect.objectContaining({ summary: "user definition" })]);
  });

  it("reports a missing default config instead of returning an empty catalog", async () => {
    process.env.XDG_CONFIG_HOME = join(temporaryDirectory, "missing-xdg");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runAsync(["tools", "list"])).resolves.toBe(1);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("No registry sources config found"));
  });

  it("uses the default config for sources inspect when --config is omitted", async () => {
    const xdgHome = join(temporaryDirectory, "xdg");
    const configPath = join(xdgHome, "capykit", "registry-sources.json");
    await writeSourcesConfig(configPath);
    process.env.XDG_CONFIG_HOME = xdgHome;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runAsync(["sources", "inspect"])).resolves.toBe(0);

    const output = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? "")) as { precedence: Array<{ toolId: string }> };
    expect(output.precedence).toEqual([expect.objectContaining({ toolId: "shared-tool" })]);
  });
});
