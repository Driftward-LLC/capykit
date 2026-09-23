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
import { createAuthGateway, type AuthGateway } from "./auth.js";
import { ArtifactError } from "./artifacts.js";
import { CapabilityError, CapabilityStore } from "./capabilities.js";
import { Readable } from "node:stream";
import { HostedAccessError } from "./workspace-access.js";
import { ConnectionError, ConnectionStore } from "./connections.js";
import { GithubError, GithubProvider, loadGithubConfig, verifyGithubWebhook, type GithubConfig } from "./github.js";
import { createWebhookIngress } from "./webhook-ingress.js";
export { verifyArtifact } from "./artifacts.js";
export { ConnectionStore } from "./connections.js";
export { GithubProvider, loadGithubConfig } from "./github.js";

interface ServerDeps {
  readonly config?: HostedConfig;
  readonly database?: HostedDatabase | undefined;
  readonly auth?: AuthGateway | undefined;
  readonly consoleDirectory?: string;
  readonly githubConfig?: GithubConfig | undefined;
  readonly githubProvider?: GithubProvider | undefined;
}

function bearerToken(request: FastifyRequest, config: HostedConfig): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ") === true) return authorization.slice("Bearer ".length);
  return request.cookies[config.sessionCookieName];
}

function setSessionCookies(reply: FastifyReply, config: HostedConfig, token: string): void {
  const csrf = randomBytes(24).toString("base64url");
  const base = { httpOnly: true, secure: config.secureCookies, sameSite: "strict" as const, path: "/" };
  reply.setCookie(config.sessionCookieName, token, base);
  reply.setCookie(config.csrfCookieName, csrf, { ...base, httpOnly: false });
}

function clearSessionCookies(reply: FastifyReply, config: HostedConfig): void {
  reply.clearCookie(config.sessionCookieName, { path: "/" });
  reply.clearCookie(config.csrfCookieName, { path: "/" });
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
  const githubConfig = deps.githubConfig ?? loadGithubConfig({ ...process.env, CAPYKIT_PUBLIC_BASE_URL: config.publicBaseUrl });
  const github = deps.githubProvider ?? (githubConfig === undefined ? undefined : new GithubProvider(githubConfig));
  const connections = database === undefined ? undefined : new ConnectionStore(database.pool, github, githubConfig);
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 16 * 1024,
    requestTimeout: 120_000, connectionTimeout: 30_000, ajv: { customOptions: { removeAdditional: false } } });
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
    if (error instanceof ArtifactError || error instanceof CapabilityError || error instanceof HostedAccessError || error instanceof ConnectionError || error instanceof GithubError) {
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
    const cookieAuth = request.cookies[config.sessionCookieName] !== undefined && request.headers.authorization?.startsWith("Bearer ") !== true;
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
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    reply.header("referrer-policy", "no-referrer");
    return reply.type("text/html").send(await readFile(join(consoleDirectory, "index.html")));
  }
  app.get("/", serveConsole);
  // Render a same-origin document before the authenticated POST continuation.
  // SameSite=Strict session cookies intentionally do not accompany GitHub's
  // initial cross-site GET. The console immediately removes code/state from its URL.
  app.get("/v1/connections/github/callback", serveConsole);
  app.get("/v1/connections/github/setup", serveConsole);
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
    const redirectTo = request.body.redirectTo ?? config.publicBaseUrl;
    let redirect: URL;
    try { redirect = new URL(redirectTo); } catch { return reply.code(400).send(stableError("INVALID_REQUEST", request.id)); }
    if (!callbackOriginAllowed(config, redirect.origin) || redirect.username !== "" || redirect.password !== "") return reply.code(400).send(stableError("INVALID_REQUEST", request.id));
    if (auth === undefined) return reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id));
    await auth.requestOtp(request.body.email.trim().toLowerCase(), redirectTo);
    return reply.code(202).send({ status: "accepted" });
  });

  async function establishSession(token: string | undefined, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const context = await authenticatedContext(token, database, auth);
    if (token === undefined || context === undefined) return reply.code(401).send(stableError("AUTHENTICATION_INVALID", request.id));
    if (!context.membership.active) return reply.code(401).send(stableError("MEMBERSHIP_INACTIVE", request.id));
    setSessionCookies(reply, config, token);
    return reply.send({ status: "authenticated" });
  }
  app.post<{ Body: { email: string; token: string } }>("/v1/auth/verify", { schema: { body: verifySchema } }, async (request, reply) => {
    if (auth === undefined || database === undefined) return reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id));
    const token = await auth.verifyOtp(request.body.email.trim().toLowerCase(), request.body.token);
    return establishSession(token, request, reply);
  });
  app.post("/v1/auth/session", async (request, reply) => establishSession(bearerToken(request, config), request, reply));

  app.post("/v1/auth/logout", async (request, reply) => {
    if (request.headers.origin !== publicOrigin || !csrfValid(request, config)) return reply.code(403).send(stableError("CSRF_REQUIRED", request.id));
    clearSessionCookies(reply, config);
    const token = bearerToken(request, config);
    if (token !== undefined) await auth?.signOut(token);
    return reply.send({ status: "logged_out" });
  });
  app.get("/v1/me", { schema: { response: { 200: meResponseSchema, 401: errorResponseSchema } } }, async (request, reply) => {
    const context = await authenticatedContext(bearerToken(request, config), database, auth);
    if (context === undefined) return reply.code(401).send(stableError("AUTHENTICATION_REQUIRED", request.id));
    if (!context.membership.active) return reply.code(401).send(stableError("MEMBERSHIP_INACTIVE", request.id));
    return {
      identity: { email: context.identity.email, principalKind: context.membership.principalKind },
      workspace: { id: context.membership.workspaceId, role: context.membership.role },
    };
  });

  async function requireIdentity(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (capabilities === undefined) { reply.code(503).send(stableError("CONFIGURATION_UNAVAILABLE", request.id)); return; }
    const context = await authenticatedContext(bearerToken(request, config), database, auth);
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
    const token = bearerToken(request, config);
    if (token === undefined) throw new Error("Missing authenticated session");
    return token;
  }
  app.get("/v1/connections", authenticated, async (request) => ({
    configured: github !== undefined,
    installationUrl: github?.installationUrl() ?? null,
    connections: await connectionStore().list(contextFor(request)),
  }));
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
