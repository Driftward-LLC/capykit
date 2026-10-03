import { createHash, randomUUID } from "node:crypto";
import nock from "nock";
import { afterEach, describe, expect, it } from "vitest";
import { createGoogleSignIn } from "../src/hosted/google-sign-in.js";
const authUrl = "http://signup-auth.example.test", origin = "https://capykit.example.test";
const callback = `${origin}/v1/auth/google/callback`;
const providerCallback = `${origin}/v1/auth/google/provider/callback`;
function googleUrl(changes: Record<string, string> = {}) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: "fixture.apps.googleusercontent.com", redirect_uri: providerCallback, response_type: "code", scope: "openid email profile", state: randomUUID(), ...changes }).toString();
  return url.href;
}
const jwt = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: randomUUID(), session_id: randomUUID() })).toString("base64url")}.fixtureSignature`;
function tokenBody(verified = true) {
  return { access_token: jwt, refresh_token: "fixture-refresh-token", token_type: "bearer", expires_in: 3600, user: { id: randomUUID(), email: "customer@example.test", email_confirmed_at: "2026-10-03", identities: [{ provider: "google", identity_data: { email: "customer@example.test", email_verified: verified } }] } };
}
afterEach(() => { nock.cleanAll(); });
describe("native Google signup", () => {
  it("requires Google and public signup to be enabled in GoTrue", async () => {
    for (const [disable_signup, google, expected] of [[false, true, true], [true, true, false], [false, false, false]] as const) {
      const scope = nock(authUrl).get("/settings").reply(200, { disable_signup, external: { google } });
      expect(await createGoogleSignIn(authUrl, origin).available()).toBe(expected); expect(scope.isDone()).toBe(true);
    }
  });
  it("uses fixed identity-only Google OAuth through native GoTrue with a browser PKCE verifier", async () => {
    let captured: URL | undefined;
    const scope = nock(authUrl).get("/authorize").query(query => { captured = new URL(`/authorize?${new URLSearchParams(query as Record<string, string>)}`, authUrl); return true; }).reply(302, "", { Location: googleUrl() });
    const started = await createGoogleSignIn(authUrl, origin).start();
    expect(started.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(captured?.searchParams.get("code_challenge")).toBe(createHash("sha256").update(started.verifier).digest("base64url"));
    expect(captured?.searchParams.get("redirect_to")).toBe(callback);
    expect(captured?.searchParams.get("scopes")).toBe("openid email profile");
    expect(captured?.searchParams.get("code_challenge_method")).toBe("s256");
    expect(started.authorizationUrl).not.toContain(started.verifier); expect(scope.isDone()).toBe(true);
  });
  it("rejects substitute hosts, callbacks, and Drive permissions", async () => {
    for (const location of ["https://evil.test/", googleUrl({ redirect_uri: "https://evil.test/callback" }), googleUrl({ scope: "openid email https://www.googleapis.com/auth/drive" })]) {
      nock(authUrl).get("/authorize").query(true).reply(302, "", { Location: location });
      await expect(createGoogleSignIn(authUrl, origin).start()).rejects.toMatchObject({ code: "AUTHENTICATION_UNAVAILABLE" });
    }
  });
  it("relays only fixed native callbacks and normalizes provider errors without leaking details", async () => {
    const signin = createGoogleSignIn(authUrl, origin);
    for (const [location, expected] of [[`${callback}?code=one-use-code`, `${callback}?code=one-use-code`], [`${callback}#error=access_denied&error_description=private`, `${origin}/?auth=google-cancelled`]] as const) {
      const scope = nock(authUrl).get("/callback").query({ state: "native-state", code: "google-code" }).reply(302, "", { Location: location });
      expect(await signin.providerCallback(new URLSearchParams({ state: "native-state", code: "google-code" }))).toBe(expected); expect(scope.isDone()).toBe(true);
    }
    for (const location of ["https://evil.test/callback?code=private", `${callback}#access_token=private`, `${origin}/wrong?code=private`]) {
      nock(authUrl).get("/callback").query(true).reply(302, "", { Location: location });
      await expect(signin.providerCallback(new URLSearchParams())).rejects.toMatchObject({ code: "AUTHENTICATION_UNAVAILABLE" });
    }
  });
  it("uses the actual auth SDK to exchange a single-use native code and rejects unverified Google email", async () => {
    for (const verified of [true, false]) {
      const scope = nock(authUrl).post("/token", { auth_code: "native-code", code_verifier: "browser-private-verifier" }).query({ grant_type: "pkce" }).reply(200, tokenBody(verified));
      const result = await createGoogleSignIn(authUrl, origin).exchange("native-code", "browser-private-verifier");
      expect(result).toEqual(verified ? { accessToken: jwt, refreshToken: "fixture-refresh-token" } : undefined); expect(scope.isDone()).toBe(true);
    }
  });
  it("does not treat another provider, another email, unconfirmed identities or an outage as a successful signup", async () => {
    const base = tokenBody();
    for (const user of [{ ...base.user, email_confirmed_at: "" }, { ...base.user, identities: [{ provider: "email", identity_data: { email: base.user.email, email_verified: true } }] }, { ...base.user, identities: [{ provider: "google", identity_data: { email: "other@example.test", email_verified: true } }] }]) {
      nock(authUrl).post("/token").query(true).reply(200, { ...base, user });
      expect(await createGoogleSignIn(authUrl, origin).exchange("code", "verifier")).toBeUndefined();
    }
    nock(authUrl).post("/token").query(true).reply(503, { message: "private provider failure" });
    await expect(createGoogleSignIn(authUrl, origin).exchange("code", "verifier")).rejects.toThrow("Authentication provider unavailable");
  });
});
