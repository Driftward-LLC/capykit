import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

/** A separate listener for public ingress. It forwards one fixed webhook route,
 * preserves signed bytes, and cannot reach the console, auth, or workspace API. */
export function createWebhookIngress(api: FastifyInstance): FastifyInstance {
  const ingress = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 1024 * 1024,
    requestTimeout: 15_000, connectionTimeout: 15_000 });
  ingress.removeContentTypeParser("application/json");
  ingress.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); });
  ingress.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
  });
  ingress.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
      && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(status).send({ error: "webhook_request_failed" });
  });
  ingress.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not_found" }));
  // Keep concurrent bodies bounded inside the existing 512 MiB app process.
  const pending = new Set<FastifyRequest>();
  const executing = new WeakSet<FastifyRequest>();
  ingress.post<{ Body: Buffer }>("/v1/webhooks/github", {
    onRequest: async (request, reply) => {
      if (request.raw.url !== "/v1/webhooks/github") return reply.code(404).send({ error: "not_found" });
      if (pending.size >= 4) return reply.code(503).header("retry-after", "5").send({ error: "busy" });
      pending.add(request);
      reply.raw.once("close", () => { if (!executing.has(request)) pending.delete(request); });
    },
  }, async (request, reply) => {
    executing.add(request);
    try {
      if (!Buffer.isBuffer(request.body)) return await reply.code(415).send({ error: "json_required" });
      const headers: Record<string, string> = { "content-type": "application/json" };
      for (const name of ["x-hub-signature-256", "x-github-event", "x-github-delivery"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const result = await api.inject({ method: "POST", url: "/v1/webhooks/github", headers, payload: request.body });
      return await reply.code(result.statusCode).type("application/json").send(result.body);
    } finally {
      pending.delete(request);
      executing.delete(request);
    }
  });
  return ingress;
}
