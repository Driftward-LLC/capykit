import { AuthClient } from "@supabase/auth-js";
import { createHash, randomBytes } from "node:crypto";
import { AuthUnavailableError, type AuthSession } from "./auth.js";
import { providerJson } from "./provider-http.js";

export interface GoogleSignIn {
  available(): Promise<boolean>;
  start(): Promise<{ authorizationUrl: string; verifier: string }>;
  providerCallback(query: URLSearchParams): Promise<string>;
  exchange(code: string, verifier: string): Promise<AuthSession | undefined>;
}

export function createGoogleSignIn(authUrl: string, origin: string): GoogleSignIn {
  const callback = `${origin}/v1/auth/google/callback`;
  const providerCallback = `${origin}/v1/auth/google/provider/callback`;
  const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  async function redirect(path: string, params: URLSearchParams): Promise<URL> {
    try {
      const response = await request(`${authUrl}${path}?${params}`);
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (![302, 303].includes(response.status) || !location || location.length > 8192) throw new Error("redirect");
      const url = new URL(location);
      if (url.username || url.password) throw new Error("redirect");
      return url;
    } catch { throw new AuthUnavailableError(); }
  }
  return {
    async available() {
      try {
        const settings = await providerJson(`${authUrl}/settings`);
        return settings.disable_signup === false && (settings.external as Record<string, unknown> | undefined)?.google === true;
      } catch { return false; }
    },
    async start() {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const url = await redirect("/authorize", new URLSearchParams({ provider: "google", redirect_to: callback, scopes: "openid email profile", code_challenge: challenge, code_challenge_method: "s256", prompt: "select_account" }));
      const scopes = url.searchParams.get("scope")?.split(/\s+/u) ?? [];
      const identityScopes = ["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];
      if (url.origin !== "https://accounts.google.com" || !["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(url.pathname) || url.hash || url.searchParams.get("redirect_uri") !== providerCallback || url.searchParams.get("response_type") !== "code" || !url.searchParams.get("state") || !scopes.length || scopes.some(scope => !identityScopes.includes(scope))) throw new AuthUnavailableError();
      return { authorizationUrl: url.href, verifier };
    },
    async providerCallback(query) {
      const url = await redirect("/callback", query);
      if (url.origin !== origin || url.pathname !== "/v1/auth/google/callback") throw new AuthUnavailableError();
      const error = url.searchParams.get("error") ?? new URLSearchParams(url.hash.slice(1)).get("error");
      if (error) return `${origin}/?auth=${error === "access_denied" ? "google-cancelled" : "google-failed"}`;
      if (url.hash || !url.searchParams.get("code") || [...url.searchParams.keys()].some(key => key !== "code")) throw new AuthUnavailableError();
      return url.href;
    },
    async exchange(code, verifier) {
      // Per-request SDK storage; only the documented PKCE verifier is seeded.
      // Native GoTrue exchanges/consumes the auth code and issues normal sessions.
      const storageKey = "capykit-google";
      const storage = new Map([[`${storageKey}-code-verifier`, JSON.stringify(verifier)]]);
      const client = new AuthClient({ url: authUrl, flowType: "pkce", storageKey, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
        storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: key => { storage.delete(key); } },
        fetch: (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }),
      });
      try {
        const { data, error } = await client.exchangeCodeForSession(code);
        if (error) {
          if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) return undefined;
          throw new AuthUnavailableError();
        }
        const user = data.user, session = data.session;
        const email = user.email;
        if (!user.email_confirmed_at || !email || !user.identities?.some(identity => {
          const claims: Record<string, unknown> | undefined = identity.identity_data;
          return identity.provider === "google" && claims?.email_verified === true && typeof claims.email === "string" && claims.email.toLowerCase() === email.toLowerCase();
        })) return undefined;
        if ([session.access_token, session.refresh_token].some(token => typeof token !== "string" || !token || token.length > 16_384 || /[\r\n\0]/u.test(token))) throw new AuthUnavailableError();
        return { accessToken: session.access_token, refreshToken: session.refresh_token };
      } catch { throw new AuthUnavailableError(); }
      finally { storage.clear(); }
    },
  };
}
