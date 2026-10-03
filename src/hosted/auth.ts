import { AuthClient, type Session } from "@supabase/auth-js";
import { createHash } from "node:crypto";
import type { HostedConfig } from "./config.js";
import type { VerifiedIdentity } from "./identity.js";

export interface AuthSession { accessToken: string; refreshToken: string }

export class AuthUnavailableError extends Error {
  readonly code = "AUTHENTICATION_UNAVAILABLE";
  readonly statusCode = 503;
  constructor() { super("Authentication provider unavailable"); this.name = "AuthUnavailableError"; }
}

export interface AuthGateway {
  signInTrusted?(email: string, subject: string): Promise<AuthSession | undefined>;
  requestOtp(email: string, redirectTo: string): Promise<void>;
  verifyOtp(email: string, token: string): Promise<AuthSession | undefined>;
  refresh(refreshToken: string): Promise<AuthSession | undefined>;
  verifyBearer(accessToken: string): Promise<VerifiedIdentity | undefined>;
  signOut(accessToken: string): Promise<void>;
}

function invalidCredentials(error: unknown, additionalCodes: readonly string[] = []): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, code, name } = error as { status?: number; code?: string; name?: string };
  if (status === 429 || status === 0 || (status !== undefined && status >= 500) || name === "AuthRetryableFetchError") return false;
  if (name === "AuthSessionMissingError" || status === 401 || status === 403) return true;
  return status === 400 && typeof code === "string" && [
    "bad_jwt", "no_authorization", "user_not_found", "session_not_found", "session_expired", "user_banned", "invalid_credentials", ...additionalCodes,
  ].includes(code);
}

function sessionTokens(session: Session | null): AuthSession {
  if (!session || [session.access_token, session.refresh_token].some((token) => typeof token !== "string" || !token || token.length > 16_384 || /[\r\n\0]/u.test(token))) throw new AuthUnavailableError();
  return { accessToken: session.access_token, refreshToken: session.refresh_token };
}

export function createAuthGateway(config: HostedConfig): AuthGateway | undefined {
  const { authUrl } = config;
  if (authUrl === undefined) return undefined;
  // OTP verification changes SDK session state. Keep each request's client isolated.
  const client = (serviceKey?: string) => new AuthClient({
    url: authUrl, autoRefreshToken: false, persistSession: false, detectSessionInUrl: false,
    // ponytail: one shared pilot quota; introduce trusted per-client keys when usage grows.
    headers: { "x-capykit-auth-client": "capykit-api", ...(serviceKey === undefined ? {} : { Authorization: `Bearer ${serviceKey}` }) },
    fetch: (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }),
  });
  // Native rotation handles stale-token reuse; this map only coalesces concurrent requests.
  const refreshing = new Map<string, Promise<AuthSession | undefined>>();
  return {
    async signInTrusted(email, subject) {
      const key = config.tailscaleSignIn?.serviceKey;
      if (key === undefined) return undefined;
      try {
        const admin = client(key).admin;
        // Never generate a link for a missing or different account: generateLink can create users.
        const existing = await admin.getUserById(subject);
        if (existing.error) {
          if (existing.error.status === 404) return undefined;
          throw new AuthUnavailableError();
        }
        if (existing.data.user.id !== subject || existing.data.user.email?.toLowerCase() !== email || !existing.data.user.email_confirmed_at) return undefined;
        const link = await admin.generateLink({ type: "magiclink", email });
        if (link.error || link.data.user.id !== subject || !link.data.properties.hashed_token) throw new AuthUnavailableError();
        const verified = await client().verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
        if (verified.error || verified.data.user?.id !== subject) throw new AuthUnavailableError();
        return sessionTokens(verified.data.session);
      } catch { throw new AuthUnavailableError(); }
    },
    async requestOtp(email, redirectTo) {
      // Deliberately return the same public result for invited and unknown emails.
      await client().signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } });
    },
    async verifyOtp(email, token) {
      try {
        const { data, error } = await client().verifyOtp({ email, token, type: "email" });
        if (error) {
          if (invalidCredentials(error, ["otp_expired", "validation_failed"])) return undefined;
          throw new AuthUnavailableError();
        }
        return sessionTokens(data.session);
      } catch { throw new AuthUnavailableError(); }
    },
    async refresh(refreshToken) {
      const key = createHash("sha256").update(refreshToken).digest("hex");
      const existing = refreshing.get(key);
      if (existing) return existing;
      if (refreshing.size >= 128) throw new AuthUnavailableError();
      const pending = (async () => {
        try {
          const { data, error } = await client().refreshSession({ refresh_token: refreshToken });
          if (error) {
            if (invalidCredentials(error, ["refresh_token_not_found", "refresh_token_already_used", "validation_failed"])) return undefined;
            throw new AuthUnavailableError();
          }
          return sessionTokens(data.session);
        } catch { throw new AuthUnavailableError(); }
      })().finally(() => { refreshing.delete(key); });
      refreshing.set(key, pending);
      return pending;
    },
    async verifyBearer(accessToken) {
      let user;
      try {
        const { data, error } = await client().getUser(accessToken);
        if (error) {
          if (invalidCredentials(error)) return undefined;
          throw new AuthUnavailableError();
        }
        user = data.user;
        if (typeof user.id !== "string") throw new AuthUnavailableError();
      } catch { throw new AuthUnavailableError(); }
      if (typeof user.email !== "string" || !user.email) return undefined;
      try {
        // Decode only after GoTrue has verified the JWT and checked its live session.
        if (accessToken.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(accessToken)) return undefined;
        const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
        const sessionId = claims.session_id;
        if (claims.sub !== user.id || typeof sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId) || sessionId === "00000000-0000-0000-0000-000000000000") return undefined;
        return { provider: "gotrue", subject: user.id, email: user.email, sessionId: sessionId.toLowerCase() };
      } catch { return undefined; }
    },
    async signOut(accessToken) {
      // Despite the SDK namespace, this endpoint uses the user's token, not an admin key.
      // getUser checks the provider session on every request, including after logout.
      try {
        const { error } = await client().admin.signOut(accessToken, "local");
        if (error !== null && !invalidCredentials(error) && error.status !== 404) throw new AuthUnavailableError();
      } catch { throw new AuthUnavailableError(); }
    },
  };
}
