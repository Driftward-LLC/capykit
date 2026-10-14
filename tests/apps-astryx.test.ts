import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeField, PieceDetails } from "../src/console/piece-details.js";
import { PersonalApp } from "../src/console/personal-app.js";
import type { CatalogApp } from "../src/hosted/piece-catalog.js";

const h = React.createElement;
afterEach(() => { vi.unstubAllGlobals(); });

describe("Apps Astryx presentation preserves native and account semantics", () => {
  it("keeps native validation, password privacy and accessible description wiring", () => {
    const html = renderToStaticMarkup(h(NativeField, { label: "API key", description: "Provider credential" },
      h("input", { id: "provider-secret", type: "password", required: true, disabled: true, maxLength: 16000, autoComplete: "off", "aria-describedby": "existing-help" })));
    expect(html).toContain("astryx-field");
    expect(html).toContain('for="provider-secret"');
    expect(html).toContain('type="password"');
    expect(html).toContain('required=""');
    expect(html).toContain('disabled=""');
    expect(html).toContain('maxLength="16000"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('aria-describedby="existing-help provider-secret-description"');
  });

  it("retains exact option values and native required selection", () => {
    const html = renderToStaticMarkup(h(NativeField, { label: "User or agent" },
      h("select", { id: "recipient", required: true, value: "agent-id", onChange: () => {} },
        h("option", { value: "" }, "Choose a recipient"), h("option", { value: "agent-id" }, "Same name · agent-id"))));
    expect(html).toContain('for="recipient"');
    expect(html).toContain('<select id="recipient" required=""');
    expect(html).toContain('value="agent-id" selected=""');
  });

  it("uses real catalog components without presenting a catalog entry as connected", () => {
    const app: CatalogApp = { id: "fixture", pieceName: "@activepieces/piece-fixture", name: "Fixture", description: "Catalog fixture only", version: "1.0.0", logoUrl: null, categories: [], actionCount: 2, triggerCount: 1, authentication: ["API key"], deprecated: true, connector: "fixture@1.0.0", supportedInCapykit: false, configured: false, connected: false };
    const html = renderToStaticMarkup(h(PieceDetails, { app }));
    for (const component of ["astryx-card", "astryx-banner", "astryx-button"]) expect(html).toContain(component);
    expect(html).toContain("Available in the catalog, not connected");
    expect(html).toContain("deprecated");
    expect(html).toContain('href="https://www.activepieces.com/pieces/fixture"');
    expect(html).not.toContain("Run action");
  });

  it("keeps personal/shared identities and inactive connection states visible without runnable access", () => {
    const accounts = [
      { id: "personal-id", appId: "fixture", name: "Same account", status: "active", personal: true, version: "1" },
      { id: "shared-id", appId: "fixture", name: "Same account", status: "active", personal: false, version: "1" },
      ...["expired", "reconnect_required", "pending", "failed"].map(status => ({ id: `${status}-id`, appId: "fixture", name: "Inactive account", status, personal: true, version: "1" })),
    ];
    const html = renderToStaticMarkup(h(PersonalApp, { appId: "fixture", appName: "Fixture", accounts, shareStates: { current: new Map() }, active: true, onShareChanged: () => {}, onSessionExpired: () => {}, onChanged: () => {} }));
    expect(html).toContain("astryx-card");
    expect(html).toContain("astryx-list-item");
    expect(html).toContain("Personal · Connected");
    expect(html).toContain("Same account · Shared with you · shared-id");
    for (const state of ["Authorization expired", "Reconnect required", "Setup unfinished", "Connection failed"]) expect(html).toContain(state);
    expect(html).not.toContain('value="expired-id"');
    expect(html).toContain("does not verify the agent client");
  });

  it("renders real loading components in both Apps and GitHub connections", async () => {
    vi.stubGlobal("window", { location: { href: "https://capykit.example.test/" } });
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    const { Apps } = await import("../src/console/apps.js");
    const { Connections } = await import("../src/console/connections.js");
    const apps = renderToStaticMarkup(h(Apps, { active: true, onSessionExpired: () => {}, onCreateFunction: () => {} }));
    const github = renderToStaticMarkup(h(Connections, { active: true, onSessionExpired: () => {} }));
    expect(apps).toContain("astryx-spinner");
    expect(apps).toContain("Loading apps…");
    expect(github).toContain("astryx-spinner");
    expect(github).toContain("Loading connections…");
  });
});
