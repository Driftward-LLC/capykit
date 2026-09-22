import { access, chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEnvironmentProfile, inspectEnvironmentProfile } from "../src/core/profiles.js";
import { addRegistrySource, loadConfiguredRegistryCatalog } from "../src/core/sources.js";
import type { EnvironmentProfile } from "../src/core/profile-schema.js";
import type { RegistryDocument } from "../src/core/registry.js";

const fixtures = fileURLToPath(new URL("./fixtures/registries/", import.meta.url));
const script = "#!/bin/sh\nprintf 'research fixture\\n'\n";
const reference = "Verify the original sources before writing a summary.\n";
const asset = Buffer.from([0, 1, 127, 128, 255]);

describe("portable environment profiles", () => {
  let directory: string;
  let bundle: string;
  let profilePath: string;
  let profile: EnvironmentProfile;
  let registry: RegistryDocument;
  let configPath: string;

  async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "capykit-profile-flow-"));
    bundle = join(directory, "portable-bundle");
    profilePath = join(bundle, "profile.json");
    configPath = join(directory, "environment-a", "capykit", "registry-sources.json");
    profile = {
      format: "capykit.environmentProfile.v0.1", id: "portable-kit", version: "1.0.0", name: "Portable research kit", registry: "registry/tools.json",
      skills: [{ id: "research", path: "skills/research" }],
      tools: [{ command: "portable-tool", npm: { package: "fixture-cli", version: "1.2.3" } }],
      connections: [{ id: "workspace", summary: "Read research documents", instructions: "Sign in to the workspace in this environment." }],
    };
    const fixture = JSON.parse(await readFile(join(fixtures, "builtin.registry.json"), "utf8")) as RegistryDocument;
    const base = fixture.tools[0];
    if (base === undefined) throw new Error("Missing registry fixture tool");
    registry = { ...fixture, tools: [
      { ...base, id: "portable-tool", name: "Portable tool", summary: "Read source documents", interfaces: [{ id: "portable-cli", type: "cli", command: "portable-tool", capabilities: [{ name: "read", summary: "Read source documents" }] }] },
      { ...base, id: "portable-research", name: "Portable research", summary: "Research a topic", interfaces: [{ id: "research-skill", type: "skill", format: "agents-skill", location: "skills/research/SKILL.md", capabilities: [{ name: "research", summary: "Research a topic using source documents" }] }] },
    ] };
    await writeJson(profilePath, profile);
    await writeJson(join(bundle, profile.registry), registry);
    for (const folder of ["scripts", "references", "assets"]) await mkdir(join(bundle, "skills", "research", folder), { recursive: true });
    await writeFile(join(bundle, "skills", "research", "SKILL.md"), "---\nname: research\ndescription: Research a topic using verified sources.\n---\nRead references/guide.md and run scripts/check.sh.\n");
    await writeFile(join(bundle, "skills", "research", "scripts", "check.sh"), script, { mode: 0o755 });
    await writeFile(join(bundle, "skills", "research", "references", "guide.md"), reference);
    await writeFile(join(bundle, "skills", "research", "assets", "fixture.bin"), asset);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("inspects without writing, then applies the same portable bundle in two independent environments", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", join(directory, "environment-a"));
    const copiedBundle = join(directory, "copied-bundle");
    await cp(bundle, copiedBundle, { recursive: true });
    const plan = await inspectEnvironmentProfile(profilePath, { path: directory });
    expect(plan).toMatchObject({ configPath, tools: [{ command: "portable-tool", availability: { status: "unavailable" }, version: "unverified", access: "unverified" }], connections: [{ status: "manual-setup" }] });
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(plan.directory)).rejects.toMatchObject({ code: "ENOENT" });

    for (const [index, source] of [profilePath, join(copiedBundle, "profile.json")].entries()) {
      const destinationConfig = index === 0 ? configPath : join(directory, "environment-b", "registry-sources.json");
      const skillsDirectory = join(dirname(destinationConfig), "agent-skills");
      const options = { ...(index === 0 ? {} : { configPath: destinationConfig }), skillsDirectory, path: directory };
      const result = await applyEnvironmentProfile(source, options);
      expect(result).toMatchObject({ applied: true, dependenciesInstalled: false, profile: { digest: plan.profile.digest } });
      const skillRoot = join(skillsDirectory, "research");
      expect(await readFile(join(skillRoot, "scripts", "check.sh"), "utf8")).toBe(script);
      expect(await readFile(join(skillRoot, "references", "guide.md"), "utf8")).toBe(reference);
      expect(await readFile(join(skillRoot, "assets", "fixture.bin"))).toEqual(asset);
      if (process.platform !== "win32") expect((await stat(join(skillRoot, "scripts", "check.sh"))).mode & 0o100).toBe(0o100);
      const catalog = await loadConfiguredRegistryCatalog(index === 0 ? undefined : destinationConfig);
      expect(catalog.tools.map(({ id }) => id)).toEqual(["portable-research", "portable-tool"]);
      expect(catalog.tools[0]?.record.interfaces).toEqual([expect.objectContaining({ location: join(skillRoot, "SKILL.md") })]);
      expect(catalog.tools.every(({ provenance }) => provenance.sourceId === "profile.portable-kit")).toBe(true);
      const repeated = await applyEnvironmentProfile(source, options);
      expect(repeated.profile.digest).toBe(result.profile.digest);
      expect((await loadConfiguredRegistryCatalog(destinationConfig)).sources).toHaveLength(1);
    }
  });

  it("refuses changed bytes for an installed version and preserves the active catalog and skills", async () => {
    const result = await applyEnvironmentProfile(profilePath, { configPath, path: directory });
    const previousConfig = await readFile(configPath, "utf8");
    await writeFile(join(bundle, "skills", "research", "references", "guide.md"), "Changed source guidance\n");

    await expect(applyEnvironmentProfile(profilePath, { configPath, path: directory })).rejects.toThrow(/different bytes|new profile version/u);

    expect(await readFile(configPath, "utf8")).toBe(previousConfig);
    const installedSkill = result.skills[0];
    if (installedSkill === undefined) throw new Error("Missing installed skill");
    expect(await readFile(join(installedSkill.destination, "references", "guide.md"), "utf8")).toBe(reference);
    expect((await loadConfiguredRegistryCatalog(configPath)).tools).toHaveLength(2);
  });

  it("does not overwrite an existing conflicting skill or change the previous catalog", async () => {
    await addRegistrySource({ configPath, source: { id: "existing", layer: "user", type: "file", root: fixtures, path: "builtin.registry.json" } });
    const previousConfig = await readFile(configPath, "utf8");
    const skillsDirectory = join(directory, "agent-skills");
    const existingSkill = join(skillsDirectory, "research", "SKILL.md");
    await mkdir(dirname(existingSkill), { recursive: true });
    await writeFile(existingSkill, "Operator-owned skill\n");

    await expect(applyEnvironmentProfile(profilePath, { configPath, skillsDirectory, path: directory })).rejects.toThrow(/already exists with different files/u);

    expect(await readFile(existingSkill, "utf8")).toBe("Operator-owned skill\n");
    expect(await readFile(configPath, "utf8")).toBe(previousConfig);
    expect((await loadConfiguredRegistryCatalog(configPath)).tools.map(({ id }) => id)).toEqual(["shared-tool"]);
  });

  it.each(["source-id", "tool-id"])("preserves existing sources when a profile has a %s collision", async (collision) => {
    await addRegistrySource({ configPath, source: { id: collision === "source-id" ? "profile.portable-kit" : "existing", layer: "user", type: "file", root: fixtures, path: "builtin.registry.json" } });
    const previousConfig = await readFile(configPath, "utf8");
    if (collision === "tool-id") await writeJson(join(bundle, profile.registry), { ...registry, tools: [{ ...registry.tools[0], id: "shared-tool" }] });

    await expect(applyEnvironmentProfile(profilePath, { configPath, path: directory })).rejects.toThrow(/another source|conflict|override|duplicate/u);

    expect(await readFile(configPath, "utf8")).toBe(previousConfig);
    expect((await loadConfiguredRegistryCatalog(configPath)).tools.map(({ id }) => id)).toEqual(["shared-tool"]);
  });

  it("keeps the previous profile active after a failed pinned dependency install", async () => {
    const previous = await applyEnvironmentProfile(profilePath, { configPath, path: directory });
    const previousConfig = await readFile(configPath, "utf8");
    await writeJson(profilePath, { ...profile, version: "1.1.0" });
    const execute = vi.fn<(command: string, args: readonly string[]) => Promise<void>>().mockRejectedValue(new Error("private installer failure"));

    await expect(applyEnvironmentProfile(profilePath, { configPath, installTools: true, execFile: execute, path: directory })).rejects.toThrow("Pinned npm dependency installation failed");

    expect(execute).toHaveBeenCalledOnce();
    expect(await readFile(configPath, "utf8")).toBe(previousConfig);
    const active = await loadConfiguredRegistryCatalog(configPath);
    expect(active.tools).toHaveLength(2);
    expect(active.sources[0]?.sourceUri).toContain("/1.0.0/registry.json");
    await expect(access(join(dirname(previous.directory), "1.1.0"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeJson(profilePath, profile);
    await expect(applyEnvironmentProfile(profilePath, { configPath, path: directory })).resolves.toMatchObject({ applied: true });
  });

  it("reports installed commands from the managed npm prefix while keeping access unverified", async () => {
    const plan = await inspectEnvironmentProfile(profilePath, { configPath, path: directory });
    const execute = vi.fn<(command: string, args: readonly string[]) => Promise<void>>().mockImplementation(async () => {
      await mkdir(plan.npm.binPath, { recursive: true });
      await writeFile(join(plan.npm.binPath, process.platform === "win32" ? "portable-tool.cmd" : "portable-tool"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    });

    const result = await applyEnvironmentProfile(profilePath, { configPath, path: directory, installTools: true, execFile: execute });

    expect(execute).toHaveBeenCalledExactlyOnceWith(plan.npm.command, plan.npm.args);
    expect(result).toMatchObject({ applied: true, dependenciesInstalled: true, tools: [{ availability: { status: "available", reason: "present_on_path" }, version: "unverified", access: "unverified" }] });
  });

  it.each(["symlink", "traversal", ".env", "credentials.json", "credential-assignment", "reserved-manifest", "reserved-manifest-case", "reserved-manifest-prefix"])("rejects %s in the bundle before creating environment files", async (unsafe) => {
    const skillRoot = join(bundle, "skills", "research");
    if (unsafe === "symlink") {
      const outside = join(directory, "outside.md");
      await writeFile(outside, "Outside content\n");
      await symlink(outside, join(skillRoot, "references", "external.md"));
    } else if (unsafe.startsWith("reserved-manifest")) {
      const alternatePath = join(bundle, "environment.json");
      await rename(profilePath, alternatePath);
      profilePath = alternatePath;
      const registryPath = unsafe === "reserved-manifest-case" ? "PROFILE.json" : unsafe === "reserved-manifest-prefix" ? "profile.json/registry.json" : "profile.json";
      await writeJson(join(bundle, registryPath), registry);
      await writeJson(profilePath, { ...profile, registry: registryPath });
    } else if (unsafe === "traversal") await writeJson(profilePath, { ...profile, registry: "../outside.json" });
    else if (unsafe === "credential-assignment") await writeFile(join(skillRoot, "references", "private.txt"), `access_token=${"x".repeat(32)}\n`);
    else await writeFile(join(skillRoot, unsafe), "private content\n");

    await expect(inspectEnvironmentProfile(profilePath, { configPath, path: directory })).rejects.toThrow(/symlink|relative|credential|environment files|collid|reserved/u);
    await expect(applyEnvironmentProfile(profilePath, { configPath, path: directory })).rejects.toThrow();
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlink skill destination without writing through it", async () => {
    const elsewhere = join(directory, "elsewhere");
    const skillsDirectory = join(directory, "linked-skills");
    await mkdir(elsewhere);
    await symlink(elsewhere, skillsDirectory, "junction");
    await expect(applyEnvironmentProfile(profilePath, { configPath, skillsDirectory, path: directory })).rejects.toThrow(/symlink/u);
    await expect(access(join(elsewhere, "research"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlink configuration file while preserving its target", async () => {
    const target = join(directory, "operator-config.json");
    await writeJson(target, { format: "capykit.registrySources.v0.1", sources: [], locks: [] });
    const contents = await readFile(target, "utf8");
    await mkdir(dirname(configPath), { recursive: true });
    await symlink(target, configPath);

    await expect(applyEnvironmentProfile(profilePath, { configPath, path: directory })).rejects.toThrow(/symlink/u);

    expect(await readFile(target, "utf8")).toBe(contents);
  });

  it("treats executable mode changes as profile changes", async () => {
    if (process.platform === "win32") return;
    const before = await inspectEnvironmentProfile(profilePath, { configPath, path: directory });
    await chmod(join(bundle, "skills", "research", "scripts", "check.sh"), 0o644);
    const after = await inspectEnvironmentProfile(profilePath, { configPath, path: directory });
    expect(after.profile.digest).not.toBe(before.profile.digest);
  });

  it("reapplies a 512-file bundle and stops before reading a later skill beyond the shared limit", async () => {
    const skillRoot = join(bundle, "skills", "research");
    for (let index = 0; index < 506; index += 1) await writeFile(join(skillRoot, `file-${String(index)}.txt`), "");
    const options = { configPath, path: directory };
    await expect(applyEnvironmentProfile(profilePath, options)).resolves.toMatchObject({ applied: true });
    await expect(applyEnvironmentProfile(profilePath, options)).resolves.toMatchObject({ applied: true });

    const extra = join(bundle, "skills", "extra");
    await mkdir(extra);
    await writeFile(join(extra, "SKILL.md"), "---\nname: extra\ndescription: Extra skill.\n---\n");
    await writeFile(join(extra, "z-private.txt"), `access_token=${"x".repeat(32)}\n`);
    await writeJson(profilePath, { ...profile, skills: [...profile.skills, { id: "extra", path: "skills/extra" }] });

    // The old per-skill budget reached the credential sentinel before checking the total.
    await expect(inspectEnvironmentProfile(profilePath, options)).rejects.toThrow(/512-file/u);
  }, 30_000);

  it("reapplies a 32 MiB bundle including generated snapshot metadata and rejects one extra byte", async () => {
    const fileLimit = 8 * 1024 * 1024;
    const bundleLimit = 32 * 1024 * 1024;
    const firstTool = registry.tools[0];
    if (firstTool === undefined) throw new Error("Missing registry fixture tool");
    const originalRegistrySize = (await stat(join(bundle, profile.registry))).size;
    const padding = "x".repeat(fileLimit - originalRegistrySize);
    await writeJson(join(bundle, profile.registry), { ...registry, tools: [{ ...firstTool, summary: `${String(firstTool.summary)}${padding}` }, ...registry.tools.slice(1)] });
    expect((await stat(join(bundle, profile.registry))).size).toBe(fileLimit);

    const existingPaths = ["profile.json", profile.registry, "skills/research/SKILL.md", "skills/research/scripts/check.sh", "skills/research/references/guide.md", "skills/research/assets/fixture.bin"];
    const existingSizes = await Promise.all(existingPaths.map(async (path) => (await stat(join(bundle, path))).size));
    let remaining = bundleLimit - existingSizes.reduce((total, size) => total + size, 0);
    let lastAsset = "";
    let lastSize = 0;
    for (let index = 0; remaining > 0; index += 1) {
      lastAsset = join(bundle, "skills", "research", "assets", `large-${String(index)}.bin`);
      lastSize = Math.min(fileLimit, remaining);
      await writeFile(lastAsset, Buffer.alloc(lastSize));
      remaining -= lastSize;
    }
    const options = { configPath, path: directory };
    const installed = await applyEnvironmentProfile(profilePath, options);
    expect((await stat(join(installed.directory, "registry.json"))).size).toBeGreaterThan(fileLimit);
    await expect(applyEnvironmentProfile(profilePath, options)).resolves.toMatchObject({ applied: true });

    await writeFile(lastAsset, Buffer.alloc(lastSize + 1));
    await expect(inspectEnvironmentProfile(profilePath, options)).rejects.toThrow(/33554432-byte/u);
  }, 30_000);

  it("reapplies skills at the accepted nesting limit after adding snapshot parent directories", async () => {
    const nested = join(bundle, "skills", "research", ...Array.from({ length: 32 }, (_, index) => `d${String(index)}`));
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "guide.txt"), "Nested guidance\n");
    const options = { configPath, path: directory };
    await expect(applyEnvironmentProfile(profilePath, options)).resolves.toMatchObject({ applied: true });
    await expect(applyEnvironmentProfile(profilePath, options)).resolves.toMatchObject({ applied: true });
  });
});
