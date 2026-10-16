import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Access } from "../src/console/access.js";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog } from "@astryxdesign/core/Dialog";
import { NativeField } from "../src/console/piece-details.js";

// Exercise Access's handlers with deterministic hook state; child components render
// unchanged for markup checks. Native modal focus/Escape belong to browser coverage.
const hooks = vi.hoisted(() => ({ active: false, index: 0, state: [] as unknown[] }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      if (!hooks.active) return actual.useState(initial);
      const index = hooks.index++;
      if (!(index in hooks.state)) hooks.state[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks.state[index], (value: unknown) => { hooks.state[index] = typeof value === "function" ? (value as (current: unknown) => unknown)(hooks.state[index]) : value; }];
    },
    useEffect: (...args: Parameters<typeof actual.useEffect>) => { if (!hooks.active) actual.useEffect(...args); },
    useId: () => hooks.active ? "people-confirmation" : actual.useId(),
    useRef: (initial: unknown) => hooks.active ? { current: initial } : actual.useRef(initial),
  };
});
const options = {
  users: [{ id: "person-1", name: "Same name", email: "one@example.test", role: "member" }, { id: "person-2", name: "Same name", email: "two@example.test", role: "member" }],
  versions: [{ capabilityId: "cap-1", name: "Read issues", kind: "function", version: "1.2.3", operation: "github.issues.list" }, { capabilityId: "cap-1", name: "Read issues", kind: "function", version: "2.0.0", operation: "github.issues.list" }, { capabilityId: "skill-1", name: "Guide", kind: "skill", version: "1.0.0", operation: null }],
  connections: [{ id: "account-1", name: "Same account", repositories: [{ id: "7", name: "acme/one" }, { id: "8", name: "acme/two" }] }, { id: "account-2", name: "Same account", repositories: [{ id: "9", name: "acme/other" }] }],
  truncated: false,
};
const existing = { id: "grant/exact", recipientName: "Same name", capabilityName: "Read issues", version: "1.2.3", action: "invoke", repositoryIds: ["7", "missing"], connectionName: "Same account", repositories: [{ id: "7", name: "acme/one" }], expiresAt: "2027-01-01T12:30:00Z", status: "active" };
const expiry = "2027-01-01T12:30";
type Props = { children?: React.ReactNode; label?: string; isDisabled?: boolean; value?: unknown; onClick?: () => void; onSubmit?: (event: { preventDefault: () => void }) => void; onChange?: (value: never) => void; onOpenChange?: (open: boolean) => void; purpose?: string; isOpen?: boolean };
function tree(onSessionExpired = () => {}): React.ReactElement {
  hooks.active = true; hooks.index = 0;
  try { return Access({ active: true, onSessionExpired }); } finally { hooks.active = false; }
}
function nodes(value: React.ReactNode): React.ReactElement<Props>[] {
  return React.Children.toArray(value).flatMap(child => React.isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
}
function control(type: unknown, label?: string, root = tree()): React.ReactElement<Props> {
  const node = nodes(root).find(n => n.type === type && (label === undefined || n.props.label === label));
  if (!node) throw new Error(`Missing control ${label ?? String(type)}`);
  return node;
}
function change(node: React.ReactElement<Props>, value: unknown): void { node.props.onChange?.(value as never); }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  hooks.state = [options, [existing], null, "person-1", "cap-1:1.2.3", "account-1", ["7"], expiry, true, null, false, false, "", "", ""];
  fetchMock.mockReset();
  vi.stubGlobal("document", { cookie: "capykit_csrf=fixture-csrf" });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { hooks.active = false; vi.unstubAllGlobals(); });

describe("People access Astryx migration", () => {
  it("renders installed components, native fields and exact recipient/version/account/resources/expiry review", () => {
    hooks.state[12] = "Owner-only failure"; hooks.state[13] = "Access refreshed";
    const html = renderToStaticMarkup(tree());
    for (const component of ["astryx-card", "astryx-button", "astryx-banner", "astryx-badge", "astryx-field", "astryx-checkbox-input", "astryx-form-layout"]) expect(html).toContain(component);
    for (const exact of ["Review exact grant", "Same name (one@example.test) · person-1", "Read issues · 1.2.3 · function · cap-1", "Same account · account-1", "acme/one · 7", "Unavailable repository · missing", expiry, "github.issues.list"]) expect(html).toContain(exact);
    expect(html).toMatch(/<select[^>]*required=""/u);
    expect(html).toMatch(/<input[^>]*type="datetime-local"[^>]*required=""/u);
    expect(html).toContain('role="alert"'); expect(html).toContain('role="status"');
    expect(html).not.toContain('class="panel'); expect(html).not.toContain("status-badge");
  });

  it("resets consent on every scope edit and clears dependent account/resources on version or account change", () => {
    for (const [label, value] of [["User", "person-2"], ["Expires", "2027-02-01T10:00"], ["Published capability version", "cap-1:2.0.0"], ["GitHub connection", "account-2"]]) {
      hooks.state[8] = true;
      const field = control(NativeField, label);
      change(React.Children.only(field.props.children) as React.ReactElement<Props>, { currentTarget: { value } });
      expect(hooks.state[8]).toBe(false);
      if (label === "Published capability version") { expect(hooks.state[5]).toBe(""); expect(hooks.state[6]).toEqual([]); }
      if (label === "GitHub connection") expect(hooks.state[6]).toEqual([]);
    }
    hooks.state[5] = "account-1"; hooks.state[6] = ["7"]; hooks.state[8] = true;
    change(control(CheckboxInput, "acme/two · 8"), true);
    expect(hooks.state[6]).toEqual(["7", "8"]); expect(hooks.state[8]).toBe(false);
    expect(control(Button, "Grant access").props.isDisabled).toBe(true);
  });

  it.each(["function", "skill"])("preserves exact %s grant payload and session CSRF transport, resetting consent after success", async kind => {
    if (kind === "skill") hooks.state[4] = "skill-1:1.0.0";
    fetchMock.mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(options)).mockResolvedValueOnce(json({ grants: [existing], nextCursor: null }));
    control("form").props.onSubmit?.({ preventDefault: () => {} });
    await vi.waitFor(() => { expect(hooks.state[11]).toBe(false); });
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Grant request missing");
    const [path, init] = call;
    expect(path).toBe("/v1/grants"); expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin"); expect(new Headers(init?.headers).get("x-csrf-token")).toBe("fixture-csrf");
    if (typeof init?.body !== "string") throw new Error("Expected JSON grant body");
    expect(JSON.parse(init.body)).toEqual({ recipientId: "person-1", capabilityId: kind === "function" ? "cap-1" : "skill-1", version: kind === "function" ? "1.2.3" : "1.0.0", expiresAt: new Date(expiry).toISOString(), ...(kind === "function" ? { connectionId: "account-1", repositoryIds: ["7"] } : {}) });
    expect(hooks.state[8]).toBe(false); expect(hooks.state[6]).toEqual([]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/v1/grants", "/v1/access/options", "/v1/grants"]);
  });

  it("requires fresh consent and a selected resource before sending a grant", () => {
    hooks.state[8] = false; control("form").props.onSubmit?.({ preventDefault: () => {} });
    hooks.state[8] = true; hooks.state[6] = []; control("form").props.onSubmit?.({ preventDefault: () => {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a named modal with safe autofocus, pending lock, visible owner denial and explicit cancellation", async () => {
    control(Button, "Revoke access for Same name").props.onClick?.();
    expect(hooks.state[9]).toBe(existing.id); expect(fetchMock).not.toHaveBeenCalled();
    const modal = control(Dialog);
    expect(modal.props.isOpen).toBe(true); expect(modal.props.purpose).toBe("form");
    const html = renderToStaticMarkup(tree());
    for (const exact of ['aria-modal="true"', 'aria-labelledby="people-confirmation"', 'data-autofocus=""', "Revoke this exact grant?", "grant/exact", "Other grants, connected accounts, agent keys and client verification remain unchanged."]) expect(html).toContain(exact);
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    control(Button, "Confirm revoke").props.onClick?.();
    expect(control(Dialog).props.purpose).toBe("required"); expect(control(Button, "Keep access").props.isDisabled).toBe(true);
    control(Dialog).props.onOpenChange?.(false); expect(hooks.state[9]).toBe(existing.id);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/grants/grant%2Fexact"); expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
    finish(json({ error: { code: "FORBIDDEN" } }, 403));
    await vi.waitFor(() => { expect(hooks.state[11]).toBe(false); });
    expect(hooks.state[9]).toBe(existing.id);
    const failure = renderToStaticMarkup(tree()); expect(failure).toContain("Only a workspace owner can manage grants."); expect(failure).toContain('role="alert"');
    control(Button, "Keep access").props.onClick?.();
    expect(hooks.state[9]).toBe(null); expect(hooks.state[14]).toBe(""); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("closes after successful exact revocation and reloads grant metadata", async () => {
    hooks.state[9] = existing.id;
    fetchMock.mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(options)).mockResolvedValueOnce(json({ grants: [{ ...existing, status: "revoked" }], nextCursor: null }));
    control(Button, "Confirm revoke").props.onClick?.();
    await vi.waitFor(() => { expect(hooks.state[11]).toBe(false); });
    expect(hooks.state[9]).toBe(null); expect(control(Dialog).props.isOpen).toBe(false);
    expect(hooks.state[8]).toBe(false); expect(hooks.state[13]).toBe("Access revoked. Future authorized requests will be denied.");
    expect(nodes(tree()).some(n => n.type === Button && n.props.label === "Revoke access for Same name")).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/v1/grants/grant%2Fexact", "/v1/access/options", "/v1/grants"]);
  });

  it("keeps 401 session handling and refresh-triggered consent reset", async () => {
    const expired = vi.fn();
    fetchMock.mockResolvedValueOnce(json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401));
    // No CSRF cookie prevents session-renewal replay, exposing the original 401.
    vi.stubGlobal("document", { cookie: "" });
    control(Button, "Refresh access", tree(expired)).props.onClick?.();
    await vi.waitFor(() => { expect(hooks.state[10]).toBe(false); });
    expect(expired).toHaveBeenCalledTimes(1); expect(hooks.state[12]).toBe("Your session expired. Sign in again.");
    fetchMock.mockResolvedValueOnce(json(options)).mockResolvedValueOnce(json({ grants: [], nextCursor: null }));
    control(Button, "Refresh access").props.onClick?.();
    await vi.waitFor(() => { expect(hooks.state[10]).toBe(false); }); expect(hooks.state[8]).toBe(false);
  });
});
