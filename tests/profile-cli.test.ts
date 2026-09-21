import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runAsync } from "../src/cli/index.js";
import { loadConfiguredRegistryCatalog } from "../src/core/sources.js";

const bundle = fileURLToPath(new URL("../examples/portable-toolkit/", import.meta.url));
const profile = join(bundle, "profile.json");

describe("portable profile CLI", () => {
  let directory: string;
  let configPath: string;
  let skillsDirectory: string;
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;
  const readOutput = () => stdout.mock.calls.map(([chunk]) => String(chunk)).join("");

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "capykit-profile-cli-"));
    configPath = join(directory, "configuration", "registry-sources.json");
    skillsDirectory = join(directory, "agent-skills");
    vi.stubEnv("XDG_CONFIG_HOME", join(directory, "xdg"));
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("inspects explicit destinations as JSON without creating configuration or installing files", async () => {
    expect(await runAsync(["profile", "inspect", profile, "--config", configPath, "--skills-dir", skillsDirectory, "--path", "", "--json"])).toBe(0);

    expect(JSON.parse(readOutput()) as unknown).toMatchObject({
      format: "capykit.profilePlan.v0.1", configPath,
      profile: { id: "portable-toolkit", version: "1.0.0" },
      skills: [{ id: "json-review", destination: join(skillsDirectory, "json-review") }],
      tools: [
        { command: "node", availability: { status: "unavailable" }, access: "unverified" },
        { command: "prettier", availability: { status: "unavailable" }, access: "unverified" },
      ],
      npm: { packages: ["prettier@3.9.8"] },
      mcp: { command: "capykit-mcp", args: ["--config", configPath] },
    });
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(skillsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(directory, "configuration"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("applies the example registry and complete skill to explicit destinations without installing npm tools", async () => {
    expect(await runAsync(["profile", "apply", profile, "--config", configPath, "--skills-dir", skillsDirectory, "--json"])).toBe(0);

    expect(JSON.parse(readOutput()) as unknown).toMatchObject({ applied: true, dependenciesInstalled: false, configPath });
    const catalog = await loadConfiguredRegistryCatalog(configPath);
    expect(catalog.tools.map(({ id }) => id)).toEqual(["json-review", "prettier"]);
    expect(catalog.tools[0]?.record.interfaces).toEqual([expect.objectContaining({ location: join(skillsDirectory, "json-review", "SKILL.md") })]);
    expect(catalog.tools.every(({ provenance }) => provenance.sourceId === "profile.portable-toolkit")).toBe(true);
    for (const file of ["SKILL.md", "scripts/check-json.mjs"]) {
      expect(await readFile(join(skillsDirectory, "json-review", file), "utf8")).toBe(await readFile(join(bundle, "skills", "json-review", file), "utf8"));
    }
    await expect(access(join(directory, "configuration", "profile-tools"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("uses XDG configuration and bundled skill locations when destination flags are omitted", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", join(directory, "xdg"));
    const expectedConfig = join(directory, "xdg", "capykit", "registry-sources.json");
    const expectedSkill = join(directory, "xdg", "capykit", "profiles", "portable-toolkit", "1.0.0", "bundle", "skills", "json-review", "SKILL.md");

    expect(await runAsync(["profile", "apply", profile, "--json"])).toBe(0);

    expect(JSON.parse(readOutput()) as unknown).toMatchObject({ applied: true, configPath: expectedConfig });
    const catalog = await loadConfiguredRegistryCatalog();
    expect(catalog.tools[0]?.record.interfaces).toEqual([expect.objectContaining({ location: expectedSkill })]);
    expect(await readFile(expectedSkill, "utf8")).toBe(await readFile(join(bundle, "skills", "json-review", "SKILL.md"), "utf8"));
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints usable source, skill, dependency, and MCP connection guidance", async () => {
    expect(await runAsync(["profile", "inspect", profile, "--config", configPath, "--skills-dir", skillsDirectory])).toBe(0);

    const output = readOutput();
    expect(output).toContain("installation plan");
    expect(output).toContain(`Sources: ${configPath}`);
    expect(output).toContain(`Skill json-review: ${join(skillsDirectory, "json-review")}`);
    expect(output).toContain("Pinned dependencies (--install-tools): prettier@3.9.8");
    expect(output).toContain(`Capykit MCP connection: ${JSON.stringify({ command: "capykit-mcp", args: ["--config", configPath] })}`);
    expect(output).toContain("version and access unverified");
  });

  it("rejects invalid actions, missing values, unknown or repeated options, and installation during inspect", async () => {
    const invalid = [
      ["remove", profile], ["apply"], ["inspect", profile, "--config"],
      ["inspect", profile, "--unknown", "value"], ["inspect", profile, "--install-tools"],
      ["apply", profile, "--config", configPath, "--config", configPath],
      ["inspect", profile, "--config", ""], ["inspect", profile, "--skills-dir", ""],
    ];
    for (const args of invalid) {
      expect(await runAsync(["profile", ...args]), JSON.stringify(args)).toBe(2);
    }
    expect(stderr).toHaveBeenCalledTimes(invalid.length);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("capykit profile inspect <profile.json>"));
    expect(stdout).not.toHaveBeenCalled();
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the bundled JSON validator successfully and rejects malformed JSON without changing input", async () => {
    const script = join(bundle, "skills", "json-review", "scripts", "check-json.mjs");
    const valid = join(directory, "valid.json");
    const invalid = join(directory, "invalid.json");
    await writeFile(valid, '{"ok":true}\n');
    await writeFile(invalid, "{invalid\n");

    const success = spawnSync(process.execPath, [script, valid], { encoding: "utf8", timeout: 5000 });
    const failure = spawnSync(process.execPath, [script, invalid], { encoding: "utf8", timeout: 5000 });

    expect(success.status).toBe(0);
    expect(success.stdout).toContain(`${valid}: valid JSON`);
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("invalid JSON (contents omitted)");
    expect(await readFile(valid, "utf8")).toBe('{"ok":true}\n');
    expect(await readFile(invalid, "utf8")).toBe("{invalid\n");
  });
});
