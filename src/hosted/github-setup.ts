import { createHash, randomBytes, sign } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GithubError, loadGithubConfig, type GithubConfig } from "./github.js";
import { canManageWorkspace, type AuthenticatedContext } from "./identity.js";
import { HostedAccessError } from "./workspace-access.js";

export interface GithubSetupOptions {
  workspaceId: string; principalId: string; organization: string; webhookUrl: string; configFile: string;
}
const MAX_BYTES = 64 * 1024;
const ENV_FIELDS = ["CAPYKIT_GITHUB_APP_ID", "CAPYKIT_GITHUB_APP_SLUG", "CAPYKIT_GITHUB_CLIENT_ID", "CAPYKIT_GITHUB_CLIENT_SECRET", "CAPYKIT_GITHUB_PRIVATE_KEY", "CAPYKIT_GITHUB_WEBHOOK_SECRET", "CONNECT_STATE_ENCRYPTION_KEY", "CONNECT_STATE_ENCRYPTION_KEY_VERSION", "CAPYKIT_GITHUB_CALLBACK_URL"] as const;
function fail(code = "GITHUB_SETUP_FAILED", status = 502): never { throw new GithubError(code, status); }
function configError(): never { return fail("CONFIGURATION_UNAVAILABLE", 503); }
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/u.test(value)) fail();
  return value;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function filePath(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || dirname(value) === value || /[\r\n\0]/u.test(value)) configError();
  return value;
}

export function loadGithubSetupOptions(env: NodeJS.ProcessEnv = process.env): GithubSetupOptions | undefined {
  const names = ["CAPYKIT_GITHUB_SETUP_WORKSPACE_ID", "CAPYKIT_GITHUB_SETUP_PRINCIPAL_ID", "CAPYKIT_GITHUB_SETUP_ORGANIZATION", "CAPYKIT_GITHUB_WEBHOOK_URL"];
  // A config-file path alone also supports a previously provisioned deployment.
  if (!names.some((name) => Boolean(env[name]?.trim()))) return undefined;
  try {
    const workspaceId = text(env.CAPYKIT_GITHUB_SETUP_WORKSPACE_ID);
    const principalId = text(env.CAPYKIT_GITHUB_SETUP_PRINCIPAL_ID);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    if (!uuid.test(workspaceId) || !uuid.test(principalId)) configError();
    const organization = text(env.CAPYKIT_GITHUB_SETUP_ORGANIZATION, 39);
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/u.test(organization) || organization.includes("--")) configError();
    const webhookUrl = text(env.CAPYKIT_GITHUB_WEBHOOK_URL);
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/v1/webhooks/github" || url.href !== webhookUrl) configError();
    return { workspaceId, principalId, organization, webhookUrl, configFile: filePath(text(env.CAPYKIT_GITHUB_CONFIG_FILE, 4096)) };
  } catch { return configError(); }
}

function checkDirectory(path: string, create: boolean): void {
  const directory = dirname(filePath(path));
  const parents: string[] = [];
  for (let current = directory;; current = dirname(current)) {
    parents.push(current);
    if (current === dirname(current)) break;
  }
  // Check every existing ancestor before creating anything through it.
  for (const parent of parents.reverse()) {
    try { if (!lstatSync(parent).isDirectory()) configError(); }
    catch (error) { if (!missing(error)) throw error; }
  }
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) configError();
  } catch (error) { if (create || !missing(error)) throw error; }
}

function configurationEnvironment(config: GithubConfig): Record<string, string> {
  return {
    CAPYKIT_GITHUB_APP_ID: config.appId, CAPYKIT_GITHUB_APP_SLUG: config.appSlug,
    CAPYKIT_GITHUB_CLIENT_ID: config.clientId, CAPYKIT_GITHUB_CLIENT_SECRET: config.clientSecret,
    CAPYKIT_GITHUB_PRIVATE_KEY: config.privateKey, CAPYKIT_GITHUB_WEBHOOK_SECRET: config.webhookSecret,
    CONNECT_STATE_ENCRYPTION_KEY: config.encryptionKey.toString("base64"), CONNECT_STATE_ENCRYPTION_KEY_VERSION: config.keyVersion,
    CAPYKIT_GITHUB_CALLBACK_URL: config.callbackUrl,
  };
}

export function readStoredGithubConfig(path: string, publicBaseUrl: string): GithubConfig | undefined {
  let descriptor: number | undefined;
  try {
    checkDirectory(path, false);
    try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > MAX_BYTES) configError();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > MAX_BYTES) configError();
    const env = object(JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown);
    if (Object.keys(env).sort().join() !== [...ENV_FIELDS].sort().join() || Object.values(env).some((value) => typeof value !== "string")) configError();
    return loadGithubConfig(env as NodeJS.ProcessEnv, publicBaseUrl) ?? configError();
  } catch { return configError(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function persistGithubConfig(path: string, config: GithubConfig): void {
  let descriptor: number | undefined;
  let temporary: string | undefined;
  try {
    checkDirectory(path, true);
    const serialized = JSON.stringify(configurationEnvironment(config));
    if (Buffer.byteLength(serialized) > MAX_BYTES) configError();
    // Validate the same complete document that future processes will load.
    loadGithubConfig(configurationEnvironment(config), new URL(config.callbackUrl).origin);
    temporary = join(dirname(path), `.github-${randomBytes(16).toString("hex")}.tmp`);
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, serialized);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    try { linkSync(temporary, path); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") fail("GITHUB_ALREADY_CONFIGURED", 409);
      throw error;
    }
    unlinkSync(temporary); temporary = undefined;
    descriptor = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof GithubError) throw error;
    return configError();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporary !== undefined) { try { unlinkSync(temporary); } catch { /* A failed bootstrap never replaces the existing configuration. */ } }
  }
}

interface PendingSetup { stateHash: string; binding: string; expiresAt: number }
export class GithubSetup {
  private pending: PendingSetup | undefined;
  private busy = false;
  private completed = false;
  constructor(readonly options: GithubSetupOptions, private readonly publicBaseUrl: string, private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}
  eligible(context: AuthenticatedContext): boolean {
    return canManageWorkspace(context.membership) && context.membership.workspaceId === this.options.workspaceId && context.membership.principalId === this.options.principalId;
  }
  private binding(context: AuthenticatedContext, session: string): string {
    return hash(JSON.stringify([context.membership.workspaceId, context.membership.principalId, context.identity.provider, context.identity.subject, hash(session)]));
  }
  private available(context: AuthenticatedContext): void {
    if (!this.eligible(context)) fail("FORBIDDEN", 403);
    if (this.completed || readStoredGithubConfig(this.options.configFile, this.publicBaseUrl) !== undefined) fail("GITHUB_ALREADY_CONFIGURED", 409);
    if (this.busy) fail("GITHUB_SETUP_BUSY", 409);
  }
  start(context: AuthenticatedContext, session: string): { registrationUrl: string; manifest: Record<string, unknown> } {
    this.available(context);
    const state = randomBytes(32).toString("base64url");
    // ponytail: one pending registration per process; shared state is needed only if API replicas are introduced.
    this.pending = { stateHash: hash(state), binding: this.binding(context, session), expiresAt: this.now() + 600_000 };
    const registration = new URL(`https://github.com/organizations/${this.options.organization}/settings/apps/new`);
    registration.searchParams.set("state", state);
    return { registrationUrl: registration.href, manifest: {
      name: `Capykit ${this.options.organization.slice(0, 19)} ${randomBytes(3).toString("hex")}`,
      url: this.publicBaseUrl, hook_attributes: { url: this.options.webhookUrl, active: true },
      redirect_url: `${this.publicBaseUrl}/v1/provider-setup/github/callback`,
      callback_urls: [`${this.publicBaseUrl}/v1/connections/github/callback`],
      setup_url: `${this.publicBaseUrl}/v1/connections/github/setup`, public: false,
      default_permissions: { issues: "read", metadata: "read" }, default_events: [], request_oauth_on_install: false,
    } };
  }
  private async request(path: string, method: "GET" | "POST", authorization?: string): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/vnd.github+json", "user-agent": "capykit", "x-github-api-version": "2026-03-10", ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
    });
    if (response.status !== (method === "POST" ? 201 : 200)) { await response.body?.cancel(); fail(); }
    const reader = response.body?.getReader();
    if (!reader) fail();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BYTES) { await reader.cancel(); fail(); }
      chunks.push(chunk.value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  }
  private validateApp(app: Record<string, unknown>): { appId: string; appSlug: string; clientId: string; ownerId: number } {
    const owner = object(app.owner);
    const permissions = object(app.permissions);
    if (typeof app.id !== "number" || !Number.isSafeInteger(app.id) || app.id <= 0 || typeof owner.id !== "number" || !Number.isSafeInteger(owner.id) || owner.id <= 0) fail();
    const appSlug = text(app.slug, 100);
    const clientId = text(app.client_id);
    if (!/^[a-z0-9-]+$/u.test(appSlug) || !/^[A-Za-z0-9_.-]+$/u.test(clientId)) fail();
    if (owner.type !== "Organization" || text(owner.login).toLowerCase() !== this.options.organization.toLowerCase()) fail();
    if (app.external_url !== this.publicBaseUrl || app.html_url !== `https://github.com/apps/${appSlug}`) fail();
    if (Object.keys(permissions).sort().join() !== "issues,metadata" || permissions.issues !== "read" || permissions.metadata !== "read" || !Array.isArray(app.events) || app.events.length !== 0) fail();
    return { appId: String(app.id), appSlug, clientId, ownerId: owner.id };
  }
  async complete(context: AuthenticatedContext, session: string, body: unknown, authorize: () => Promise<void>): Promise<GithubConfig> {
    this.available(context);
    const input = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (Object.keys(input).sort().join() !== "code,state" || typeof input.code !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(input.code) || typeof input.state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.state)) fail("GITHUB_SETUP_STATE_INVALID", 400);
    const pending = this.pending;
    if (!pending || pending.expiresAt <= this.now() || pending.stateHash !== hash(input.state) || pending.binding !== this.binding(context, session)) fail("GITHUB_SETUP_STATE_INVALID", 400);
    this.pending = undefined; this.busy = true;
    try {
      const converted = await this.request(`/app-manifests/${encodeURIComponent(input.code)}/conversions`, "POST");
      const app = this.validateApp(converted);
      let config: GithubConfig;
      try {
        config = loadGithubConfig({
          CAPYKIT_GITHUB_APP_ID: app.appId, CAPYKIT_GITHUB_APP_SLUG: app.appSlug, CAPYKIT_GITHUB_CLIENT_ID: app.clientId,
          CAPYKIT_GITHUB_CLIENT_SECRET: text(converted.client_secret), CAPYKIT_GITHUB_WEBHOOK_SECRET: text(converted.webhook_secret),
          CAPYKIT_GITHUB_PRIVATE_KEY: typeof converted.pem === "string" ? converted.pem : "",
          CONNECT_STATE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), CONNECT_STATE_ENCRYPTION_KEY_VERSION: "v1",
        }, this.publicBaseUrl) ?? fail();
      } catch { return fail(); }
      const now = Math.floor(this.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.clientId })).toString("base64url");
      const data = `${header}.${payload}`;
      const jwt = `${data}.${sign("RSA-SHA256", Buffer.from(data), config.privateKey).toString("base64url")}`;
      const verified = this.validateApp(await this.request("/app", "GET", jwt));
      if (JSON.stringify(verified) !== JSON.stringify(app)) fail();
      const hook = await this.request("/app/hook/config", "GET", jwt);
      if (hook.url !== this.options.webhookUrl || hook.insecure_ssl !== "0" || hook.content_type !== "json") fail();
      await authorize();
      if (pending.expiresAt <= this.now()) fail("GITHUB_SETUP_STATE_INVALID", 400);
      persistGithubConfig(this.options.configFile, config);
      this.completed = true;
      return config;
    } catch (error) {
      if (error instanceof HostedAccessError || (error instanceof GithubError && error.code !== "CONFIGURATION_UNAVAILABLE")) throw error;
      return fail();
    } finally { this.busy = false; }
  }
}
