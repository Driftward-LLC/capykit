import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { HostedConfig } from "./config.js";
import type { VerifiedIdentity } from "./identity.js";

export interface SupabaseAuthGateway {
  requestOtp(email: string, redirectTo: string): Promise<void>;
  verifyBearer(accessToken: string): Promise<VerifiedIdentity | undefined>;
}

export function createSupabaseAuthGateway(config: HostedConfig): SupabaseAuthGateway | undefined {
  if (config.supabaseUrl === undefined || config.supabaseServiceRoleKey === undefined) return undefined;
  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return createSupabaseAuthGatewayForClient(client);
}

export function createSupabaseAuthGatewayForClient(client: SupabaseClient): SupabaseAuthGateway {
  return {
    async requestOtp(email, redirectTo) {
      await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } });
    },
    async verifyBearer(accessToken) {
      const { data, error } = await client.auth.getUser(accessToken);
      if (error !== null) return undefined;
      const email = data.user.email;
      return email === undefined ? undefined : { provider: "supabase", subject: data.user.id, email };
    },
  };
}
