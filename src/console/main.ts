import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function App(): React.ReactElement {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("Enter your invited email to request a sign-in link.");
  const [loading, setLoading] = useState(false);
  async function requestOtp(): Promise<void> {
    setLoading(true);
    setStatus("Sending sign-in link…");
    try {
      await fetch("/v1/auth/otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, redirectTo: window.location.origin }),
      });
      setStatus("If that email is invited, a sign-in link will arrive shortly.");
    } catch {
      setStatus("The request failed. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }
  return React.createElement("main", { className: "console" },
    React.createElement("h1", null, "Capykit hosted console"),
    React.createElement("label", { htmlFor: "email" }, "Email address"),
    React.createElement("input", { id: "email", type: "email", autoComplete: "email", value: email, onChange: (event) => { setEmail(event.currentTarget.value); } }),
    React.createElement("button", { type: "button", disabled: loading || email.trim() === "", onClick: () => { void requestOtp(); } }, loading ? "Sending…" : "Send sign-in link"),
    React.createElement("p", { role: "status", "aria-live": "polite" }, status),
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(React.createElement(App));
