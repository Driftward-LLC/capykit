import React, { useEffect, useState } from "react";
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
  const version = options?.versions.find(v => `${v.capabilityId}:${v.version}` === versionKey);
  const connection = options?.connections.find(c => c.id === connectionId);
  const recipient = options?.users.find(u => u.id === recipientId);
  const disabled = pending || loading;
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
    setPending(true); setError(""); setNotice("");
    try { await checked(await writeRequest(`/v1/grants/${encodeURIComponent(grantId)}`, "DELETE")); setRevokeId(null); await refresh(); setNotice("Access revoked. Future authorized requests will be denied."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not revoke access."); }
    finally { setPending(false); }
  }
  async function more(): Promise<void> {
    if (!cursor) return;
    setPending(true); setError("");
    try { const response = await checked(await sessionFetch(`/v1/grants?cursor=${encodeURIComponent(cursor)}`)); const page = await response.json() as { grants: Grant[]; nextCursor: string | null }; setGrants(current => [...current, ...page.grants.filter(g => !current.some(old => old.id === g.id))]); setCursor(page.nextCursor); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load more grants."); }
    finally { setPending(false); }
  }
  return h("section", { "aria-label": "Workspace access", "aria-busy": disabled },
    h("div", { className: "section-heading" }, h("div", null, h("p", { className: "eyebrow" }, "Workspace permissions"), h("h1", null, "Access"), h("p", { className: "muted" }, "Give a workspace user access to an exact published version.")), h("button", { type: "button", className: "secondary", disabled, onClick: () => { void refresh(); } }, "Refresh access")),
    error ? h("p", { className: "message error", role: "alert" }, error) : null,
    notice ? h("p", { className: "message success", role: "status" }, notice) : null,
    loading ? h("p", { role: "status" }, "Loading access…") : null,
    !options ? null : h("section", { className: "panel connection-intro" }, h("h2", null, "Grant access"),
      options.truncated ? h("p", { role: "status" }, "Only the first 200 choices are shown. Contact your operator if a choice is missing.") : null,
      options.versions.length === 0 ? h("p", null, "Publish a function or skill in Capabilities first. Only published versions can be granted.") : h("form", { onSubmit: event => { void grant(event); } },
        h("div", { className: "form-grid access-grid" },
          h("label", null, "User", h("select", { "aria-label": "User", required: true, value: recipientId, disabled, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setRecipientId(e.currentTarget.value); setApproved(false); } }, h("option", { value: "" }, "Choose a user"), ...options.users.map(u => h("option", { key: u.id, value: u.id }, `${u.name} (${u.email})`)))),
          h("label", null, "Published capability version", h("select", { "aria-label": "Published capability version", required: true, value: versionKey, disabled, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setVersionKey(e.currentTarget.value); setConnectionId(""); setRepositoryIds([]); setApproved(false); } }, h("option", { value: "" }, "Choose a version"), ...options.versions.map(v => h("option", { key: `${v.capabilityId}:${v.version}`, value: `${v.capabilityId}:${v.version}` }, `${v.name} · ${v.version} · ${v.kind}`)))),
          h("label", null, "Expires", h("input", { type: "datetime-local", required: true, disabled, value: expiry, onChange: e => { setExpiry(e.currentTarget.value); setApproved(false); } })),
        ),
        h("p", { className: "small muted" }, "Users must already be invited to this workspace. The grant expires at the selected local time; the default is 30 days."),
        version?.kind !== "function" ? null : h(React.Fragment, null,
          h("label", null, "GitHub connection", h("select", { "aria-label": "GitHub connection", required: true, value: connectionId, disabled, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { setConnectionId(e.currentTarget.value); setRepositoryIds([]); setApproved(false); } }, h("option", { value: "" }, "Choose a connected account"), ...options.connections.map(c => h("option", { key: c.id, value: c.id }, c.name)))),
          options.connections.length === 0 ? h("p", null, "Connect GitHub in Connections before granting function access.") : null,
          !connection ? null : h("fieldset", { className: "repository-picker", disabled }, h("legend", null, "Allowed repositories"), ...connection.repositories.map(r => h("label", { className: "checkbox-label", key: r.id }, h("input", { type: "checkbox", checked: repositoryIds.includes(r.id), onChange: e => { const selected = e.currentTarget.checked; setRepositoryIds(current => selected ? [...current, r.id] : current.filter(id => id !== r.id)); setApproved(false); } }), r.name))),
          h("p", { className: "small muted", role: "status" }, `${String(repositoryIds.length)} repositories selected. Permission: read GitHub issues and metadata.`),
        ),
        !version || !recipient || (version.kind === "function" && repositoryIds.length === 0) ? null : h("div", { className: "connection-consent" },
          h("label", { className: "checkbox-label" }, h("input", { type: "checkbox", checked: approved, disabled, onChange: e => { setApproved(e.currentTarget.checked); } }), `I grant ${recipient.name} access to ${version.name} ${version.version}${version.kind === "function" ? ` for the ${String(repositoryIds.length)} selected repositories` : " for skill retrieval"}.`),
          h("p", { className: "small muted" }, version.kind === "function" ? "The user can act through this connection without their own GitHub repository access. New versions and repositories require a new grant. Function execution is the next delivery milestone." : "The user can download the complete skill. Downloading a skill does not grant function or GitHub access."),
        ),
        h("button", { type: "submit", disabled: disabled || !approved }, pending ? "Saving…" : "Grant access"),
      ),
    ),
    h("section", { className: "panel" }, h("h2", null, "Existing grants"),
      grants.length === 0 ? h("p", { className: "muted" }, "No access grants yet.") : grants.map(g => h("article", { className: "published-version", key: g.id }, h("div", { className: "section-heading" }, h("div", null, h("h3", null, `${g.recipientName} · ${g.capabilityName} ${g.version}`), h("p", { className: "small muted" }, `${g.action === "invoke" ? `Read GitHub issues · ${String(g.repositoryIds.length)} repositories` : "Retrieve skill"} · Expires ${new Date(g.expiresAt).toLocaleString()}`)), h("span", { className: `status-badge${g.status === "active" ? " connected" : ""}` }, g.status)),
        g.action !== "invoke" ? null : h("div", null, h("p", { className: "small" }, `GitHub account: ${g.connectionName ?? "Unavailable connection"}`), h("ul", null, ...g.repositories.map(r => h("li", { key: r.id }, r.name)))),
        g.status === "revoked" ? null : revokeId !== g.id ? h("button", { type: "button", className: "text-button danger-text", disabled, onClick: () => { setRevokeId(g.id); } }, `Revoke access for ${g.recipientName}`) : h("div", null, h("p", null, "Revoke this grant? Future authorized requests stop; already downloaded copies cannot be recalled."), h("div", { className: "actions" }, h("button", { type: "button", className: "danger", disabled, onClick: () => { void revoke(g.id); } }, "Confirm revoke"), h("button", { type: "button", className: "secondary", disabled, onClick: () => { setRevokeId(null); } }, "Keep access"))),
      )), cursor === null ? null : h("button", { type: "button", className: "secondary", disabled, onClick: () => { void more(); } }, "Load more grants"),
    ),
  );
}
