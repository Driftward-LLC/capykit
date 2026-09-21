import { useState, type FormEvent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

function App(): ReactElement {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("Enter an invited email address to receive a sign-in link.");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setStatus("Sending sign-in link…");
    try {
      const response = await fetch("/v1/auth/otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, redirectTo: window.location.origin }) });
      setStatus(response.ok ? "If that address is invited, a sign-in link was sent." : "Sign-in failed. Check the link or try again.");
    } catch { setStatus("Network error. Try again when the hosted API is reachable."); } finally { setLoading(false); }
  }
  return <main><h1>Capykit</h1><form onSubmit={submit}><label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.currentTarget.value)} /><button type="submit" disabled={loading}>{loading ? "Sending…" : "Send sign-in link"}</button></form><p role="status" aria-live="polite">{status}</p></main>;
}
const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
