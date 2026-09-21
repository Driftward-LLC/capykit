export interface HostedConfig { readonly databaseUrl?: string | undefined; readonly supabaseUrl?: string | undefined; readonly supabaseServiceRoleKey?: string | undefined; readonly cookieSecret: string; readonly allowedCallbackOrigins: readonly string[]; readonly publicOrigin: string; readonly secureCookies: boolean; }

function splitCsv(value: string | undefined): readonly string[] { return value === undefined ? [] : value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0); }

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const publicOrigin = env.CAPYKIT_PUBLIC_ORIGIN ?? "http://localhost:3000";
  return { databaseUrl: env.DATABASE_URL, supabaseUrl: env.SUPABASE_URL, supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, cookieSecret: env.CAPYKIT_COOKIE_SECRET ?? "development-cookie-secret-change-me", allowedCallbackOrigins: splitCsv(env.CAPYKIT_ALLOWED_CALLBACK_ORIGINS ?? publicOrigin), publicOrigin, secureCookies: env.NODE_ENV === "production" };
}

export function redactOperationalValue(value: string | undefined): string { return value === undefined || value.length === 0 ? "missing" : "configured"; }
