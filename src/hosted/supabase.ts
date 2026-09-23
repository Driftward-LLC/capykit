import { createClient } from "@supabase/supabase-js";
import type { HostedConfig } from "./config.js";
import type { VerifiedIdentity } from "./identity.js";

export interface SupabaseAuthGateway {
  requestOtp(email: string, redirectTo: string): Promise<void>;
  verifyOtp(email: string, token: string): Promise<string | undefined>;
  verifyBearer(accessToken: string): Promise<VerifiedIdentity | undefined>;
}

export function createSupabaseAuthGateway(config: HostedConfig): SupabaseAuthGateway | undefined {
  const { supabaseUrl, supabaseServiceRoleKey } = config;
  if (supabaseUrl === undefined || supabaseServiceRoleKey === undefined) return undefined;
  // OTP verification changes SDK session state. Keep each request's client isolated.
  const client = () => createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return {
    async requestOtp(email, redirectTo) {
      // Deliberately return the same public result for invited and unknown emails.
      await client().auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } });
    },
    async verifyOtp(email, token) {
      const { data, error } = await client().auth.verifyOtp({ email, token, type: "email" });
      return error === null ? data.session?.access_token : undefined;
    },
    async verifyBearer(accessToken) {
      const { data, error } = await client().auth.getUser(accessToken);
      if (error !== null || data.user.email === undefined) return undefined;
      return { provider: "supabase", subject: data.user.id, email: data.user.email };
    },
  };
}
