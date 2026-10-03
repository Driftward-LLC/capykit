import type { GoogleSignIn } from "../src/hosted/google-sign-in.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHostedConfig, type HostedConfig } from "../src/hosted/config.js";
import type { DatabaseReadiness } from "../src/hosted/db.js";
import type { AuthenticatedContext, VerifiedIdentity } from "../src/hosted/identity.js";
import { createHostedServer } from "../src/hosted/server.js";
import { AuthUnavailableError, type AuthSession } from "../src/hosted/auth.js";
import { ConnectionStore } from "../src/hosted/connections.js";

const origin = "https://capykit.example.test";
const config: HostedConfig = loadHostedConfig({
  CAPYKIT_PUBLIC_BASE_URL: origin, DATABASE_URL: "postgres://unused",
  CAPYKIT_AUTH_URL: "http://auth:9999",
});
const identity = { provider: "gotrue" as const, subject: "owner-1", email: "owner@example.test", sessionId: "12345678-1234-4321-8123-123456789012" };
const session: AuthSession = { accessToken: "verified-token", refreshToken: "refresh-token" };
const renewedSession: AuthSession = { accessToken: "renewed-token", refreshToken: "rotated-refresh-token" };
const rememberedAge = 30 * 24 * 60 * 60;
const renewalHeaders = { cookie: "capykit_session=expired-token; capykit_refresh=refresh-token; capykit_csrf=csrf-proof", origin, "x-csrf-token": "csrf-proof" };
const context: AuthenticatedContext = {
  identity, membership: { workspaceId: "workspace-a", principalId: "owner-1", principalKind: "human", role: "owner", active: true },
};
const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
function fixture(overrides: { config?: HostedConfig; consoleDirectory?: string; googleSignIn?: GoogleSignIn } = {}) {
  const pool = new Pool();
  const database = {
    pool, close: () => pool.end(),
    readiness: vi.fn((): Promise<DatabaseReadiness> => Promise.resolve({ status: "ready", reason: "ok" })),
    resolveContext: vi.fn((verified: VerifiedIdentity): Promise<AuthenticatedContext | undefined> => Promise.resolve({ ...context, identity: verified })),
  };
  const auth = {
    requestOtp: vi.fn(async () => {}),
    signInTrusted: vi.fn((): Promise<AuthSession | undefined> => Promise.resolve(session)),
    signOut: vi.fn(async () => {}),
    verifyOtp: vi.fn((): Promise<AuthSession | undefined> => Promise.resolve(session)),
    refresh: vi.fn<(token: string) => Promise<AuthSession | undefined>>().mockResolvedValue(renewedSession),
    verifyBearer: vi.fn((token: string): Promise<VerifiedIdentity | undefined> => Promise.resolve([session.accessToken, renewedSession.accessToken].includes(token) ? identity : undefined)),
  };
  const app = createHostedServer({ config, database, auth, ...overrides });
  apps.push(app);
  return { app, auth, database };
}

describe("hosted HTTP boundaries", () => {

  const tailscaleConfig = { ...config, tailscaleSignIn: { login: "owner@example.test", email: identity.email, subject: identity.subject, proxyAddress: "127.0.0.1", serviceKey: "private-service-key" } };
  const trustedHeaders = { origin, "tailscale-user-login": "owner@example.test" };
  it("exchanges only the trusted proxy identity for an invited human's native session", async () => {
    const { app, auth, database } = fixture({ config: tailscaleConfig });
    expect((await app.inject({ url: "/v1/auth/method" })).json()).toEqual({ method: "tailscale" });
    const signedIn = await app.inject({ method: "POST", url: "/v1/auth/tailscale", headers: trustedHeaders, payload: {} });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(signedIn.cookies).toHaveLength(3);
    expect(signedIn.cookies.find(({ name }) => name === "capykit_refresh")).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", maxAge: rememberedAge });
    expect(signedIn.body).not.toMatch(/verified-token|refresh-token|private-service-key/u);
    expect(auth.requestOtp).not.toHaveBeenCalled();
    expect(auth.signInTrusted).toHaveBeenCalledExactlyOnceWith(identity.email, identity.subject);
    expect(database.resolveContext).toHaveBeenCalledTimes(2);
  });
  it("rejects missing, substituted and forged proxy identities before using the service credential", async () => {
    const { app, auth } = fixture({ config: tailscaleConfig });
    for (const headers of [{ origin }, { ...trustedHeaders, "tailscale-user-login": "someone-else" }, { ...trustedHeaders, "tailscale-user-login": "owner@example.test,owner@example.test" }]) {
      const denied = await app.inject({ method: "POST", url: "/v1/auth/tailscale", headers, payload: {} });
      expect(denied.statusCode).toBe(401); expect(denied.cookies).toHaveLength(0);
    }
    const direct = await app.inject({ method: "POST", url: "/v1/auth/tailscale", headers: trustedHeaders, remoteAddress: "172.25.0.9", payload: {} });
    expect(direct.statusCode).toBe(401); expect(direct.cookies).toHaveLength(0);
    expect(auth.signInTrusted).not.toHaveBeenCalled();
  });
  it("requires same-origin and CSRF for cookie-bearing Tailscale sign-in; accepts no chosen account", async () => {
    const { app, auth } = fixture({ config: tailscaleConfig });
    for (const headers of [{ "tailscale-user-login": "owner@example.test" }, { ...trustedHeaders, origin: "https://evil.test" }, { ...trustedHeaders, authorization: "Bearer verified-token" }, { ...trustedHeaders, cookie: renewalHeaders.cookie }, { ...trustedHeaders, cookie: renewalHeaders.cookie, "x-csrf-token": "wrong" }]) {
      const denied = await app.inject({ method: "POST", url: "/v1/auth/tailscale", headers, payload: {} });
      expect(denied.statusCode).toBe(403); expect(denied.cookies).toHaveLength(0);
    }
    expect((await app.inject({ method: "POST", url: "/v1/auth/tailscale", headers: trustedHeaders, payload: { email: "someone-else@example.test" } })).statusCode).toBe(400);
    expect(auth.signInTrusted).not.toHaveBeenCalled();
  });
  it("denies uninvited, inactive and agent principals, mismatched subjects and post-exchange access removal", async () => {
    const { app, auth, database } = fixture({ config: tailscaleConfig });
    for (const membership of [undefined, { ...context, membership: { ...context.membership, active: false } }, { ...context, membership: { ...context.membership, principalKind: "agent" as const } }]) {
      database.resolveContext.mockResolvedValueOnce(membership);
      const denied = await app.inject({ method: "POST", url: "/v1/auth/tailscale", headers: trustedHeaders, payload: {} });
      expect(denied.statusCode).toBe(401); expect(denied.cookies).toHaveLength(0);
    }
    expect(auth.signInTrusted).not.toHaveBeenCalled();
    auth.verifyBearer.mockResolvedValueOnce({ ...identity, subject: "other-user" });
    const mismatch = await app.inject({ method: "POST", url: "/v1/auth/tailscale", headers: trustedHeaders, payload: {} });
    expect(mismatch.statusCode).toBe(401); expect(mismatch.cookies).toHaveLength(0);
    database.resolveContext.mockResolvedValueOnce(context).mockResolvedValueOnce(undefined);
    const removed = await app.inject({ method: "POST", url: "/v1/auth/tailscale", headers: trustedHeaders, payload: {} });
    expect(removed.statusCode).toBe(401); expect(removed.cookies).toHaveLength(0);
  });
  it("fails closed for incomplete or unsafe Tailscale configuration", () => {
    const env = { CAPYKIT_PUBLIC_BASE_URL: "https://preview.example.ts.net", CAPYKIT_AUTH_URL: "http://auth:9999", CAPYKIT_TAILSCALE_LOGIN: "owner@github", CAPYKIT_TAILSCALE_EMAIL: identity.email, CAPYKIT_TAILSCALE_SUBJECT: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CAPYKIT_TAILSCALE_PROXY_ADDRESS: "172.25.0.1", CAPYKIT_TAILSCALE_SERVICE_KEY: "private-service-key" };
    expect(loadHostedConfig(env).tailscaleSignIn).toMatchObject({ login: "owner@github", proxyAddress: "172.25.0.1" });
    for (const key of Object.keys(env).filter(key => key.startsWith("CAPYKIT_TAILSCALE_"))) {
      expect(() => loadHostedConfig({ ...env, [key]: "" })).toThrow(/Tailscale sign-in/u);
    }
    for (const changes of [{ CAPYKIT_PUBLIC_BASE_URL: origin }, { CAPYKIT_TAILSCALE_PROXY_ADDRESS: "0.0.0.0" }, { CAPYKIT_TAILSCALE_PROXY_ADDRESS: "172.25.0.0/16" }, { CAPYKIT_TAILSCALE_SUBJECT: "invalid" }, { CAPYKIT_TAILSCALE_SERVICE_KEY: "private\nheader" }]) {
      expect(() => loadHostedConfig({ ...env, ...changes })).toThrow(/Tailscale sign-in/u);
    }
  });
  it("keeps Tailscale sign-in disabled by default and bounds provider errors without exposing details", async () => {
    const standard = fixture();
    expect((await standard.app.inject({ url: "/v1/auth/method" })).json()).toEqual({ method: "email" });
    expect((await standard.app.inject({ method: "POST", url: "/v1/auth/tailscale", headers: trustedHeaders, payload: {} })).statusCode).toBe(503);
    expect(standard.auth.signInTrusted).not.toHaveBeenCalled();
    const { app, auth } = fixture({ config: tailscaleConfig });
    auth.signInTrusted.mockRejectedValueOnce(new AuthUnavailableError());
    const unavailable = await app.inject({ method: "POST", url: "/v1/auth/tailscale", headers: trustedHeaders, payload: {} });
    expect(unavailable.statusCode).toBe(503); expect(unavailable.cookies).toHaveLength(0);
    expect(unavailable.json()).toMatchObject({ error: { code: "AUTHENTICATION_UNAVAILABLE" } });
  });

  it("verifies an email code before issuing private session cookies and resolving current identity", async () => {
    const { app, auth, database } = fixture();
    const request = await app.inject({ method: "POST", url: "/v1/auth/otp", headers: { origin }, payload: { email: "Owner@example.test" } });
    expect(request.statusCode).toBe(202);
    expect(auth.requestOtp).toHaveBeenCalledWith("owner@example.test", origin);
    const verified = await app.inject({ method: "POST", url: "/v1/auth/verify", headers: { origin }, payload: { email: identity.email, token: "123456" } });
    expect(verified.statusCode).toBe(200);
    expect(verified.body).not.toMatch(/verified-token|refresh-token/u);
    expect(auth.verifyBearer).toHaveBeenCalledWith("verified-token");
    expect(verified.cookies).toHaveLength(3);
    expect(verified.cookies.find(({ name }) => name === "capykit_session")).toMatchObject({ value: session.accessToken, httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: rememberedAge });
    expect(verified.cookies.find(({ name }) => name === "capykit_refresh")).toMatchObject({ value: session.refreshToken, httpOnly: true, secure: true, sameSite: "Strict", path: "/v1/auth", maxAge: rememberedAge });
    const csrfCookie = verified.cookies.find(({ name }) => name === "capykit_csrf");
    expect(csrfCookie).toMatchObject({ secure: true, sameSite: "Strict", path: "/", maxAge: rememberedAge });
    expect(csrfCookie?.httpOnly).not.toBe(true);
    expect(csrfCookie?.value).toBeTruthy();
    const cookie = verified.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const me = await app.inject({ url: "/v1/me", headers: { cookie, "x-workspace-id": "workspace-b", "x-request-id": "untrusted-supplied-id" } });
    expect(me.statusCode).toBe(200);
    expect(me.json<unknown>()).toEqual({ identity: { email: identity.email, principalKind: "human" }, workspace: { id: "workspace-a", role: "owner" } });
    expect(me.headers["x-request-id"]).not.toBe("untrusted-supplied-id");
    expect(database.resolveContext).toHaveBeenCalledTimes(2);
    database.resolveContext.mockResolvedValueOnce(undefined);
    expect((await app.inject({ url: "/v1/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("rejects expired codes, forged tokens, unknown identities, and inactive membership without cookies", async () => {
    const { app, auth, database } = fixture();
    auth.verifyOtp.mockResolvedValueOnce(undefined);
    const invalid = await app.inject({ method: "POST", url: "/v1/auth/verify", headers: { origin }, payload: { email: identity.email, token: "654321" } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.cookies).toHaveLength(0);
    expect((await app.inject({ url: "/v1/me", headers: { authorization: "Bearer forged" } })).statusCode).toBe(401);
    database.resolveContext.mockResolvedValueOnce(undefined);
    expect((await app.inject({ method: "POST", url: "/v1/auth/session", headers: { origin, authorization: "Bearer verified-token" } })).statusCode).toBe(401);
    database.resolveContext.mockResolvedValueOnce({ ...context, membership: { ...context.membership, active: false } });
    const inactive = await app.inject({ method: "POST", url: "/v1/auth/session", headers: { origin, authorization: "Bearer verified-token" } });
    expect(inactive.statusCode).toBe(401);
    expect(inactive.cookies).toHaveLength(0);
  });

  it("requires the exact origin before issuing an initial OTP or imported bearer session", async () => {
    const { app, auth } = fixture();
    for (const suppliedOrigin of [undefined, "null", "https://other.example.test"]) {
      const headers = suppliedOrigin === undefined ? {} : { origin: suppliedOrigin };
      const verified = await app.inject({ method: "POST", url: "/v1/auth/verify", headers, payload: { email: identity.email, token: "123456" } });
      expect(verified.statusCode).toBe(403);
      expect(verified.cookies).toHaveLength(0);
      const imported = await app.inject({ method: "POST", url: "/v1/auth/session", headers: { ...headers, authorization: "Bearer verified-token" } });
      expect(imported.statusCode).toBe(403);
      expect(imported.cookies).toHaveLength(0);
    }
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.verifyBearer).not.toHaveBeenCalled();
  });

  it("imports only a bearer access token without creating a persistent refresh session", async () => {
    const { app, auth } = fixture();
    const imported = await app.inject({ method: "POST", url: "/v1/auth/session", headers: { origin, authorization: "Bearer verified-token" } });
    expect(imported.statusCode).toBe(200);
    expect(imported.cookies.find(({ name }) => name === "capykit_session")).toMatchObject({ value: session.accessToken, httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    expect(imported.cookies.find(({ name }) => name === "capykit_session")?.maxAge).toBe(3600);
    expect(imported.cookies.some(({ name, value }) => name === "capykit_refresh" && value !== "")).toBe(false);
    expect(imported.body).not.toContain(session.accessToken);
    expect(auth.refresh).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: "/v1/auth/session", headers: { origin, cookie: "capykit_session=verified-token; capykit_csrf=csrf-proof", "x-csrf-token": "csrf-proof" } })).statusCode).toBe(401);
  });

  it("renews expired or missing access cookies using the private refresh cookie and preserves CSRF", async () => {
    const { app, auth, database } = fixture();
    for (const cookie of [renewalHeaders.cookie, "capykit_refresh=refresh-token; capykit_csrf=csrf-proof"]) {
      const renewed = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { ...renewalHeaders, cookie }, payload: {} });
      expect(renewed.statusCode, renewed.body).toBe(200);
      expect(renewed.cookies).toHaveLength(3);
      expect(renewed.cookies.find(({ name }) => name === "capykit_session")).toMatchObject({ value: renewedSession.accessToken, httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: rememberedAge });
      expect(renewed.cookies.find(({ name }) => name === "capykit_refresh")).toMatchObject({ value: renewedSession.refreshToken, httpOnly: true, secure: true, sameSite: "Strict", path: "/v1/auth", maxAge: rememberedAge });
      expect(renewed.cookies.find(({ name }) => name === "capykit_csrf")).toMatchObject({ value: "csrf-proof", secure: true, sameSite: "Strict", path: "/", maxAge: rememberedAge });
      expect(renewed.body).not.toMatch(/renewed-token|refresh-token/u);
      expect(renewed.headers["cache-control"]).toBe("no-store");
      const me = await app.inject({ url: "/v1/me", headers: { cookie: "capykit_session=renewed-token" } });
      expect(me.statusCode).toBe(200);
    }
    expect(auth.refresh).toHaveBeenCalledTimes(2);
    expect(auth.refresh).toHaveBeenCalledWith(session.refreshToken);
    expect(auth.verifyBearer).toHaveBeenCalledWith(renewedSession.accessToken);
    expect(database.resolveContext).toHaveBeenCalledWith(identity);
  });

  it("protects refresh-only sessions with Origin and CSRF and rejects bearer or body credentials", async () => {
    const { app, auth } = fixture();
    const cookie = "capykit_refresh=refresh-token; capykit_csrf=csrf-proof";
    for (const headers of [{ cookie }, { cookie, origin }, { cookie, origin, "x-csrf-token": "wrong" },
      { cookie, origin: "null", "x-csrf-token": "csrf-proof" }, { cookie, origin: "https://other.example.test", "x-csrf-token": "csrf-proof" }]) {
      for (const url of ["/v1/auth/refresh", "/v1/auth/logout"]) {
        const denied = await app.inject({ method: "POST", url, headers, payload: {} });
        expect(denied.statusCode).toBe(403);
        expect(denied.cookies).toHaveLength(0);
      }
    }
    for (const authorization of ["Bearer verified-token", "Basic anything"]) {
      const denied = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { ...renewalHeaders, authorization }, payload: {} });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      expect(denied.statusCode).toBeLessThan(500);
      expect(denied.cookies).toHaveLength(0);
    }
    const supplied = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: renewalHeaders, payload: { refreshToken: "SENTINEL_BODY_TOKEN" } });
    expect(supplied.statusCode).toBe(400);
    expect(supplied.cookies).toHaveLength(0);
    expect(supplied.body).not.toContain("SENTINEL");
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("clears terminally invalid refresh sessions and rejects revoked membership before issuing credentials", async () => {
    for (const failure of ["missing-refresh", "refresh", "identity", "missing-member", "inactive-member"] as const) {
      const { app, auth, database } = fixture();
      if (failure === "refresh") auth.refresh.mockResolvedValueOnce(undefined);
      if (failure === "identity") auth.verifyBearer.mockResolvedValueOnce(undefined);
      if (failure === "missing-member") database.resolveContext.mockResolvedValueOnce(undefined);
      if (failure === "inactive-member") database.resolveContext.mockResolvedValueOnce({ ...context, membership: { ...context.membership, active: false } });
      const headers = failure === "missing-refresh" ? { ...renewalHeaders, cookie: "capykit_csrf=csrf-proof" } : renewalHeaders;
      const denied = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers, payload: {} });
      expect(denied.statusCode, `${failure}: ${denied.body}`).toBe(401);
      expect(denied.cookies).toHaveLength(3);
      expect(denied.cookies.every(({ value }) => value === "")).toBe(true);
      expect(denied.cookies.find(({ name }) => name === "capykit_refresh")?.path).toBe("/v1/auth");
      expect(denied.body).not.toMatch(/verified-token|renewed-token|refresh-token/u);
      if (failure === "missing-refresh") expect(auth.refresh).not.toHaveBeenCalled();
    }
  });

  it("preserves browser credentials on transient refresh, identity and membership failures", async () => {
    for (const failure of ["refresh", "identity", "database"] as const) {
      const { app, auth, database } = fixture();
      if (failure === "refresh") auth.refresh.mockRejectedValueOnce(new AuthUnavailableError());
      if (failure === "identity") auth.verifyBearer.mockRejectedValueOnce(new AuthUnavailableError());
      if (failure === "database") database.resolveContext.mockRejectedValueOnce(new Error("SENTINEL_DATABASE_DETAIL"));
      const unavailable = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: renewalHeaders, payload: {} });
      expect(unavailable.statusCode, `${failure}: ${unavailable.body}`).toBe(failure === "database" ? 500 : 503);
      expect(unavailable.cookies).toHaveLength(0);
      expect(unavailable.body).not.toMatch(/SENTINEL|renewed-token|refresh-token/u);
      if (failure !== "database") expect(unavailable.json<{ error: { code: string } }>().error.code).toBe("AUTHENTICATION_UNAVAILABLE");
    }
  });

  it("renews for logout even after access expires, revokes the provider session and clears every cookie", async () => {
    const { app, auth } = fixture();
    const logout = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: renewalHeaders, payload: {} });
    expect(logout.statusCode).toBe(200);
    expect(auth.refresh).toHaveBeenCalledWith(session.refreshToken);
    expect(auth.signOut).toHaveBeenCalledWith(renewedSession.accessToken);
    expect(logout.cookies).toHaveLength(3);
    expect(logout.cookies.every(({ value }) => value === "")).toBe(true);
    expect(logout.cookies.find(({ name }) => name === "capykit_refresh")?.path).toBe("/v1/auth");
    expect(logout.body).not.toMatch(/renewed-token|refresh-token/u);
  });

  it("falls back to the presented access token on invalid refresh and preserves cookies on logout outages", async () => {
    const { app, auth } = fixture();
    auth.refresh.mockResolvedValueOnce(undefined);
    const logout = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { ...renewalHeaders, cookie: "capykit_session=verified-token; capykit_refresh=invalid-refresh; capykit_csrf=csrf-proof" }, payload: {} });
    expect(logout.statusCode).toBe(200);
    expect(auth.signOut).toHaveBeenCalledWith(session.accessToken);
    for (const failure of ["refresh", "signout"] as const) {
      if (failure === "refresh") auth.refresh.mockRejectedValueOnce(new AuthUnavailableError());
      else auth.signOut.mockRejectedValueOnce(new AuthUnavailableError());
      const unavailable = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: renewalHeaders, payload: {} });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.cookies).toHaveLength(0);
    }
  });

  it("rejects a delayed refresh when logout has revoked the provider session", async () => {
    const { app, auth } = fixture();
    let finishRotation: ((value: AuthSession) => void) | undefined;
    const rotation = new Promise<AuthSession>((resolve) => { finishRotation = resolve; });
    let finishRevocation: (() => void) | undefined;
    const revoked = new Promise<void>((resolve) => { finishRevocation = resolve; });
    auth.refresh.mockImplementation(() => rotation);
    auth.signOut.mockImplementation(() => { finishRevocation?.(); return Promise.resolve(); });
    auth.verifyBearer.mockImplementation(async () => { await revoked; return undefined; });
    const refreshing = app.inject({ method: "POST", url: "/v1/auth/refresh", headers: renewalHeaders, payload: {} }).then((response) => response);
    const loggingOut = app.inject({ method: "POST", url: "/v1/auth/logout", headers: renewalHeaders, payload: {} }).then((response) => response);
    await vi.waitFor(() => { expect(auth.refresh).toHaveBeenCalledTimes(2); });
    finishRotation?.(renewedSession);
    const [refreshResponse, logoutResponse] = await Promise.all([refreshing, loggingOut]);
    expect(logoutResponse.statusCode).toBe(200);
    expect(auth.signOut).toHaveBeenCalledWith(renewedSession.accessToken);
    expect(refreshResponse.statusCode).toBe(401);
    expect(refreshResponse.cookies.every(({ value }) => value === "")).toBe(true);
    expect(logoutResponse.cookies.every(({ value }) => value === "")).toBe(true);
  });

  it("keeps GitHub setup bound to the verified provider session across access-token rotation", async () => {
    const { app, auth } = fixture();
    const starting = vi.spyOn(ConnectionStore.prototype, "start").mockResolvedValue({ connectionId: "connection", setupId: "setup", authorizationUrl: "https://github.com/login/oauth/authorize", installationUrl: "https://github.com/apps/capykit/installations/new" });
    try {
      for (const accessToken of [session.accessToken, renewedSession.accessToken]) {
        if (accessToken === renewedSession.accessToken) expect((await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: renewalHeaders, payload: {} })).statusCode).toBe(200);
        const started = await app.inject({ method: "POST", url: "/v1/connections/github/start", headers: { origin, cookie: `capykit_session=${accessToken}; capykit_csrf=csrf-proof`, "x-csrf-token": "csrf-proof" }, payload: {} });
        expect(started.statusCode).toBe(200);
      }
      expect(starting.mock.calls[0]?.[1]).toBe(`gotrue:${identity.subject}:${identity.sessionId}`);
      expect(starting.mock.calls[1]?.[1]).toBe(starting.mock.calls[0]?.[1]);
      auth.verifyBearer.mockResolvedValueOnce({ ...identity, sessionId: "87654321-4321-4321-8123-123456789012" });
      const differentSession = await app.inject({ method: "POST", url: "/v1/connections/github/start", headers: { origin, authorization: "Bearer another-login" }, payload: {} });
      expect(differentSession.statusCode).toBe(200);
      expect(starting.mock.calls[2]?.[1]).not.toBe(starting.mock.calls[0]?.[1]);
    } finally { starting.mockRestore(); }
  });

  it("validates OTP inputs and callback origins without leaking submitted data", async () => {
    const { app, auth } = fixture();
    for (const redirectTo of ["not a URL", "https://capykit.example.test.evil.test", "https://user:password@capykit.example.test"]) {
      const reply = await app.inject({ method: "POST", url: "/v1/auth/otp", payload: { email: identity.email, redirectTo } });
      expect(reply.statusCode).toBe(400);
      expect(reply.body).not.toContain(redirectTo);
    }
    expect(auth.requestOtp).not.toHaveBeenCalled();
    const malformed = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email: identity.email, token: "SENTINEL_BAD_CODE" } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain("SENTINEL");
  });

  it("lets authenticated members browse upstream metadata without owner connection authority", async () => {
    const {app,database}=fixture();
    expect((await app.inject({url:"/v1/apps/catalog"})).statusCode).toBe(401);
    database.resolveContext.mockResolvedValue({...context,membership:{...context.membership,role:"member"}});
    const response=await app.inject({url:"/v1/apps/catalog",headers:{authorization:`Bearer ${session.accessToken}`}});
    expect(response.statusCode).toBe(200);
    const catalog=response.json<{apps:{id:string;configured:boolean;connected:boolean}[];catalog:{count:number}}>();
    expect(catalog.apps.length).toBe(catalog.catalog.count);expect(catalog.apps.length).toBeGreaterThan(700);
    expect(catalog.apps.every(app=>!app.connected&&!app.configured)).toBe(true);
    expect(response.body).not.toContain(session.accessToken);
  });

  it("reports unavailable configuration/database with a failing HTTP readiness status", async () => {
    const { app, database } = fixture();
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
    database.readiness.mockResolvedValueOnce({ status: "unavailable", reason: "connection_failed" });
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(503);
    database.readiness.mockRejectedValueOnce(new Error("SENTINEL_DATABASE_DETAIL"));
    const failure = await app.inject({ url: "/health/ready" });
    expect(failure.statusCode).toBe(500);
    expect(failure.body).not.toContain("SENTINEL");
    const incomplete = fixture({ config: { ...config, authUrl: undefined } });
    const unready = await incomplete.app.inject({ url: "/health/ready" });
    expect(unready.statusCode).toBe(503);
    expect(unready.json<unknown>()).toMatchObject({ status: "unavailable", missing: ["CAPYKIT_AUTH_URL"] });
    const unconfigured = createHostedServer({ config: loadHostedConfig({}) });
    apps.push(unconfigured);
    expect((await unconfigured.inject({ url: "/health/ready" })).statusCode).toBe(503);
    expect((await unconfigured.inject({ url: "/health/live" })).statusCode).toBe(200);
  });

  it("sanitizes database and provider errors and returns server-generated request IDs", async () => {
    const { app, database, auth } = fixture();
    database.resolveContext.mockRejectedValueOnce(new Error("SENTINEL_PRIVATE_DATABASE_DETAIL"));
    auth.requestOtp.mockRejectedValueOnce(new Error("SENTINEL_PROVIDER_TOKEN"));
    const failures = [
      await app.inject({ url: "/v1/me", headers: { authorization: "Bearer verified-token" } }),
      await app.inject({ method: "POST", url: "/v1/auth/otp", payload: { email: identity.email } }),
    ];
    for (const response of failures) {
      expect(response.statusCode).toBe(500);
      expect(response.json<unknown>()).toEqual({ error: { code: "INTERNAL_ERROR", requestId: response.headers["x-request-id"] } });
      expect(response.body).not.toContain("SENTINEL");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("serves the console and assets without allowing traversal or serving other files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capykit-console-"));
    directories.push(directory);
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), '<script type="module" src="/assets/index-test.js"></script>');
    await writeFile(join(directory, "assets/index-test.js"), "document.title = 'Console';");
    await writeFile(join(directory, "private.txt"), "SENTINEL_PRIVATE_FILE");
    const { app } = fixture({ consoleDirectory: directory });
    const template = await app.inject({ url: "/auth/email-template" });
    expect(template.statusCode).toBe(200);
    expect(template.headers["content-type"]).toContain("text/html");
    expect(template.body).toContain("{{ .Token }}");
    expect(template.body).not.toContain("{{ .ConfirmationURL }}");
    const root = await app.inject({ url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("/assets/index-test.js");
    expect(root.headers["content-security-policy"]).toContain("img-src 'self' https://cdn.activepieces.com;");
    expect(root.headers["content-security-policy"]).toContain("script-src 'self';");
    expect(root.headers["content-security-policy"]).toContain("connect-src 'self';");
    const asset = await app.inject({ url: "/assets/index-test.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    for (const url of ["/assets/missing.js", "/assets/..%2Fprivate.txt", "/assets/index-test.js.map", "/private.txt"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body).not.toContain("SENTINEL");
    }
  });

  it("rejects invalid/public insecure deployment URLs without echoing configuration values", () => {
    for (const value of ["bad-SENTINEL", "https://user:SENTINEL@example.test", "http://public.example.test", "https://example.test/path"]) {
      expect(() => loadHostedConfig({ CAPYKIT_PUBLIC_BASE_URL: value })).toThrow(/Hosted URLs/u);
    }
    expect(loadHostedConfig({ CAPYKIT_PUBLIC_BASE_URL: "https://capykit.example.test/" }).publicBaseUrl).toBe(origin);
    expect(loadHostedConfig({ CAPYKIT_PUBLIC_BASE_URL: "http://localhost:3000" }).secureCookies).toBe(false);
    expect(loadHostedConfig({ CAPYKIT_AUTH_URL: "http://auth:9999/" }).authUrl).toBe("http://auth:9999");
    for (const value of ["invalid-provider-url", "ftp://auth:9999", "http://user:secret@auth:9999", "http://auth:9999/path", "http://auth:9999?secret=value", "http://auth:9999#fragment"]) {
      expect(() => loadHostedConfig({ CAPYKIT_AUTH_URL: value })).toThrow(/Authentication URL/u);
    }
  });
});


describe("public Google signup HTTP boundaries", () => {
  function publicFixture(available = true) {
    const googleSignIn = { available: vi.fn(() => Promise.resolve(available)), start: vi.fn(() => Promise.resolve({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=native", verifier: "v".repeat(43) })), providerCallback: vi.fn<(query: URLSearchParams) => Promise<string>>().mockResolvedValue(`${origin}/v1/auth/google/callback?code=native`), exchange: vi.fn<() => Promise<AuthSession | undefined>>().mockResolvedValue(session) };
    const value = fixture({ config: loadHostedConfig({ CAPYKIT_PUBLIC_SIGNUP: "true", CAPYKIT_PUBLIC_BASE_URL: origin, DATABASE_URL: "postgres://unused", CAPYKIT_AUTH_URL: "http://auth:9999" }), googleSignIn });
    const provisionIdentity = vi.fn(() => Promise.resolve());
    Object.assign(value.database, { provisionIdentity });
    return { ...value, googleSignIn, provisionIdentity };
  }
  it("keeps private sessions and email-code login out of the public signup flow", async () => {
    const { app, auth } = publicFixture();
    expect((await app.inject({ url: "/v1/me", headers: { cookie: "capykit_session=verified-token" } })).statusCode).toBe(401);
    expect(auth.verifyBearer).not.toHaveBeenCalled();
    for (const [url, payload] of [["/v1/auth/otp", { email: identity.email }], ["/v1/auth/verify", { email: identity.email, token: "123456" }]] as const) expect((await app.inject({ method: "POST", url, headers: { origin }, payload })).statusCode).toBe(404);
    expect(auth.requestOtp).not.toHaveBeenCalled(); expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(() => loadHostedConfig({ CAPYKIT_PUBLIC_SIGNUP: "yes" })).toThrow();
    expect(() => loadHostedConfig({ CAPYKIT_PUBLIC_SIGNUP: "true", CAPYKIT_PUBLIC_BASE_URL: "https://example.ts.net", CAPYKIT_AUTH_URL: "http://auth:9999", CAPYKIT_TAILSCALE_LOGIN: "owner@github", CAPYKIT_TAILSCALE_EMAIL: identity.email, CAPYKIT_TAILSCALE_SUBJECT: "12345678-1234-4321-8123-123456789012", CAPYKIT_TAILSCALE_PROXY_ADDRESS: "172.25.0.1", CAPYKIT_TAILSCALE_SERVICE_KEY: "test-only-service-key" })).toThrow("Public signup cannot use a private Tailscale identity mapping.");
  });
  it("offers Google signup, creates a short-lived private verifier and accepts no user-selected identity or redirect", async () => {
    const { app, googleSignIn } = publicFixture();
    expect((await app.inject({ url: "/v1/auth/method" })).json()).toEqual({ method: "google", available: true });
    for (const headers of [{}, { origin: "https://evil.test" }, { origin, authorization: "Bearer verified-token" }]) expect((await app.inject({ method: "POST", url: "/v1/auth/google/start", headers, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/auth/google/start", headers: { origin }, payload: { workspaceId: "driftward", redirectTo: "https://evil.test" } })).statusCode).toBe(400);
    expect(googleSignIn.start).not.toHaveBeenCalled();
    const result = await app.inject({ method: "POST", url: "/v1/auth/google/start", headers: { origin }, payload: {} });
    expect(result.statusCode).toBe(200);
    expect(result.cookies).toEqual([expect.objectContaining({ name: "capykit_google_verifier", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 600, path: "/v1/auth/google/callback" })]);
    expect(result.body).not.toContain("v".repeat(43));
  });
  it("verifies native identity before provisioning and writes normal remembered sessions without exposing tokens", async () => {
    const { app, auth, provisionIdentity, googleSignIn } = publicFixture();
    const result = await app.inject({ url: "/v1/auth/google/callback?code=native", headers: { cookie: `capykit_google_verifier=${"v".repeat(43)}` } });
    expect(result.statusCode).toBe(302); expect(result.headers.location).toBe(`${origin}/?tab=connections`);
    expect(googleSignIn.exchange).toHaveBeenCalledWith("native", "v".repeat(43));
    expect(auth.verifyBearer).toHaveBeenCalledWith(session.accessToken);
    expect(provisionIdentity).toHaveBeenCalledExactlyOnceWith(identity);
    expect(result.cookies.find(({ name }) => name === "capykit_public_refresh")).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", maxAge: rememberedAge });
    expect(result.cookies.find(({ name }) => name === "capykit_public_csrf")).toMatchObject({ secure: true, sameSite: "Strict" });
    expect(result.cookies.find(({ name }) => name === "capykit_public_csrf")?.httpOnly).not.toBe(true);
    expect(result.cookies.some(({ name }) => name === "capykit_csrf")).toBe(false);
    expect(result.cookies.find(({ name }) => name === "capykit_google_verifier")?.value).toBe("");
    expect(result.body).not.toMatch(/verified-token|refresh-token/u);
  });
  it("uses only public CSRF and preserves private cookies on public logout", async () => {
    const { app } = publicFixture();
    const cookie = "capykit_session=verified-token; capykit_refresh=private-refresh; capykit_csrf=private-proof; capykit_public_session=verified-token; capykit_public_refresh=refresh-token; capykit_public_csrf=public-proof";
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { origin, cookie, "x-csrf-token": "private-proof" }, payload: {} })).statusCode).toBe(403);
    const result = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { origin, cookie, "x-csrf-token": "public-proof" }, payload: {} });
    expect(result.statusCode).toBe(200);
    expect(result.cookies.map(({ name }) => name).sort()).toEqual(["capykit_public_csrf", "capykit_public_refresh", "capykit_public_session"]);
  });
  it("rejects missing/wrong-browser verifiers, expired codes and invalid native sessions without provisioning", async () => {
    const { app, googleSignIn, auth, provisionIdentity } = publicFixture();
    for (const url of ["/v1/auth/google/callback?code=native", "/v1/auth/google/callback"]) {
      expect((await app.inject({ url })).headers.location).toBe(`${origin}/?auth=google-expired`);
    }
    expect(googleSignIn.exchange).not.toHaveBeenCalled();
    googleSignIn.exchange.mockResolvedValueOnce(undefined);
    expect((await app.inject({ url: "/v1/auth/google/callback?code=expired", headers: { cookie: `capykit_google_verifier=${"v".repeat(43)}` } })).headers.location).toBe(`${origin}/?auth=google-failed`);
    auth.verifyBearer.mockResolvedValueOnce(undefined);
    const denied = await app.inject({ url: "/v1/auth/google/callback?code=native", headers: { cookie: `capykit_google_verifier=${"v".repeat(43)}` } });
    expect(denied.headers.location).toBe(`${origin}/?auth=google-failed`); expect(provisionIdentity).not.toHaveBeenCalled();
    expect(denied.cookies.filter(({ name }) => name !== "capykit_google_verifier")).toHaveLength(0);
  });
  it("forwards no caller cookies, headers or extra query fields to GoTrue's callback", async () => {
    const { app, googleSignIn } = publicFixture();
    const result = await app.inject({ url: "/v1/auth/google/provider/callback?code=provider-code&state=native-state&redirect_to=https://evil.test&scope=drive", headers: { cookie: "private=cookie", authorization: "Bearer private" } });
    expect(result.headers.location).toBe(`${origin}/v1/auth/google/callback?code=native`);
    expect(googleSignIn.providerCallback.mock.calls[0]?.[0].toString()).toBe("code=provider-code&state=native-state");
  });
  it("does not establish authority if provisioning fails, or membership becomes inactive", async () => {
    const { app, provisionIdentity, database } = publicFixture();
    provisionIdentity.mockRejectedValueOnce(new Error("private database failure"));
    for (const revoked of [false, true]) {
      if (revoked) database.resolveContext.mockResolvedValueOnce(undefined);
      const denied = await app.inject({ url: "/v1/auth/google/callback?code=native", headers: { cookie: `capykit_google_verifier=${"v".repeat(43)}` } });
      expect(denied.headers.location).toBe(`${origin}/?auth=google-failed`);
      expect(denied.cookies.filter(({ name }) => name !== "capykit_google_verifier")).toHaveLength(0);
    }
  });
});
