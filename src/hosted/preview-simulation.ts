import { ConnectionError } from "./connections.js";
import type { GithubConfig, InstallationCandidate } from "./github.js";
import type { GoogleConfig } from "./google.js";

const enabledValue = "true";
const key = Buffer.alloc(32, 0);
const githubInstallation: InstallationCandidate = {
  installationId: "9001",
  account: { id: "7001", login: "capykit-simulated", type: "Organization" },
  permissions: { issues: "read", metadata: "read" },
  repositories: [
    { id: "101", fullName: "capykit-simulated/preview-repo", url: "https://github.com/capykit-simulated/preview-repo", admin: true },
    { id: "102", fullName: "capykit-simulated/empty-repo", url: "https://github.com/capykit-simulated/empty-repo", admin: true },
  ],
};

function fail(code: string, status = 400): never { throw new ConnectionError(code, status); }
function clone<T>(value: T): T { return structuredClone(value); }
function previewEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.CAPYKIT_PREVIEW_SIMULATED_PROVIDERS;
  if (value === undefined || value === "") return false;
  if (value !== enabledValue) throw new ConnectionError("CONFIGURATION_UNAVAILABLE", 503);
  return true;
}

export function previewSimulationEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return previewEnabled(env); }

export function previewSimulationConsentPage(provider: "github" | "google-drive", state: unknown): string {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(state)) return "<!doctype html><title>Invalid simulated consent</title><h1>Invalid simulated consent</h1>";
  const label = provider === "github" ? "GitHub" : "Google Drive";
  const callback = provider === "github" ? "/v1/connections/github/callback" : "/v1/connections/google/callback";
  const code = provider === "github" ? "simulated-github-code" : "simulated-google-code";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated ${label} consent</title><style>body{font:16px system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5}a{display:inline-block;margin-top:1rem;padding:.7rem 1rem;background:#116149;color:white;border-radius:.5rem;text-decoration:none}</style></head><body><p><strong>Simulated provider consent</strong></p><h1>Connect simulated ${label}</h1><p>This isolated Capykit preview uses deterministic fixture data. It is not a real ${label} login, no provider credentials are requested, and no external provider account is contacted.</p><a href="${callback}?code=${code}&state=${state}">Approve simulated ${label} access</a></body></html>`;
}

export function loadPreviewSimulation(env: NodeJS.ProcessEnv, publicBaseUrl: string, live: { github?: unknown; google?: unknown }): undefined | { githubConfig: GithubConfig; githubProvider: SimulatedGithubProvider; googleConfig: GoogleConfig; googleProvider: SimulatedGoogleProvider } {
  if (!previewEnabled(env)) return undefined;
  if (live.github !== undefined || live.google !== undefined || env.CAPYKIT_GITHUB_CONFIG_FILE) throw new ConnectionError("CONFIGURATION_UNAVAILABLE", 503);
  const base = new URL(publicBaseUrl).origin;
  const githubConfig: GithubConfig = { appId: "9001", appSlug: "capykit-simulated", clientId: "simulated", clientSecret: "simulated", privateKey: "simulated", webhookSecret: "simulated-webhook-secret-not-used", encryptionKey: key, keyVersion: "preview-sim-v1", callbackUrl: `${base}/v1/connections/github/callback` };
  const googleConfig: GoogleConfig = { clientId: "simulated.apps.googleusercontent.com", clientSecret: "simulated", encryptionKey: key, keyVersion: "preview-sim-google-v1", callbackUrl: `${base}/v1/connections/google/callback` };
  return { githubConfig, githubProvider: new SimulatedGithubProvider(base), googleConfig, googleProvider: new SimulatedGoogleProvider(base) };
}

export class SimulatedGithubProvider {
  constructor(private readonly base: string) {}
  authorizationUrl(state: string): string { return `${this.base}/v1/preview/simulated/github/consent?state=${encodeURIComponent(state)}`; }
  installationUrl(): string { return `${this.base}/v1/preview/simulated/github/consent`; }
  exchange(code: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
    if (code !== "simulated-github-code") fail("GITHUB_AUTHORIZATION_FAILED", 400);
    return Promise.resolve({ accessToken: "simulated-github-user", refreshToken: "simulated-github-refresh", expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }
  revokeUserToken(): Promise<void> { return Promise.resolve(); }
  user(): Promise<{ id: string; login: string }> { return Promise.resolve({ id: "7001", login: "preview-operator" }); }
  candidates(): Promise<InstallationCandidate[]> { return Promise.resolve([clone(githubInstallation)]); }
  recheck(_token: string, installationId: string, accountId: string, repositoryIds: string[]): Promise<InstallationCandidate> {
    if (installationId !== githubInstallation.installationId || accountId !== githubInstallation.account.id) fail("GITHUB_INSTALLATION_INVALID", 403);
    const repositories = repositoryIds.map(id => githubInstallation.repositories.find(repo => repo.id === id && repo.admin) ?? fail("GITHUB_REPOSITORY_FORBIDDEN", 403));
    return Promise.resolve({ ...clone(githubInstallation), repositories });
  }
  mint(_installationId: string, repositoryIds: string[]): Promise<{ token: string; expiresAt: string }> {
    for (const id of repositoryIds) if (!githubInstallation.repositories.some(repo => repo.id === id)) fail("GITHUB_REPOSITORY_FORBIDDEN", 403);
    return Promise.resolve({ token: `simulated-github:${repositoryIds.join(",")}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }
  revokeInstallationToken(): Promise<void> { return Promise.resolve(); }
}

export class SimulatedGoogleProvider {
  constructor(private readonly base: string) {}
  authorizationUrl(state: string): string { return `${this.base}/v1/preview/simulated/google-drive/consent?state=${encodeURIComponent(state)}`; }
  exchange(code: string): Promise<{ refreshToken: string; subject: string; email: string }> {
    if (code !== "simulated-google-code") fail("PROVIDER_AUTHORIZATION_EXPIRED", 502);
    return Promise.resolve({ refreshToken: "simulated-google-refresh", subject: "9001", email: "simulated.drive@example.test" });
  }
  refresh(refreshToken: string): Promise<string> {
    if (refreshToken !== "simulated-google-refresh") fail("PROVIDER_AUTHORIZATION_EXPIRED", 502);
    return Promise.resolve("simulated-google-access");
  }
}

export function simulatedProviderJson(url: string, init: RequestInit = {}): Record<string, unknown> | undefined {
  if (!previewEnabled(process.env)) return undefined;
  const authorization = new Headers(init.headers).get("authorization") ?? "";
  if (!authorization.startsWith("Bearer simulated-")) fail("PROVIDER_AUTHORIZATION_EXPIRED", 502);
  const parsed = new URL(url);
  if (parsed.hostname === "api.github.com") {
    if (parsed.pathname === "/repositories/101") return { id: 101, full_name: "capykit-simulated/preview-repo" };
    if (parsed.pathname === "/repositories/102") return { id: 102, full_name: "capykit-simulated/empty-repo" };
    if (parsed.pathname === "/repos/capykit-simulated/preview-repo/issues/1") return { number: 1, title: "Simulated preview issue", state: "open", body: "Fixture body omitted" };
    if (parsed.pathname === "/repos/capykit-simulated/empty-repo/issues/1") fail("PROVIDER_RESOURCE_NOT_FOUND", 502);
  }
  if (parsed.hostname === "www.googleapis.com" && parsed.pathname.startsWith("/drive/v3/files")) {
    if (parsed.pathname === "/drive/v3/files") {
      const query = parsed.searchParams.get("q") ?? "";
      return query.includes("Empty") ? { files: [] } : { files: [{ id: "file_preview", name: "Simulated planning brief", mimeType: "application/pdf", owners: ["redacted"] }], nextPageToken: null };
    }
    const id = decodeURIComponent(parsed.pathname.slice("/drive/v3/files/".length));
    if (id === "file_unavailable") fail("PROVIDER_UNAVAILABLE", 502);
    if (id === "file_expired") fail("PROVIDER_AUTHORIZATION_EXPIRED", 502);
    if (id === "file_empty") fail("PROVIDER_RESOURCE_NOT_FOUND", 502);
    return { id, name: id === "file_preview" ? "Simulated planning brief" : "Simulated fixture file", mimeType: "application/pdf", owners: ["redacted"] };
  }
  fail("PROVIDER_RESOURCE_NOT_FOUND", 502);
}
