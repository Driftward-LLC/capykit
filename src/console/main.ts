import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CapabilityLibrary, writeRequest } from "./library.js";
import "./style.css";

interface CurrentUser {
  readonly identity: { readonly email: string; readonly principalKind: string };
  readonly workspace: { readonly id: string; readonly role: string };
}

async function post(path: string, body?: unknown): Promise<Response> {
  return writeRequest(path, "POST", body ?? {});
}

function callbackError(): string {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("error") && !new URLSearchParams(url.hash.slice(1)).has("error")) return "";
  window.history.replaceState(null, "", url.pathname);
  return "That sign-in link expired or could not be verified. Request a new email code below.";
}

function App(): React.ReactElement {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeRequested, setCodeRequested] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [pending, setPending] = useState<"session" | "otp" | "verify" | "logout" | null>("session");
  const [status, setStatus] = useState("Checking your session…");
  const [error, setError] = useState(callbackError);

  const loadIdentity = useCallback(async (initial = false): Promise<void> => {
    // Keep the library mounted while focus checks renew the identity display.
    setPending("session");
    if (initial) setStatus("Checking your session…");
    try {
      const response = await fetch("/v1/me", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) {
        setCurrentUser(null);
        setStatus(initial ? "Sign in with your invited email address." : "Your session expired or access is no longer available. Sign in again.");
      } else if (!response.ok) {
        throw new Error("session unavailable");
      } else {
        setCurrentUser(await response.json() as CurrentUser);
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
    setCurrentUser(null);
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
      setCurrentUser(null);
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
  return h("main", { className: "console", "aria-busy": disabled },
    h("header", { className: "app-header" },
      h("span", { className: "wordmark" }, "capykit", h("span", { className: "beta-label" }, "Preview")),
      currentUser === null ? null : h("div", { className: "account" }, h("span", null, currentUser.identity.email), h("button", { type: "button", className: "secondary", disabled, onClick: () => { void logout(); } }, pending === "logout" ? "Signing out…" : "Sign out")),
    ),
    error === "" ? null : h("p", { className: "message error", role: "alert" }, error),
    currentUser === null ? h("section", { className: "panel sign-in", "aria-label": "Sign in" },
      h("p", { className: "eyebrow" }, "Your capabilities, together"),
      h("h1", null, "Welcome to Capykit"),
      h("p", { className: "muted", role: "status", "aria-live": "polite" }, status),
      h("form", { onSubmit: (event) => { void requestCode(event); } },
        h("label", { htmlFor: "email" }, "Invited email address"),
        h("input", {
          id: "email", name: "email", type: "email", autoComplete: "email", required: true,
          value: email, disabled,
          onChange: (event) => { setEmail(event.currentTarget.value); setCodeRequested(false); setCode(""); },
        }),
        h("button", { type: "submit", disabled }, pending === "otp" ? "Sending…" : codeRequested ? "Send a new code" : "Send sign-in code"),
      ),
      codeRequested ? h("form", { onSubmit: (event) => { void verifyCode(event); } },
        h("label", { htmlFor: "code" }, "Six-digit sign-in code"),
        h("input", {
          id: "code", name: "code", type: "text", inputMode: "numeric", autoComplete: "one-time-code",
          pattern: "[0-9]{6}", maxLength: 6, minLength: 6, required: true,
          value: code, disabled, onChange: (event) => { setCode(event.currentTarget.value); },
        }),
        h("button", { type: "submit", disabled }, pending === "verify" ? "Verifying…" : "Sign in"),
      ) : null,
      error === "" ? null : h("button", { type: "button", disabled, onClick: () => { void loadIdentity(); } }, "Retry session check"),
    ) : h(React.Fragment, null,
      currentUser.identity.principalKind === "human" && currentUser.workspace.role === "owner"
        ? h(CapabilityLibrary, { key: currentUser.workspace.id, onSessionExpired: sessionExpired })
        : h("section", { className: "panel", "aria-label": "Capability access" }, h("h1", null, "Your workspace"), h("p", null, "Your account is active. Capability access is currently available to workspace owners. Member and agent access will become available through grants.")),
      h("details", { className: "workspace-details", "aria-label": "Current identity and workspace" }, h("summary", null, "Workspace and account details"),
      h("dl", null,
        h("dt", null, "Signed in as"), h("dd", null, currentUser.identity.email),
        h("dt", null, "Identity type"), h("dd", null, currentUser.identity.principalKind),
        h("dt", null, "Workspace"), h("dd", null, currentUser.workspace.id),
        h("dt", null, "Role"), h("dd", null, currentUser.workspace.role),
      ),
      ),
    ),
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(React.createElement(App));
