import Fastify from "fastify";
import { request as httpRequest, type ClientRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebhookIngress } from "../src/hosted/webhook-ingress.js";

describe("public GitHub webhook listener", () => {
  const close: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
  function fixture(beforeResponse?: () => Promise<void>) {
    const api = Fastify();
    api.removeContentTypeParser("application/json");
    api.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); });
    const received = vi.fn();
    api.post("/v1/webhooks/github", async (request, reply) => { received(request.body, request.headers); await beforeResponse?.(); return reply.code(202).send({ status: "accepted" }); });
    const ingress = createWebhookIngress(api);
    close.push(() => api.close(), () => ingress.close());
    return { api, ingress, received };
  }
  it("forwards exact bytes and signature headers without identity, cookies, or forwarding headers", async () => {
    const { ingress, received } = fixture();
    const body = Buffer.from('{ "event" : "\u00e9", "spacing": true }\n');
    const result = await ingress.inject({ method: "POST", url: "/v1/webhooks/github", payload: body, headers: {
      "content-type": "application/json", "x-hub-signature-256": "test-signature", "x-github-event": "installation",
      "x-github-delivery": "delivery", cookie: "session=private", authorization: "Bearer private", origin: "https://untrusted.test",
      "x-forwarded-host": "untrusted.test",
    } });
    expect(result.statusCode).toBe(202);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(received).toHaveBeenCalledOnce();
    expect(received.mock.calls[0]?.[0]).toEqual(body);
    const headers = received.mock.calls[0]?.[1] as Record<string, string>;
    expect(headers["x-hub-signature-256"]).toBe("test-signature");
    for (const name of ["cookie", "authorization", "origin", "x-forwarded-host"]) expect(headers[name]).toBeUndefined();
  });
  it("exposes only the exact POST path and bounds body size", async () => {
    const { ingress, received } = fixture();
    for (const path of ["/", "/v1/me", "/v1/auth/otp", "/health/ready", "/v1/webhooks/github?next=/v1/me", "/v1/webhooks/github/", "/v1/webhooks/%67ithub"]) {
      expect((await ingress.inject({ method: "POST", url: path, headers: { "content-type": "application/json" }, payload: "{}" })).statusCode, path).toBe(404);
    }
    expect((await ingress.inject("/v1/webhooks/github")).statusCode).toBe(404);
    expect((await ingress.inject({ method: "POST", url: "/v1/webhooks/github", payload: "text", headers: { "content-type": "text/plain" } })).statusCode).toBe(415);
    expect((await ingress.inject({ method: "POST", url: "/v1/webhooks/github", payload: "x".repeat(1024 * 1024 + 1), headers: { "content-type": "application/json" } })).statusCode).toBe(413);
    expect(received).not.toHaveBeenCalled();
  });
  it("rejects raw dot-segment paths without relying on client URL normalization", async () => {
    const { ingress, received } = fixture();
    await ingress.listen({ host: "127.0.0.1", port: 0 });
    const address = ingress.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected local listener");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/v1/webhooks/github/../github", method: "POST", headers: { "content-type": "application/json" } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
      request.end("{}");
    });
    expect(status).toBe(404);
    expect(received).not.toHaveBeenCalled();
  });

  it("does not leak body reservations when parsing rejects requests before the handler", async () => {
    const { ingress, received } = fixture();
    for (let index = 0; index < 8; index++) {
      const rejected = await ingress.inject({ method: "POST", url: "/v1/webhooks/github", headers: { "content-type": "application/octet-stream" }, payload: "unsupported" });
      expect(rejected.statusCode).toBe(415);
    }
    expect(received).not.toHaveBeenCalled();
    const accepted = await ingress.inject({ method: "POST", url: "/v1/webhooks/github", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(accepted.statusCode).toBe(202);
    expect(received).toHaveBeenCalledOnce();
  });

  it("rejects a fifth active delivery and releases capacity after the four forwarded requests settle", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { ingress, received } = fixture(() => blocked);
    const deliver = () => ingress.inject({ method: "POST", url: "/v1/webhooks/github", headers: { "content-type": "application/json" }, payload: "{}" });
    const active = Array.from({ length: 4 }, () => Promise.resolve(deliver()));
    try {
      await expect.poll(() => received.mock.calls.length).toBe(4);
      const overflow = await deliver();
      expect(overflow.statusCode).toBe(503);
      expect(overflow.headers["retry-after"]).toBe("5");
      expect(overflow.json<{ error: string }>()).toEqual({ error: "busy" });
      expect(received).toHaveBeenCalledTimes(4);
      release();
      expect((await Promise.all(active)).map((response) => response.statusCode)).toEqual([202, 202, 202, 202]);
      expect((await deliver()).statusCode).toBe(202);
      expect(received).toHaveBeenCalledTimes(5);
    } finally { release(); await Promise.allSettled(active); }
  });

  it("releases reservations when clients abort incomplete bodies before forwarding", async () => {
    const { ingress, received } = fixture();
    let parsing = 0;
    ingress.addHook("preParsing", (request, _reply, payload, done) => { if (request.headers["x-partial-test"] === "yes") parsing++; done(null, payload); });
    await ingress.listen({ host: "127.0.0.1", port: 0 });
    const address = ingress.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected local listener");
    const partial: ClientRequest[] = [];
    const deliver = () => ingress.inject({ method: "POST", url: "/v1/webhooks/github", headers: { "content-type": "application/json" }, payload: "{}" });
    try {
      for (let index = 0; index < 4; index++) {
        const request = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/v1/webhooks/github", method: "POST", headers: { "content-type": "application/json", "content-length": "1024", "x-partial-test": "yes" } });
        request.on("error", () => {});
        request.on("response", (response) => response.resume());
        request.write('{"incomplete":');
        partial.push(request);
      }
      await expect.poll(() => parsing).toBe(4);
      expect(received).not.toHaveBeenCalled();
      expect((await deliver()).statusCode).toBe(503);
      partial[0]?.destroy();
      await expect.poll(async () => (await deliver()).statusCode).toBe(202);
      expect(received.mock.calls.length).toBeGreaterThan(0);
      for (const request of partial) request.destroy();
      await expect.poll(async () => (await deliver()).statusCode).toBe(202);
    } finally { for (const request of partial) request.destroy(); }
  });

  it("keeps disconnected clients counted while their forwarded delivery is still executing", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { ingress, received } = fixture(() => blocked);
    await ingress.listen({ host: "127.0.0.1", port: 0 });
    const address = ingress.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected local listener");
    const active: ClientRequest[] = [];
    try {
      for (let index = 0; index < 4; index++) {
        const request = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/v1/webhooks/github", method: "POST", headers: { "content-type": "application/json" } });
        request.on("error", () => {});
        request.on("response", (response) => response.resume());
        request.end("{}");
        active.push(request);
      }
      await expect.poll(() => received.mock.calls.length).toBe(4);
      for (const request of active) request.destroy();
      const overflow = await ingress.inject({ method: "POST", url: "/v1/webhooks/github", headers: { "content-type": "application/json" }, payload: "{}" });
      expect(overflow.statusCode).toBe(503);
      expect(received).toHaveBeenCalledTimes(4);
      release();
      await expect.poll(async () => (await ingress.inject({ method: "POST", url: "/v1/webhooks/github", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(202);
    } finally { release(); for (const request of active) request.destroy(); }
  });

});
