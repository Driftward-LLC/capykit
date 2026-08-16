import { afterEach, describe, expect, it, vi } from "vitest";
import { helpText, run } from "../src/cli/index.js";
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
});
