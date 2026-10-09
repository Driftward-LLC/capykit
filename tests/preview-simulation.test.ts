import { afterEach, describe, expect, it } from "vitest";
import { ConnectionError } from "../src/hosted/connections.js";
import { loadPreviewSimulation, previewSimulationConsentPage, simulatedProviderJson } from "../src/hosted/preview-simulation.js";

afterEach(() => { delete process.env.CAPYKIT_PREVIEW_SIMULATED_PROVIDERS; });

describe("isolated preview provider simulation", () => {
  it("is off by default and fails closed for mixed live provider configuration", () => {
    expect(loadPreviewSimulation({}, "https://capykit.example.test", {})).toBeUndefined();
    expect(() => loadPreviewSimulation({ CAPYKIT_PREVIEW_SIMULATED_PROVIDERS: "true" }, "https://capykit.example.test", { github: {} })).toThrow(ConnectionError);
    expect(() => loadPreviewSimulation({ CAPYKIT_PREVIEW_SIMULATED_PROVIDERS: "yes" }, "https://capykit.example.test", {})).toThrow(ConnectionError);
  });

  it("uses plainly labelled same-origin consent and deterministic provider data", async () => {
    process.env.CAPYKIT_PREVIEW_SIMULATED_PROVIDERS = "true";
    const simulation = loadPreviewSimulation(process.env, "https://capykit.example.test", {});
    expect(simulation?.githubProvider.authorizationUrl("A".repeat(43))).toBe("https://capykit.example.test/v1/preview/simulated/github/consent?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(previewSimulationConsentPage("github", "A".repeat(43))).toContain("not a real GitHub login");

    const setup = await simulation?.githubProvider.candidates();
    expect(setup?.[0]?.repositories.map(repo => repo.fullName)).toEqual(["capykit-simulated/preview-repo", "capykit-simulated/empty-repo"]);
    expect(simulatedProviderJson("https://api.github.com/repositories/101", { headers: { authorization: "Bearer simulated-github:101" } })).toEqual({ id: 101, full_name: "capykit-simulated/preview-repo" });
    expect(simulatedProviderJson("https://www.googleapis.com/drive/v3/files/file_preview?supportsAllDrives=true", { headers: { authorization: "Bearer simulated-google-access" } })).toMatchObject({ id: "file_preview", name: "Simulated planning brief" });
  });
});
