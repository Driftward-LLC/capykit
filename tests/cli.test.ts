import { afterEach, describe, expect, it, vi } from "vitest";
import { helpText, run } from "../src/cli/index.js";
afterEach(() => vi.restoreAllMocks());
describe("CLI scaffold", () => {
  it("renders help", () => { expect(helpText()).toContain("Usage: capykit <command>"); });
  it("rejects unknown commands", () => { const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true); expect(run(["missing"])).toBe(2); expect(stderr).toHaveBeenCalled(); });
});