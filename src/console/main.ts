import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CapabilityLibrary } from "./library.js";
import { sessionFetch, writeRequest, setPublicSignupSession } from "./session.js";
import { discardGitHubReturn, hasGitHubReturn } from "./connections.js";
import { Apps, discardGoogleReturn } from "./apps.js";
import { Access } from "./access.js";
import { ActionAccess } from "./action-access.js";
import { ActionConsole } from "./actions.js";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { Grid2X2, Users, Zap, CodeXml, ShieldCheck } from "lucide-react";
import { readAppearance, saveAppearance } from "./theme.js";
import "./shell.css";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./fonts.css";
import "./style.css";

interface CurrentUser {
  readonly identity: { readonly email: string; readonly principalKind: string };
  readonly workspace: { readonly id: string; readonly role: string };
}

async function post(path: string, body?: unknown): Promise<Response> {
  return writeRequest(path, "POST", body ?? {});
}

type SignInMethod = "email" | "tailscale" | "google";
async function signInMethod(): Promise<{ method: SignInMethod; available: boolean }> {
  const response = await sessionFetch("/v1/auth/method");
  if (response.status === 404) { setPublicSignupSession(false); return { method: "email", available: true }; }
  if (!response.ok) throw new Error("sign-in unavailable");
  const result = await response.json() as { method?: unknown; available?: unknown };
  if (result.method !== "email" && result.method !== "tailscale" && result.method !== "google") throw new Error("sign-in unavailable");
  setPublicSignupSession(result.method === "google");
  return { method: result.method, available: result.method === "google" ? result.available === true : true };
}

function callbackError(): string {
  const url = new URL(window.location.href);
  const googleError = url.searchParams.get("auth");
  if (googleError?.startsWith("google-")) {
    window.history.replaceState(null, "", url.pathname);
    return googleError === "google-cancelled" ? "Google sign-in was cancelled. You can try again." : googleError === "google-expired" ? "Your sign-in attempt expired. Continue with Google to start again." : "Google sign-in could not be completed. Please try again.";
  }
  if (!url.searchParams.has("error") && !new URLSearchParams(url.hash.slice(1)).has("error")) return "";
  window.history.replaceState(null, "", url.pathname);
  return "That sign-in link expired or could not be verified. Request a new email code below.";
}

function App(): React.ReactElement {
  const [appearance, setAppearance] = useState(readAppearance);
  const [tab, setTab] = useState(["capabilities", "connections", "agents", "actions", "access"].includes(new URL(window.location.href).searchParams.get("tab") ?? "") ? new URL(window.location.href).searchParams.get("tab") ?? "capabilities" : "connections");
  const [createFunctionRequest, setCreateFunctionRequest] = useState(0);
  const [githubNotice, setGitHubNotice] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeRequested, setCodeRequested] = useState(false);
  const [authMethod, setAuthMethod] = useState<SignInMethod>("email");
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [identityResolved, setIdentityResolved] = useState(false);
  const [returningFromGitHub] = useState(hasGitHubReturn);
  const [pending, setPending] = useState<"session" | "otp" | "verify" | "logout" | "google" | null>("session");
  const [status, setStatus] = useState("Checking your session…");
  const [error, setError] = useState(callbackError);

  const loadIdentity = useCallback(async (initial = false): Promise<void> => {
    // Keep the library mounted while focus checks renew the identity display.
    setPending("session");
    if (initial) setStatus("Checking your session…");
    try {
      const method = initial ? await signInMethod() : undefined;
      if (method !== undefined) { setAuthMethod(method.method); setGoogleAvailable(method.available); }
      let response = await sessionFetch("/v1/me");
      if (response.status === 401 && initial) {
        if (method?.method === "tailscale") {
          // A new session cannot resume an authorization bound to the previous browser session.
          discardGoogleReturn(); discardGitHubReturn();
          const connected = await post("/v1/auth/tailscale");
          if (connected.status === 401) {
            setCurrentUser(null); setIdentityResolved(true);
            setStatus("Connect to Tailscale with your invited account to open this workspace.");
            setError("This device’s Tailscale identity does not have access to this workspace.");
            return;
          }
          if (!connected.ok) throw new Error("sign-in unavailable");
          response = await sessionFetch("/v1/me");
        }
      }
      if (response.status === 401) {
        discardGoogleReturn();
        if (discardGitHubReturn()) setGitHubNotice("GitHub setup needs an existing signed-in session. Sign in below, then start a new GitHub authorization from Connections.");
        const url = new URL(window.location.href);
        url.searchParams.delete("setup");
        window.history.replaceState(null, "", `${url.pathname}${url.search}`);
        setCurrentUser(null);
        setIdentityResolved(true);
        setStatus(initial ? (method?.method === "google" ? "Sign up or sign in with your Google account." : "Sign in with your invited email address.") : "Your session expired or access is no longer available. Sign in again.");
      } else if (!response.ok) {
        throw new Error("session unavailable");
      } else {
        const user = await response.json() as CurrentUser;
        if ((user.identity.principalKind !== "human" || user.workspace.role !== "owner") && discardGitHubReturn()) setGitHubNotice("Only a workspace owner can manage GitHub connections. This authorization was discarded.");
        if (user.identity.principalKind !== "human" || user.workspace.role !== "owner") discardGoogleReturn();
        setCurrentUser(user);
        setIdentityResolved(true);
        setStatus("You are signed in.");
        setError("");
      }
    } catch {
      setStatus("");
      setError("Could not check your session. Check your connection and retry.");
    } finally {
      setPending(null);
    }
  }, []);

  const sessionExpired = useCallback((): void => {
    discardGitHubReturn(); discardGoogleReturn();
    const url = new URL(window.location.href);
    url.searchParams.delete("setup");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    setCurrentUser(null);
    setIdentityResolved(true);
    setStatus("Your session expired or access is no longer available. Sign in again.");
    setError("");
  }, []);

  useEffect(() => { void loadIdentity(true); }, [loadIdentity]);
  useEffect(() => {
    const refresh = (): void => {
      if (currentUser !== null && pending === null && document.visibilityState === "visible") void loadIdentity();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [currentUser, loadIdentity, pending]);

  async function continueWithGoogle(): Promise<void> {
    setPending("google"); setError("");
    try {
      const response = await post("/v1/auth/google/start");
      if (!response.ok) throw new Error("Google unavailable");
      const body = await response.json() as { authorizationUrl: string };
      const url = new URL(body.authorizationUrl);
      if (url.origin !== "https://accounts.google.com" || url.username || url.password) throw new Error("Google unavailable");
      window.location.assign(url.href);
    } catch { setError("Google sign-in is temporarily unavailable. Please try again."); setPending(null); }
  }

  async function requestCode(event: React.SubmitEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    setPending("otp");
    setError("");
    setStatus("Requesting your sign-in code…");
    try {
      const response = await post("/v1/auth/otp", { email: email.trim() });
      if (!response.ok) throw new Error("code request failed");
      setCodeRequested(true);
      setCode("");
      setStatus("If that email is invited, a six-digit sign-in code will arrive shortly. Enter it below.");
    } catch {
      setStatus("");
      setError("Could not request a code. Check your connection and try again.");
    } finally {
      setPending(null);
    }
  }

  async function verifyCode(event: React.SubmitEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    setPending("verify");
    setError("");
    setStatus("Verifying your code…");
    try {
      const response = await post("/v1/auth/verify", { email: email.trim(), token: code });
      if (response.status === 401 || response.status === 400) {
        setStatus("");
        setError("That code is invalid or expired, or access is unavailable. Check the code or request a new one.");
      } else if (!response.ok) {
        throw new Error("verification failed");
      } else {
        setCode("");
        setCodeRequested(false);
        await loadIdentity();
      }
    } catch {
      setStatus("");
      setError("Could not verify your code. Check your connection and try again.");
    } finally {
      setPending(null);
    }
  }

  async function logout(): Promise<void> {
    setPending("logout");
    setError("");
    try {
      const response = await post("/v1/auth/logout");
      if (!response.ok) throw new Error("logout failed");
      discardGitHubReturn(); discardGoogleReturn();
      const url = new URL(window.location.href);
      url.searchParams.delete("setup");
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
      setCurrentUser(null);
      setIdentityResolved(true);
      setCodeRequested(false);
      setCode("");
      setStatus("You are signed out.");
    } catch {
      setError("Could not sign out. Check your connection and try again.");
    } finally {
      setPending(null);
    }
  }

  const h = React.createElement;
  const disabled = pending !== null;
  function navigationButton(name: string): React.ReactElement {
    const label = name === "capabilities" ? "Functions" : name === "connections" ? "Apps" : name === "agents" ? "Agents" : name === "actions" ? "Actions" : "People access";
    const icon = name === "connections" ? Grid2X2 : name === "agents" ? Users : name === "actions" ? Zap : name === "capabilities" ? CodeXml : ShieldCheck;
    return h(Button, { key: name, type: "button", label, variant: tab === name ? "secondary" : "ghost", icon: h(Icon, { icon }), "aria-current": tab === name ? "page" : undefined, onClick: () => { setTab(name); setGitHubNotice(""); const url = new URL(window.location.href); url.searchParams.set("tab", name); if (name !== "connections") url.searchParams.delete("setup"); window.history.replaceState(null, "", `${url.pathname}${url.search}`); } });
  }
  return h(Theme, { theme: neutralTheme, mode: appearance, children: h("main", { className: "console", "aria-busy": disabled },
    h("header", { className: "app-header" },
      h("span", { className: "wordmark" }, "Capykit", h(Badge, { label: "Preview" })),
      h("div", { className: "header-controls" },
        h("label", { className: "appearance", htmlFor: "appearance" }, "Appearance", h("select", { id: "appearance", value: appearance, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { const value = event.currentTarget.value; if (value !== "light" && value !== "dark" && value !== "system") return; setAppearance(value); saveAppearance(value); } }, h("option", { value: "system" }, "System"), h("option", { value: "light" }, "Light"), h("option", { value: "dark" }, "Dark"))),
        currentUser === null ? null : h("div", { className: "account" }, h("span", null, currentUser.identity.email), h(Button, { type: "button", label: pending === "logout" ? "Signing out…" : "Sign out", isDisabled: disabled, onClick: () => { void logout(); } })),
      ),
    ),
    error === "" ? null : h(Banner, { className: "shell-notice", status: "error", role: "alert", title: error }),
    githubNotice === "" ? null : h(Banner, { className: "shell-notice", status: "info", role: "status", title: githubNotice }),
    currentUser === null && !identityResolved ? h(Card, { className: "sign-in", role: "region", "aria-label": "Checking your session" },
      h("p", { className: "eyebrow" }, returningFromGitHub ? "GitHub connection" : "Your workspace"),
      h("h1", null, error !== "" ? "Let’s try that again" : returningFromGitHub ? "Returning from GitHub…" : "Opening your workspace…"),
      h("p", { className: "muted", role: "status", "aria-live": "polite" }, error !== "" ? "Your session could not be checked. Retry to continue." : returningFromGitHub ? "Checking your session before continuing GitHub setup." : "Checking your session…"),
      error === "" ? null : h(Button, { type: "button", isDisabled: disabled, label: pending === "session" ? "Checking…" : "Retry session check", onClick: () => { setError(""); void loadIdentity(true); } }),
    ) : currentUser === null ? h(Card, { className: "sign-in", role: "region", "aria-label": "Sign in" },
      h("p", { className: "eyebrow" }, "Your capabilities, together"),
      h("h1", null, "Welcome to Capykit"),
      h("p", { className: "muted", role: "status", "aria-live": "polite" }, status),
      authMethod === "google" ? h(React.Fragment, null,
        h("p", { className: "muted" }, "Create your own workspace. No invitation needed."),
        googleAvailable ? h(Button, { type: "button", isDisabled: disabled, variant: "primary", label: pending === "google" ? "Opening Google…" : "Continue with Google", onClick: () => { void continueWithGoogle(); } }) : h(React.Fragment, null,
          h(Banner, { status: "info", role: "status", title: "Google sign-in is temporarily unavailable. Please try again shortly." }),
          h(Button, { type: "button", isDisabled: disabled, label: "Try again", onClick: () => { void loadIdentity(true); } }),
        ),
        h("p", { className: "small muted" }, "Sign-in uses your name and email. Connecting Google Drive is a separate step."),
        h("p", { className: "small muted" }, "Stay signed in for 30 days between visits."),
      ) : authMethod === "tailscale" ? h(React.Fragment, null,
        h("p", { className: "small muted" }, "Use your connected Tailscale account. No email code needed."),
        h(Button, { type: "button", isDisabled: disabled, variant: "primary", label: pending === "session" ? "Opening workspace…" : "Continue with Tailscale", onClick: () => { setError(""); void loadIdentity(true); } }),
      ) : h(React.Fragment, null,
      h("p", { className: "small muted" }, "Stay signed in for 30 days between visits."),
      h("form", { onSubmit: (event) => { void requestCode(event); } },
        h("label", { htmlFor: "email" }, "Invited email address"),
        h("input", {
          id: "email", name: "email", type: "email", autoComplete: "email", required: true,
          value: email, disabled,
          onChange: (event) => { setEmail(event.currentTarget.value); setCodeRequested(false); setCode(""); },
        }),
        h(Button, { type: "submit", isDisabled: disabled, variant: codeRequested ? "secondary" : "primary", label: pending === "otp" ? "Sending…" : codeRequested ? "Send a new code" : "Send sign-in code" }),
      ),
      codeRequested ? h("form", { onSubmit: (event) => { void verifyCode(event); } },
        h("label", { htmlFor: "code" }, "Six-digit sign-in code"),
        h("input", {
          id: "code", name: "code", type: "text", inputMode: "numeric", autoComplete: "one-time-code",
          pattern: "[0-9]{6}", maxLength: 6, minLength: 6, required: true,
          value: code, disabled, onChange: (event) => { setCode(event.currentTarget.value); },
        }),
        h(Button, { type: "submit", isDisabled: disabled, variant: "primary", label: pending === "verify" ? "Verifying…" : "Sign in" }),
      ) : null,
      ),
      error === "" ? null : h(Button, { type: "button", isDisabled: disabled, label: "Retry session check", onClick: () => { void loadIdentity(); } }),
    ) : h(React.Fragment, null,
      currentUser.identity.principalKind === "human"
        ? h(React.Fragment, { key: `${currentUser.workspace.id}:${currentUser.identity.email}` },
          h("nav", { className: "workspace-nav", "aria-label": "Workspace" },
            ...(currentUser.workspace.role === "owner" ? ["connections", "agents", "actions"] : ["connections", "actions"]).map(navigationButton),
          ),
          h("details", { className: "workspace-tools", open: tab === "capabilities" || tab === "access" }, h("summary", null, currentUser.workspace.role === "owner" ? "Functions & people access" : "Functions"), h("nav", { className: "secondary-nav", "aria-label": "Workspace tools" }, ...(currentUser.workspace.role === "owner" ? ["capabilities", "access"] : ["capabilities"]).map(navigationButton))),
          h("div", { className: "legacy-route", hidden: tab !== "capabilities" }, h(CapabilityLibrary, { createFunctionRequest, onSessionExpired: sessionExpired, manage: currentUser.workspace.role === "owner" })),
          h("div", { className: "astryx-route", hidden: tab !== "connections" }, h(Apps, { manage:currentUser.workspace.role === "owner", onSessionExpired: sessionExpired, active: tab === "connections", onManageAgents: () => { setTab("agents"); const url = new URL(window.location.href); url.searchParams.set("tab", "agents"); url.searchParams.delete("setup"); window.history.replaceState(null, "", `${url.pathname}${url.search}`); }, onCreateFunction: () => { setCreateFunctionRequest(value => value + 1); setTab("capabilities"); const url = new URL(window.location.href); url.searchParams.set("tab","capabilities"); url.searchParams.delete("setup"); window.history.replaceState(null,"",`${url.pathname}${url.search}`); } })),
          currentUser.workspace.role !== "owner" ? null : h("div", { className: "astryx-route", hidden: tab !== "agents" }, h(ActionAccess, { onSessionExpired: sessionExpired, active: tab === "agents", onOpenApps: () => { setTab("connections"); const url = new URL(window.location.href); url.searchParams.set("tab", "connections"); window.history.replaceState(null, "", `${url.pathname}${url.search}`); } })),
          tab === "actions" ? h("div", { className: "legacy-route" }, h(ActionConsole, { onSessionExpired: sessionExpired })) : null,
          currentUser.workspace.role !== "owner" ? null : h("div", { className: "legacy-route", hidden: tab !== "access" }, h(Access, { onSessionExpired: sessionExpired, active: tab === "access" })),
        )
        : h("section", { className: "legacy-route panel", "aria-label": "Capability access" }, h("h1", null, "Your workspace"), h("p", null, "Your account is active. Capability access is currently available to workspace owners. Member and agent access will become available through grants.")),
      h("details", { className: "workspace-details", "aria-label": "Current identity and workspace" }, h("summary", null, "Workspace and account details"),
      h("dl", null,
        h("dt", null, "Signed in as"), h("dd", null, currentUser.identity.email),
        h("dt", null, "Identity type"), h("dd", null, currentUser.identity.principalKind),
        h("dt", null, "Workspace"), h("dd", null, currentUser.workspace.id),
        h("dt", null, "Role"), h("dd", null, currentUser.workspace.role),
      ),
      ),
    ),
  ) });
}

createRoot(document.getElementById("root") as HTMLElement).render(React.createElement(App));
