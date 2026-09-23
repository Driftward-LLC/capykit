import { AuthClient } from "@supabase/auth-js";
import type { HostedConfig } from "./config.js";
import type { VerifiedIdentity } from "./identity.js";

export interface AuthGateway {
  requestOtp(email: string, redirectTo: string): Promise<void>;
  verifyOtp(email: string, token: string): Promise<string | undefined>;
  verifyBearer(accessToken: string): Promise<VerifiedIdentity | undefined>;
  signOut(accessToken: string): Promise<void>;
}

export function createAuthGateway(config: HostedConfig): AuthGateway | undefined {
  const { authUrl } = config;
  if (authUrl === undefined) return undefined;
  // OTP verification changes SDK session state. Keep each request's client isolated.
  const client = () => new AuthClient({
    url: authUrl, autoRefreshToken: false, persistSession: false, detectSessionInUrl: false,
    // ponytail: one shared pilot quota; introduce trusted per-client keys when usage grows.
    headers: { "x-capykit-auth-client": "capykit-api" },
  });
  return {
    async requestOtp(email, redirectTo) {
      // Deliberately return the same public result for invited and unknown emails.
      await client().signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } });
    },
    async verifyOtp(email, token) {
      const { data, error } = await client().verifyOtp({ email, token, type: "email" });
      return error === null ? data.session?.access_token : undefined;
    },
    async verifyBearer(accessToken) {
      const { data, error } = await client().getUser(accessToken);
      if (error !== null || data.user.email === undefined) return undefined;
      return { provider: "gotrue", subject: data.user.id, email: data.user.email };
    },
    async signOut(accessToken) {
      // Despite the SDK namespace, this endpoint uses the user's token, not an admin key.
      // getUser checks the provider session on every request, including after logout.
      const { error } = await client().admin.signOut(accessToken, "local");
      if (error !== null && ![401, 403, 404].includes(error.status ?? 0)) throw new Error("Authentication provider unavailable");
    },
  };
}
