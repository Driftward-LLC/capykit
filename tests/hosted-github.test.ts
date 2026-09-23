import { createHash, createHmac, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GithubError, GithubProvider, loadGithubConfig, pkce, seal, unseal, verifyGithubWebhook, type GithubConfig } from "../src/hosted/github.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: GithubConfig = {
  appId: "42", appSlug: "capykit-test", clientId: "Iv1.test", clientSecret: "test-client-secret",
  privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), webhookSecret: "webhook-test-secret-with-32-characters", encryptionKey: Buffer.alloc(32, 8), keyVersion: "v1",
  callbackUrl: "https://app.example.test/v1/connections/github/callback",
};
const installation = { id: 10, app_id: 42, account: { id: 20, login: "team", type: "Organization" }, permissions: { issues: "read", metadata: "read" }, suspended_at: null, repository_selection: "selected" };
const repo = { id: 123, full_name: "team/repo", permissions: { admin: true } };
const user = { id: 30, login: "owner" };
function response(value: unknown, headers?: Record<string, string>): Response { return new Response(JSON.stringify(value), { status: 200, ...(headers ? { headers } : {}) }); }
function mockFetch(...values: unknown[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const value of values) fetcher.mockResolvedValueOnce(value instanceof Response ? value : response(value));
  return fetcher;
}
function environment(): NodeJS.ProcessEnv {
  return {
    CAPYKIT_GITHUB_APP_ID: config.appId, CAPYKIT_GITHUB_APP_SLUG: config.appSlug, CAPYKIT_GITHUB_CLIENT_ID: config.clientId,
    CAPYKIT_GITHUB_CLIENT_SECRET: config.clientSecret, CAPYKIT_GITHUB_PRIVATE_KEY: config.privateKey, CAPYKIT_GITHUB_WEBHOOK_SECRET: config.webhookSecret,
    CONNECT_STATE_ENCRYPTION_KEY: config.encryptionKey.toString("base64"), CONNECT_STATE_ENCRYPTION_KEY_VERSION: config.keyVersion,
    CAPYKIT_PUBLIC_BASE_URL: "https://app.example.test",
  };
}

describe("GitHub connection cryptography and configuration", () => {
  it("permits absent configuration, validates complete configuration and never echoes invalid values", () => {
    expect(loadGithubConfig({})).toBeUndefined();
    expect(loadGithubConfig(environment())).toEqual(config);
    for (const overrides of [
      { CAPYKIT_GITHUB_APP_ID: "SENTINEL_SECRET" }, { CAPYKIT_GITHUB_PRIVATE_KEY: "SENTINEL_SECRET" },
      { CONNECT_STATE_ENCRYPTION_KEY: "SENTINEL_SECRET" }, { CONNECT_STATE_ENCRYPTION_KEY_VERSION: "" },
      { CAPYKIT_GITHUB_CALLBACK_URL: "https://evil.test/callback" }, { CAPYKIT_PUBLIC_BASE_URL: "http://example.test" },
      { CAPYKIT_GITHUB_PRIVATE_KEY_FILE: "/SENTINEL_SECRET" },
    ]) {
      expect(() => loadGithubConfig({ ...environment(), ...overrides })).toThrow("GitHub connection configuration is unavailable.");
    }
    expect(() => loadGithubConfig({ CAPYKIT_GITHUB_CLIENT_ID: "partial" })).toThrow(GithubError);
  });
  it("encrypts opaque setup payloads with independent nonces and rejects wrong tenant, key/version or any modified field", () => {
    const payload = { accessToken: "test-user-token", verifier: "test-verifier" };
    const a = seal(config, payload, "workspace:principal:setup");
    expect(a).not.toEqual(seal(config, payload, "workspace:principal:setup"));
    expect(JSON.stringify(a)).not.toContain("test-user-token");
    expect(unseal(config, a, "workspace:principal:setup")).toEqual(payload);
    expect(() => unseal(config, a, "other:principal:setup")).toThrowError(GithubError);
    expect(() => unseal({ ...config, encryptionKey: Buffer.alloc(32, 9) }, a, "workspace:principal:setup")).toThrow(GithubError);
    for (const field of ["version", "nonce", "tag", "ciphertext"] as const) expect(() => unseal(config, { ...a, [field]: "modified" }, "workspace:principal:setup")).toThrow(GithubError);
  });
  it("creates S256 PKCE and verifies the raw webhook bytes with a fixed-length HMAC", () => {
    const proof = pkce();
    expect(proof.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(proof.challenge).toBe(createHash("sha256").update(proof.verifier).digest("base64url"));
    const raw = Buffer.from('{"action":"deleted"}');
    const signature = `sha256=${createHmac("sha256", config.webhookSecret).update(raw).digest("hex")}`;
    expect(verifyGithubWebhook(config.webhookSecret, raw, signature)).toBe(true);
    for (const invalid of [undefined, "", "sha1=abc", `${signature}a`, signature.replace(/.$/u, signature.endsWith("a") ? "b" : "a")]) expect(verifyGithubWebhook(config.webhookSecret, raw, invalid)).toBe(false);
    expect(verifyGithubWebhook(config.webhookSecret, Buffer.concat([raw, Buffer.from(" ")]), signature)).toBe(false);
  });
});

describe("GitHub owner verification and narrow tokens", () => {
  it("uses fixed OAuth endpoints, PKCE, and bounded lifetimes, revoking temporary user tokens through client authentication", async () => {
    const fetcher = mockFetch({ access_token: "test-user-token", refresh_token: "test-refresh-token", token_type: "bearer", expires_in: 28800 }, new Response(null, { status: 204 }));
    const provider = new GithubProvider(config, fetcher);
    const url = new URL(provider.authorizationUrl("state", "challenge"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(url.searchParams.has("scope")).toBe(false);
    expect(provider.installationUrl()).toBe("https://github.com/apps/capykit-test/installations/new");
    const token = await provider.exchange("code", "verifier");
    expect(token.accessToken).toBe("test-user-token");
    const exchange = fetcher.mock.calls[0] ?? [];
    expect(exchange[0]).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(exchange[1]?.body as string)).toEqual({ client_id: config.clientId, client_secret: config.clientSecret, code: "code", redirect_uri: config.callbackUrl, code_verifier: "verifier" });
    expect(exchange[1]?.redirect).toBe("error");
    expect(exchange[1]?.signal).toBeInstanceOf(AbortSignal);
    await provider.revokeUserToken(token.accessToken);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.github.com/applications/Iv1.test/token");
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });
  it("rejects nonexpiring temporary tokens and attempts immediate revocation", async () => {
    const fetcher = mockFetch({ access_token: "test-user-token", token_type: "bearer" }, new Response(null, { status: 204 }));
    await expect(new GithubProvider(config, fetcher).exchange("code", "verifier")).rejects.toMatchObject({ code: "GITHUB_AUTHORIZATION_FAILED" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("independently checks the current user, app installation and admin permission for every displayed repository", async () => {
    const fetcher = mockFetch(user, { installations: [installation] }, installation, { repositories: [repo, { ...repo, id: 124, permissions: { admin: false } }] });
    const candidates = await new GithubProvider(config, fetcher).candidates("user-token");
    expect(candidates).toEqual([{ installationId: "10", account: { id: "20", login: "team", type: "Organization" }, permissions: { issues: "read", metadata: "read" }, repositories: [{ id: "123", fullName: "team/repo", url: "https://github.com/team/repo", admin: true }] }]);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "https://api.github.com/user", "https://api.github.com/user/installations?per_page=100&page=1", "https://api.github.com/app/installations/10", "https://api.github.com/user/installations/10/repositories?per_page=100&page=1",
    ]);
    const authorization = (fetcher.mock.calls[2]?.[1]?.headers as Record<string, string>).authorization ?? "";
    const [header, payload, signature] = authorization.slice(7).split(".") as [string, string, string];
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss: string; iat: number; exp: number };
    expect(claims.iss).toBe(config.clientId);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });
  it("skips known ineligible discoveries while keeping confirmation and token minting strict", async () => {
    for (const wrong of [
      { ...installation, permissions: { issues: "write", metadata: "read" } },
      { ...installation, permissions: { ...installation.permissions, contents: "read" } }, { ...installation, repository_selection: "all" },
      { ...installation, suspended_at: new Date().toISOString() },
    ]) {
      const next = { ...installation, id: 11 };
      const fetcher = mockFetch(user, { installations: [installation, next] }, wrong, next, { repositories: [repo] });
      await expect(new GithubProvider(config, fetcher).candidates("user-token")).resolves.toMatchObject([{ installationId: "11", repositories: [{ id: "123" }] }]);
      expect(fetcher.mock.calls.map((call) => call[0])).not.toContain("https://api.github.com/user/installations/10/repositories?per_page=100&page=1");
      await expect(new GithubProvider(config, mockFetch(user, { installations: [installation] }, wrong)).recheck("user-token", "10", "20", ["123"])).rejects.toBeInstanceOf(GithubError);
      await expect(new GithubProvider(config, mockFetch(wrong)).mint("10", ["123"])).rejects.toBeInstanceOf(GithubError);
    }
  });
  it("does not hide wrong-app, malformed, authentication or network discovery failures", async () => {
    for (const wrong of [{ ...installation, app_id: 43 }, { ...installation, repository_selection: "unexpected" }, { ...installation, permissions: null }]) {
      await expect(new GithubProvider(config, mockFetch(user, { installations: [installation] }, wrong)).candidates("user-token")).rejects.toBeInstanceOf(GithubError);
    }
    for (const status of [401, 403, 500]) {
      await expect(new GithubProvider(config, mockFetch(user, { installations: [installation] }, new Response(null, { status }))).candidates("user-token")).rejects.toMatchObject({ code: status === 500 ? "GITHUB_UNAVAILABLE" : "GITHUB_ACCESS_REVOKED" });
    }
    const network = mockFetch(user, { installations: [installation] }).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(new GithubProvider(config, network).candidates("user-token")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });
  it("bounds discovery to 20 installations before fetching installation details", async () => {
    const fetcher = mockFetch(user, { installations: Array.from({ length: 21 }, (_, index) => ({ ...installation, id: index + 1 })) });
    await expect(new GithubProvider(config, fetcher).candidates("user-token")).rejects.toMatchObject({ code: "GITHUB_RESULT_LIMIT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const boundary = Array.from({ length: 20 }, (_, index) => ({ ...installation, id: index + 1, suspended_at: "2026-01-01T00:00:00Z" }));
    const accepted = mockFetch(user, { installations: boundary }, ...boundary);
    await expect(new GithubProvider(config, accepted).candidates("user-token")).resolves.toEqual([]);
    expect(accepted).toHaveBeenCalledTimes(22);
  });
  it("bounds aggregate repository discovery across installations before filtering administrator access", async () => {
    const first = Array.from({ length: 300 }, (_, index) => ({ ...repo, id: index + 1, permissions: { admin: false } }));
    const next = { ...installation, id: 11 };
    const nextRepositories = Array.from({ length: 201 }, (_, index) => ({ ...repo, id: index + 1000 }));
    const more = { link: '<https://api.github.com/next>; rel="next"' };
    const pages = (repositories: unknown[]) => Array.from({ length: Math.ceil(repositories.length / 100) }, (_, index) => response({ repositories: repositories.slice(index * 100, (index + 1) * 100) }, (index + 1) * 100 < repositories.length ? more : undefined));
    const fetcher = mockFetch(user, { installations: [installation, next] }, installation, ...pages(first), next, ...pages(nextRepositories));
    await expect(new GithubProvider(config, fetcher).candidates("user-token")).rejects.toMatchObject({ code: "GITHUB_RESULT_LIMIT" });
    expect(fetcher).toHaveBeenCalledTimes(9);
    const accepted = mockFetch(user, { installations: [installation, next] }, installation, ...pages(first), next, ...pages(nextRepositories.slice(0, 200)));
    const candidates = await new GithubProvider(config, accepted).candidates("user-token");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.repositories).toHaveLength(200);
  });
  it("rechecks selected repository admin permissions and account identity at confirmation", async () => {
    const success = mockFetch(user, { installations: [installation] }, installation, { repositories: [repo] });
    const result = await new GithubProvider(config, success).recheck("user-token", "10", "20", ["123"]);
    expect(result.repositories.map((item) => item.id)).toEqual(["123"]);
    const lostAdmin = mockFetch(user, { installations: [installation] }, installation, { repositories: [{ ...repo, permissions: { admin: false } }] });
    await expect(new GithubProvider(config, lostAdmin).recheck("user-token", "10", "20", ["123"])).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_FORBIDDEN" });
    const wrongAccount = mockFetch(user, { installations: [installation] }, installation);
    await expect(new GithubProvider(config, wrongAccount).recheck("user-token", "10", "21", ["123"])).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_INVALID" });
    const lostInstallation = mockFetch(user, { installations: [] });
    await expect(new GithubProvider(config, lostInstallation).recheck("user-token", "10", "20", ["123"])).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_INVALID" });
  });
  it("uses numbered fixed-path pagination, rejects overflow and never follows provider Link URLs", async () => {
    const fetcher = mockFetch(user, response({ installations: [] }, { link: '<https://evil.test/secret>; rel="next"' }), { installations: [installation] }, installation, { repositories: [repo] });
    expect(await new GithubProvider(config, fetcher).candidates("user-token")).toHaveLength(1);
    expect(fetcher.mock.calls[2]?.[0]).toBe("https://api.github.com/user/installations?per_page=100&page=2");
    const overflow = mockFetch(user, ...Array.from({ length: 10 }, () => response({ installations: [] }, { link: '<https://api.github.com/user/installations?page=2>; rel="next"' })));
    await expect(new GithubProvider(config, overflow).candidates("user-token")).rejects.toMatchObject({ code: "GITHUB_RESULT_LIMIT" });
    expect(overflow).toHaveBeenCalledTimes(11);
  });
  it("mints exact repository IDs and Issues/Metadata read only, rejecting and revoking any wider returned token", async () => {
    const minted = { token: "test-installation-token", expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: installation.permissions, repository_selection: "selected", repositories: [repo] };
    const fetcher = mockFetch(installation, minted);
    const result = await new GithubProvider(config, fetcher).mint("10", ["123"]);
    expect(result.token).toBe(minted.token);
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({ repository_ids: [123], permissions: { issues: "read", metadata: "read" } });
    for (const wrong of [{ ...minted, repositories: [repo, { ...repo, id: 124 }] }, { ...minted, permissions: { ...installation.permissions, contents: "read" } }, { ...minted, repositories: undefined }]) {
      const invalid = mockFetch(installation, wrong, new Response(null, { status: 204 }));
      await expect(new GithubProvider(config, invalid).mint("10", ["123"])).rejects.toBeInstanceOf(GithubError);
      expect(invalid.mock.calls[2]?.[0]).toBe("https://api.github.com/installation/token");
      expect(invalid.mock.calls[2]?.[1]?.method).toBe("DELETE");
    }
    const none = mockFetch();
    for (const ids of [[], ["123", "123"], ["9007199254740992"]]) await expect(new GithubProvider(config, none).mint("10", ids)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(none).not.toHaveBeenCalled();
  });
  it("treats expired installation tokens as revoked but preserves forbidden/retryable revocation errors", async () => {
    await expect(new GithubProvider(config, mockFetch(new Response(null, { status: 401 }))).revokeInstallationToken("expired")).resolves.toBeUndefined();
    await expect(new GithubProvider(config, mockFetch(new Response(null, { status: 403 }))).revokeInstallationToken("valid")).rejects.toMatchObject({ code: "GITHUB_ACCESS_REVOKED" });
    await expect(new GithubProvider(config, mockFetch(new Response(null, { status: 429 }))).revokeInstallationToken("valid")).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
  });
  it("returns stable, redacted rate-limit/access/network/response errors", async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const fetcher = mockFetch(new Response("SENTINEL_PROVIDER_SECRET", { status }));
      await expect(new GithubProvider(config, fetcher).user("test-token")).rejects.toMatchObject({ code: status === 429 ? "GITHUB_RATE_LIMITED" : status === 500 ? "GITHUB_UNAVAILABLE" : "GITHUB_ACCESS_REVOKED" });
    }
    const limited = mockFetch(new Response("SENTINEL_SECRET", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    await expect(new GithubProvider(config, limited).user("test-token")).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error("SENTINEL_SECRET"));
    await expect(new GithubProvider(config, network).user("test-token")).rejects.toThrow("GitHub connection request could not be completed.");
    const oversized = mockFetch(new Response("x".repeat(4 * 1024 * 1024 + 1)));
    await expect(new GithubProvider(config, oversized).user("test-token")).rejects.toMatchObject({ code: "GITHUB_RESPONSE_LIMIT" });
  });
});

describe("GitHub issues fixed facade", () => {
  const issue = { id: 55, number: 7, title: "Issue", state: "open", body: "MUST_NOT_RETURN", labels: [{ name: "bug" }], user: { login: "author", email: "MUST_NOT_RETURN" }, updated_at: "2026-01-01T00:00:00Z", html_url: "https://evil.test/" };
  it("derives the repository route from stable ID and returns only reviewed fields from one provider page", async () => {
    const fetcher = mockFetch(repo, response([issue, { ...issue, id: 56, number: 8, pull_request: {} }], { link: '<https://api.github.com/page2>; rel="next"' }));
    const result = await new GithubProvider(config, fetcher).listIssues("installation-token", { repositoryId: "123", limit: 2 });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["https://api.github.com/repositories/123", "https://api.github.com/repos/team/repo/issues?state=open&page=1&per_page=2"]);
    expect(result).toEqual({ repository: { id: "123", fullName: "team/repo", url: "https://github.com/team/repo" }, issues: [{ id: "55", number: 7, title: "Issue", state: "open", url: "https://github.com/team/repo/issues/7", labels: ["bug"], author: { login: "author", url: "https://github.com/author" }, updatedAt: "2026-01-01T00:00:00.000Z" }], nextPage: 2 });
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_RETURN");
  });
  it("keeps continuation for an all-PR page and always stops at page 100", async () => {
    for (const page of [1, 100]) {
      const fetcher = mockFetch(repo, response([{ ...issue, pull_request: {} }], { link: '<https://evil.test>; rel="next"' }));
      expect(await new GithubProvider(config, fetcher).listIssues("installation-token", { repositoryId: "123", page, limit: 1 })).toMatchObject({ issues: [], nextPage: page === 1 ? 2 : null });
    }
  });
  it("rejects arbitrary URLs, fields, unsafe IDs and renamed/mismatched IDs before issuing issue requests", async () => {
    const noFetch = mockFetch();
    for (const input of [{ repositoryId: "123", url: "https://evil.test" }, { repositoryId: "123", limit: 51 }, { repositoryId: "9007199254740992" }]) await expect(new GithubProvider(config, noFetch).listIssues("token", input)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(noFetch).not.toHaveBeenCalled();
    const wrong = mockFetch({ ...repo, id: 124 });
    await expect(new GithubProvider(config, wrong).listIssues("token", { repositoryId: "123" })).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_FORBIDDEN" });
    expect(wrong).toHaveBeenCalledTimes(1);
  });
});
