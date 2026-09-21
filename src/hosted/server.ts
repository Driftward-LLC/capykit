import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { callbackOriginAllowed, loadHostedConfig, missingHostedConfig, type HostedConfig } from "./config.js";
import { checkDatabaseReadiness, createHostedDatabase, type HostedDatabase } from "./db.js";
import { stableError, type AuthenticatedContext } from "./identity.js";
import { createSupabaseAuthGateway, type SupabaseAuthGateway } from "./supabase.js";

interface ServerDeps {
  readonly config?: HostedConfig;
  readonly database?: HostedDatabase | undefined;
  readonly auth?: SupabaseAuthGateway | undefined;
}

function requestId(request: FastifyRequest): string {
  const header = request.headers["x-request-id"];
  return typeof header === "string" && header.length > 0 ? header : randomUUID();
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
  return token !== undefined && typeof header === "string" && header === token;
}

async function authenticatedContext(request: FastifyRequest, config: HostedConfig, database: HostedDatabase | undefined, auth: SupabaseAuthGateway | undefined): Promise<AuthenticatedContext | undefined> {
  const token = bearerToken(request, config);
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

export function createHostedServer(deps: ServerDeps = {}): FastifyInstance {
  const config = deps.config ?? loadHostedConfig();
  const database = deps.database ?? createHostedDatabase(config.databaseUrl);
  const auth = deps.auth ?? createSupabaseAuthGateway(config);
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  void app.register(cookie);

  app.get("/health/live", () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    const db = await checkDatabaseReadiness(database);
    return { status: db.status, database: db.reason, missing: missingHostedConfig(config) };
  });
  app.get("/", (_request, reply) => reply.type("text/html").send("<main id=\"root\"><h1>Capykit hosted console</h1><p>Use the invite-only email OTP flow to sign in.</p></main>"));

  app.post("/v1/auth/otp", async (request, reply) => {
    const body = request.body as { readonly email?: unknown; readonly redirectTo?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const redirectTo = typeof body?.redirectTo === "string" ? body.redirectTo : config.publicBaseUrl;
    const origin = new URL(redirectTo).origin;
    if (email.length > 0 && auth !== undefined && callbackOriginAllowed(config, origin)) await auth.requestOtp(email, redirectTo);
    return reply.code(202).send({ status: "accepted" });
  });

  app.post("/v1/auth/session", async (request, reply) => {
    const id = requestId(request);
    const token = bearerToken(request, config);
    if (token === undefined || auth === undefined || database === undefined) return reply.code(401).send(stableError("AUTHENTICATION_REQUIRED", id));
    const identity = await auth.verifyBearer(token);
    const context = identity === undefined ? undefined : await database.resolveContext(identity);
    if (context === undefined) return reply.code(401).send(stableError("AUTHENTICATION_INVALID", id));
    if (!context.membership.active) return reply.code(401).send(stableError("MEMBERSHIP_INACTIVE", id));
    setSessionCookies(reply, config, token);
    return reply.send({ status: "authenticated" });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const id = requestId(request);
    if (!csrfValid(request, config)) return reply.code(403).send(stableError("CSRF_REQUIRED", id));
    clearSessionCookies(reply, config);
    return reply.send({ status: "logged_out" });
  });

  app.get("/v1/me", async (request, reply) => {
    const id = requestId(request);
    const context = await authenticatedContext(request, config, database, auth);
    if (context === undefined) return reply.code(401).send(stableError("AUTHENTICATION_REQUIRED", id));
    if (!context.membership.active) return reply.code(401).send(stableError("MEMBERSHIP_INACTIVE", id));
    return {
      identity: { email: context.identity.email, principalKind: context.membership.principalKind },
      workspace: { id: context.membership.workspaceId, role: context.membership.role },
    };
  });

  return app;
}

export async function startHostedServer(): Promise<void> {
  const config = loadHostedConfig();
  const app = createHostedServer({ config });
  await app.listen({ host: "0.0.0.0", port: config.port });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) void startHostedServer();
