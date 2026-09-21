export interface HostedConfig {
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly allowedCallbackOrigins: readonly string[];
  readonly databaseUrl: string | undefined;
  readonly supabaseUrl: string | undefined;
  readonly supabaseServiceRoleKey: string | undefined;
  readonly sessionCookieName: string;
  readonly csrfCookieName: string;
  readonly secureCookies: boolean;
}

function splitOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0);
}

function optionalEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const publicBaseUrl = optionalEnv("CAPYKIT_PUBLIC_BASE_URL", env) ?? "http://localhost:3000";
  const callbackOrigins = splitOrigins(optionalEnv("CAPYKIT_ALLOWED_CALLBACK_ORIGINS", env));
  return {
    port: Number.parseInt(optionalEnv("PORT", env) ?? "3000", 10),
    publicBaseUrl,
    allowedCallbackOrigins: callbackOrigins.length === 0 ? [publicBaseUrl] : callbackOrigins,
    databaseUrl: optionalEnv("DATABASE_URL", env),
    supabaseUrl: optionalEnv("SUPABASE_URL", env),
    supabaseServiceRoleKey: optionalEnv("SUPABASE_SERVICE_ROLE_KEY", env),
    sessionCookieName: "capykit_session",
    csrfCookieName: "capykit_csrf",
    secureCookies: publicBaseUrl.startsWith("https://"),
  };
}

export function callbackOriginAllowed(config: HostedConfig, origin: string): boolean {
  return config.allowedCallbackOrigins.includes(origin);
}

export function missingHostedConfig(config: HostedConfig): readonly string[] {
  const required: ReadonlyArray<readonly [string, string | undefined]> = [
    ["DATABASE_URL", config.databaseUrl],
    ["SUPABASE_URL", config.supabaseUrl],
    ["SUPABASE_SERVICE_ROLE_KEY", config.supabaseServiceRoleKey],
  ];
  return required.flatMap(([name, value]) => value === undefined ? [name] : []);
}
