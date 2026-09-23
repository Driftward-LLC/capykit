import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

interface CurrentUser {
  readonly identity: { readonly email: string; readonly principalKind: string };
  readonly workspace: { readonly id: string; readonly role: string };
}

async function post(path: string, body?: unknown): Promise<Response> {
  const csrf = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("capykit_csrf="))?.slice("capykit_csrf=".length);
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(csrf === undefined ? {} : { "x-csrf-token": csrf }) },
    body: JSON.stringify(body ?? {}),
  });
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
    setPending("session");
    setStatus("Checking your session…");
    if (!initial) setError("");
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
      setCurrentUser(null);
      setStatus("");
      setError("Could not check your session. Check your connection and retry.");
    } finally {
      setPending(null);
    }
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
    h("h1", null, "Capykit hosted console"),
    h("p", { role: "status", "aria-live": "polite" }, status),
    error === "" ? null : h("p", { role: "alert" }, error),
    currentUser === null ? h("section", { "aria-label": "Sign in" },
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
    ) : h("section", { "aria-label": "Current identity and workspace" },
      h("h2", null, "Your workspace"),
      h("dl", null,
        h("dt", null, "Signed in as"), h("dd", null, currentUser.identity.email),
        h("dt", null, "Identity type"), h("dd", null, currentUser.identity.principalKind),
        h("dt", null, "Workspace"), h("dd", null, currentUser.workspace.id),
        h("dt", null, "Role"), h("dd", null, currentUser.workspace.role),
      ),
      h("button", { type: "button", disabled, onClick: () => { void logout(); } }, pending === "logout" ? "Signing out…" : "Sign out"),
    ),
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(React.createElement(App));
