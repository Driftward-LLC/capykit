import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAsync } from "../src/cli/index.js";
import { discoverHostRegistry, doctorRegistryFile } from "../src/core/index.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "capykit-discovery-"));
  directories.push(path);
  return path;
}

async function writeExecutable(directory: string, name: string): Promise<void> {
  await writeFile(join(directory, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

const emptyMcp = "No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n";
const stdioHeader = "Name  Command  Args  Env  Cwd  Status  Auth       \n";
const httpHeader = "Name  Url  Bearer Token Env Var  Status  Auth        \n";

function metadata(outputs: Record<string, string>) {
  return vi.fn((command: string, args: readonly string[]) => {
    const stdout = outputs[args.join(" ")];
    if (stdout === undefined) throw new Error(`unexpected codex command: ${command}`);
    return Promise.resolve({ stdout, stderr: "" });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("host registry discovery", () => {
  it("does not launch Codex or resolve its authentication without explicit opt-in", async () => {
    const path = await directory();
    await writeExecutable(path, "codex");
    const execFile = vi.fn(() => { throw new Error("Codex must not run"); });
    const registry = await discoverHostRegistry({ path, execFile });
    expect(registry.tools.map(({ id }) => id)).toEqual(["codex-cli"]);
    expect(registry.extensions).toMatchObject({ "x-codex-metadata-status": "not-requested" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects partial plugin inventories signaled only through stderr", async () => {
    const path = await directory();
    await writeExecutable(path, "codex");
    const execFile = vi.fn((_command: string, args: readonly string[]) => Promise.resolve(args[0] === "mcp"
      ? { stdout: emptyMcp, stderr: "" }
      : { stdout: '{"installed":[],"available":[]}', stderr: "Warning: failed to list remote marketplace plugins: AUTH_SENTINEL" }));
    const error: unknown = await discoverHostRegistry({ path, allowCodexAuth: true, execFile }).catch((error: unknown) => error);
    expect(error).toMatchObject({ message: "Codex metadata discovery failed; the registry was not generated." });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("SENTINEL");
  });

  it("discovers executable symlinks, uses the selected Codex binary, and emits a valid private-value-free registry", async () => {
    const root = await directory();
    const binDirectory = join(root, "bin");
    await mkdir(binDirectory);
    await Promise.all([
      writeExecutable(root, "codex-target"),
      writeExecutable(binDirectory, "alpha-tool"),
      writeExecutable(binDirectory, "openseo-env"),
      writeExecutable(binDirectory, "browserbase-env"),
      writeFile(join(binDirectory, "not-executable"), "data", { mode: 0o644 }),
      mkdir(join(binDirectory, "not-a-command")),
    ]);
    await Promise.all([
      symlink(join(root, "codex-target"), join(binDirectory, "codex")),
      symlink(join(binDirectory, "not-a-command"), join(binDirectory, "directory-link")),
      symlink(join(binDirectory, "missing"), join(binDirectory, "broken-link")),
      symlink(join(binDirectory, "not-executable"), join(binDirectory, "non-executable-link")),
    ]);
    const execFile = metadata({
      "mcp list": `${stdioHeader}filesystem  npx  ARG_VALUE_SENTINEL  FILE_TOKEN=*****  -  enabled  Unsupported\n\n${httpHeader}linear  https://example.test/PATH_VALUE_SENTINEL?key=URL_VALUE_SENTINEL  LINEAR_API_KEY  enabled  Bearer token\n`,
      "mcp get filesystem": "filesystem\n  enabled: true\n  transport: stdio\n  command: COMMAND_VALUE_SENTINEL\n  args: ARG_VALUE_SENTINEL --api-key VALUE_IS_NOT_A_REFERENCE\n  cwd: /fixture-root\n  env: FILE_TOKEN=*****, APP_SECRET=*****, APP_PASSWORD=*****\n",
      "mcp get linear": "linear\n  enabled: true\n  transport: streamable_http\n  url: https://USER_VALUE_SENTINEL:PASS_VALUE_SENTINEL@example.test/PATH_VALUE_SENTINEL?key=URL_VALUE_SENTINEL#HASH_VALUE_SENTINEL\n  bearer_token_env_var: LINEAR_API_KEY\n  http_headers: Authorization=*****\n  env_http_headers: X-Client-Secret=CLIENT_SECRET, X-Cookie=SESSION_COOKIE\n",
      "plugin list --json": JSON.stringify({
        installed: [
          { pluginId: "driftward-review@local", name: "driftward-review", installed: true, enabled: true, source: { url: "https://example.test/PLUGIN_SOURCE_SENTINEL" } },
          { pluginId: "disabled@local", installed: true, enabled: false },
        ],
        available: [{ pluginId: "uninstalled@local", installed: false, enabled: false }],
      }),
    });
    const registry = await discoverHostRegistry({
      path: binDirectory,
      hostname: "fixture-host",
      now: () => new Date("2026-09-11T00:00:00Z"),
      allowCodexAuth: true,
      execFile,
    });

    expect(registry.registry).toMatchObject({ id: "fixture-host-generated", name: "Generated host registry for fixture-host" });
    expect(registry.extensions).toMatchObject({ "x-generated-source": "live-host-discovery", "x-host-discovery-version": 2 });
    expect(registry.tools.map((tool) => tool.id)).toEqual([
      "alpha-tool-cli", "browserbase-env-cli", "codex-cli", "codex-mcp-filesystem", "codex-mcp-linear", `codex-plugin-driftward-review-local-${createHash("sha256").update("driftward-review@local").digest("hex").slice(0, 12)}`, "openseo-env-cli",
    ]);
    expect(execFile.mock.calls.every(([command]) => command === join(binDirectory, "codex"))).toBe(true);
    expect(execFile.mock.calls.map(([, args]) => args)).toEqual([
      ["mcp", "list"], ["mcp", "get", "filesystem"], ["mcp", "get", "linear"], ["plugin", "list", "--json"],
    ]);
    const filesystem = registry.tools.find((tool) => tool.id === "codex-mcp-filesystem");
    const linear = registry.tools.find((tool) => tool.id === "codex-mcp-linear");
    expect(filesystem?.authentication).toMatchObject({ requirements: [{ references: [
      { kind: "environment", name: "APP_PASSWORD" }, { kind: "environment", name: "APP_SECRET" }, { kind: "environment", name: "FILE_TOKEN" },
    ] }] });
    expect(linear?.authentication).toMatchObject({ requirements: [{ references: [
      { kind: "environment", name: "CLIENT_SECRET" }, { kind: "environment", name: "LINEAR_API_KEY" }, { kind: "environment", name: "SESSION_COOKIE" },
    ] }] });
    expect(filesystem?.extensions).toMatchObject({ "x-codex-mcp-transport": "stdio" });
    expect(linear?.extensions).toMatchObject({ "x-codex-mcp-transport": "http", "x-codex-mcp-server-name": "linear" });
    expect(linear?.interfaces).toMatchObject([{ id: "codex", type: "cli", command: "codex" }]);
    expect(linear?.safety).toMatchObject({ risk: "executes-code", approval: "always" });
    expect(JSON.stringify(registry)).not.toMatch(/SENTINEL|VALUE_IS_NOT_A_REFERENCE|fixture-root|example\.test/u);

    const registryPath = join(root, "generated.registry.json");
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    const report = await doctorRegistryFile(registryPath, {
      approvedCommands: ["alpha-tool", "browserbase-env", "codex", "openseo-env"],
      path: binDirectory,
      now: () => new Date("2026-09-11T00:00:00Z"),
    });
    expect(report.ok).toBe(true);
  });

  it("prints JSON from capykit discover host --json without executing discovered commands", async () => {
    const path = await directory();
    await writeExecutable(path, "example-tool");
    const execFile = vi.fn(() => { throw new Error("PATH discovery must not execute commands"); });
    await expect(discoverHostRegistry({ path, allowCodexAuth: true, execFile })).resolves.toMatchObject({ tools: [{ id: "example-tool-cli" }] });
    expect(execFile).not.toHaveBeenCalled();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runAsync(["discover", "host", "--json", "--path", path])).resolves.toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0] ?? ""))).toMatchObject({ schemaVersion: "0.1.0", tools: [{ id: "example-tool-cli" }] });
  });

  it("recognizes empty metadata and omits disabled MCP and plugin configurations", async () => {
    const path = await directory();
    await writeExecutable(path, "codex");
    const execFile = metadata({ "mcp list": emptyMcp, "plugin list --json": '{"installed":[],"available":[]}' });
    await expect(discoverHostRegistry({ path, allowCodexAuth: true, execFile })).resolves.toMatchObject({ tools: [{ id: "codex-cli" }] });
    expect(execFile).toHaveBeenCalledTimes(2);
    const disabled = metadata({
      "mcp list": `${stdioHeader}disabled  node  -  -  -  disabled: policy  Unsupported\n`,
      "mcp get disabled": "disabled (disabled: policy)\n",
      "plugin list --json": '{"installed":[{"pluginId":"disabled@local","installed":true,"enabled":false}]}',
    });
    const registry = await discoverHostRegistry({ path, allowCodexAuth: true, execFile: disabled });
    expect(registry.tools.map(({ id }) => id)).toEqual(["codex-cli"]);
  });

  it.each(["", "Warning: unexpected output\n", "filesystem\n", '[{"name":"filesystem","env":{"API_KEY":"VALUE_SENTINEL"}}]'])("rejects unrecognized MCP list output without turning it into tools: %j", async (output) => {
      const path = await directory();
      await writeExecutable(path, "codex");
      const execFile = metadata({ "mcp list": output });
      await expect(discoverHostRegistry({ path, allowCodexAuth: true, execFile })).rejects.toThrow("Unsupported Codex metadata; the registry was not generated.");
      expect(execFile).toHaveBeenCalledTimes(1);
    });

  it.each([
    "sample\n  enabled: true\n  transport: stdio\n  env: API_KEY=VALUE_SENTINEL\n",
    '{"name":"sample","transport":{"type":"stdio","env":{"API_KEY":"VALUE_SENTINEL"}}}',
    "sample\n  enabled: true\n  transport: stdio\n  env: INJECTED_SECRET=*****\n  env: -\n",
    "sample\n  enabled: true\n  transport: stdio\n  env: lowercase=*****\n",
  ])("rejects unmasked or ambiguous MCP details without echoing them", async (output) => {
    const path = await directory();
    await writeExecutable(path, "codex");
    await expect(discoverHostRegistry({ path, allowCodexAuth: true, execFile: metadata({
      "mcp list": `${stdioHeader}sample  node  -  -  -  enabled  Unsupported\n`,
      "mcp get sample": output,
    }) })).rejects.toThrow(/^Unsupported Codex metadata; the registry was not generated\.$/u);
  });

  it.each(["Warning: plugin list unsupported", '[{"name":"bogus"}]', '{"installed":[{"pluginId":"bogus","installed":false,"enabled":true}]}'])("rejects unsupported plugin metadata instead of inventing installed tools", async (output) => {
      const path = await directory();
      await writeExecutable(path, "codex");
      await expect(discoverHostRegistry({ path, allowCodexAuth: true, execFile: metadata({ "mcp list": emptyMcp, "plugin list --json": output }) }))
        .rejects.toThrow("Unsupported Codex metadata; the registry was not generated.");
    });

  it("fails metadata commands without leaking their stdout, stderr, or error cause", async () => {
    const path = await directory();
    await writeExecutable(path, "codex");
    const execFile = vi.fn(() => Promise.reject(Object.assign(new Error("VALUE_SENTINEL"), { stdout: "VALUE_SENTINEL", stderr: "VALUE_SENTINEL" })));
    const error = await discoverHostRegistry({ path, allowCodexAuth: true, execFile }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "Codex metadata discovery failed; the registry was not generated." });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("VALUE_SENTINEL");
  });

  it("preserves distinct tools after normalization and keeps long identifiers schema-valid", async () => {
    const path = await directory();
    const longName = "long".repeat(55);
    await Promise.all([writeExecutable(path, "Some-Tool"), writeExecutable(path, "some-tool"), writeExecutable(path, longName)]);
    const registry = await discoverHostRegistry({ path, hostname: longName });
    expect(registry.tools).toHaveLength(3);
    expect(new Set(registry.tools.map(({ id }) => id)).size).toBe(3);
    expect(registry.tools.some(({ id }) => id === "some-tool-cli")).toBe(true);
    expect(registry.tools.some(({ id }) => /^some-tool-[a-f0-9]{12}-cli$/u.test(id))).toBe(true);
    expect(registry.tools.map(({ id }) => id)).toEqual((await discoverHostRegistry({ path, hostname: longName })).tools.map(({ id }) => id));
    const registryPath = join(path, "registry.json");
    await writeFile(registryPath, JSON.stringify(registry));
    expect((await doctorRegistryFile(registryPath, { path, approvedCommands: ["Some-Tool", "some-tool", longName] })).ok).toBe(true);
  });

  it("returns a failing CLI exit with no partial JSON when Codex metadata is unsupported", async () => {
    const path = await directory();
    await writeFile(join(path, "codex"), "#!/bin/sh\nprintf 'UNSUPPORTED_METADATA_SENTINEL\\n'\n", { mode: 0o755 });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runAsync(["discover", "host", "--json", "--path", path, "--allow-codex-auth"])).resolves.toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(String(stderr.mock.calls[0]?.[0])).not.toContain("SENTINEL");
  });
});
