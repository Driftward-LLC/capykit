import { AuthClient } from "@supabase/auth-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostedConfig } from "../src/hosted/config.js";
import { AuthUnavailableError, createAuthGateway } from "../src/hosted/auth.js";

const methods = vi.hoisted(() => ({ signInWithOtp: vi.fn(), verifyOtp: vi.fn(), refreshSession: vi.fn(), getUser: vi.fn(), signOut: vi.fn() }));
vi.mock("@supabase/auth-js", () => ({ AuthClient: vi.fn(function () { return { ...methods, admin: { signOut: methods.signOut } }; }) }));
const config = loadHostedConfig({ CAPYKIT_AUTH_URL: "http://auth:9999" });
const subject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const user = { id: subject, email: "owner@example.test" };
const session = { access_token: "test-access-token", refresh_token: "test-refresh-token" };
function jwt(claims: unknown = { sub: subject, session_id: sessionId }): string {
  return `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.testSignature`;
}
function gateway() {
  const result = createAuthGateway(config);
  if (!result) throw new Error("test auth configuration missing");
  return result;
}
beforeEach(() => { vi.clearAllMocks(); for (const method of Object.values(methods)) method.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("GoTrue authentication boundary", () => {
  it("disables account creation and keeps invited/unknown email responses indistinguishable", async () => {
    const auth = gateway();
    methods.signInWithOtp.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "user not found" } });
    await expect(auth.requestOtp("owner@example.test", "https://app.example.test")).resolves.toBeUndefined();
    await expect(auth.requestOtp("unknown@example.test", "https://app.example.test")).resolves.toBeUndefined();
    expect(methods.signInWithOtp).toHaveBeenCalledWith({ email: "unknown@example.test", options: { emailRedirectTo: "https://app.example.test", shouldCreateUser: false } });
    expect(AuthClient).toHaveBeenCalledTimes(2);
    expect(AuthClient).toHaveBeenLastCalledWith({ url: "http://auth:9999", autoRefreshToken: false, persistSession: false, detectSessionInUrl: false, headers: { "x-capykit-auth-client": "capykit-api" }, fetch: expect.any(Function) as typeof fetch });
  });
  it("returns the complete OTP session and rejects expired codes without persisting SDK state", async () => {
    const auth = gateway();
    methods.verifyOtp.mockResolvedValueOnce({ data: { session }, error: null });
    methods.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: { status: 403, code: "otp_expired" } });
    await expect(auth.verifyOtp(user.email, "123456")).resolves.toEqual({ accessToken: session.access_token, refreshToken: session.refresh_token });
    await expect(auth.verifyOtp(user.email, "654321")).resolves.toBeUndefined();
    expect(methods.verifyOtp).toHaveBeenCalledWith({ email: user.email, token: "123456", type: "email" });
    expect(AuthClient).toHaveBeenCalledTimes(2);
  });
  it("uses the native refresh token grant and returns both rotated credentials", async () => {
    const auth = gateway(); methods.refreshSession.mockResolvedValueOnce({ data: { session }, error: null });
    await expect(auth.refresh("old-refresh-token")).resolves.toEqual({ accessToken: session.access_token, refreshToken: session.refresh_token });
    expect(methods.refreshSession).toHaveBeenCalledWith({ refresh_token: "old-refresh-token" });
  });
  it("coalesces concurrent refreshes for the same credential and releases the entry afterward", async () => {
    const auth = gateway(); let release: (value: unknown) => void = () => {};
    methods.refreshSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = auth.refresh("same-refresh-token"); const second = auth.refresh("same-refresh-token");
    expect(methods.refreshSession).toHaveBeenCalledOnce(); release({ data: { session }, error: null });
    expect(await first).toEqual(await second);
    methods.refreshSession.mockResolvedValueOnce({ data: { session }, error: null }); await auth.refresh("same-refresh-token");
    expect(methods.refreshSession).toHaveBeenCalledTimes(2);
  });
  it("bounds distinct refreshes without rejecting callers sharing an existing request", async () => {
    const auth = gateway(); let release: (value: unknown) => void = () => {};
    const result = new Promise((resolve) => { release = resolve; }); methods.refreshSession.mockReturnValue(result);
    const requests = Array.from({ length: 128 }, (_, index) => auth.refresh(`test-refresh-${String(index)}`));
    const shared = auth.refresh("test-refresh-0");
    await expect(auth.refresh("over-capacity")).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(methods.refreshSession).toHaveBeenCalledTimes(128); release({ data: { session }, error: null });
    await Promise.all([...requests, shared]); await auth.refresh("over-capacity");
    expect(methods.refreshSession).toHaveBeenCalledTimes(129);
  });
  it("distinguishes invalid refresh sessions from temporary provider failures and releases failed attempts", async () => {
    const auth = gateway();
    for (const error of [
      { status: 400, code: "refresh_token_not_found" }, { status: 400, code: "refresh_token_already_used" },
      { status: 400, code: "session_expired" }, { status: 400, code: "validation_failed" },
      { name: "AuthSessionMissingError", status: 400 }, { status: 401 }, { status: 403 },
    ]) {
      methods.refreshSession.mockResolvedValueOnce({ data: { session: null }, error });
      await expect(auth.refresh("invalid-refresh-token")).resolves.toBeUndefined();
    }
    for (const error of [
      { name: "AuthRetryableFetchError", status: 0 }, { status: 429, code: "over_request_rate_limit" },
      { status: 500, code: "session_expired" }, { status: 503 }, { status: 400, code: "unexpected_failure" },
      { name: "AuthUnknownError", message: "PRIVATE_PROVIDER_DETAIL" },
    ]) {
      methods.refreshSession.mockResolvedValueOnce({ data: { session: null }, error });
      await expect(auth.refresh("temporarily-unavailable")).rejects.toMatchObject({ code: "AUTHENTICATION_UNAVAILABLE", statusCode: 503, message: "Authentication provider unavailable" });
    }
    methods.refreshSession.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_DETAIL"));
    await expect(auth.refresh("temporarily-unavailable")).rejects.toThrow("Authentication provider unavailable");
    methods.refreshSession.mockResolvedValueOnce({ data: { session }, error: null });
    await expect(auth.refresh("temporarily-unavailable")).resolves.toBeDefined();
  });
  it("derives stable session binding only from a token whose user GoTrue verified", async () => {
    const auth = gateway(); const first = jwt({ sub: subject, session_id: sessionId, iat: 1 }); const rotated = jwt({ sub: subject, session_id: sessionId, iat: 2 });
    methods.getUser.mockResolvedValue({ data: { user }, error: null });
    const identity = { provider: "gotrue", subject, email: user.email, sessionId };
    await expect(auth.verifyBearer(first)).resolves.toEqual(identity); await expect(auth.verifyBearer(rotated)).resolves.toEqual(identity);
    expect(methods.getUser).toHaveBeenNthCalledWith(1, first); expect(methods.getUser).toHaveBeenNthCalledWith(2, rotated);
    for (const token of ["malformed", jwt(null), jwt({ sub: "someone-else", session_id: sessionId }), jwt({ sub: subject }), jwt({ sub: subject, session_id: "invalid" }), jwt({ sub: subject, session_id: "00000000-0000-0000-0000-000000000000" })]) {
      await expect(auth.verifyBearer(token)).resolves.toBeUndefined();
    }
    for (const error of [{ status: 403, code: "bad_jwt" }, { name: "AuthSessionMissingError", status: 400 }]) {
      methods.getUser.mockResolvedValueOnce({ data: { user: null }, error });
      await expect(auth.verifyBearer(first)).resolves.toBeUndefined();
    }
  });
  it("does not turn OTP or identity outages and malformed sessions into invalid-credential results", async () => {
    const auth = gateway();
    for (const error of [{ status: 429 }, { status: 500 }, { status: 503 }, { name: "AuthUnknownError" }]) {
      methods.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error });
      await expect(auth.verifyOtp(user.email, "123456")).rejects.toBeInstanceOf(AuthUnavailableError);
      methods.getUser.mockResolvedValueOnce({ data: { user: null }, error });
      await expect(auth.verifyBearer(jwt())).rejects.toBeInstanceOf(AuthUnavailableError);
    }
    for (const incomplete of [null, { access_token: "only-access" }, { refresh_token: "only-refresh" }, { ...session, refresh_token: "" }]) {
      methods.verifyOtp.mockResolvedValueOnce({ data: { session: incomplete }, error: null });
      await expect(auth.verifyOtp(user.email, "123456")).rejects.toBeInstanceOf(AuthUnavailableError);
      methods.refreshSession.mockResolvedValueOnce({ data: { session: incomplete }, error: null });
      await expect(auth.refresh("refresh-token")).rejects.toBeInstanceOf(AuthUnavailableError);
    }
  });
  it("ends only the presented provider session and reports unavailable revocation", async () => {
    const auth = gateway(); methods.signOut.mockResolvedValueOnce({ error: null });
    await expect(auth.signOut("verified-token")).resolves.toBeUndefined();
    expect(methods.signOut).toHaveBeenCalledWith("verified-token", "local");
    for (const error of [{ status: 403 }, { status: 404 }, { name: "AuthSessionMissingError", status: 400 }]) {
      methods.signOut.mockResolvedValueOnce({ error }); await expect(auth.signOut("revoked-token")).resolves.toBeUndefined();
    }
    for (const error of [{ status: 429 }, { status: 500, message: "PRIVATE_PROVIDER_DETAIL" }]) {
      methods.signOut.mockResolvedValueOnce({ error }); await expect(auth.signOut("verified-token")).rejects.toBeInstanceOf(AuthUnavailableError);
    }
  });
  it("bounds each SDK network request and refuses redirects", async () => {
    const auth = gateway(); methods.verifyOtp.mockResolvedValueOnce({ data: { session }, error: null }); await auth.verifyOtp(user.email, "123456");
    const options = vi.mocked(AuthClient).mock.calls[0]?.[0]; if (!options?.fetch) throw new Error("test SDK fetch missing");
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", network);
    await options.fetch("http://auth:9999/user", { method: "GET" });
    expect(network).toHaveBeenCalledWith("http://auth:9999/user", { method: "GET", redirect: "error", signal: expect.any(AbortSignal) as AbortSignal });
  });
});
