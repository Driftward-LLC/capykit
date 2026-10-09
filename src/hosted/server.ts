import { createGoogleSignIn, type GoogleSignIn } from "./google-sign-in.js";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callbackOriginAllowed, loadHostedConfig, missingHostedConfig, type HostedConfig } from "./config.js";
import { checkDatabaseReadiness, createHostedDatabase, type HostedDatabase } from "./db.js";
import { stableError, type AuthenticatedContext, type StableErrorCode } from "./identity.js";
import { AuthUnavailableError, createAuthGateway, type AuthGateway } from "./auth.js";
import { ArtifactError } from "./artifacts.js";
import { CapabilityError, CapabilityStore } from "./capabilities.js";
import { Readable } from "node:stream";
import { authorizeWorkspace, HostedAccessError, requireWorkspaceOwner } from "./workspace-access.js";
import { ConnectionError, ConnectionStore } from "./connections.js";
import { GithubError, GithubProvider, loadGithubConfig as loadEnvironmentGithubConfig, verifyGithubWebhook, type GithubConfig } from "./github.js";
import { GithubSetup, loadGithubSetupOptions, readStoredGithubConfig } from "./github-setup.js";
import { createWebhookIngress } from "./webhook-ingress.js";
import { GoogleConnections, GoogleProvider, loadGoogleConfig, type GoogleConfig } from "./google.js";
import { ActionAccess } from "./action-access.js";
import { runAction } from "./action-runner.js";
import { appCatalog, catalogProvenance, personalAvailability } from "./piece-catalog.js";
import { loadPreviewSimulation, previewSimulationConsentPage } from "./preview-simulation.js";

import { PieceEngine, loadPieceEngineConfig } from "./piece-engine.js";
import { PersonalConnections } from "./personal-connections.js";
import { GrantError, GrantStore } from "./grants.js";
export { verifyArtifact } from "./artifacts.js";
export { ConnectionStore } from "./connections.js";
export { GithubProvider } from "./github.js";

/** Shared by API startup and the operator-only cleanup command. */
export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env, publicBaseUrl?: string): GithubConfig | undefined {
  const base = publicBaseUrl ?? loadHostedConfig(env).publicBaseUrl;
  const manual = loadEnvironmentGithubConfig(env, base);
  const stored = env.CAPYKIT_GITHUB_CONFIG_FILE ? readStoredGithubConfig(env.CAPYKIT_GITHUB_CONFIG_FILE, base) : undefined;
  if (manual && stored) throw new GithubError("CONFIGURATION_UNAVAILABLE", 503);
  return manual ?? stored;
}

interface ServerDeps {
  pieceEngine?: PieceEngine;
  googleSignIn?: GoogleSignIn;
  readonly config?: HostedConfig;
  readonly database?: HostedDatabase | undefined;
  readonly auth?: AuthGateway | undefined;
  readonly consoleDirectory?: string;
  readonly githubConfig?: GithubConfig | undefined;
  readonly githubProvider?: GithubProvider | undefined;
  readonly githubSetup?: GithubSetup | undefined;
  readonly googleConfig?: GoogleConfig | undefined;
  readonly googleProvider?: GoogleProvider | undefined;
}

function bearerToken(request: FastifyRequest, config: HostedConfig): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ") === true) return authorization.slice("Bearer ".length);
  return request.cookies[config.sessionCookieName];
}

const rememberedSessionSeconds = 30 * 24 * 60 * 60;
function setSessionCookies(reply: FastifyReply, config: HostedConfig, token: string, refreshToken?: string, existingCsrf?: string): void {
  const csrf = existingCsrf ?? randomBytes(24).toString("base64url");
  const base = { httpOnly: true, secure: config.secureCookies, sameSite: "strict" as const, path: "/", maxAge: refreshToken === undefined ? 3600 : rememberedSessionSeconds };
  reply.setCookie(config.sessionCookieName, token, base);
  reply.setCookie(config.csrfCookieName, csrf, { ...base, httpOnly: false });
  if (refreshToken !== undefined) reply.setCookie(config.refreshCookieName, refreshToken, { ...base, path: "/v1/auth" });
  else reply.clearCookie(config.refreshCookieName, { path: "/v1/auth" });
}

function clearSessionCookies(reply: FastifyReply, config: HostedConfig): void {
  reply.clearCookie(config.sessionCookieName, { path: "/" });
  reply.clearCookie(config.csrfCookieName, { path: "/" });
  reply.clearCookie(config.refreshCookieName, { path: "/v1/auth" });
}

function csrfValid(request: FastifyRequest, config: HostedConfig): boolean {
  const token = request.cookies[config.csrfCookieName];
  const header = request.headers["x-csrf-token"];
  return token !== undefined && token.length > 0 && typeof header === "string" && header === token;
}

async function authenticatedContext(token: string | undefined, database: HostedDatabase | undefined, auth: AuthGateway | undefined): Promise<AuthenticatedContext | undefined> {
  if (token === undefined || auth === undefined || database === undefined) return undefined;
  const identity = await auth.verifyBearer(token);
  return identity === undefined ? undefined : database.resolveContext(identity);
}

export const meResponseSchema = {
  type: "object",
  required: ["identity", "workspace"],
  properties: {
    identity: { type: "object", required: ["email", "principalKind"], properties: { email: { type: "string" }, principalKind: { type: "string" } }, additionalProperties: false },
    workspace: { type: "object", required: ["id", "role"], properties: { id: { type: "string" }, role: { type: "string" } }, additionalProperties: false },
  },
  additionalProperties: false,
} as const;

const emailSchema = { type: "string", minLength: 3, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" } as const;
const otpSchema = {
  type: "object", required: ["email"], additionalProperties: false,
  properties: { email: emailSchema, redirectTo: { type: "string", maxLength: 2048 } },
} as const;
const verifySchema = {
  type: "object", required: ["email", "token"], additionalProperties: false,
  properties: { email: emailSchema, token: { type: "string", pattern: "^[0-9]{6}$" } },
} as const;
const errorResponseSchema = {
  type: "object", required: ["error"], additionalProperties: false,
  properties: { error: { type: "object", required: ["code", "requestId"], additionalProperties: false,
    properties: { code: { type: "string" }, requestId: { type: "string" } } } },
} as const;

export function createHostedServer(deps: ServerDeps = {}): FastifyInstance {
  const config = deps.config ?? loadHostedConfig();
  const database = deps.database ?? createHostedDatabase(config.databaseUrl);
  const auth = deps.auth ?? createAuthGateway(config);
  const consoleDirectory = deps.consoleDirectory ?? fileURLToPath(new URL("./console/", import.meta.url));
  const publicOrigin = new URL(config.publicBaseUrl).origin;
  let githubConfig = deps.githubConfig ?? loadGithubConfig(process.env, config.publicBaseUrl);
  const googleConfig = deps.googleConfig ?? loadGoogleConfig(process.env, config.publicBaseUrl);
  const simulation = loadPreviewSimulation(process.env, config.publicBaseUrl, { github: githubConfig, google: googleConfig });
  githubConfig = simulation?.githubConfig ?? githubConfig;
  let github = deps.githubProvider ?? simulation?.githubProvider ?? (githubConfig === undefined ? undefined : new GithubProvider(githubConfig));
  let connections = database === undefined ? undefined : new ConnectionStore(database.pool, github, githubConfig);
  const activeGoogleConfig = simulation?.googleConfig ?? googleConfig;
  const google = deps.googleProvider ?? simulation?.googleProvider ?? (activeGoogleConfig ? new GoogleProvider(activeGoogleConfig) : undefined);
  const drive = database ? new GoogleConnections(database.pool, google, activeGoogleConfig) : undefined;
  const setupOptions = deps.githubSetup === undefined ? loadGithubSetupOptions() : undefined;
  const githubSetup = deps.githubSetup ?? (setupOptions === undefined ? undefined : new GithubSetup(setupOptions, config.publicBaseUrl));
  const googleSignIn = deps.googleSignIn ?? (config.publicSignup && config.authUrl ? createGoogleSignIn(config.authUrl, publicOrigin) : undefined);
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 16 * 1024,
    requestTimeout: 120_000, connectionTimeout: 30_000, ajv: { customOptions: { removeAdditional: false } } });
  const grants = database === undefined ? undefined : new GrantStore(database.pool);
  const actionAccess = database ? new ActionAccess(database.pool) : undefined;
  const pieceConfig = deps.pieceEngine?.config ?? loadPieceEngineConfig(process.env.CAPYKIT_PIECE_ENGINE_CONFIG_FILE);
  const pieceEngine = deps.pieceEngine ?? (pieceConfig ? new PieceEngine(pieceConfig) : undefined);
  const personal = database ? new PersonalConnections(database.pool, pieceEngine, config.publicBaseUrl) : undefined;
  const capabilities = database === undefined ? undefined : new CapabilityStore(database.pool);
  const contexts = new WeakMap<FastifyRequest, AuthenticatedContext>();
  // ponytail: one artifact transfer per API process bounds memory for 32 MiB bundles;
  // use streaming storage if concurrent large transfers become necessary.
  let artifactTransfer: FastifyRequest | undefined;
  void app.register(cookie);
  app.addHook("onClose", async () => { await database?.close(); });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id).header("cache-control", "no-store").header("x-content-type-options", "nosniff");
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ArtifactError || error instanceof CapabilityError || error instanceof GrantError || error instanceof HostedAccessError || error instanceof ConnectionError || error instanceof GithubError || error instanceof AuthUnavailableError) {
      return reply.code(error.statusCode).send(stableError(error.code as StableErrorCode, request.id));
    }
    const status = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(status).type("application/json").send(stableError(status < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR", request.id));
  });
  for (const hook of ["onResponse", "onRequestAbort", "onTimeout"] as const) {
    app.addHook(hook, (request: FastifyRequest) => { if (artifactTransfer === request) artifactTransfer = undefined; return Promise.resolve(); });
  }
  app.setNotFoundHandler((request, reply) => reply.code(404).send(stableError("NOT_FOUND", request.id)));
  app.addHook("preHandler", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const origin = request.headers.origin;
    const cookieAuth = (request.cookies[config.sessionCookieName] !== undefined || request.cookies[config.refreshCookieName] !== undefined) && request.headers.authorization?.startsWith("Bearer ") !== true;
    if ((origin !== undefined && origin !== publicOrigin) || (cookieAuth && (origin !== publicOrigin || !csrfValid(request, config)))) {
      return reply.code(403).send(stableError("CSRF_REQUIRED", request.id));
    }
  });

  app.get("/health/live", () => ({ status: "ok" }));
  app.get("/auth/email-template", (_request, reply) => reply.type("text/html").send("<!doctype html><html lang=\"en\"><body><h1>Your Capykit sign-in code</h1><p>Enter this six-digit code in Capykit:</p><p><strong>{{ .Token }}</strong></p><p>If you did not request this code, you can ignore this email.</p></body></html>"));
  app.get("/health/ready", async (_request, reply) => {
    const db = await checkDatabaseReadiness(database);
    const missing = missingHostedConfig(config);
    const ready = missing.length === 0 && db.status === "ready";
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable", database: db.reason, missing });
  });
  async function serveConsole(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    reply.header("content-security-policy", `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.activepieces.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${githubSetup ? " https://github.com" : ""}`);
    reply.header("referrer-policy", "no-referrer");
    return reply.type("text/html").send(await readFile(join(consoleDirectory, "index.html")));
  }
  app.get("/", serveConsole);
  // Render a same-origin document before the authenticated POST continuation.
  // SameSite=Strict session cookies intentionally do not accompany GitHub's
  // initial cross-site GET. The console immediately removes code/state from its URL.
  app.get("/v1/connections/github/callback", serveConsole);
  app.get("/v1/connections/google/callback", serveConsole);
  app.get("/v1/connections/personal/callback", serveConsole);
  app.get("/v1/connections/github/setup", serveConsole);
  app.get("/v1/provider-setup/github/callback", serveConsole);
  app.get<{ Querystring: { state?: string } }>("/v1/preview/simulated/github/consent", async (request, reply) => {
    if (simulation === undefined) return reply.code(404).send(stableError("NOT_FOUND", request.id));
    return reply.type("text/html").send(previewSimulationConsentPage("github", request.query.state));
  });
  app.get<{ Querystring: { state?: string } }>("/v1/preview/simulated/google-drive/consent", async (request, reply) => {
    if (simulation === undefined) return reply.code(404).send(stableError("NOT_FOUND", request.id));
    return reply.type("text/html").send(previewSimulationConsentPage("google-drive", request.query.state));
  });
  app.get<{ Params: { file: string } }>("/assets/:file", async (request, reply) => {
    const { file } = request.params;
    if (!/^[a-zA-Z0-9_-]+\.(?:js|css)$/u.test(file)) return reply.code(404).send(stableError("NOT_FOUND", request.id));
    try {
      const content = await readFile(join(consoleDirectory, "assets", file));
      return await reply.type(file.endsWith(".js") ? "text/javascript" : "text/css").send(content);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return reply.code(404).send(stableError("NOT_FOUND", request.id));
      throw error;
    }
  });

  app.post<{ Body: { email: string; redirectTo?: string } }>("/v1/auth/otp", { schema: { body: otpSchema } }, async (request, reply) => {
    if (config.publicSignup) return reply.code(404).send(stableError("NOT_FOUND", request.id));
    const redirectTo = request.body.redirectTo ?? config.publicBaseUrl;
    let redirect: URL;
    try { redirect = new URL(redirectTo); } catch { return reply.code(400).send(stableError("INVALID_REQUEST", request.id)); }
    if (!callbackOriginAllowed(config, redirect.origin) || redirect.username !== "" || redirect.password !== "") return reply.code(400).send(stableError("INVALID_REQUEST", request.id));
    if (auth === undefined) return reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id));
    await auth.requestOtp(request.body.email.trim().toLowerCase(), redirectTo);
    return reply.code(202).send({ status: "accepted" });
  });

  async function establishSession(token: string | undefined, request: FastifyRequest, reply: FastifyReply, refreshToken?: string): Promise<FastifyReply> {
    const context = await authenticatedContext(token, database, auth);
    if (token === undefined || context === undefined) return reply.code(401).send(stableError("AUTHENTICATION_INVALID", request.id));
    if (!context.membership.active) return reply.code(401).send(stableError("MEMBERSHIP_INACTIVE", request.id));
    setSessionCookies(reply, config, token, refreshToken);
    return reply.send({ status: "authenticated" });
  }
  const googleCookie = "capykit_google_verifier";
  const googleCookieOptions = { path: "/v1/auth/google/callback", httpOnly: true, secure: config.secureCookies, sameSite: "lax" as const };
  // ponytail: eight concurrent login operations per API process; use shared admission
  // if public signup outgrows this deployment. GoTrue owns code expiry and replay.
  let googleOperations = 0;
  async function googleOperation<T>(run: () => Promise<T>): Promise<T> {
    if (googleOperations >= 8) throw new AuthUnavailableError();
    googleOperations++;
    try { return await run(); } finally { googleOperations--; }
  }
  app.get("/v1/auth/method", async () => config.publicSignup ? { method: "google", available: googleSignIn ? await googleSignIn.available() : false } : { method: config.tailscaleSignIn === undefined ? "email" : "tailscale" });
  app.post("/v1/auth/google/start", { schema: { body: { type: "object", additionalProperties: false, properties: {} } } }, async (request, reply) => {
    if (request.headers.origin !== publicOrigin || request.headers.authorization !== undefined) return reply.code(403).send(stableError("CSRF_REQUIRED", request.id));
    if (!config.publicSignup || !googleSignIn || !database?.provisionIdentity || !auth) return reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id));
    const started = await googleOperation(() => googleSignIn.start());
    reply.setCookie(googleCookie, started.verifier, { ...googleCookieOptions, maxAge: 600 });
    return { authorizationUrl: started.authorizationUrl };
  });
  app.get("/v1/auth/google/provider/callback", async (request, reply) => {
    reply.header("referrer-policy", "no-referrer");
    if (!config.publicSignup || !googleSignIn || request.url.length > 8192) return await reply.redirect(`${publicOrigin}/?auth=google-failed`);
    const input = new URL(request.url, publicOrigin).searchParams;
    const params = new URLSearchParams();
    for (const key of ["code", "state", "error"]) { const value = input.get(key); if (value) params.set(key, value); }
    try { return await reply.redirect(await googleOperation(() => googleSignIn.providerCallback(params))); }
    catch { return await reply.redirect(`${publicOrigin}/?auth=google-failed`); }
  });
  app.get<{ Querystring: { code?: string } }>("/v1/auth/google/callback", async (request, reply) => {
    reply.header("referrer-policy", "no-referrer");
    reply.clearCookie(googleCookie, googleCookieOptions);
    const verifier = request.cookies[googleCookie], code = request.query.code;
    if (!config.publicSignup || !googleSignIn || !auth || !database?.provisionIdentity || !verifier || !/^[A-Za-z0-9_-]{43}$/u.test(verifier) || typeof code !== "string" || !code || code.length > 4096 || /[\r\n\0]/u.test(code)) return await reply.redirect(`${publicOrigin}/?auth=google-expired`);
    try {
      const session = await googleOperation(() => googleSignIn.exchange(code, verifier));
      const identity = session ? await auth.verifyBearer(session.accessToken) : undefined;
      if (!identity || !session) return await reply.redirect(`${publicOrigin}/?auth=google-failed`);
      await database.provisionIdentity(identity);
      const context = await database.resolveContext(identity);
      if (!context?.membership.active || context.membership.principalKind !== "human") return await reply.redirect(`${publicOrigin}/?auth=google-failed`);
      setSessionCookies(reply, config, session.accessToken, session.refreshToken);
      return await reply.redirect(`${publicOrigin}/?tab=connections`);
    } catch { return await reply.redirect(`${publicOrigin}/?auth=google-failed`); }
  });
  app.post("/v1/auth/tailscale", { schema: { body: { type: "object", additionalProperties: false, properties: {} } } }, async (request, reply) => {
    if (request.headers.origin !== publicOrigin || request.headers.authorization !== undefined) return reply.code(403).send(stableError("CSRF_REQUIRED", request.id));
    const mapping = config.tailscaleSignIn;
    if (mapping === undefined || auth?.signInTrusted === undefined || database === undefined) return reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id));
    // Serve strips caller-supplied identity headers. Publish this backend ONLY on loopback;
    // the configured peer is the host/Docker gateway, never a forwarded client address.
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/u, "");
    if (peer !== mapping.proxyAddress || request.headers["tailscale-user-login"] !== mapping.login) return reply.code(401).send(stableError("AUTHENTICATION_INVALID", request.id));
    const invited = await database.resolveContext({ provider: "gotrue", subject: mapping.subject, email: mapping.email });
    if (!invited?.membership.active || invited.membership.principalKind !== "human") return reply.code(401).send(stableError("MEMBERSHIP_INACTIVE", request.id));
    const session = await auth.signInTrusted(mapping.email, mapping.subject);
    const identity = session === undefined ? undefined : await auth.verifyBearer(session.accessToken);
    if (identity?.subject !== mapping.subject || identity.email.toLowerCase() !== mapping.email) return reply.code(401).send(stableError("AUTHENTICATION_INVALID", request.id));
    return establishSession(session?.accessToken, request, reply, session?.refreshToken);
  });
  app.post<{ Body: { email: string; token: string } }>("/v1/auth/verify", { schema: { body: verifySchema } }, async (request, reply) => {
    if (config.publicSignup) return reply.code(404).send(stableError("NOT_FOUND", request.id));
    if (request.headers.origin !== publicOrigin) return reply.code(403).send(stableError("CSRF_REQUIRED", request.id));
    if (auth === undefined || database === undefined) return reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id));
    const session = await auth.verifyOtp(request.body.email.trim().toLowerCase(), request.body.token);
    return establishSession(session?.accessToken, request, reply, session?.refreshToken);
  });
  app.post("/v1/auth/session", async (request, reply) => {
    if (request.headers.origin !== publicOrigin) return reply.code(403).send(stableError("CSRF_REQUIRED", request.id));
    const authorization = request.headers.authorization;
    return establishSession(authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : undefined, request, reply);
  });

  app.post("/v1/auth/refresh", { schema: { body: { type: "object", additionalProperties: false, properties: {} } } }, async (request, reply) => {
    if (request.headers.origin !== publicOrigin || !csrfValid(request, config) || request.headers.authorization !== undefined) return reply.code(403).send(stableError("CSRF_REQUIRED", request.id));
    if (auth === undefined || database === undefined) return reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id));
    const refreshToken = request.cookies[config.refreshCookieName];
    const session = refreshToken === undefined ? undefined : await auth.refresh(refreshToken);
    const context = await authenticatedContext(session?.accessToken, database, auth);
    if (session === undefined || context === undefined || !context.membership.active) {
      clearSessionCookies(reply, config);
      return reply.code(401).send(stableError("AUTHENTICATION_REQUIRED", request.id));
    }
    // Preserve CSRF across token rotation so other tabs and concurrent writes stay valid.
    setSessionCookies(reply, config, session.accessToken, session.refreshToken, request.cookies[config.csrfCookieName]);
    return reply.send({ status: "authenticated" });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    if (request.headers.origin !== publicOrigin || !csrfValid(request, config)) return reply.code(403).send(stableError("CSRF_REQUIRED", request.id));
    if (auth === undefined) return reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id));
    // Join any pending rotation, then revoke the provider session with a fresh token.
    // Expired access tokens alone cannot revoke a still-valid refresh session.
    const refreshToken = request.cookies[config.refreshCookieName];
    const renewed = refreshToken === undefined ? undefined : await auth.refresh(refreshToken);
    const token = renewed?.accessToken ?? bearerToken(request, config);
    if (token !== undefined) await auth.signOut(token);
    clearSessionCookies(reply, config);
    return reply.send({ status: "logged_out" });
  });
  app.get("/v1/me", { schema: { response: { 200: meResponseSchema, 401: errorResponseSchema } } }, async (request, reply) => {
    const token = bearerToken(request, config);
    const context = token?.startsWith("ck_agent_") ? await actionAccess?.authenticate(token) : await authenticatedContext(token, database, auth);
    if (context === undefined) return reply.code(401).send(stableError("AUTHENTICATION_REQUIRED", request.id));
    if (!context.membership.active) return reply.code(401).send(stableError("MEMBERSHIP_INACTIVE", request.id));
    return {
      identity: { email: context.identity.email, principalKind: context.membership.principalKind },
      workspace: { id: context.membership.workspaceId, role: context.membership.role },
    };
  });

  async function requireIdentity(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (capabilities === undefined) { reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id)); return; }
    const token = bearerToken(request, config);
    const context = token?.startsWith("ck_agent_") ? await actionAccess?.authenticate(token) : await authenticatedContext(token, database, auth);
    if (context === undefined || !context.membership.active) { reply.code(401).send(stableError("AUTHENTICATION_REQUIRED", request.id)); return; }
    contexts.set(request, context);
  }
  function contextFor(request: FastifyRequest): AuthenticatedContext {
    const context = contexts.get(request);
    if (context === undefined) throw new Error("Missing authenticated context");
    return context;
  }
  function capabilityStore(): CapabilityStore {
    if (capabilities === undefined) throw new Error("Missing capability database");
    return capabilities;
  }
  const authenticated = { onRequest: requireIdentity };
  function grantStore(): GrantStore {
    if (!grants) throw new Error("Missing grant database");
    return grants;
  }
  app.get("/v1/access/options", authenticated, async request => grantStore().options(contextFor(request)));
  app.get<{ Querystring: { cursor?: string } }>("/v1/grants", { ...authenticated,
    schema: { querystring: { type: "object", additionalProperties: false, properties: { cursor: { type: "string", maxLength: 36 } } } },
  }, async request => grantStore().list(contextFor(request), request.query.cursor));
  app.post("/v1/grants", authenticated, async (request, reply) => reply.code(201).send(await grantStore().create(contextFor(request), request.body)));
  app.delete<{ Params: { id: string } }>("/v1/grants/:id", authenticated, async (request, reply) => {
    await grantStore().revoke(contextFor(request), request.params.id);
    return reply.code(204).send();
  });
  app.get("/v1/capabilities", authenticated, async (request) => ({ capabilities: await capabilityStore().list(contextFor(request)) }));
  app.post("/v1/capabilities", authenticated, async (request, reply) => reply.code(201).send(await capabilityStore().create(contextFor(request), request.body)));
  app.get<{ Params: { id: string } }>("/v1/capabilities/:id", authenticated, async (request) => capabilityStore().detail(contextFor(request), request.params.id));
  async function beginArtifactTransfer(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireIdentity(request, reply);
    if (reply.sent) return;
    // Scope and authorize the exact record before accepting or reading bytes.
    await capabilityStore().detail(contextFor(request), (request.params as { id: string }).id);
    if (!["GET", "HEAD"].includes(request.method)) {
      const cookieAuth = request.headers.authorization?.startsWith("Bearer ") !== true;
      if ((request.headers.origin !== undefined && request.headers.origin !== publicOrigin) || (cookieAuth && (request.headers.origin !== publicOrigin || !csrfValid(request, config)))) {
        reply.code(403).send(stableError("CSRF_REQUIRED", request.id)); return;
      }
    }
    if (artifactTransfer !== undefined) { reply.code(429).header("retry-after", "2").send(stableError("ARTIFACT_BUSY", request.id)); return; }
    if (!reply.raw.destroyed && reply.raw.socket?.destroyed !== true) {
      artifactTransfer = request;
      reply.raw.once("close", () => { if (artifactTransfer === request) artifactTransfer = undefined; });
    }
  }
  const transferring = { onRequest: beginArtifactTransfer };
  app.put<{ Params: { id: string } }>("/v1/capabilities/:id/draft", {
    ...transferring, bodyLimit: 46 * 1024 * 1024,
  }, async (request) => capabilityStore().saveDraft(contextFor(request), request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/v1/capabilities/:id/publish", transferring, async (request) => capabilityStore().publish(contextFor(request), request.params.id, request.body));
  app.get<{ Params: { id: string; version: string } }>("/v1/capabilities/:id/versions/:version/download", transferring, async (request, reply) => {
    const download = await capabilityStore().download(contextFor(request), request.params.id, request.params.version);
    reply.header("content-disposition", `attachment; filename="${download.capability.slug}-${download.version}.capykit.json"`);
    return reply.type("application/json").send(Readable.from([JSON.stringify(download)]));
  });
  app.delete<{ Params: { id: string } }>("/v1/capabilities/:id", authenticated, async (request, reply) => {
    await capabilityStore().delete(contextFor(request), request.params.id);
    return reply.code(204).send();
  });

  function connectionStore(): ConnectionStore {
    if (connections === undefined) throw new Error("Missing connection database");
    return connections;
  }
  function sessionFor(request: FastifyRequest): string {
    const identity = contextFor(request).identity;
    if (identity.sessionId !== undefined) return `${identity.provider}:${identity.subject}:${identity.sessionId}`;
    const token = bearerToken(request, config);
    if (token === undefined) throw new Error("Missing authenticated session");
    return token;
  }
  function driveStore(): GoogleConnections {
    if (!drive) throw new ConnectionError("CONFIGURATION_UNAVAILABLE", 503);
    return drive;
  }

  app.get("/v1/apps/catalog", authenticated, () => ({apps:personalAvailability(appCatalog(),pieceEngine?new Set(Object.keys(pieceEngine.config.oauthClients)):undefined),catalog:catalogProvenance,personalEnabled:Boolean(pieceEngine)}));
  app.get("/v1/apps", authenticated, async request => {
    const context = contextFor(request);
    const records = await connectionStore().list(context);
    const googleState = await driveStore().detail(context);
    return { apps: personalAvailability(appCatalog([
      { id: "github", name: "GitHub", configured: Boolean(github), connected: records.some(row => row.status === "active"), description: "Read issues from selected repositories", connector: "@activepieces/piece-github@0.9.0" },
      { id: "google-drive", name: "Google Drive", configured: googleState.configured, connected: googleState.connection?.status === "active", description: "Read file names and metadata", connector: "@activepieces/piece-google-drive@0.11.0" },
    ]),pieceEngine?new Set(Object.keys(pieceEngine.config.oauthClients)):undefined), catalog:catalogProvenance, github: records, google: googleState,personalEnabled:Boolean(pieceEngine), previewSimulation: simulation !== undefined };
  });
  function personalStore(): PersonalConnections { if(!personal)throw new ConnectionError("CONFIGURATION_UNAVAILABLE",503);return personal; }
  app.get("/v1/connections/personal",authenticated,async request=>({connections:await personalStore().list(contextFor(request)),enabled:Boolean(pieceEngine)}));
  app.get<{Params:{app:string}}>("/v1/apps/:app/connection-schema",authenticated,async request=>personalStore().describe(contextFor(request),request.params.app));
  app.post<{Params:{app:string}}>("/v1/apps/:app/connect",authenticated,async request=>personalStore().start(contextFor(request),sessionFor(request),request.params.app,request.body));
  app.post("/v1/connections/personal/callback",authenticated,async request=>personalStore().callback(contextFor(request),sessionFor(request),request.body));
  app.delete<{Params:{id:string}}>("/v1/connections/personal/:id",authenticated,async(request,reply)=>{await personalStore().disconnect(contextFor(request),request.params.id);return reply.code(204).send();});
  app.get<{Params:{id:string}}>("/v1/connections/personal/:id/actions",authenticated,async request=>personalStore().actions(contextFor(request),request.params.id));
  app.post<{Params:{id:string;action:string};Body:{input:unknown}}>("/v1/connections/personal/:id/actions/:action/fields",{...authenticated,schema:{body:{type:"object",additionalProperties:false,required:["input"],properties:{input:{type:"object"}}}}},async request=>personalStore().fields(contextFor(request),request.params.id,request.params.action,request.body.input));
  app.post<{Params:{id:string;action:string};Body:{input:unknown}}>("/v1/connections/personal/:id/actions/:action/run",{...authenticated,schema:{body:{type:"object",additionalProperties:false,required:["input"],properties:{input:{type:"object"}}}}},async request=>personalStore().run(contextFor(request),request.params.id,request.params.action,request.body.input));
  app.get<{Params:{id:string}}>("/v1/connections/personal/:id/sharing",authenticated,async request=>personalStore().sharing(contextFor(request),request.params.id));
  app.post<{Params:{id:string}}>("/v1/connections/personal/:id/grants",authenticated,async(request,reply)=>reply.code(201).send(await personalStore().grant(contextFor(request),request.params.id,request.body)));
  app.delete<{Params:{id:string;grant:string}}>("/v1/connections/personal/:id/grants/:grant",authenticated,async(request,reply)=>{await personalStore().revoke(contextFor(request),request.params.id,request.params.grant);return reply.code(204).send();});
  app.post("/v1/connections/google/start", { ...authenticated, schema: { body: { type: "object", additionalProperties: false, required: ["consent"], properties: { consent: { const: true } } } } }, async request => driveStore().start(contextFor(request), sessionFor(request)));
  app.post<{ Body: { code: string; state: string } }>("/v1/connections/google/callback", { ...authenticated, schema: { body: { type: "object", additionalProperties: false, required: ["code","state"], properties: { code: { type:"string", minLength:1,maxLength:4096 }, state: { type:"string",pattern:"^[A-Za-z0-9_-]{43}$" } } } } }, async request => {
    await driveStore().callback(contextFor(request),sessionFor(request),request.body); return { status: "connected" };
  });
  app.delete("/v1/connections/google", authenticated, async (request,reply) => { await driveStore().disconnect(contextFor(request)); return reply.code(204).send(); });
  function actionStore(): ActionAccess { if(!actionAccess)throw new ConnectionError("CONFIGURATION_UNAVAILABLE",503);return actionAccess; }
  app.get("/v1/actions",authenticated,async request=>actionStore().catalog(contextFor(request)));
  app.post<{Params:{id:string};Body:{connectionId:string;input:unknown}}>("/v1/actions/:id/run",{...authenticated,schema:{body:{type:"object",additionalProperties:false,required:["connectionId","input"],properties:{connectionId:{type:"string",format:"uuid"},input:{type:"object"}}}}},async request=>runAction(actionStore(),connectionStore(),driveStore(),contextFor(request),request.params.id,request.body.connectionId,request.body.input));
  app.get("/v1/action-access",authenticated,async request=>actionStore().options(contextFor(request)));
  app.post("/v1/agents/keys",authenticated,async(request,reply)=>reply.code(201).send(await actionStore().issueKey(contextFor(request),request.body)));
  app.delete<{Params:{id:string}}>("/v1/agents/keys/:id",authenticated,async(request,reply)=>{await actionStore().revokeKey(contextFor(request),request.params.id);return reply.code(204).send();});
  app.post("/v1/action-grants",authenticated,async(request,reply)=>reply.code(201).send(await actionStore().grant(contextFor(request),request.body)));
  app.delete<{Params:{id:string}}>("/v1/action-grants/:id",authenticated,async(request,reply)=>{await actionStore().revokeGrant(contextFor(request),request.params.id);return reply.code(204).send();});
  // Keep the preview's old connection-test URLs on the same authorization/execution path.
  app.post<{Body:{connectionId:string;repositoryId:string;issueNumber:number}}>("/v1/apps/github/test",{...authenticated,schema:{body:{type:"object",additionalProperties:false,required:["connectionId","repositoryId","issueNumber"],properties:{connectionId:{type:"string",format:"uuid"},repositoryId:{type:"string",pattern:"^[0-9]+$"},issueNumber:{type:"integer",minimum:1,maximum:Number.MAX_SAFE_INTEGER}}}}},async request=>{
    const {connectionId,...input}=request.body;return runAction(actionStore(),connectionStore(),driveStore(),contextFor(request),"github.get-issue.v1",connectionId,input);
  });
  app.post<{Body:{fileId:string}}>("/v1/apps/google-drive/test",authenticated,async request=>runAction(actionStore(),connectionStore(),driveStore(),contextFor(request),"drive.get-file.v1",contextFor(request).membership.workspaceId,request.body));
  app.get("/v1/connections", authenticated, async (request) => {
    const context = contextFor(request);
    const records = await connectionStore().list(context);
    return { configured: github !== undefined, installationUrl: github?.installationUrl() ?? null, connections: records,
      setup: github === undefined && githubSetup ? { available: githubSetup.eligible(context), organization: githubSetup.options.organization } : null };
  });
  async function requireSetupOperator(context: AuthenticatedContext): Promise<void> {
    if (!githubSetup || !database) throw new GithubError("CONFIGURATION_UNAVAILABLE", 503);
    if (!githubSetup.eligible(context)) throw new HostedAccessError("FORBIDDEN", 403);
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      requireWorkspaceOwner(await authorizeWorkspace(client, context));
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
    if (github !== undefined) throw new GithubError("GITHUB_ALREADY_CONFIGURED", 409);
  }
  app.post("/v1/provider-setup/github/start", { ...authenticated,
    schema: { body: { type: "object", additionalProperties: false, properties: {} } },
  }, async (request) => {
    const context = contextFor(request);
    await requireSetupOperator(context);
    if (!githubSetup) throw new Error("Missing GitHub setup");
    return githubSetup.start(context, sessionFor(request));
  });
  app.post("/v1/provider-setup/github/callback", { ...authenticated,
    schema: { body: { type: "object", additionalProperties: false, required: ["code", "state"], properties: {
      code: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[A-Za-z0-9_-]+$" },
      state: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    } } },
  }, async (request) => {
    const context = contextFor(request);
    await requireSetupOperator(context);
    if (!githubSetup || !database) throw new Error("Missing GitHub setup");
    const activated = await githubSetup.complete(context, sessionFor(request), request.body, () => requireSetupOperator(context));
    // Publish all consumers together after validated credentials are durable.
    githubConfig = activated;
    github = new GithubProvider(activated);
    connections = new ConnectionStore(database.pool, github, activated);
    return { configured: true };
  });
  app.get<{ Params: { id: string } }>("/v1/connections/:id", authenticated, async (request) => connectionStore().detail(contextFor(request), request.params.id));
  app.post("/v1/connections/github/start", authenticated, async (request) => connectionStore().start(contextFor(request), sessionFor(request), request.id, request.body));
  app.post("/v1/connections/github/callback", authenticated, async (request) => connectionStore().callback(contextFor(request), sessionFor(request), request.id, request.body));
  app.get<{ Params: { setupId: string } }>("/v1/connections/github/pending/:setupId", authenticated, async (request) => connectionStore().pending(contextFor(request), sessionFor(request), request.params.setupId));
  app.post("/v1/connections/github/confirm", authenticated, async (request) => connectionStore().confirm(contextFor(request), sessionFor(request), request.id, request.body));
  app.delete<{ Params: { setupId: string } }>("/v1/connections/github/pending/:setupId", authenticated, async (request, reply) => {
    await connectionStore().cancel(contextFor(request), sessionFor(request), request.id, request.params.setupId);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>("/v1/connections/:id", authenticated, async (request, reply) => {
    await connectionStore().disconnect(contextFor(request), request.id, request.params.id);
    return reply.code(204).send();
  });

  // Encapsulation preserves the normal JSON parser for all authenticated APIs.
  void app.register((webhooks, _options, done) => {
    webhooks.removeContentTypeParser("application/json");
    webhooks.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_request, body, done) => { done(null, body); });
    webhooks.post<{ Body: Buffer }>("/v1/webhooks/github", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      if (githubConfig === undefined || connections === undefined) return reply.code(503).send(stableError("GITHUB_NOT_CONFIGURED", request.id));
      if (!Buffer.isBuffer(request.body) || !verifyGithubWebhook(githubConfig.webhookSecret, request.body, request.headers["x-hub-signature-256"])) {
        return reply.code(401).send(stableError("WEBHOOK_INVALID", request.id));
      }
      const deliveryId = request.headers["x-github-delivery"];
      const event = request.headers["x-github-event"];
      if (typeof deliveryId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/u.test(deliveryId) || typeof event !== "string" || !/^[a-z_]{1,64}$/u.test(event)) {
        return reply.code(400).send(stableError("INVALID_REQUEST", request.id));
      }
      let payload: unknown;
      try { payload = JSON.parse(request.body.toString("utf8")) as unknown; }
      catch { return reply.code(400).send(stableError("INVALID_REQUEST", request.id)); }
      await connections.webhook(event, deliveryId, payload);
      return reply.code(202).send({ status: "accepted" });
    });
    done();
  });
  return app;
}

export async function startHostedServer(): Promise<void> {
  const config = loadHostedConfig();
  const webhookPort = process.env.CAPYKIT_WEBHOOK_PORT === undefined ? undefined : Number(process.env.CAPYKIT_WEBHOOK_PORT);
  if (webhookPort !== undefined && (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535 || webhookPort === config.port)) {
    throw new Error("Invalid webhook listener port");
  }
  const app = createHostedServer({ config });
  const ingress = webhookPort === undefined ? undefined : createWebhookIngress(app);
  try {
    await app.listen({ host: "0.0.0.0", port: config.port });
    if (ingress && webhookPort !== undefined) await ingress.listen({ host: "0.0.0.0", port: webhookPort });
  } catch (error) {
    await ingress?.close();
    await app.close();
    throw error;
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
    void (async () => { await ingress?.close(); await app.close(); })().catch(() => { process.exitCode = 1; });
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) void startHostedServer();
