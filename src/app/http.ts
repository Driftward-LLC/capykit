import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { authenticatedContext, AuthError, type AuthenticatedContext, type IdentityStore } from "./identity.js";
import { loadHostedConfig, redactOperationalValue, type HostedConfig } from "./config.js";

export interface HostedApiOptions { readonly config?: HostedConfig | undefined; readonly identityStore: IdentityStore; }
interface ErrorBody { readonly error: { readonly code: string; readonly requestId: string }; }
function errorBody(code: string, requestId: string): ErrorBody { return { error: { code, requestId } }; }
function statusFor(error: AuthError): number { if (error.code === "unauthenticated") return 401; if (error.code === "not_found") return 404; return 403; }
function resolveContext(request: FastifyRequest, store: IdentityStore): Promise<AuthenticatedContext> { return authenticatedContext(store, request.cookies.capykit_session, request.id); }
function assertCsrf(request: FastifyRequest): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())) return;
  const csrfCookie = request.cookies.capykit_csrf;
  const csrfHeader = request.headers["x-csrf-token"];
  if (csrfCookie === undefined || csrfHeader !== csrfCookie) throw new AuthError("forbidden");
}
function exactOriginAllowed(request: FastifyRequest, config: HostedConfig): boolean { const origin = request.headers.origin; return origin === undefined || config.allowedCallbackOrigins.includes(origin); }

export async function createHostedApi(options: HostedApiOptions): Promise<FastifyInstance> {
  const config = options.config ?? loadHostedConfig();
  const app = Fastify({ genReqId: () => randomUUID(), logger: { redact: ["req.headers.authorization", "req.headers.cookie", "req.body", "res.headers['set-cookie']"] } });
  await app.register(cookie, { secret: config.cookieSecret });
  app.addHook("preHandler", (request, _reply, done) => { if (!exactOriginAllowed(request, config)) throw new AuthError("forbidden"); assertCsrf(request); done(); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) { void reply.status(statusFor(error)).send(errorBody(error.code, request.id)); return; }
    request.log.error({ err: error }, "request failed");
    void reply.status(500).send(errorBody("internal_error", request.id));
  });
  app.get("/health/live", () => ({ status: "ok" }));
  app.get("/health/ready", () => ({ status: config.databaseUrl === undefined ? "degraded" : "ok", database: redactOperationalValue(config.databaseUrl), supabase: redactOperationalValue(config.supabaseUrl) }));
  app.post("/v1/auth/otp", async (request, reply) => {
    const body = request.body as { readonly email?: unknown; readonly redirectTo?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email : "";
    const redirectTo = typeof body?.redirectTo === "string" ? body.redirectTo : config.publicOrigin;
    if (!config.allowedCallbackOrigins.some((origin) => redirectTo.startsWith(origin))) throw new AuthError("forbidden");
    if (config.supabaseUrl !== undefined && config.supabaseServiceRoleKey !== undefined && email.includes("@")) {
      const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false } });
      const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
      if (error !== null) request.log.info({ code: error.name }, "otp request rejected");
    }
    return reply.status(202).send({ status: "if_invited_email_was_sent" });
  });
  app.post("/v1/auth/logout", (_request, reply) => { reply.clearCookie("capykit_session", { path: "/" }); reply.clearCookie("capykit_csrf", { path: "/" }); return { status: "ok" }; });
  app.get("/v1/me", async (request) => {
    const context = await resolveContext(request, options.identityStore);
    return { requestId: context.requestId, workspace: { id: context.workspaceId }, principal: { id: context.principal.principalId, kind: context.principal.kind, displayName: context.principal.displayName }, membership: { role: context.membership.role } };
  });
  app.get("/", async (_request, reply: FastifyReply) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const html = await readFile(join(here, "..", "console", "index.html"), "utf8").catch(() => "<div id=\"root\">Capykit hosted console</div>");
    return reply.type("text/html").send(html);
  });
  return app;
}
