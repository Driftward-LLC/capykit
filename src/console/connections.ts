import React, { useEffect, useRef, useState } from "react";
import { sessionFetch, writeRequest } from "./session.js";

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
interface ProviderSetup { available: boolean; organization: string; }
type GitHubReturn = { callback: "/v1/connections/github/callback" | "/v1/provider-setup/github/callback"; code: string; state: string } | { notice: string };

// Strip OAuth material before any identity request, render, or later navigation.
let githubReturn: GitHubReturn | null = (() => {
  const url = new URL(window.location.href);
  if (url.pathname === "/v1/connections/github/setup") {
    window.history.replaceState(null, "", "/?tab=connections");
    return { notice: "Continue with GitHub to verify your account, then choose which repositories this workspace may use." };
  }
  if (url.pathname !== "/v1/connections/github/callback" && url.pathname !== "/v1/provider-setup/github/callback") return null;
  const providerSetup = url.pathname === "/v1/provider-setup/github/callback";
  window.history.replaceState(null, "", "/?tab=connections");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.has("error")) return { notice: providerSetup ? "GitHub App setup was not completed. You can start again when you are ready." : "GitHub authorization was not completed. You can start again when you are ready." };
  if (code === null || state === null || code.length === 0 || state.length === 0 || code.length > 4096 || state.length > 4096 || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length !== 1) return { notice: providerSetup ? "That GitHub App setup could not be verified. Start a new setup." : "That GitHub setup could not be verified. Start a new authorization." };
  return { callback: url.pathname, code, state };
})();

export function hasGitHubReturn(): boolean {
  return githubReturn !== null;
}

export function discardGitHubReturn(): boolean {
  const present = githubReturn !== null;
  githubReturn = null;
  return present;
}

const statusLabels: Record<Connection["status"], string> = {
  pending: "Setup unfinished", active: "Connected", suspended: "Suspended on GitHub", reconnect_required: "Reconnect required", revoked: "Disconnected",
};

function unfinishedConnection(connection: Connection): boolean {
  return connection.consentAt === null && (connection.status === "pending" || connection.status === "reconnect_required");
}

function connectionStatus(connection: Connection): string {
  return unfinishedConnection(connection) ? "Setup unfinished" : statusLabels[connection.status];
}
const errorMessages: Record<string, string> = {
  FORBIDDEN: "Only an active workspace owner can manage connections. GitHub setup also requires administrator access to each chosen repository.",
  NOT_FOUND: "This connection or setup is no longer available. Refresh connections or start a new authorization.",
  INVALID_REQUEST: "Check the selected installation and repositories, then try again.",
  CONFLICT: "This installation or setup changed, or the installation is connected to another workspace. Refresh and start a new authorization.",
  CONNECT_SETUP_EXPIRED: "Your GitHub review expired. Continue with GitHub to refresh it. No new repository access was approved.",
  CONNECT_STATE_INVALID: "This setup could not be verified. Start a new GitHub authorization.",
  GITHUB_NOT_CONFIGURED: "Your operator needs to configure a dedicated Capykit GitHub App before you can connect repositories.",
  GITHUB_SETUP_STATE_INVALID: "This GitHub App setup expired or could not be verified. Start a new setup from Connections.",
  GITHUB_SETUP_BUSY: "Another GitHub App setup is in progress. Complete it or wait for it to expire, then refresh and try again.",
  GITHUB_SETUP_FAILED: "GitHub App setup could not be completed. The app may already exist on GitHub. Ask your organization administrator to check for and remove an incomplete Capykit app before trying again.",
  GITHUB_ALREADY_CONFIGURED: "GitHub is already configured. Refresh connections, then continue with GitHub.",
  CONFIGURATION_UNAVAILABLE: "GitHub configuration is unavailable. Contact your workspace operator.",
  GITHUB_AUTHORIZATION_FAILED: "GitHub authorization could not be verified. Start a new authorization.",
  GITHUB_ACCESS_REVOKED: "GitHub access was revoked or is no longer available. Check the app installation and your repository permissions, then reconnect.",
  GITHUB_INSTALLATION_INVALID: "This installation is unavailable or does not meet the connection requirements. Use the Capykit GitHub App with selected repositories, then reconnect.",
  GITHUB_SELECTED_REPOSITORIES_REQUIRED: "The Capykit GitHub App is installed for All repositories. In GitHub, change Repository access to Only select repositories, choose at least one repository, and save. Then return here and choose Continue with GitHub.",
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

export function Connections({ onSessionExpired, active }: { onSessionExpired: () => void; active: boolean }): React.ReactElement {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [providerSetup, setProviderSetup] = useState<ProviderSetup | null>(null);
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
  const [checkingGitHub] = useState(() => hasGitHubReturn() || new URL(window.location.href).searchParams.has("setup"));
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const focusedSetup = useRef<string | null>(null);
  const candidate = setup?.candidates.find((entry) => entry.installationId === installationId);
  const unfinished = connections.filter(unfinishedConnection);
  const resumable = unfinished.length === 1 ? unfinished[0] : undefined;

  useEffect(() => {
    if (!active || loading || setup === null || focusedSetup.current === setup.setupId || document.visibilityState !== "visible") return;
    const heading = reviewHeading.current;
    if (heading === null || document.activeElement?.closest("form") !== null) return;
    heading.focus();
    focusedSetup.current = setup.setupId;
  }, [active, loading, setup]);

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
    const response = await checked(await sessionFetch("/v1/connections", { credentials: "same-origin", cache: "no-store" }));
    const result = await response.json() as { configured: boolean; setup: ProviderSetup | null; installationUrl: string | null; connections: Connection[] };
    setConnections(result.connections); setConfigured(result.configured); setProviderSetup(result.setup ?? null); setInstallationUrl(result.installationUrl);
    setSelected((previous) => previous === null ? null : result.connections.find((entry) => entry.id === previous.id) ?? null);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setPending(true); setError(""); setNotice("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "The request could not be completed. Try again."); }
    finally { setPending(false); }
  }

  function showSetup(value: Setup): void {
    setSetup(value); setSelected(null); setInstallationId(value.candidates.length === 1 ? value.candidates[0]?.installationId ?? "" : ""); setRepositoryIds([]); setConsent(false);
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
          const request = writeRequest(returned.callback, "POST", { code: returned.code, state: returned.state });
          returned.code = ""; returned.state = "";
          const response = await checked(await request);
          if (returned.callback === "/v1/provider-setup/github/callback") {
            const value = await response.json() as { configured: unknown };
            if (value.configured !== true) throw new Error(errorMessages.GITHUB_SETUP_FAILED);
            if (!controller.signal.aborted) setNotice("The Capykit GitHub App is ready. Continue with GitHub to verify your account and review repository access.");
          } else {
            const value = await response.json() as Setup;
            if (!controller.signal.aborted) showSetup(value);
          }
        } else if (returned !== null) {
          if (!controller.signal.aborted) setNotice(returned.notice);
        } else if (setupId !== null) {
          if (!/^[a-f0-9-]{36}$/i.test(setupId)) { setupInUrl(); throw new Error("That setup link is invalid. Start a new GitHub authorization."); }
          const response = await checked(await sessionFetch(`/v1/connections/github/pending/${encodeURIComponent(setupId)}`, { credentials: "same-origin", cache: "no-store" }));
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

  async function startProviderSetup(): Promise<void> {
    if (configured !== false || providerSetup?.available !== true) return;
    await run(async () => {
      const response = await checked(await writeRequest("/v1/provider-setup/github/start", "POST", {}));
      const value = await response.json() as { registrationUrl: string; manifest: unknown };
      let url: URL;
      try { url = new URL(value.registrationUrl); }
      catch { throw new Error(errorMessages.GITHUB_SETUP_FAILED); }
      if (url.origin !== "https://github.com" || url.username !== "" || url.password !== "" || url.pathname !== `/organizations/${encodeURIComponent(providerSetup.organization)}/settings/apps/new` || url.hash !== "" || url.searchParams.getAll("state").length !== 1 || !url.searchParams.get("state") || [...url.searchParams.keys()].some((key) => key !== "state") || value.manifest === null || typeof value.manifest !== "object" || Array.isArray(value.manifest)) {
        throw new Error(errorMessages.GITHUB_SETUP_FAILED);
      }
      // GitHub accepts the manifest through a browser form; credentials return only to the server.
      const form = document.createElement("form");
      form.method = "POST"; form.action = url.href; form.hidden = true;
      const manifest = document.createElement("input");
      manifest.type = "hidden"; manifest.name = "manifest"; manifest.value = JSON.stringify(value.manifest);
      form.append(manifest); document.body.append(form);
      try { form.submit(); }
      catch { form.remove(); throw new Error("GitHub App registration could not open. Refresh and try again."); }
    });
  }

  async function start(connectionId?: string): Promise<void> {
    await run(async () => {
      const existingId = connectionId ?? setup?.connectionId ?? resumable?.id;
      if (existingId === undefined && unfinished.length > 1) throw new Error("Select an unfinished setup under Your connections, then choose Continue with GitHub.");
      const response = await checked(await writeRequest("/v1/connections/github/start", "POST", existingId === undefined ? {} : { connectionId: existingId }));
      const value = await response.json() as { authorizationUrl: string };
      const url = githubLink(value.authorizationUrl);
      if (url === undefined) throw new Error("GitHub authorization is unavailable. Contact your workspace operator.");
      window.location.assign(url);
    });
  }

  async function open(id: string): Promise<void> {
    await run(async () => {
      const response = await checked(await sessionFetch(`/v1/connections/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" }));
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
      await refresh(); setSelected(value); setNotice("GitHub is connected to the repositories you selected.");
    });
  }

  async function cancel(): Promise<void> {
    if (setup === null) return;
    await run(async () => {
      const response = await writeRequest(`/v1/connections/github/pending/${encodeURIComponent(setup.setupId)}`, "DELETE");
      // An expired or already-removed setup needs no further server cleanup.
      if (response.status !== 404 && response.status !== 410) await checked(response);
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
  const selectedUnfinished = selected !== null && unfinishedConnection(selected);
  const installationBlocked = error === errorMessages.GITHUB_SELECTED_REPOSITORIES_REQUIRED;
  const reviewExpired = error === errorMessages.CONNECT_SETUP_EXPIRED;
  const reviewing = setup !== null && setup.candidates.length > 0 && !reviewExpired;
  const manageAccess = installLink === undefined ? null : h("a", { className: "button-link secondary", href: installLink, target: "_blank", rel: "noopener noreferrer" }, "Manage GitHub access", h("span", { className: "small" }, " ↗"));
  const progress = h("ol", { className: "connection-progress", "aria-label": "Connection progress" },
    h("li", { "aria-current": reviewing ? undefined : "step", className: reviewing ? "complete" : "current" }, reviewing ? "✓ GitHub verified" : "1. Continue with GitHub"),
    h("li", { "aria-current": reviewing ? "step" : undefined, className: reviewing ? "current" : "" }, "2. Approve workspace access"),
  );
  const installationHelp = h("details", { className: "connection-help" },
    h("summary", null, "Need to install the GitHub App?"),
    h("p", { className: "small muted" }, "In GitHub, install or configure the Capykit GitHub App. Choose Only select repositories, select repositories you administer, and save. Then return here to continue. All repositories is not supported in this preview."),
    manageAccess,
  );
  const continueSetup = (connectionId?: string): React.ReactElement => h("button", { type: "button", disabled, onClick: () => { void start(connectionId); } }, pending ? "Opening GitHub…" : "Continue with GitHub");
  return h("section", { className: "connections", "aria-label": "GitHub connections", "aria-busy": disabled },
    h("div", { className: "section-heading" },
      h("div", null, h("p", { className: "eyebrow" }, "Workspace connections"), h("h1", null, "Connect GitHub"), h("p", { className: "muted" }, "Choose which repositories Capykit can read for this workspace.")),
      setup !== null || selectedUnfinished || resumable !== undefined || loading ? null : h("button", { type: "button", className: "text-button", disabled, onClick: () => { void run(refresh); } }, "Refresh connections"),
    ),
    error === "" ? null : h("p", { className: "message error", role: "alert" }, error),
    notice === "" ? null : h("p", { className: "message success", role: "status" }, notice),
    loading ? h("section", { className: "panel connection-intro", role: "status" }, h("h2", null, checkingGitHub ? "Checking your GitHub access…" : "Loading connections…"), checkingGitHub ? h("p", { className: "muted" }, "You’ll review repository access here before anything is connected.") : null) : configured === null ? h("section", { className: "panel connection-intro", "aria-label": "Connection status unavailable" },
      h("h2", null, "Could not load connection status"), h("p", { className: "muted" }, "Retry to check whether GitHub is ready to connect."),
      h("button", { type: "button", disabled, onClick: () => { void run(refresh); } }, "Retry connection status"),
    ) : configured ? setup !== null || selected !== null ? null : h("section", { className: "panel connection-intro", "aria-label": "Connect GitHub" },
      progress,
      h("h2", null, installationBlocked ? "Choose repositories on GitHub" : resumable === undefined ? "Connect your GitHub account" : "Finish connecting GitHub"),
      installationBlocked ? h(React.Fragment, null,
        h("p", { className: "muted" }, "Open your GitHub App settings, choose Only select repositories, and save your selection. Then return here to continue."),
        h("div", { className: "actions" }, manageAccess, unfinished.length > 1 ? null : continueSetup()),
      ) : h(React.Fragment, null,
        h("p", { className: "muted" }, unfinished.length > 1 ? "Choose an unfinished setup under Your connections to continue where you left off." : "GitHub will ask you to authorize Capykit. You’ll return here to choose repositories and approve access for this workspace."),
        unfinished.length > 1 ? null : continueSetup(),
        h("p", { className: "small muted connection-permissions" }, "Read access to issues and repository metadata. Nothing is connected until you confirm."),
        installationHelp,
      ),
    ) : h("section", { className: "panel connection-intro", "aria-label": "GitHub setup required" },
      h("h2", null, "Set up GitHub"),
      providerSetup?.available === true ? h(React.Fragment, null,
        h("p", { className: "muted" }, `Create the dedicated Capykit GitHub App for ${providerSetup.organization}. GitHub will ask an authorized organization administrator to approve its creation. Capykit saves the app credentials securely when you return.`),
        h("p", { className: "small muted" }, "After setup, install the app on selected repositories and approve their access here. Permissions: read issues and repository metadata."),
        h("button", { type: "button", disabled, onClick: () => { void startProviderSetup(); } }, "Set up GitHub"),
      ) : h("p", { className: "muted" }, providerSetup === null ? "Your operator needs to enable GitHub App setup for this Capykit deployment. Once enabled, they can create the app here and you can connect selected repositories." : "Only this deployment’s designated operator can set up the GitHub App. Ask them to open Connections and complete setup, then refresh to connect your repositories."),
    ),
    setup === null ? null : h("section", { className: "panel connection-setup", "aria-label": "Review GitHub connection" },
      progress,
      h("h2", { ref: reviewHeading, tabIndex: -1 }, reviewExpired ? "Review expired" : setup.candidates.length === 0 ? "No repositories are ready to connect" : "Choose repositories for this workspace"),
      reviewExpired ? h(React.Fragment, null,
        h("p", { className: "muted" }, "Continue with GitHub to get a fresh repository list, then review access again."),
        h("div", { className: "actions" }, continueSetup(setup.connectionId), h("button", { type: "button", className: "text-button", disabled, onClick: () => { void cancel(); } }, "Cancel setup")),
      ) : setup.candidates.length === 0 ? h(React.Fragment, null,
        h("p", null, "GitHub authorization succeeded, but no repositories you administer are available to Capykit. No connection has been approved."),
        h("p", { className: "muted" }, "Open the GitHub App installation, choose Only select repositories, select at least one repository you administer, and save. If it already uses selected repositories, check that you authorized the GitHub account with administrator access."),
        h("p", { className: "small muted" }, "Then return here and continue with GitHub to review the updated list."),
        h("div", { className: "actions" }, manageAccess, continueSetup(setup.connectionId), h("button", { type: "button", className: "text-button", disabled, onClick: () => { void cancel(); } }, "Cancel setup")),
      ) : h("form", { onSubmit: (event) => { void confirm(event); } },
        setup.candidates.length === 1 ? h("p", { className: "connection-verified" }, h("strong", null, "GitHub verified. "), `Repositories from ${candidate?.account.login ?? "your GitHub account"} are ready to review.`) : h("label", { htmlFor: "github-installation" }, "Choose a GitHub account", h("select", { id: "github-installation", value: installationId, disabled, required: true, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { setInstallationId(event.currentTarget.value); setRepositoryIds([]); setConsent(false); } }, h("option", { value: "" }, "Choose a GitHub account"), ...setup.candidates.map((entry) => h("option", { key: entry.installationId, value: entry.installationId }, `${entry.account.login} (${entry.account.type})`)))),
        h("p", { id: "repository-instructions", className: "muted" }, "Select the repositories this workspace may use. Capykit can read their issues and metadata; it cannot write to them."),
        candidate === undefined ? null : h("fieldset", { className: "repository-picker", disabled, "aria-describedby": "repository-instructions" }, h("legend", null, "Repositories"), candidate.repositories.length === 0 ? h("p", { className: "muted" }, "No repositories are available for this installation.") : null,
          ...candidate.repositories.map((repo) => h("label", { key: repo.id, className: "checkbox-label" }, h("input", { type: "checkbox", disabled: disabled || !repo.admin, checked: repositoryIds.includes(repo.id), onChange: (event) => { const checked = event.currentTarget.checked; setRepositoryIds((current) => checked ? [...current, repo.id] : current.filter((id) => id !== repo.id)); setConsent(false); } }), h("span", null, repo.fullName, !repo.admin ? h("span", { className: "muted small" }, " — administrator access required") : null))),
        ),
        h("p", { className: "small muted", role: "status" }, `${String(repositoryIds.length)} ${repositoryIds.length === 1 ? "repository" : "repositories"} selected.`, repositoryIds.length === 0 ? " Select at least one to continue." : !consent ? " Approve workspace access below to connect." : " Ready to connect."),
        repositoryIds.length === 0 ? null : h("div", { className: "connection-consent" },
          h("label", { className: "checkbox-label" }, h("input", { type: "checkbox", checked: consent, disabled, "aria-describedby": "connection-disclosure", onChange: (event) => { setConsent(event.currentTarget.checked); } }), h("span", null, "I approve read access to these repositories for this workspace.")),
          h("p", { id: "connection-disclosure", className: "small muted" }, "Humans and agents explicitly granted access may use this connection without their own GitHub repository access. Publishing a function does not grant provider access."),
        ),
        h("div", { className: "actions" }, h("button", { type: "submit", disabled: disabled || !consent || repositoryIds.length === 0 }, pending ? "Connecting…" : "Confirm connection"), h("button", { type: "button", className: "text-button", disabled, onClick: () => { void cancel(); } }, "Cancel setup")),
        h("details", { className: "connection-help" }, h("summary", null, "Missing a repository?"),
          h("p", { className: "small muted" }, "Manage the GitHub App’s selected repositories and save your changes. You need administrator access to each repository. Then check again to refresh this list."),
          h("div", { className: "actions" }, manageAccess, h("button", { type: "button", className: "secondary", disabled, onClick: () => { void start(setup.connectionId); } }, "Check again")),
        ),
      ),
    ),
    loading || configured === null || setup !== null || connections.length === 0 ? null : h("div", { className: `library-layout${selected === null ? " connection-list-only" : ""}` },
      h("nav", { className: "panel library-nav", "aria-label": "Connections" }, h("h2", null, "Your connections"), h("ul", { className: "capability-list" }, ...connections.map((connection) => h("li", { key: connection.id }, h("button", { type: "button", className: `capability-item${selected?.id === connection.id ? " active" : ""}`, "aria-pressed": selected?.id === connection.id, disabled, onClick: () => { void open(connection.id); } }, h("strong", null, connection.account?.login ?? "GitHub setup"), h("span", { className: "small muted" }, connectionStatus(connection))))))),
      selected === null ? null : h("section", { className: "panel connection-detail", "aria-label": "Connection details" },
        h("button", { type: "button", className: "text-button connection-back", disabled, onClick: () => { setSelected(null); setDisconnecting(false); setReconnecting(false); } }, "← Back to connections"),
        selectedUnfinished ? h(React.Fragment, null,
          progress,
          h("div", { className: "section-heading compact" }, h("h2", null, "Finish setup"), h("span", { className: "status-badge" }, "Setup unfinished")),
          h("p", { className: "muted" }, "Continue with GitHub to verify your account. You’ll return here to choose repositories and approve access. No repository access has been approved yet."),
          installationBlocked ? h("p", null, manageAccess) : null,
          configured ? continueSetup(selected.id) : null,
          installationHelp,
          h("details", null, h("summary", null, "Cancel this setup"), h("p", { className: "small muted" }, "You can discard this unfinished setup. No repository access has been approved."), h("button", { type: "button", className: "text-button danger-text", disabled, onClick: () => { setDisconnecting(true); setReconnecting(false); } }, "Discard setup")),
        ) : h(React.Fragment, null,
          h("div", { className: "section-heading compact" }, h("h2", null, selected.account?.login ?? "GitHub setup"), h("span", { className: `status-badge${selected.status === "active" ? " connected" : ""}` }, connectionStatus(selected))),
          h("p", { className: "muted" }, selected.status === "active" ? "This connection is ready for explicit access grants. Grants and execution are not available yet." : selected.status === "suspended" ? "This installation is suspended on GitHub. Resume it on GitHub and reconnect to verify access." : selected.status === "reconnect_required" ? "Repository access changed. Reconnect to verify the current repositories before this connection can be used." : "Capykit access is disabled for this connection."),
          h("h3", null, "Selected repositories"), selected.repositories.length === 0 ? h("p", { className: "muted" }, "No repositories are approved.") : h("ul", { className: "repository-list" }, ...selected.repositories.map((repo) => h("li", { key: repo.id }, githubLink(repo.url) === undefined ? repo.fullName : h("a", { href: githubLink(repo.url), target: "_blank", rel: "noopener noreferrer" }, repo.fullName)))),
          h("dl", null, h("dt", null, "Permissions"), h("dd", null, "Issues: read · Metadata: read"), h("dt", null, "Approved"), h("dd", null, selected.consentAt === null ? "Not confirmed" : new Date(selected.consentAt).toLocaleString()), selected.consentByPrincipalId == null ? null : h(React.Fragment, null, h("dt", null, "Approved by"), h("dd", null, selected.consentByPrincipalId)), h("dt", null, "Updated"), h("dd", null, new Date(selected.updatedAt).toLocaleString())),
          h("div", { className: "actions" }, configured ? h("button", { type: "button", className: "secondary", disabled, onClick: () => { setReconnecting(true); setDisconnecting(false); } }, selected.status === "active" ? "Review and reconnect" : "Reconnect") : null, selected.status === "revoked" ? null : h("button", { type: "button", className: "text-button danger-text", disabled, onClick: () => { setDisconnecting(true); setReconnecting(false); } }, "Disconnect")),
        ),
        reconnecting ? h("div", { className: "connection-confirm" }, h("p", null, "Starting a reconnect pauses use of this connection until you verify repository access and confirm again."), h("div", { className: "actions" }, h("button", { type: "button", disabled, onClick: () => { void start(selected.id); } }, "Continue with GitHub"), h("button", { type: "button", className: "secondary", disabled, onClick: () => { setReconnecting(false); } }, "Keep current connection"))) : null,
        disconnecting ? h("div", { className: "connection-confirm" }, h("p", null, selectedUnfinished ? "Discard this unfinished setup? No repository access has been approved. The GitHub App will stay installed." : "Disconnect this account from Capykit? Access stops immediately. The GitHub App stays installed until you uninstall it on GitHub."), h("div", { className: "actions" }, h("button", { type: "button", className: "danger", disabled, onClick: () => { void disconnect(); } }, selectedUnfinished ? "Confirm discard" : "Confirm disconnect"), h("button", { type: "button", className: "secondary", disabled, onClick: () => { setDisconnecting(false); } }, "Cancel"))) : null,
        githubLink(selected.uninstallUrl) === undefined || selectedUnfinished ? null : h("p", { className: "small github-manage" }, h("a", { href: githubLink(selected.uninstallUrl), target: "_blank", rel: "noopener noreferrer" }, "Manage or uninstall this app on GitHub")),
      ),
    ),
  );
}
