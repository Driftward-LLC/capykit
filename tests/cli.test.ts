import { afterEach, describe, expect, it, vi } from "vitest";
import { completionText, helpText, run, runAsync } from "../src/cli/index.js";
import { CAPYKIT_VERSION } from "../src/core/index.js";

afterEach(() => vi.restoreAllMocks());

describe("CLI scaffold", () => {
  it("renders help", () => {
    expect(helpText()).toContain("Usage: capykit <command>");
  });

  it("rejects unknown commands", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(run(["missing"])).toBe(2);
    expect(stderr).toHaveBeenCalled();
  });

  it.each(["version", "--version", "-v"])("prints deterministic version for %s", (command) => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(run([command])).toBe(0);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith(`${CAPYKIT_VERSION}\n`);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("prints documented JSON usage for doctor", () => {
    expect(helpText()).toContain("doctor <registry.json>");
    expect(helpText()).toContain("capykit.registryDoctor.v0.1");
  });

  it.each(["bash", "zsh", "fish"])("prints %s shell completions", (shell) => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(run(["completion", shell])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(completionText(shell));
    expect(completionText(shell)).toContain("capykit");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("rejects unsupported completion shells", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(run(["completion", "powershell"])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage: capykit completion <bash|zsh|fish>"));
  });

  it("rejects doctor without a registry path", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(run(["doctor"])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage: capykit doctor <registry.json>"));
  });

  it.each([
    ["--json", "--paths", "SENSITIVE_ARGUMENT"],
    ["--json", "--path", "/one", "--path", "/two"],
    ["--json", "unexpected"],
    ["--json", "--path"],
    [],
  ])("rejects invalid discovery options without inspecting the default host: %j", async (...options) => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await runAsync(["discover", "host", ...options])).toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage: capykit discover host --json [--path <path>] [--allow-codex-auth]\n"));
  });

  it("reports discovery format support without inspecting host metadata", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runAsync(["discover", "host", "--format-version"])).toBe(0);
    expect(stdout).toHaveBeenCalledExactlyOnceWith("2\n");
    expect(stderr).not.toHaveBeenCalled();
  });
});
