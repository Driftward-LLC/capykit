import { isIP } from "node:net";

export interface TailscaleSignInConfig {
  readonly login: string;
  readonly email: string;
  readonly subject: string;
  readonly proxyAddress: string;
  readonly serviceKey: string;
}

export interface HostedConfig {
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly allowedCallbackOrigins: readonly string[];
  readonly databaseUrl: string | undefined;
  readonly authUrl: string | undefined;
  readonly sessionCookieName: string;
  readonly refreshCookieName: string;
  readonly csrfCookieName: string;
  readonly secureCookies: boolean;
  readonly tailscaleSignIn?: TailscaleSignInConfig;
  readonly publicSignup?: boolean;
}

function splitOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0);
}

function optionalEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function configuredOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Hosted URLs must be valid HTTP(S) origins."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Hosted URLs require HTTPS origins; loopback HTTP is allowed for local development.");
  }
  return url.origin;
}

function internalAuthOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Authentication URL must be a valid HTTP(S) origin."); }
  // This server-only URL may address an HTTP service on a private container network.
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Authentication URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const signupValue = optionalEnv("CAPYKIT_PUBLIC_SIGNUP", env);
  if (signupValue !== undefined && !["true", "false"].includes(signupValue)) throw new Error("CAPYKIT_PUBLIC_SIGNUP must be true or false.");
  const publicSignup = signupValue === "true";
  const publicBaseUrl = configuredOrigin(optionalEnv("CAPYKIT_PUBLIC_BASE_URL", env) ?? "http://localhost:3000");
  const callbackOrigins = splitOrigins(optionalEnv("CAPYKIT_ALLOWED_CALLBACK_ORIGINS", env)).map(configuredOrigin);
  const authUrl = optionalEnv("CAPYKIT_AUTH_URL", env);
  const tailscaleValues = ["LOGIN", "EMAIL", "SUBJECT", "PROXY_ADDRESS", "SERVICE_KEY"].map((key) => optionalEnv(`CAPYKIT_TAILSCALE_${key}`, env));
  let tailscaleSignIn: TailscaleSignInConfig | undefined;
  if (tailscaleValues.some((value) => value !== undefined)) {
    const [login, email, subject, proxyAddress, serviceKey] = tailscaleValues;
    if (!login || !email || !subject || !proxyAddress || !serviceKey || !authUrl ||
      !publicBaseUrl.startsWith("https://") || !new URL(publicBaseUrl).hostname.endsWith(".ts.net") ||
      !/^[\x21-\x7e]{1,254}$/u.test(login) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(subject) ||
      isIP(proxyAddress) === 0 || proxyAddress === "0.0.0.0" || proxyAddress === "::" ||
      serviceKey.length > 16_384 || /[\r\n\0]/u.test(serviceKey)) throw new Error("Tailscale sign-in requires a complete identity mapping, exact proxy IP, HTTPS tailnet origin and server-only auth service key.");
    tailscaleSignIn = { login, email: email.toLowerCase(), subject: subject.toLowerCase(), proxyAddress, serviceKey };
  }
  if (publicSignup && tailscaleSignIn) throw new Error("Public signup cannot use a private Tailscale identity mapping.");
  const port = Number(optionalEnv("PORT", env) ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535.");
  return {
    port,
    publicSignup,
    publicBaseUrl,
    allowedCallbackOrigins: callbackOrigins.length === 0 ? [publicBaseUrl] : callbackOrigins,
    databaseUrl: optionalEnv("DATABASE_URL", env),
    authUrl: authUrl === undefined ? undefined : internalAuthOrigin(authUrl),
    sessionCookieName: publicSignup ? "capykit_public_session" : "capykit_session",
    refreshCookieName: publicSignup ? "capykit_public_refresh" : "capykit_refresh",
    csrfCookieName: "capykit_csrf",
    secureCookies: publicBaseUrl.startsWith("https://"),
    ...(tailscaleSignIn === undefined ? {} : { tailscaleSignIn }),
  };
}

export function callbackOriginAllowed(config: HostedConfig, origin: string): boolean {
  return config.allowedCallbackOrigins.includes(origin);
}

export function missingHostedConfig(config: HostedConfig): readonly string[] {
  const required: ReadonlyArray<readonly [string, string | undefined]> = [
    ["DATABASE_URL", config.databaseUrl],
    ["CAPYKIT_AUTH_URL", config.authUrl],
  ];
  return required.flatMap(([name, value]) => value === undefined ? [name] : []);
}
