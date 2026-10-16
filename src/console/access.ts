import React, { useEffect, useId, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Banner } from "@astryxdesign/core/Banner";
import { Badge } from "@astryxdesign/core/Badge";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Stack } from "@astryxdesign/core/Stack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { NativeField } from "./piece-details.js";
import { sessionFetch, writeRequest } from "./session.js";
const h = React.createElement;
interface User { id: string; name: string; email: string; role: string; }
interface Version { capabilityId: string; name: string; kind: "skill" | "function"; version: string; operation: string | null; }
interface Connection { id: string; name: string; repositories: { id: string; name: string }[]; }
interface Options { users: User[]; versions: Version[]; connections: Connection[]; truncated: boolean; }
interface Grant { id: string; recipientName: string; capabilityName: string; version: string; action: string; repositoryIds: string[]; connectionName: string | null; repositories: { id: string; name: string }[]; expiresAt: string; status: string; }
const errors: Record<string, string> = { FORBIDDEN: "Only a workspace owner can manage grants. Refresh to check your current role.", NOT_FOUND: "That user, version or connection is no longer available. Refresh and choose again.", CONNECTION_INACTIVE: "This GitHub connection is no longer active. Reconnect it before granting access.", INVALID_REQUEST: "Check your choices and choose a future expiry within one year.", CSRF_REQUIRED: "Reload the page to refresh your session, then try again." };
function defaultExpiry(): string {
  const date = new Date(Date.now() + 30 * 86400000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
export function Access({ onSessionExpired, active }: { onSessionExpired: () => void; active: boolean }): React.ReactElement {
  const [options, setOptions] = useState<Options | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [recipientId, setRecipientId] = useState("");
  const [versionKey, setVersionKey] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState(defaultExpiry);
  const [approved, setApproved] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revokeError, setRevokeError] = useState("");
  const confirmationId = useId();
  const refreshButton = useRef<HTMLButtonElement>(null);
  const revoked = useRef(false);
  const version = options?.versions.find(v => `${v.capabilityId}:${v.version}` === versionKey);
  const connection = options?.connections.find(c => c.id === connectionId);
  const recipient = options?.users.find(u => u.id === recipientId);
  const revokeGrant = grants.find(g => g.id === revokeId);
  const disabled = pending || loading;
  // A successful revoke removes its trigger; return focus after Dialog closes.
  useEffect(() => { if (revoked.current && revokeId === null && !disabled) { revoked.current = false; refreshButton.current?.focus(); } }, [revokeId, disabled]);
  async function checked(response: Response): Promise<Response> {
    if (response.status === 401) { onSessionExpired(); throw new Error("Your session expired. Sign in again."); }
    if (!response.ok) {
      const body = await response.json() as { error?: { code?: string } };
      throw new Error(errors[body.error?.code ?? ""] ?? "Could not update access. Try again.");
    }
    return response;
  }
  async function refresh(): Promise<void> {
    setLoading(true); setError("");
    try {
      const choices = await checked(await sessionFetch("/v1/access/options"));
      const data = await choices.json() as Options;
      const list = await checked(await sessionFetch("/v1/grants"));
      const page = await list.json() as { grants: Grant[]; nextCursor: string | null };
      setOptions(data); setGrants(page.grants); setCursor(page.nextCursor);
      setApproved(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load access."); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (active) void refresh(); }, [active]);
  async function grant(event: React.SubmitEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    if (!version || !recipient || !approved || (version.kind === "function" && repositoryIds.length === 0)) return;
    setPending(true); setError(""); setNotice("");
    try {
      await checked(await writeRequest("/v1/grants", "POST", { recipientId, capabilityId: version.capabilityId, version: version.version, expiresAt: new Date(expiry).toISOString(), ...(version.kind === "function" ? { connectionId, repositoryIds } : {}) }));
      setApproved(false); setRepositoryIds([]);
      await refresh(); setNotice(`Access granted to ${recipient.name} for ${version.name} ${version.version}.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not grant access."); }
    finally { setPending(false); }
  }
  async function revoke(grantId: string): Promise<void> {
    if (disabled) return;
    setPending(true); setRevokeError(""); setError(""); setNotice("");
    try { await checked(await writeRequest(`/v1/grants/${encodeURIComponent(grantId)}`, "DELETE")); await refresh(); revoked.current = true; setRevokeId(null); setNotice("Access revoked. Future authorized requests will be denied."); }
    catch (e) { setRevokeError(e instanceof Error ? e.message : "Could not revoke access."); }
    finally { setPending(false); }
  }
  async function more(): Promise<void> {
    if (!cursor) return;
    setPending(true); setError("");
    try { const response = await checked(await sessionFetch(`/v1/grants?cursor=${encodeURIComponent(cursor)}`)); const page = await response.json() as { grants: Grant[]; nextCursor: string | null }; setGrants(current => [...current, ...page.grants.filter(g => !current.some(old => old.id === g.id))]); setCursor(page.nextCursor); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load more grants."); }
    finally { setPending(false); }
  }
  return h(Stack, { as: "section", gap: 4, "aria-label": "Workspace access", "aria-busy": disabled },
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "Workspace permissions"), h("h1", null, "People access"), h("p", { className: "muted" }, "Give a workspace user access to an exact published version.")), h(Button, { ref: refreshButton, label: "Refresh access", isDisabled: disabled, onClick: () => { void refresh(); } })),
    error ? h(Banner, { status: "error", role: "alert", title: error }) : null,
    notice ? h(Banner, { status: "success", role: "status", title: notice }) : null,
    loading ? h(Spinner, { label: "Loading access…" }) : null,
    !options ? null : h(Card, { padding: 4, role: "region", "aria-label": "Grant access" }, h(Stack, { gap: 4 },
      h("h2", null, "Grant access"),
      options.truncated ? h(Banner, { status: "info", role: "status", title: "Only the first 200 choices are shown. Contact your operator if a choice is missing." }) : null,
      options.versions.length === 0 ? h("p", null, "Publish a function or skill in Capabilities first. Only published versions can be granted.") : h("form", { onSubmit: event => { void grant(event); } }, h(FormLayout, null,
        h(NativeField, { label: "User", children: h("select", { required: true, value: recipientId, disabled, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setRecipientId(e.currentTarget.value); setApproved(false); } }, h("option", { value: "" }, "Choose a user"), ...options.users.map(u => h("option", { key: u.id, value: u.id }, `${u.name} (${u.email}) · ${u.id}`))) }),
        h(NativeField, { label: "Published capability version", children: h("select", { required: true, value: versionKey, disabled, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setVersionKey(e.currentTarget.value); setConnectionId(""); setRepositoryIds([]); setApproved(false); } }, h("option", { value: "" }, "Choose a version"), ...options.versions.map(v => h("option", { key: `${v.capabilityId}:${v.version}`, value: `${v.capabilityId}:${v.version}` }, `${v.name} · ${v.version} · ${v.kind} · ${v.capabilityId}`))) }),
        h(NativeField, { label: "Expires", description: `Local timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. The default is 30 days; choose a future expiry within one year.`, children: h("input", { type: "datetime-local", required: true, disabled, value: expiry, onChange: e => { setExpiry(e.currentTarget.value); setApproved(false); } }) }),
        h("p", { className: "small muted" }, "Users must already be invited to this workspace. People, published-version grants, connected accounts, agent keys and client verification are separate."),
        version?.kind !== "function" ? null : h(React.Fragment, null,
          h(NativeField, { label: "GitHub connection", children: h("select", { required: true, value: connectionId, disabled, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setConnectionId(e.currentTarget.value); setRepositoryIds([]); setApproved(false); } }, h("option", { value: "" }, "Choose a connected account"), ...options.connections.map(c => h("option", { key: c.id, value: c.id }, `${c.name} · ${c.id}`))) }),
          options.connections.length === 0 ? h("p", null, "Connect GitHub in Apps before granting function access.") : null,
          !connection ? null : h("fieldset", { className: "repository-picker", disabled }, h("legend", null, "Allowed repositories"), ...connection.repositories.map(r => h(CheckboxInput, { key: r.id, label: `${r.name} · ${r.id}`, value: repositoryIds.includes(r.id), isDisabled: disabled, onChange: (selected: boolean) => { setRepositoryIds(current => selected ? [...current, r.id] : current.filter(id => id !== r.id)); setApproved(false); } }))),
          h("p", { className: "small muted", role: "status" }, `${String(repositoryIds.length)} repositories selected. Permission: read GitHub issues and metadata.`),
        ),
        !version || !recipient || (version.kind === "function" && repositoryIds.length === 0) ? null : h(Card, { padding: 4, variant: "muted" }, h(Stack, { gap: 3 },
          h("h3", null, "Review exact grant"),
          h("dl", null,
            h("dt", null, "Recipient"), h("dd", null, `${recipient.name} (${recipient.email}) · ${recipient.id}`),
            h("dt", null, "Published capability version"), h("dd", null, `${version.name} · ${version.version} · ${version.kind} · ${version.capabilityId}`),
            h("dt", null, "Permission"), h("dd", null, version.kind === "function" ? `Read GitHub issues and metadata${version.operation ? ` · ${version.operation}` : ""}` : "Retrieve the complete skill"),
            h("dt", null, "Connected account"), h("dd", null, version.kind === "function" ? `${connection?.name ?? "Unavailable connection"} · ${connectionId}` : "None — skill retrieval only"),
            h("dt", null, "Resources"), h("dd", null, version.kind === "function" ? h("ul", null, ...repositoryIds.map(id => h("li", { key: id }, `${connection?.repositories.find(r => r.id === id)?.name ?? "Unavailable repository"} · ${id}`))) : "Complete skill contents; no function or GitHub access"),
            h("dt", null, "Expires"), h("dd", null, `${expiry || "Choose an expiry"} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`),
          ),
          h(CheckboxInput, { label: "I approve this exact recipient, published version, connected account, resource list and expiry.", value: approved, isDisabled: disabled, onChange: setApproved }),
          h("p", { className: "small muted" }, version.kind === "function" ? "The user can act through this connection without their own GitHub repository access. New versions and repositories require a new grant. Function execution is the next delivery milestone." : "The user can download the complete skill. Downloading a skill does not grant function or GitHub access."),
        )),
        h(Button, { label: pending ? "Saving…" : "Grant access", type: "submit", variant: "primary", isDisabled: disabled || !approved }),
      )),
    )),
    h(Stack, { as: "section", gap: 3, "aria-label": "Existing grants" }, h("h2", null, "Existing grants"),
      grants.length === 0 ? h("p", { className: "muted" }, "No access grants yet.") : grants.map(g => h(Card, { key: g.id, padding: 4, role: "article", "aria-label": `${g.recipientName} · ${g.capabilityName} ${g.version}` }, h(Stack, { gap: 3 },
        h("div", { className: "section-heading" }, h("div", null, h("h3", null, `${g.recipientName} · ${g.capabilityName} ${g.version}`), h("p", { className: "small muted" }, `${g.action === "invoke" ? `Read GitHub issues · ${String(g.repositoryIds.length)} repositories` : "Retrieve skill"} · Expires ${new Date(g.expiresAt).toLocaleString()}`)), h(Badge, { variant: g.status === "active" ? "success" : "neutral", label: g.status })),
        h("p", { className: "small muted" }, `Grant ID: ${g.id}`),
        g.action !== "invoke" ? null : h("div", null, h("p", { className: "small" }, `GitHub account: ${g.connectionName ?? "Unavailable connection"}`), h("ul", null, ...g.repositoryIds.map(id => h("li", { key: id }, `${g.repositories.find(r => r.id === id)?.name ?? "Unavailable repository"} · ${id}`)))),
        g.status === "revoked" ? null : h(Button, { label: `Revoke access for ${g.recipientName}`, variant: "destructive", isDisabled: disabled, onClick: () => { setRevokeError(""); setRevokeId(g.id); } }),
      ))), cursor === null ? null : h(Button, { label: "Load more grants", isDisabled: disabled, onClick: () => { void more(); } }),
    ),
    h(Dialog, { isOpen: revokeGrant !== undefined, purpose: disabled ? "required" : "form", width: 560, "aria-labelledby": confirmationId, "aria-describedby": `${confirmationId}-description`, onOpenChange: (open: boolean) => { if (!open && !disabled) { setRevokeId(null); setRevokeError(""); } }, children: !revokeGrant ? null : h(Stack, { gap: 3, isScrollable: true },
      h("h2", { id: confirmationId }, "Revoke this exact grant?"),
      h("p", { id: `${confirmationId}-description` }, "Future authorized requests stop; already downloaded copies cannot be recalled. Other grants, connected accounts, agent keys and client verification remain unchanged."),
      h("dl", null,
        h("dt", null, "Recipient"), h("dd", null, revokeGrant.recipientName),
        h("dt", null, "Published capability version"), h("dd", null, `${revokeGrant.capabilityName} · ${revokeGrant.version}`),
        h("dt", null, "Grant ID"), h("dd", null, revokeGrant.id),
        h("dt", null, "Connected account"), h("dd", null, revokeGrant.action === "invoke" ? revokeGrant.connectionName ?? "Unavailable connection" : "None — skill retrieval only"),
        h("dt", null, "Resources"), h("dd", null, revokeGrant.action === "invoke" ? h("ul", null, ...revokeGrant.repositoryIds.map(id => h("li", { key: id }, `${revokeGrant.repositories.find(r => r.id === id)?.name ?? "Unavailable repository"} · ${id}`))) : "Complete skill contents"),
        h("dt", null, "Expires"), h("dd", null, new Date(revokeGrant.expiresAt).toLocaleString()),
      ),
      revokeError ? h(Banner, { status: "error", role: "alert", title: revokeError }) : null,
      pending ? h("p", { role: "status" }, "Revoking access…") : null,
      h(Stack, { direction: "horizontal", wrap: "wrap", gap: 2 },
        h(Button, { label: pending ? "Revoking…" : "Confirm revoke", variant: "destructive", isDisabled: disabled, onClick: () => { void revoke(revokeGrant.id); } }),
        h(Button, { label: "Keep access", "data-autofocus": "", isDisabled: disabled, onClick: () => { setRevokeId(null); setRevokeError(""); } }),
      ),
    ) }),
  );
}
