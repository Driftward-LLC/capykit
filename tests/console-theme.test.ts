import { afterEach, describe, expect, it, vi } from "vitest";
import { readAppearance, saveAppearance } from "../src/console/theme.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("appearance preference is non-sensitive and optional", () => {
  it("accepts only documented light/dark/system modes", () => {
    for (const value of [null, "system", "invalid", "light", "dark"]) {
      vi.stubGlobal("localStorage", { getItem: vi.fn(() => value) });
      expect(readAppearance()).toBe(value === "light" || value === "dark" ? value : "system");
    }
  });
  it("persists only appearance and stays usable when storage throws", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    saveAppearance("dark");
    expect(setItem).toHaveBeenCalledExactlyOnceWith("capykit.appearance", "dark");
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("Storage denied"); },
      setItem: () => { throw new Error("Storage denied"); },
    });
    expect(readAppearance()).toBe("system");
    expect(() => { saveAppearance("light"); }).not.toThrow();
  });
});
