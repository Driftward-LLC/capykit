import React, { useEffect, useState } from "react";
import { writeRequest } from "./library.js";

const h = React.createElement;
interface Repository { id: string; fullName: string; url: string; }
interface Account { id: string; login: string; type: string; }
interface Connection {
  id: string;
  status: "pending" | "active" | "suspended" | "reconnect_required" | "revoked";
  account: Account | null;
  installationId: string | null;
  repositories: Repository[];
  permissions: { issues: "read"; metadata: "read" };
  consentAt: string | null;
  consentByPrincipalId: string | null;
  uninstallUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
interface Candidate {
  installationId: string;
  account: Account;
  repositories: (Repository & { admin: boolean })[];
}
interface Setup { setupId: string; connectionId: string; candidates: Candidate[]; expiresAt: string; }
type GitHubReturn = { code: string; state: string } | { notice: string };

// Strip OAuth material before any identity request, render, or later navigation.
let githubReturn: GitHubReturn | null = (() => {
  const url = new URL(window.location.href);
  if (url.pathname === "/v1/connections/github/setup") {
    window.history.replaceState(null, "", "/?tab=connections");
    return { notice: "Continue by authorizing your GitHub account. Capykit will verify the installation and let you choose repositories." };
  }
  if (url.pathname !== "/v1/connections/github/callback") return null;
  window.history.replaceState(null, "", "/?tab=connections");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.has("error")) return { notice: "GitHub authorization was not completed. You can start again when you are ready." };
  if (code === null || state === null || code.length === 0 || state.length === 0 || code.length > 4096 || state.length > 4096 || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length !== 1) return { notice: "That GitHub setup could not be verified. Start a new authorization." };
  return { code, state };
})();

export function discardGitHubReturn(): boolean {
  const present = githubReturn !== null;
  githubReturn = null;
  return present;
}

const statusLabels: Record<Connection["status"], string> = {
  pending: "Setup pending", active: "Connected", suspended: "Suspended on GitHub", reconnect_required: "Reconnect required", revoked: "Disconnected",
};
const errorMessages: Record<string, string> = {
  FORBIDDEN: "Only an active workspace owner can manage connections. GitHub setup also requires administrator access to each chosen repository.",
  NOT_FOUND: "This connection or setup is no longer available. Refresh connections or start a new authorization.",
  INVALID_REQUEST: "Check the selected installation and repositories, then try again.",
  CONFLICT: "This installation or setup changed, or the installation is connected to another workspace. Refresh and start a new authorization.",
  CONNECT_SETUP_EXPIRED: "This setup expired. Start a new GitHub authorization.",
  CONNECT_STATE_INVALID: "This setup could not be verified. Start a new GitHub authorization.",
  GITHUB_NOT_CONFIGURED: "Your operator needs to configure a dedicated Capykit GitHub App before you can connect repositories.",
  CONFIGURATION_UNAVAILABLE: "GitHub configuration is unavailable. Contact your workspace operator.",
  GITHUB_AUTHORIZATION_FAILED: "GitHub authorization could not be verified. Start a new authorization.",
  GITHUB_ACCESS_REVOKED: "GitHub access was revoked or is no longer available. Check the app installation and your repository permissions, then reconnect.",
  GITHUB_INSTALLATION_INVALID: "This installation is unavailable or does not meet the connection requirements. Use the Capykit GitHub App with selected repositories, then reconnect.",
  GITHUB_PERMISSION_MISMATCH: "The GitHub App permissions do not match the required read access. Contact your workspace operator.",
  GITHUB_REPOSITORY_FORBIDDEN: "You no longer have administrator access to every selected repository. Start a new authorization and review the repositories.",
  GITHUB_RESULT_LIMIT: "This GitHub account has too many installations or repositories for this preview. Contact your workspace operator.",
  GITHUB_RESPONSE_LIMIT: "GitHub returned more data than this preview can process. Try a smaller set of repositories or contact your workspace operator.",
  GITHUB_RESPONSE_INVALID: "GitHub returned a response that could not be verified. Try again shortly.",
  GITHUB_TOKEN_SCOPE_INVALID: "GitHub access could not be restricted to the approved repositories. No access was enabled; contact your workspace operator.",
  CONNECTION_INACTIVE: "This connection is no longer active. Refresh connections and reconnect to verify access.",
  GITHUB_UNAVAILABLE: "GitHub could not complete this request. Try again shortly; an expired authorization must be restarted.",
  GITHUB_RATE_LIMITED: "GitHub is limiting requests. Wait before trying again.",
  CSRF_REQUIRED: "Your session needs refreshing. Reload the page and try again.",
};

function setupInUrl(setupId?: string): void {
  const url = new URL(window.location.href);
  if (setupId === undefined) url.searchParams.delete("setup"); else url.searchParams.set("setup", setupId);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function githubLink(url: string | null): string | undefined {
  if (url === null) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && parsed.username === "" && parsed.password === "" ? parsed.href : undefined;
  } catch { return undefined; }
}

export function Connections({ onSessionExpired }: { onSessionExpired: () => void }): React.ReactElement {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [configured, setConfigured] = useState(false);
  const [installationUrl, setInstallationUrl] = useState<string | null>(null);
  const [selected, setSelected] = useState<Connection | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [installationId, setInstallationId] = useState("");
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const candidate = setup?.candidates.find((entry) => entry.installationId === installationId);

  async function checked(response: Response): Promise<Response> {
    if (response.status === 401) {
      discardGitHubReturn();
      onSessionExpired();
      throw new Error("Your session expired. Sign in again and start a new GitHub authorization.");
    }
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      throw new Error(errorMessages[value?.error?.code ?? ""] ?? "The request could not be completed. Check your connection and try again.");
    }
    return response;
  }

  async function refresh(): Promise<void> {
    const response = await checked(await fetch("/v1/connections", { credentials: "same-origin", cache: "no-store" }));
    const result = await response.json() as { configured: boolean; installationUrl: string | null; connections: Connection[] };
    setConnections(result.connections); setConfigured(result.configured); setInstallationUrl(result.installationUrl);
    setSelected((previous) => previous === null ? null : result.connections.find((entry) => entry.id === previous.id) ?? null);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setPending(true); setError(""); setNotice("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "The request could not be completed. Try again."); }
    finally { setPending(false); }
  }

  function showSetup(value: Setup): void {
    setSetup(value); setSelected(null); setInstallationId(""); setRepositoryIds([]); setConsent(false);
    setupInUrl(value.setupId);
  }

  useEffect(() => {
    const controller = new AbortController();
    const returned = githubReturn;
    githubReturn = null;
    const setupId = new URL(window.location.href).searchParams.get("setup");
    void (async () => {
      try {
        if (returned !== null && "code" in returned) {
          // The one-use code stays in this request only; it is never persisted.
          const request = writeRequest("/v1/connections/github/callback", "POST", returned);
          returned.code = ""; returned.state = "";
          const response = await checked(await request);
          const value = await response.json() as Setup;
          if (!controller.signal.aborted) showSetup(value);
        } else if (returned !== null) {
          if (!controller.signal.aborted) setNotice(returned.notice);
        } else if (setupId !== null) {
          if (!/^[a-f0-9-]{36}$/i.test(setupId)) { setupInUrl(); throw new Error("That setup link is invalid. Start a new GitHub authorization."); }
          const response = await checked(await fetch(`/v1/connections/github/pending/${encodeURIComponent(setupId)}`, { credentials: "same-origin", cache: "no-store" }));
          const value = await response.json() as Setup;
          if (!controller.signal.aborted) showSetup(value);
        }
      } catch (failure) {
        if (!controller.signal.aborted) { setupInUrl(); setError(failure instanceof Error ? failure.message : "GitHub setup could not be completed. Start a new authorization."); }
      }
      try { if (!controller.signal.aborted) await refresh(); }
      catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load connections."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => { controller.abort(); };
  }, [onSessionExpired]);

  async function start(connectionId?: string): Promise<void> {
    await run(async () => {
      const response = await checked(await writeRequest("/v1/connections/github/start", "POST", connectionId === undefined ? {} : { connectionId }));
      const value = await response.json() as { authorizationUrl: string };
      const url = githubLink(value.authorizationUrl);
      if (url === undefined) throw new Error("GitHub authorization is unavailable. Contact your workspace operator.");
      window.location.assign(url);
    });
  }

  async function open(id: string): Promise<void> {
    await run(async () => {
      const response = await checked(await fetch(`/v1/connections/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" }));
      setSelected(await response.json() as Connection); setDisconnecting(false); setReconnecting(false);
    });
  }

  async function confirm(event: React.SubmitEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    if (setup === null || !consent || repositoryIds.length === 0 || installationId === "") return;
    await run(async () => {
      const response = await checked(await writeRequest("/v1/connections/github/confirm", "POST", { setupId: setup.setupId, installationId, repositoryIds, consent: true }));
      const value = await response.json() as Connection;
      setSetup(null); setupInUrl(); setConsent(false); setRepositoryIds([]);
      await refresh(); setSelected(value); setNotice("GitHub is connected to the selected repositories. Function access will require an explicit grant when grants become available.");
    });
  }

  async function cancel(): Promise<void> {
    if (setup === null) return;
    await run(async () => {
      await checked(await writeRequest(`/v1/connections/github/pending/${encodeURIComponent(setup.setupId)}`, "DELETE"));
      setSetup(null); setupInUrl(); setConsent(false); setRepositoryIds([]); setNotice("Setup canceled. No new repository access was approved.");
      await refresh();
    });
  }

  async function disconnect(): Promise<void> {
    if (selected === null) return;
    await run(async () => {
      await checked(await writeRequest(`/v1/connections/${encodeURIComponent(selected.id)}`, "DELETE"));
      setDisconnecting(false); setReconnecting(false); await refresh();
      setNotice("Disconnected. Capykit access to this connection has stopped. You can also uninstall the app on GitHub.");
    });
  }

  const disabled = pending || loading;
  const installLink = configured ? githubLink(installationUrl) : undefined;
  return h("section", { className: "connections", "aria-label": "GitHub connections", "aria-busy": disabled },
    h("div", { className: "section-heading" },
      h("div", null, h("p", { className: "eyebrow" }, "Workspace connections"), h("h1", null, "Connect your repositories"), h("p", { className: "muted" }, "Choose where Capykit can read GitHub issues. Only workspace owners can manage these connections.")),
      h("button", { type: "button", className: "secondary", disabled, onClick: () => { void run(refresh); } }, "Refresh"),
    ),
    error === "" ? null : h("p", { className: "message error", role: "alert" }, error),
    notice === "" ? null : h("p", { className: "message success", role: "status" }, notice),
    loading ? h("p", { className: "muted", role: "status" }, "Loading connections…") : configured ? h("section", { className: "panel connection-intro", "aria-label": "Connect GitHub" },
      h("h2", null, "GitHub App"), h("p", { className: "muted" }, "Install the Capykit GitHub App on selected repositories, then authorize your GitHub account to verify administrator access. You will review the repositories before connecting."),
      h("p", { className: "small muted" }, "Permissions: read issues and repository metadata. Publishing a function does not grant access to GitHub."),
      h("div", { className: "actions" }, installLink === undefined ? null : h("a", { className: "button-link secondary", href: installLink, target: "_blank", rel: "noopener noreferrer" }, "Install on GitHub"), h("button", { type: "button", disabled: disabled || setup !== null, onClick: () => { void start(); } }, "Authorize GitHub")),
    ) : h("section", { className: "panel connection-intro", "aria-label": "GitHub setup required" }, h("h2", null, "GitHub setup is not configured yet"), h("p", { className: "muted" }, "Your operator needs to register and configure a dedicated Capykit GitHub App. Once it is configured, you can install it, choose repositories, and connect them here.")),
    setup === null ? null : h("section", { className: "panel connection-setup", "aria-label": "Review GitHub connection" },
      h("h2", null, "Review repository access"),
      h("p", { className: "muted small" }, `This setup expires ${new Date(setup.expiresAt).toLocaleString()}. Capykit checks your administrator access again when you confirm.`),
      setup.candidates.length === 0 ? h("p", null, "No eligible installations were found. Install the Capykit GitHub App on repositories you administer, then start a new authorization.") : null,
      h("form", { onSubmit: (event) => { void confirm(event); } },
        h("label", { htmlFor: "github-installation" }, "GitHub account", h("select", { id: "github-installation", value: installationId, disabled, required: true, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { setInstallationId(event.currentTarget.value); setRepositoryIds([]); setConsent(false); } }, h("option", { value: "" }, "Choose an installation"), ...setup.candidates.map((entry) => h("option", { key: entry.installationId, value: entry.installationId }, `${entry.account.login} (${entry.account.type})`)))),
        candidate === undefined ? null : h("fieldset", { className: "repository-picker", disabled }, h("legend", null, "Repositories"), candidate.repositories.length === 0 ? h("p", { className: "muted" }, "No repositories are available for this installation.") : null,
          ...candidate.repositories.map((repo) => h("label", { key: repo.id, className: "checkbox-label" }, h("input", { type: "checkbox", disabled: disabled || !repo.admin, checked: repositoryIds.includes(repo.id), onChange: (event) => { const checked = event.currentTarget.checked; setRepositoryIds((current) => checked ? [...current, repo.id] : current.filter((id) => id !== repo.id)); setConsent(false); } }), h("span", null, repo.fullName, !repo.admin ? h("span", { className: "muted small" }, " — administrator access required") : null))),
        ),
        h("label", { className: "checkbox-label connection-consent" }, h("input", { type: "checkbox", checked: consent, disabled: disabled || repositoryIds.length === 0, onChange: (event) => { setConsent(event.currentTarget.checked); } }), h("span", null, "I authorize the Capykit GitHub App to read issues and metadata from these repositories for this workspace. Humans and agents explicitly granted access may use this connection without their own GitHub repository access. Publishing a function does not grant provider access.")),
        h("div", { className: "actions" }, h("button", { type: "submit", disabled: disabled || !consent || repositoryIds.length === 0 }, pending ? "Working…" : "Confirm connection"), h("button", { type: "button", className: "secondary", disabled, onClick: () => { void cancel(); } }, "Cancel setup")),
      ),
    ),
    loading ? null : h("div", { className: "library-layout" },
      h("nav", { className: "panel library-nav", "aria-label": "Connections" }, h("h2", null, "Your connections"), connections.length === 0 ? h("p", { className: "muted small" }, "No GitHub connections yet.") : h("ul", { className: "capability-list" }, ...connections.map((connection) => h("li", { key: connection.id }, h("button", { type: "button", className: `capability-item${selected?.id === connection.id ? " active" : ""}`, "aria-pressed": selected?.id === connection.id, disabled, onClick: () => { void open(connection.id); } }, h("strong", null, connection.account?.login ?? "GitHub setup"), h("span", { className: "small muted" }, statusLabels[connection.status])))))),
      selected === null ? h("section", { className: "panel empty-state" }, h("h2", null, "Repository access stays explicit"), h("p", { className: "muted" }, "Select a connection to review its repositories and status. Grants and function execution are the next steps after connecting GitHub.")) : h("section", { className: "panel connection-detail", "aria-label": "Connection details" },
        h("div", { className: "section-heading compact" }, h("h2", null, selected.account?.login ?? "GitHub setup"), h("span", { className: `status-badge${selected.status === "active" ? " connected" : ""}` }, statusLabels[selected.status])),
        h("p", { className: "muted" }, selected.status === "active" ? "This connection is ready for explicit access grants. Grants and execution are not available yet." : selected.status === "suspended" ? "This installation is suspended on GitHub. Resume it on GitHub and reconnect to verify access." : selected.status === "reconnect_required" ? "Repository access changed. Reconnect to verify the current repositories before this connection can be used." : selected.status === "revoked" ? "Capykit access is disabled for this connection." : "GitHub setup has not been confirmed."),
        h("h3", null, "Selected repositories"), selected.repositories.length === 0 ? h("p", { className: "muted" }, "No repositories are approved.") : h("ul", { className: "repository-list" }, ...selected.repositories.map((repo) => h("li", { key: repo.id }, githubLink(repo.url) === undefined ? repo.fullName : h("a", { href: githubLink(repo.url), target: "_blank", rel: "noopener noreferrer" }, repo.fullName)))),
        h("dl", null, h("dt", null, "Permissions"), h("dd", null, "Issues: read · Metadata: read"), h("dt", null, "Approved"), h("dd", null, selected.consentAt === null ? "Not confirmed" : new Date(selected.consentAt).toLocaleString()), selected.consentByPrincipalId == null ? null : h(React.Fragment, null, h("dt", null, "Approved by"), h("dd", null, selected.consentByPrincipalId)), h("dt", null, "Updated"), h("dd", null, new Date(selected.updatedAt).toLocaleString())),
        h("div", { className: "actions" }, configured ? h("button", { type: "button", className: "secondary", disabled: disabled || setup !== null, onClick: () => { setReconnecting(true); setDisconnecting(false); } }, selected.status === "active" ? "Review and reconnect" : "Reconnect") : null, selected.status === "revoked" ? null : h("button", { type: "button", className: "text-button danger-text", disabled, onClick: () => { setDisconnecting(true); setReconnecting(false); } }, "Disconnect")),
        reconnecting ? h("div", { className: "connection-confirm" }, h("p", null, "Starting a reconnect pauses use of this connection until you verify repository access and confirm again."), h("div", { className: "actions" }, h("button", { type: "button", disabled, onClick: () => { void start(selected.id); } }, "Continue to GitHub"), h("button", { type: "button", className: "secondary", disabled, onClick: () => { setReconnecting(false); } }, "Keep current connection"))) : null,
        disconnecting ? h("div", { className: "connection-confirm" }, h("p", null, "Disconnect this account from Capykit? Access stops immediately. The GitHub App stays installed until you uninstall it on GitHub."), h("div", { className: "actions" }, h("button", { type: "button", className: "danger", disabled, onClick: () => { void disconnect(); } }, "Confirm disconnect"), h("button", { type: "button", className: "secondary", disabled, onClick: () => { setDisconnecting(false); } }, "Cancel"))) : null,
        githubLink(selected.uninstallUrl) === undefined ? null : h("p", { className: "small github-manage" }, h("a", { href: githubLink(selected.uninstallUrl), target: "_blank", rel: "noopener noreferrer" }, "Manage or uninstall this app on GitHub")),
      ),
    ),
  );
}
