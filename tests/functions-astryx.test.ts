import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CapabilityLibrary } from "../src/console/library.js";
import { writeRequest } from "../src/console/session.js";

// Seed library state only; installed components render normally. Event checks
// exercise the real handlers, not native browser validity or modal focus.
const seed = vi.hoisted(() => ({ values: [] as unknown[], setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    if (seed.values.length === 0) return actual.useState(initial);
    const [value] = actual.useState(seed.values.shift());
    const setter = vi.fn(); seed.setters.push(setter);
    return [value, setter];
  } };
});
vi.mock("../src/console/session.js", () => ({ sessionFetch: vi.fn(), writeRequest: vi.fn() }));

const artifact = { digest: "draft-exact-digest", byteCount: 4, fileCount: 1, contract: { id: "github.issues.list.v1" }, files: [{ path: "index.mjs", executable: true, byteLength: 4, sha256: "file-exact-digest" }] };
const capability = { id: "capability-id", name: "Reviewed function", slug: "reviewed-function", kind: "function", createdAt: "2026-01-01T00:00:00Z", draft: { ...artifact, version: "1.0.0", updatedAt: "2026-01-01T00:00:00Z" }, versions: [{ ...artifact, digest: "published-exact-digest", version: "0.9.0", publishedAt: "2026-01-01T00:00:00Z" }] };
const upload = { path: "index.mjs", contentBase64: "dGVzdA==", executable: true, type: "file" };
type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: React.ReactNode): Element[] {
  return React.Children.toArray(node).flatMap(child => React.isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as React.ReactNode)] : []);
}
function render({ selected = capability, pending = false, creating = false, loading = false, version = "1.0.0", files = [], deleting = false, error = "", notice = "", manage = true }: Partial<{ selected: typeof capability | null; pending: boolean; creating: boolean; loading: boolean; version: string; files: typeof upload[]; deleting: boolean; error: string; notice: string; manage: boolean }> = {}) {
  seed.values = [[capability], selected, loading, pending, error, notice, creating, "Example", "example", "function", version, files, deleting];
  seed.setters = [];
  let tree: React.ReactNode = null;
  function Probe() { tree = CapabilityLibrary({ manage, onSessionExpired: () => {} }); return tree; }
  const html = renderToStaticMarkup(React.createElement(Probe));
  const nodes = elements(tree);
  return { html, find: (predicate: (node: Element) => boolean) => {
    const node = nodes.find(predicate); if (!node) throw new Error("Expected library element was not rendered."); return node;
  } };
}
function browserFile(name: string, text = "test") {
  const file = new File([text], name);
  Object.defineProperty(file, "webkitRelativePath", { value: "" });
  return file;
}
afterEach(() => { seed.values = []; vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Functions Astryx migration", () => {
  it("renders real installed primitives with full published and draft metadata", () => {
    const { html } = render({ files: [upload] });
    for (const component of ["card", "button", "badge", "field", "form-layout", "list-item", "table", "checkbox-input", "dialog"]) expect(html).toContain(`astryx-${component}`);
    for (const metadata of ["draft-exact-digest", "published-exact-digest", "file-exact-digest", "github.issues.list.v1", "0.9.0", "index.mjs"]) expect(html).toContain(metadata);
    expect(html).not.toMatch(/kind-badge|status-badge|message error|class="panel/u);
    expect(html).toContain('scope="col"');
    expect(html).toContain('aria-current="true"');
  });

  it("preserves native creation and version constraints", () => {
    const { html } = render({ creating: true });
    expect(html).toMatch(/<input[^>]*required=""[^>]*maxLength="120"/u);
    expect(html).toMatch(/<input[^>]*required=""[^>]*maxLength="80"[^>]*pattern="\[a-z0-9\]/u);
    expect(html).toContain('maxLength="64"');
    expect(html).toContain('pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}"');
    expect(html).toContain('<option value="function" selected="">Function</option>');
    expect(html).toContain('type="submit"');
    expect(html).not.toContain("novalidate");
  });

  it("keeps native function, folder and JSON file pickers", () => {
    const { html } = render();
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="\.mjs"/u);
    expect(html).toContain('accept=".json,application/json"');
    const skill = render({ selected: { ...capability, kind: "skill" } }).html;
    expect(skill).toMatch(/<input[^>]*type="file"[^>]*multiple=""[^>]*webkitdirectory=""/u);
  });

  it("retains manage guards including restricted function downloads", () => {
    const html = render({ manage: false, creating: true }).html;
    for (const action of ["New capability", "Create a capability", "Save and validate draft", "Publish 1.0.0", "Delete capability", "Download 0.9.0", "Saved draft"]) expect(html).not.toContain(action);
    expect(html).toContain("published-exact-digest");
    expect(render({ manage: false, selected: { ...capability, kind: "skill" } }).html).toContain("Download 0.9.0");
  });

  it("publishes only the saved version and exact digest, with unchanged dirty/version guards", async () => {
    for (const options of [{ files: [upload] }, { version: "2.0.0" }, { pending: true }]) {
      expect(render(options).find(node => node.type === Button && node.props.label === "Publish 1.0.0").props.isDisabled).toBe(true);
    }
    vi.mocked(writeRequest).mockResolvedValue(new Response(JSON.stringify(capability)));
    const publish = render().find(node => node.type === Button && node.props.label === "Publish 1.0.0");
    expect(publish.props.isDisabled).toBe(false);
    (publish.props.onClick as () => void)();
    await vi.waitFor(() => { expect(writeRequest).toHaveBeenCalledWith("/v1/capabilities/capability-id/publish", "POST", { version: "1.0.0", digest: "draft-exact-digest" }); expect(seed.setters[3]).toHaveBeenLastCalledWith(false); });
  });

  it("keeps destructive confirmation named, safe to cancel, blocked while pending, and errors inside the modal", () => {
    const failed = render({ deleting: true, error: "Deletion failed. Try again." });
    const dialog = failed.find(node => node.type === Dialog);
    expect(dialog.props.isOpen).toBe(true);
    expect(dialog.props.purpose).toBe("form");
    expect(failed.html).toContain('aria-modal="true"');
    expect(failed.html).toContain('data-autofocus=""');
    expect(failed.html.indexOf('role="alert"')).toBeGreaterThan(failed.html.indexOf("<dialog"));
    (dialog.props.onOpenChange as (open: boolean) => void)(false);
    expect(seed.setters[12]).toHaveBeenCalledWith(false);
    const working = render({ deleting: true, pending: true });
    const pendingDialog = working.find(node => node.type === Dialog);
    expect(pendingDialog.props.purpose).toBe("required");
    expect(working.html).toContain("Deleting capability…");
    expect(working.find(node => node.type === Button && node.props.label === "Keep capability").props.isDisabled).toBe(true);
    (pendingDialog.props.onOpenChange as (open: boolean) => void)(false);
    expect(seed.setters[12]).not.toHaveBeenCalled();
  });

  it("uses real loading and recoverable error/status surfaces", () => {
    expect(render({ loading: true, selected: null }).html).toContain("astryx-spinner");
    const html = render({ error: "Refresh and retry", notice: "Draft saved" }).html;
    expect(html).toContain('role="alert"'); expect(html).toContain('role="status"'); expect(html).toContain("astryx-banner");
    expect(html).toContain("Refresh"); expect(html).toContain("Reload capability");
  });

  it("retains the delete confirmation and selected capability when deletion fails", async () => {
    vi.mocked(writeRequest).mockResolvedValue(new Response(JSON.stringify({ error: { code: "FORBIDDEN", requestId: "delete-reference" } }), { status: 403 }));
    const remove = render({ deleting: true }).find(node => node.type === Button && node.props.label === "Delete capability and versions");
    (remove.props.onClick as () => void)();
    await vi.waitFor(() => { expect(seed.setters[4]).toHaveBeenLastCalledWith(expect.stringContaining("Reference: delete-reference")); expect(seed.setters[3]).toHaveBeenLastCalledWith(false); });
    expect(writeRequest).toHaveBeenCalledWith("/v1/capabilities/capability-id", "DELETE");
    expect(seed.setters[1]).not.toHaveBeenCalled();
    expect(seed.setters[12]).not.toHaveBeenCalled();
  });

  it("imports executable flags and version without writing, resets the native picker, and rejects unsafe paths", async () => {
    const { find } = render();
    const picker = find(node => node.type === "input" && node.props.accept === ".json,application/json");
    const choose = picker.props.onChange as (event: { currentTarget: { files: File[]; value: string } }) => void;
    const currentTarget = { files: [browserFile("artifact.json", JSON.stringify({ format: "capykit.artifact.v1", version: "2.0.0", artifact: { kind: "function", files: [upload] } }))], value: "selected" };
    choose({ currentTarget });
    expect(currentTarget.value).toBe("");
    await vi.waitFor(() => { expect(seed.setters[11]).toHaveBeenCalledWith([upload]); expect(seed.setters[10]).toHaveBeenCalledWith("2.0.0"); expect(seed.setters[3]).toHaveBeenLastCalledWith(false); });
    expect(writeRequest).not.toHaveBeenCalled();

    currentTarget.files = [browserFile("artifact.json", JSON.stringify({ format: "capykit.artifact.v1", artifact: { kind: "skill", files: [{ ...upload, path: "../SKILL.md" }] } }))];
    // Use a skill handler so the path validator, not the kind check, rejects it.
    const skillPicker = render({ selected: { ...capability, kind: "skill" } }).find(node => node.type === "input" && node.props.accept === ".json,application/json");
    (skillPicker.props.onChange as typeof choose)({ currentTarget });
    await vi.waitFor(() => { expect(seed.setters[4]).toHaveBeenLastCalledWith("File paths must be relative, without parent-directory segments or unsupported characters."); expect(seed.setters[3]).toHaveBeenLastCalledWith(false); });
    expect(seed.setters[11]).not.toHaveBeenCalled();
  });

  it("keeps one-file function validation and updates only the chosen executable flag", async () => {
    const { find } = render({ files: [upload] });
    const checkbox = find(node => node.type === CheckboxInput);
    (checkbox.props.onChange as (checked: boolean) => void)(false);
    const update = seed.setters[11]?.mock.calls[0]?.[0] as (files: typeof upload[]) => typeof upload[];
    expect(update([upload])).toEqual([{ ...upload, executable: false }]);
    const picker = find(node => node.type === "input" && node.props.accept === ".mjs");
    (picker.props.onChange as (event: { currentTarget: { files: File[]; value: string } }) => void)({ currentTarget: { files: [browserFile("wrong.mjs")], value: "selected" } });
    await vi.waitFor(() => { expect(seed.setters[4]).toHaveBeenLastCalledWith("A function must contain only index.mjs."); expect(seed.setters[3]).toHaveBeenLastCalledWith(false); });
    expect(writeRequest).not.toHaveBeenCalled();
  });
});