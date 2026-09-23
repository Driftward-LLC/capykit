import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseIssuesInput } from "./artifacts.js";
import { loadHostedConfig } from "./config.js";

export interface GithubConfig {
  appId: string; appSlug: string; clientId: string; clientSecret: string; privateKey: string;
  webhookSecret: string; encryptionKey: Buffer; keyVersion: string; callbackUrl: string;
}
export interface GithubRepository { id: string; fullName: string; url: string; admin: boolean }
export interface InstallationCandidate {
  installationId: string;
  account: { id: string; login: string; type: string };
  repositories: GithubRepository[];
  permissions: { issues: "read"; metadata: "read" };
}
export class GithubError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code === "CONFIGURATION_UNAVAILABLE" ? "GitHub connection configuration is unavailable." : "GitHub connection request could not be completed.");
    this.name = "GithubError";
  }
}
function fail(code = "GITHUB_RESPONSE_INVALID", status = 502): never { throw new GithubError(code, status); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/u.test(value)) fail();
  return value;
}
function id(value: unknown): string {
  const result = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== "string" || !/^[1-9][0-9]{0,15}$/u.test(result) || !Number.isSafeInteger(Number(result))) fail("INVALID_REQUEST", 400);
  return result;
}
function permissions(value: unknown): { issues: "read"; metadata: "read" } {
  const entry = object(value);
  if (entry.issues !== "read" || entry.metadata !== "read" || Object.keys(entry).some((key) => !["issues", "metadata"].includes(key))) fail("GITHUB_PERMISSION_MISMATCH", 403);
  return { issues: "read", metadata: "read" };
}
function repository(value: unknown): GithubRepository {
  const entry = object(value);
  const fullName = string(entry.full_name);
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/u.test(fullName)) fail();
  return { id: id(entry.id), fullName, url: `https://github.com/${fullName}`, admin: object(entry.permissions ?? {}).admin === true };
}
function repositoryIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 500) fail("INVALID_REQUEST", 400);
  const ids = values.map(id);
  if (new Set(ids).size !== ids.length) fail("INVALID_REQUEST", 400);
  return ids;
}
function equalIds(a: string[], b: string[]): boolean { return a.length === b.length && new Set(b).size === b.length && a.every((item) => b.includes(item)); }
function expiry(value: unknown): string {
  const timestamp = Date.parse(string(value));
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) fail();
  return new Date(timestamp).toISOString();
}

export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env, publicBaseUrl?: string): GithubConfig | undefined {
  const names = ["CAPYKIT_GITHUB_APP_ID", "CAPYKIT_GITHUB_APP_SLUG", "CAPYKIT_GITHUB_CLIENT_ID", "CAPYKIT_GITHUB_CLIENT_SECRET", "CAPYKIT_GITHUB_PRIVATE_KEY", "CAPYKIT_GITHUB_PRIVATE_KEY_FILE", "CAPYKIT_GITHUB_WEBHOOK_SECRET", "CONNECT_STATE_ENCRYPTION_KEY", "CONNECT_STATE_ENCRYPTION_KEY_VERSION", "CAPYKIT_GITHUB_CALLBACK_URL"];
  if (!names.some((name) => Boolean(env[name]?.trim()))) return undefined;
  try {
    const required = (name: string) => string(env[name]);
    const privateKeyValue = env.CAPYKIT_GITHUB_PRIVATE_KEY;
    const privateKeyFile = env.CAPYKIT_GITHUB_PRIVATE_KEY_FILE;
    if (Boolean(privateKeyValue) === Boolean(privateKeyFile)) fail();
    const privateKey = privateKeyValue ?? readFileSync(string(privateKeyFile), "utf8");
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail();
    const keyText = required("CONNECT_STATE_ENCRYPTION_KEY");
    const encryptionKey = Buffer.from(keyText, "base64");
    if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== keyText) fail();
    const keyVersion = required("CONNECT_STATE_ENCRYPTION_KEY_VERSION");
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(keyVersion)) fail();
    const base = loadHostedConfig({ CAPYKIT_PUBLIC_BASE_URL: publicBaseUrl ?? env.CAPYKIT_PUBLIC_BASE_URL ?? "http://localhost:3000" }).publicBaseUrl;
    const callbackUrl = `${base}/v1/connections/github/callback`;
    if (env.CAPYKIT_GITHUB_CALLBACK_URL && env.CAPYKIT_GITHUB_CALLBACK_URL !== callbackUrl) fail();
    const appSlug = required("CAPYKIT_GITHUB_APP_SLUG");
    const clientId = required("CAPYKIT_GITHUB_CLIENT_ID");
    if (!/^[a-z0-9-]+$/u.test(appSlug) || !/^[A-Za-z0-9_.-]+$/u.test(clientId)) fail();
    const webhookSecret = required("CAPYKIT_GITHUB_WEBHOOK_SECRET");
    if (webhookSecret.length < 32) fail();
    return { appId: id(required("CAPYKIT_GITHUB_APP_ID")), appSlug, clientId, clientSecret: required("CAPYKIT_GITHUB_CLIENT_SECRET"), privateKey, webhookSecret, encryptionKey, keyVersion, callbackUrl };
  } catch { return fail("CONFIGURATION_UNAVAILABLE", 503); }
}

export interface SealedGithubState { version: string; nonce: string; tag: string; ciphertext: string }
export function seal(config: GithubConfig, payload: unknown, aad: string): SealedGithubState {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([config.keyVersion, aad])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { version: config.keyVersion, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
// The authenticated JSON envelope has its domain shape validated by the connection store.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function unseal<T>(config: GithubConfig, encrypted: unknown, aad: string): T {
  try {
    const entry = object(encrypted);
    if (Object.keys(entry).sort().join() !== "ciphertext,nonce,tag,version" || entry.version !== config.keyVersion) fail();
    const decode = (value: unknown, length?: number) => {
      const encoded = string(value, 128 * 1024);
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || (length !== undefined && bytes.length !== length)) fail();
      return bytes;
    };
    const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey, decode(entry.nonce, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([config.keyVersion, aad])));
    decipher.setAuthTag(decode(entry.tag, 16));
    return JSON.parse(Buffer.concat([decipher.update(decode(entry.ciphertext)), decipher.final()]).toString("utf8")) as T;
  } catch { return fail("CONNECT_STATE_INVALID", 400); }
}
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
export function verifyGithubWebhook(secret: string, raw: Buffer, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^sha256=[0-9a-f]{64}$/u.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

const API = "https://api.github.com";
const MAX_PAGES = 10;
// Pilot discovery stays bounded across installations, including non-admin repos.
const MAX_DISCOVERY_INSTALLATIONS = 20;
const MAX_DISCOVERY_REPOSITORIES = 500;
export class GithubProvider {
  constructor(readonly config: GithubConfig, private readonly fetcher: typeof fetch = fetch) {}
  authorizationUrl(state: string, challenge: string): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.callbackUrl, state, code_challenge: challenge, code_challenge_method: "S256", allow_signup: "false" }).toString();
    return url.href;
  }
  installationUrl(): string { return `https://github.com/apps/${encodeURIComponent(this.config.appSlug)}/installations/new`; }
  private appToken(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.clientId })).toString("base64url");
    const data = `${header}.${payload}`;
    try { return `${data}.${sign("RSA-SHA256", Buffer.from(data), this.config.privateKey).toString("base64url")}`; }
    catch { return fail("CONFIGURATION_UNAVAILABLE", 503); }
  }
  private async request(path: string, authorization: string, method = "GET", body?: unknown, acceptedStatuses: readonly number[] = []): Promise<{ value: unknown; headers: Headers }> {
    try {
      const response = await this.fetcher(path === "/login/oauth/access_token" ? `https://github.com${path}` : `${API}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "capykit", "x-github-api-version": "2026-03-10", ...(authorization ? { authorization } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (acceptedStatuses.includes(response.status)) { await response.body?.cancel(); return { value: null, headers: response.headers }; }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429 || (response.status === 403 && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"))) fail("GITHUB_RATE_LIMITED", 429);
        if ([401, 403, 404].includes(response.status)) fail("GITHUB_ACCESS_REVOKED", 403);
        fail("GITHUB_UNAVAILABLE", 502);
      }
      if (response.status === 204) return { value: null, headers: response.headers };
      const reader = response.body?.getReader();
      if (!reader) fail();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.length;
        if (length > 4 * 1024 * 1024) { await reader.cancel(); fail("GITHUB_RESPONSE_LIMIT", 502); }
        chunks.push(result.value);
      }
      return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, headers: response.headers };
    } catch (error) {
      if (error instanceof GithubError) throw error;
      return fail("GITHUB_UNAVAILABLE", 502);
    }
  }
  private async pages(path: string, token: string, field: string, maxResults = MAX_PAGES * 100): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.request(`${path}?per_page=100&page=${String(page)}`, `Bearer ${token}`);
      const values = object(response.value)[field];
      if (!Array.isArray(values) || values.length > 100) fail();
      if (result.length + values.length > maxResults) fail("GITHUB_RESULT_LIMIT", 422);
      result.push(...values as unknown[]);
      if (!/;\s*rel="next"/u.test(response.headers.get("link") ?? "")) return result;
      if (result.length === maxResults) fail("GITHUB_RESULT_LIMIT", 422);
    }
    return fail("GITHUB_RESULT_LIMIT", 422);
  }
  async exchange(code: string, verifier: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }> {
    const { value } = await this.request("/login/oauth/access_token", "", "POST", { client_id: this.config.clientId, client_secret: this.config.clientSecret, code, redirect_uri: this.config.callbackUrl, code_verifier: verifier });
    const entry = object(value);
    if (entry.error || entry.token_type !== "bearer") fail("GITHUB_AUTHORIZATION_FAILED", 400);
    const accessToken = string(entry.access_token, 16384);
    try {
      const seconds = entry.expires_in;
      if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0 || seconds > 86400) fail("GITHUB_AUTHORIZATION_FAILED", 400);
      return { accessToken, ...(entry.refresh_token === undefined ? {} : { refreshToken: string(entry.refresh_token, 16384) }), expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
    } catch (error) {
      await this.revokeUserToken(accessToken).catch(() => {});
      throw error;
    }
  }
  async revokeUserToken(accessToken: string): Promise<void> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    await this.request(`/applications/${encodeURIComponent(this.config.clientId)}/token`, `Basic ${basic}`, "DELETE", { access_token: accessToken }, [404]);
  }
  async user(accessToken: string): Promise<{ id: string; login: string }> {
    const entry = object((await this.request("/user", `Bearer ${accessToken}`)).value);
    return { id: id(entry.id), login: string(entry.login) };
  }
  private async installation(installationId: string): Promise<Omit<InstallationCandidate, "repositories">>;
  private async installation(installationId: string, discovery: true): Promise<Omit<InstallationCandidate, "repositories"> | undefined>;
  private async installation(installationId: string, discovery = false): Promise<Omit<InstallationCandidate, "repositories"> | undefined> {
    const entry = object((await this.request(`/app/installations/${id(installationId)}`, `Bearer ${this.appToken()}`)).value);
    if (id(entry.app_id) !== this.config.appId || id(entry.id) !== installationId) fail("GITHUB_INSTALLATION_INVALID", 403);
    if (entry.suspended_at != null || entry.repository_selection === "all") {
      if (discovery) return undefined;
      fail("GITHUB_INSTALLATION_INVALID", 403);
    }
    if (entry.repository_selection !== "selected") fail("GITHUB_INSTALLATION_INVALID", 403);
    const account = object(entry.account);
    if (!["User", "Organization"].includes(String(account.type))) fail("GITHUB_INSTALLATION_INVALID", 403);
    let approvedPermissions: InstallationCandidate["permissions"];
    try { approvedPermissions = permissions(entry.permissions); }
    catch (error) {
      if (discovery && error instanceof GithubError && error.code === "GITHUB_PERMISSION_MISMATCH") return undefined;
      throw error;
    }
    return { installationId, account: { id: id(account.id), login: string(account.login), type: String(account.type) }, permissions: approvedPermissions };
  }
  async candidates(accessToken: string): Promise<InstallationCandidate[]> {
    await this.user(accessToken);
    const installations = await this.pages("/user/installations", accessToken, "installations", MAX_DISCOVERY_INSTALLATIONS);
    const result: InstallationCandidate[] = [];
    let remainingRepositories = MAX_DISCOVERY_REPOSITORIES;
    for (const value of installations) {
      const entry = object(value);
      if (id(entry.app_id) !== this.config.appId) fail("GITHUB_INSTALLATION_INVALID", 403);
      const installation = await this.installation(id(entry.id), true);
      if (installation === undefined) continue;
      const repos = await this.pages(`/user/installations/${installation.installationId}/repositories`, accessToken, "repositories", remainingRepositories);
      remainingRepositories -= repos.length;
      const repositories = repos.map(repository).filter((repo) => repo.admin);
      if (repositories.length > 0) result.push({ ...installation, repositories });
    }
    return result;
  }
  async recheck(accessToken: string, installationId: string, expectedAccountId: string, selectedIds: string[]): Promise<InstallationCandidate> {
    const ids = repositoryIds(selectedIds);
    await this.user(accessToken);
    // Both the app and the current user must still see the installation.
    const installations = await this.pages("/user/installations", accessToken, "installations");
    if (!installations.some((value) => { const entry = object(value); return id(entry.id) === installationId && id(entry.app_id) === this.config.appId; })) fail("GITHUB_INSTALLATION_INVALID", 403);
    const installation = await this.installation(installationId);
    if (installation.account.id !== id(expectedAccountId)) fail("GITHUB_INSTALLATION_INVALID", 403);
    const available = (await this.pages(`/user/installations/${id(installationId)}/repositories`, accessToken, "repositories")).map(repository);
    const repositories = ids.map((repositoryId) => available.find((repo) => repo.id === repositoryId && repo.admin) ?? fail("GITHUB_REPOSITORY_FORBIDDEN", 403));
    return { ...installation, repositories };
  }
  async mint(installationId: string, selectedIds: string[]): Promise<{ token: string; expiresAt: string }> {
    const ids = repositoryIds(selectedIds);
    await this.installation(installationId);
    const entry = object((await this.request(`/app/installations/${id(installationId)}/access_tokens`, `Bearer ${this.appToken()}`, "POST", { repository_ids: ids.map(Number), permissions: { issues: "read", metadata: "read" } })).value);
    const token = string(entry.token, 16384);
    try {
      permissions(entry.permissions);
      if (entry.repository_selection !== "selected" || !Array.isArray(entry.repositories) || !equalIds(ids, entry.repositories.map((value) => id(object(value).id)))) fail("GITHUB_TOKEN_SCOPE_INVALID", 502);
      return { token, expiresAt: expiry(entry.expires_at) };
    } catch (error) {
      await this.revokeInstallationToken(token).catch(() => {});
      throw error;
    }
  }
  async revokeInstallationToken(token: string): Promise<void> {
    await this.request("/installation/token", `Bearer ${token}`, "DELETE", undefined, [401, 404]);
  }
  async listIssues(token: string, value: unknown): Promise<{
    repository: { id: string; fullName: string; url: string };
    issues: { id: string; number: number; title: string; state: "open" | "closed"; url: string; labels: string[]; author: { login: string; url: string } | null; updatedAt: string }[];
    nextPage: number | null;
  }> {
    const input = parseIssuesInput(value);
    const repo = repository((await this.request(`/repositories/${id(input.repositoryId)}`, `Bearer ${token}`)).value);
    if (repo.id !== input.repositoryId) fail("GITHUB_REPOSITORY_FORBIDDEN", 403);
    const query = new URLSearchParams({ state: input.state, page: String(input.page), per_page: String(input.limit) });
    const response = await this.request(`/repos/${repo.fullName.split("/").map(encodeURIComponent).join("/")}/issues?${query}`, `Bearer ${token}`);
    if (!Array.isArray(response.value) || response.value.length > input.limit) fail();
    const nextPage = input.page < 100 && /;\s*rel="next"/u.test(response.headers.get("link") ?? "") ? input.page + 1 : null;
    const issues = response.value.map(object).filter((entry) => !Object.hasOwn(entry, "pull_request")).map((entry) => {
      if (!Number.isSafeInteger(entry.number) || Number(entry.number) < 1 || !["open", "closed"].includes(String(entry.state)) || !Array.isArray(entry.labels) || !Number.isFinite(Date.parse(String(entry.updated_at)))) fail();
      const author = entry.user === null ? null : object(entry.user);
      const login = author === null ? null : string(author.login);
      return {
        id: id(entry.id), number: Number(entry.number), title: typeof entry.title === "string" ? entry.title : fail(), state: entry.state as "open" | "closed",
        url: `${repo.url}/issues/${String(entry.number)}`, labels: entry.labels.map((label) => typeof label === "string" ? label : string(object(label).name)),
        author: login === null ? null : { login, url: `https://github.com/${encodeURIComponent(login)}` }, updatedAt: new Date(String(entry.updated_at)).toISOString(),
      };
    });
    return { repository: { id: repo.id, fullName: repo.fullName, url: repo.url }, issues, nextPage };
  }
}
