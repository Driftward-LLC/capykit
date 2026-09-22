import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProfileDependencies, profileNpmInstallPlan } from "../src/core/profile-install.js";
import { parseEnvironmentProfile, type EnvironmentProfile } from "../src/core/profile-schema.js";

function profile(tools: EnvironmentProfile["tools"] = []): EnvironmentProfile {
  return parseEnvironmentProfile({ format: "capykit.environmentProfile.v0.1", id: "test-tools", version: "1.0.0", name: "Test tools", registry: "registry/tools.json", tools });
}

describe("pinned profile dependency installation", () => {
  let directory: string;
  let prefix: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "capykit-profile-install-"));
    prefix = join(directory, "managed");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("plans exact pinned packages and installs into a private prefix with lifecycle scripts disabled", async () => {
    const config = profile([
      { command: "capykit", npm: { package: "@driftward/capykit", version: "0.1.1" } },
      { command: "capykit-mcp", npm: { package: "@driftward/capykit", version: "0.1.1" } },
      { command: "jq", instructions: "Install jq using your operating system package manager." },
      { command: "fixture", npm: { package: "fixture-cli", version: "1.2.3-beta.1" } },
    ]);
    const plan = profileNpmInstallPlan(config, prefix);
    const expectedArgs = ["install", "--prefix", prefix, "--global=false", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--package-lock=true", "--bin-links=true", "@driftward/capykit@0.1.1", "fixture-cli@1.2.3-beta.1"];
    expect(plan.packages).toEqual(["@driftward/capykit@0.1.1", "fixture-cli@1.2.3-beta.1"]);
    expect(plan.binPath).toBe(join(prefix, "node_modules", ".bin"));
    expect(plan.args.slice(process.platform === "win32" ? 1 : 0)).toEqual(expectedArgs);
    if (process.platform !== "win32") expect(plan.command).toBe("npm");
    const execute = vi.fn<(command: string, args: readonly string[]) => Promise<void>>().mockImplementation(async () => {
      expect(JSON.parse(await readFile(join(prefix, "package.json"), "utf8"))).toEqual({ private: true });
      await writeFile(join(prefix, "package-lock.json"), "fixture-lock\n");
    });

    await installProfileDependencies(config, prefix, { execFile: execute });

    expect(execute).toHaveBeenCalledExactlyOnceWith(plan.command, plan.args);
    expect(await readFile(join(prefix, "package-lock.json"), "utf8")).toBe("fixture-lock\n");
    if (process.platform !== "win32") {
      expect((await stat(prefix)).mode & 0o777).toBe(0o700);
      expect((await stat(join(prefix, "package.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("does not execute npm or create a prefix when tools have only manual instructions", async () => {
    const config = profile([{ command: "jq", instructions: "Install jq." }]);
    const execute = vi.fn<(command: string, args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);

    expect(profileNpmInstallPlan(config, prefix).packages).toEqual([]);
    await installProfileDependencies(config, prefix, { execFile: execute });

    expect(execute).not.toHaveBeenCalled();
    await expect(access(prefix)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["latest", "^1.2.3", "1.2", "https://example.com/package.tgz"])("rejects an unpinned dependency %s before invoking npm", async (version) => {
    const config = { ...profile(), tools: [{ command: "fixture", npm: { package: "fixture-cli", version } }] };
    const execute = vi.fn<(command: string, args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);

    expect(() => profileNpmInstallPlan(config, prefix)).toThrow();
    await expect(installProfileDependencies(config, prefix, { execFile: execute })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await expect(access(prefix)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts subprocess failures without retaining captured stdout, stderr, or causes", async () => {
    const config = profile([{ command: "fixture", npm: { package: "fixture-cli", version: "1.2.3" } }]);
    const execute = vi.fn<(command: string, args: readonly string[]) => Promise<void>>().mockRejectedValue(Object.assign(new Error("private-command-output"), { stdout: "private-stdout", stderr: "private-stderr" }));

    const error = await installProfileDependencies(config, prefix, { execFile: execute }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Pinned npm dependency installation failed");
    expect(String(error)).not.toContain("private-");
    expect(error).not.toHaveProperty("cause");
  });

  it("preserves an existing package.json and package-lock.json", async () => {
    await mkdir(prefix);
    const manifest = '{"private":true,"description":"Existing managed environment"}\n';
    await writeFile(join(prefix, "package.json"), manifest);
    await writeFile(join(prefix, "package-lock.json"), "existing-lock\n");
    const execute = vi.fn<(command: string, args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);

    await installProfileDependencies(profile([{ command: "fixture", npm: { package: "fixture-cli", version: "1.2.3" } }]), prefix, { execFile: execute });

    expect(await readFile(join(prefix, "package.json"), "utf8")).toBe(manifest);
    expect(await readFile(join(prefix, "package-lock.json"), "utf8")).toBe("existing-lock\n");
  });

  it("rejects relative prefixes and symlink destinations before invoking npm", async () => {
    const config = profile([{ command: "fixture", npm: { package: "fixture-cli", version: "1.2.3" } }]);
    const execute = vi.fn<(command: string, args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    expect(() => profileNpmInstallPlan(config, "relative-directory")).toThrow("absolute managed prefix");
    const target = join(directory, "elsewhere");
    await mkdir(target);
    await symlink(target, prefix, "junction");
    await expect(installProfileDependencies(config, prefix, { execFile: execute })).rejects.toThrow("not a symlink");
    await rm(prefix);
    await mkdir(prefix);
    const manifest = join(target, "package.json");
    await writeFile(manifest, "{}\n");
    await symlink(manifest, join(prefix, "package.json"));
    await expect(installProfileDependencies(config, prefix, { execFile: execute })).rejects.toThrow("not a symlink");
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(manifest, "utf8")).toBe("{}\n");
  });

  it("uses Node with the bundled npm CLI on Windows and fails actionably when it is missing", async () => {
    const config = profile([{ command: "fixture", npm: { package: "fixture-cli", version: "1.2.3" } }]);
    const nodePath = join(directory, "node.exe");
    const npmCli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(dirname(npmCli), { recursive: true });
    await writeFile(npmCli, "");
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalExecutable = Object.getOwnPropertyDescriptor(process, "execPath");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      Object.defineProperty(process, "execPath", { value: nodePath });
      const plan = profileNpmInstallPlan(config, prefix);
      expect(plan.command).toBe(nodePath);
      expect(plan.args[0]).toBe(npmCli);
      await rm(npmCli);
      expect(() => profileNpmInstallPlan(config, prefix)).not.toThrow();
      await expect(installProfileDependencies(config, prefix)).rejects.toThrow("manual installation required");
      expect(profileNpmInstallPlan(profile(), prefix).packages).toEqual([]);
    } finally {
      if (originalPlatform !== undefined) Object.defineProperty(process, "platform", originalPlatform);
      if (originalExecutable !== undefined) Object.defineProperty(process, "execPath", originalExecutable);
    }
  });

  it("rejects lockfile and dependency-directory symlinks before npm can write outside its prefix", async () => {
    const config = profile([{ command: "fixture", npm: { package: "fixture-cli", version: "1.2.3" } }]);
    const execute = vi.fn<(command: string, args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    await mkdir(prefix);
    const outside = join(directory, "outside.json");
    await writeFile(outside, "preserve\n");
    for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
      await symlink(outside, join(prefix, name));
      await expect(installProfileDependencies(config, prefix, { execFile: execute })).rejects.toThrow("must not be symlinks");
      await rm(join(prefix, name));
    }
    await symlink(directory, join(prefix, "node_modules"), "junction");
    await expect(installProfileDependencies(config, prefix, { execFile: execute })).rejects.toThrow("must not be symlinks");
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(outside, "utf8")).toBe("preserve\n");
  });
});
