import { describe, expect, it } from "vitest";
import { normalizeQuery, searchCapabilities } from "../src/core/index.js";
const capabilities = [{ id: "gh", name: "GitHub CLI", description: "Manage GitHub repositories" }, { id: "linear", name: "Linear", description: "Track engineering work" }] as const;
describe("core capability search", () => {
  it("normalizes user queries", () => { expect(normalizeQuery("  GitHub  ")).toBe("github"); });
  it("searches stable public fields", () => { expect(searchCapabilities(capabilities, "engineering")).toEqual([capabilities[1]]); expect(searchCapabilities(capabilities, "")).toEqual(capabilities); });
});