import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubError, type GithubConfig } from "../src/hosted/github.js";
import { GithubSetup, loadGithubSetupOptions, persistGithubConfig, readStoredGithubConfig, type GithubSetupOptions } from "../src/hosted/github-setup.js";
import type { AuthenticatedContext } from "../src/hosted/identity.js";
import { loadGithubConfig as loadHostedGithubConfig } from "../src/hosted/server.js";
import { HostedAccessError } from "../src/hosted/workspace-access.js";

const origin = "https://app.example.test";
const context: AuthenticatedContext = {
  identity: { provider: "gotrue", subject: "operator", email: "operator@example.test" },
  membership: { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", principalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", principalKind: "human", role: "owner", active: true },
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: GithubConfig = {
  appId: "42", appSlug: "capykit-test", clientId: "Iv1.test", clientSecret: "test-client-secret",
  privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), webhookSecret: "webhook-test-secret-with-32-characters",
  encryptionKey: Buffer.alloc(32, 7), keyVersion: "v1", callbackUrl: `${origin}/v1/connections/github/callback`,
};
const app = {
  id: 42, slug: config.appSlug, client_id: config.clientId, external_url: origin, html_url: `https://github.com/apps/${config.appSlug}`,
  owner: { id: 11, login: "test-org", type: "Organization" }, permissions: { issues: "read", metadata: "read" }, events: [],
};
const converted = { ...app, client_secret: config.clientSecret, webhook_secret: config.webhookSecret, pem: config.privateKey };
const hook = { url: "https://webhooks.example.test/v1/webhooks/github", content_type: "json", insecure_ssl: "0", secret: "********" };
const directories: string[] = [];
function options(): GithubSetupOptions {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "capykit-github-setup-")); directories.push(directory);
  return { workspaceId: context.membership.workspaceId, principalId: context.membership.principalId, organization: "test-org", webhookUrl: hook.url, configFile: join(directory, "private", "github.json") };
}
function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status }); }
function fetcher(...values: unknown[]) {
  const mock = vi.fn<typeof fetch>();
  values.forEach((value, index) => mock.mockResolvedValueOnce(value instanceof Response ? value : response(value, index === 0 ? 201 : 200)));
  return mock;
}
function body(setup: GithubSetup, session = "session"): { code: string; state: string } {
  return { code: "manifest-code", state: new URL(setup.start(context, session).registrationUrl).searchParams.get("state") ?? "" };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// Hosted credential storage requires Unix ownership and permissions (Docker in deployment).
describe.skipIf(process.platform === "win32")("GitHub App bootstrap", () => {
  it("requires complete trusted operator configuration but permits a storage path without bootstrap", () => {
    expect(loadGithubSetupOptions({})).toBeUndefined();
    expect(loadGithubSetupOptions({ CAPYKIT_GITHUB_CONFIG_FILE: "/private/github.json" })).toBeUndefined();
    const configured = options();
    const env = {
      CAPYKIT_GITHUB_SETUP_WORKSPACE_ID: configured.workspaceId, CAPYKIT_GITHUB_SETUP_PRINCIPAL_ID: configured.principalId,
      CAPYKIT_GITHUB_SETUP_ORGANIZATION: configured.organization, CAPYKIT_GITHUB_WEBHOOK_URL: configured.webhookUrl, CAPYKIT_GITHUB_CONFIG_FILE: configured.configFile,
    };
    expect(loadGithubSetupOptions(env)).toEqual(configured);
    for (const changes of [
      { CAPYKIT_GITHUB_SETUP_WORKSPACE_ID: "invalid" }, { CAPYKIT_GITHUB_SETUP_PRINCIPAL_ID: "" },
      { CAPYKIT_GITHUB_SETUP_ORGANIZATION: "bad/org" }, { CAPYKIT_GITHUB_CONFIG_FILE: "relative.json" },
      { CAPYKIT_GITHUB_WEBHOOK_URL: "http://webhooks.example.test/v1/webhooks/github" },
      { CAPYKIT_GITHUB_WEBHOOK_URL: "https://user:password@webhooks.example.test/v1/webhooks/github" },
      { CAPYKIT_GITHUB_WEBHOOK_URL: `${hook.url}?secret=bad` }, { CAPYKIT_GITHUB_WEBHOOK_URL: `${hook.url}#bad` },
    ]) expect(() => loadGithubSetupOptions({ ...env, ...changes })).toThrow(GithubError);
    expect(() => loadGithubSetupOptions({ CAPYKIT_GITHUB_SETUP_ORGANIZATION: "test-org" })).toThrow(GithubError);
  });
  it("posts a minimal private manifest with state in the registration query and a separate callback", () => {
    const network = fetcher(); const setup = new GithubSetup(options(), origin, network);
    const start = setup.start(context, "session"); const url = new URL(start.registrationUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/organizations/test-org/settings/apps/new");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(start.manifest).toMatchObject({
      url: origin, public: false, hook_attributes: { url: hook.url, active: true },
      redirect_url: `${origin}/v1/provider-setup/github/callback`, callback_urls: [config.callbackUrl],
      setup_url: `${origin}/v1/connections/github/setup`, request_oauth_on_install: false,
      default_permissions: { issues: "read", metadata: "read" }, default_events: [],
    });
    expect(start.manifest).not.toHaveProperty("state"); expect(network).not.toHaveBeenCalled();
  });
  it("restricts setup to the exact active human owner and binds state to identity and session", async () => {
    const network = fetcher(); const setup = new GithubSetup(options(), origin, network); const input = body(setup);
    for (const membership of [
      { ...context.membership, principalId: "other" }, { ...context.membership, workspaceId: "other" },
      { ...context.membership, active: false }, { ...context.membership, role: "member" as const },
      { ...context.membership, principalKind: "agent" as const },
    ]) {
      const denied = { ...context, membership };
      expect(setup.eligible(denied)).toBe(false);
      expect(() => setup.start(denied, "session")).toThrow(GithubError);
      await expect(setup.complete(denied, "session", input, async () => {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(setup.complete(context, "other-session", input, async () => {})).rejects.toMatchObject({ code: "GITHUB_SETUP_STATE_INVALID" });
    await expect(setup.complete({ ...context, identity: { ...context.identity, subject: "other" } }, "session", input, async () => {})).rejects.toMatchObject({ code: "GITHUB_SETUP_STATE_INVALID" });
    expect(network).not.toHaveBeenCalled();
  });
  it("rejects malformed callbacks, expired state and state replaced by a new attempt before networking", async () => {
    let now = Date.now(); const network = fetcher(); const setup = new GithubSetup(options(), origin, network, () => now); const first = body(setup);
    for (const invalid of [null, {}, { ...first, code: "../other" }, { ...first, unexpected: true }, { ...first, state: "bad" }]) {
      await expect(setup.complete(context, "session", invalid, async () => {})).rejects.toMatchObject({ code: "GITHUB_SETUP_STATE_INVALID" });
    }
    const second = body(setup);
    await expect(setup.complete(context, "session", first, async () => {})).rejects.toMatchObject({ code: "GITHUB_SETUP_STATE_INVALID" });
    now += 600_000;
    await expect(setup.complete(context, "session", second, async () => {})).rejects.toMatchObject({ code: "GITHUB_SETUP_STATE_INVALID" });
    expect(network).not.toHaveBeenCalled();
  });
  it("validates credentials remotely, reauthorizes, persists once, and proves the App JWT", async () => {
    const selected = options(); const network = fetcher(converted, app, hook); const setup = new GithubSetup(selected, origin, network); const input = body(setup);
    const authorize = vi.fn(() => { expect(network).toHaveBeenCalledTimes(3); expect(existsSync(selected.configFile)).toBe(false); return Promise.resolve(); });
    const saved = await setup.complete(context, "session", input, authorize);
    expect(saved).toMatchObject({ ...config, encryptionKey: expect.any(Buffer) as Buffer });
    expect(saved.encryptionKey).toHaveLength(32); expect(saved.encryptionKey).not.toEqual(config.encryptionKey);
    expect(readStoredGithubConfig(selected.configFile, origin)).toEqual(saved); expect(authorize).toHaveBeenCalledOnce();
    expect(network.mock.calls.map((call) => call[0])).toEqual(["https://api.github.com/app-manifests/manifest-code/conversions", "https://api.github.com/app", "https://api.github.com/app/hook/config"]);
    const request = network.mock.calls[1]?.[1];
    expect(request?.redirect).toBe("error"); expect(request?.signal).toBeInstanceOf(AbortSignal);
    const authorization = (request?.headers as Record<string, string>).authorization ?? "";
    const [header, payload, signature] = authorization.slice(7).split(".") as [string, string, string];
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    await expect(setup.complete(context, "session", input, authorize)).rejects.toMatchObject({ code: "GITHUB_ALREADY_CONFIGURED" });
    expect(() => setup.start(context, "session")).toThrow(GithubError);
    expect(network).toHaveBeenCalledTimes(3);
  });
  it("consumes state before remote work and refuses parallel completion or starts", async () => {
    let release: (response: Response) => void = () => {};
    const network = fetcher().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const selected = options(); const setup = new GithubSetup(selected, origin, network); const input = body(setup);
    const completing = setup.complete(context, "session", input, async () => {});
    await expect(setup.complete(context, "session", input, async () => {})).rejects.toMatchObject({ code: "GITHUB_SETUP_BUSY" });
    expect(() => setup.start(context, "session")).toThrow(GithubError);
    release(new Response(null, { status: 503 }));
    await expect(completing).rejects.toMatchObject({ code: "GITHUB_SETUP_FAILED" });
    await expect(setup.complete(context, "session", input, async () => {})).rejects.toMatchObject({ code: "GITHUB_SETUP_STATE_INVALID" });
    expect(network).toHaveBeenCalledOnce(); expect(existsSync(selected.configFile)).toBe(false);
  });
  it("rejects untrusted App fields, widened permissions, changed identity and unsafe webhook settings", async () => {
    const invalidApps = [
      { ...converted, id: 0 }, { ...converted, slug: "../other" }, { ...converted, owner: { ...app.owner, login: "other" } },
      { ...converted, owner: { ...app.owner, type: "User" } }, { ...converted, external_url: "https://other.test" },
      { ...converted, html_url: "https://other.test" }, { ...converted, events: ["issues"] },
      { ...converted, permissions: { issues: "write", metadata: "read" } }, { ...converted, permissions: { ...app.permissions, contents: "read" } },
      { ...converted, pem: "invalid" }, { ...converted, client_secret: "" }, { ...converted, webhook_secret: "short" },
    ];
    for (const replies of [...invalidApps.map((invalid) => [invalid]), [converted, { ...app, id: 43 }], [converted, { ...app, owner: { ...app.owner, id: 12 } }],
      ...[{ ...hook, url: "https://other.test" }, { ...hook, insecure_ssl: "1" }, { ...hook, content_type: "form" }].map((invalid) => [converted, app, invalid])]) {
      const selected = options(); const setup = new GithubSetup(selected, origin, fetcher(...replies)); const input = body(setup); const authorize = vi.fn(async () => {});
      await expect(setup.complete(context, "session", input, authorize)).rejects.toMatchObject({ code: "GITHUB_SETUP_FAILED" });
      expect(authorize).not.toHaveBeenCalled(); expect(existsSync(selected.configFile)).toBe(false);
    }
  });
  it("does not persist when authority is revoked or the flow expires during remote checks", async () => {
    const selected = options(); const setup = new GithubSetup(selected, origin, fetcher(converted, app, hook)); const input = body(setup);
    await expect(setup.complete(context, "session", input, () => Promise.reject(new HostedAccessError("FORBIDDEN", 403)))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(existsSync(selected.configFile)).toBe(false);
    let now = Date.now(); const timed = new GithubSetup(selected, origin, fetcher(converted, app, hook), () => now); const timedInput = body(timed);
    await expect(timed.complete(context, "session", timedInput, () => { now += 600_000; return Promise.resolve(); })).rejects.toMatchObject({ code: "GITHUB_SETUP_STATE_INVALID" });
    expect(existsSync(selected.configFile)).toBe(false);
  });
  it("bounds conversion bodies and sanitizes transport failures without saving secrets", async () => {
    for (const network of [fetcher(new Response("x".repeat(65 * 1024), { status: 201 })), fetcher().mockRejectedValueOnce(new Error("PRIVATE_SENTINEL"))]) {
      const selected = options(); const setup = new GithubSetup(selected, origin, network); const input = body(setup);
      await expect(setup.complete(context, "session", input, async () => {})).rejects.toMatchObject({ code: "GITHUB_SETUP_FAILED", message: "GitHub connection request could not be completed." });
      expect(existsSync(selected.configFile)).toBe(false);
    }
  });
  it("reports persistence failures as failed setup without exposing protected paths", async () => {
    const selected = options(); const setup = new GithubSetup(selected, origin, fetcher(converted, app, hook)); const input = body(setup);
    await expect(setup.complete(context, "session", input, () => {
      mkdirSync(join(selected.configFile, ".."), { mode: 0o755 });
      return Promise.resolve();
    })).rejects.toMatchObject({ code: "GITHUB_SETUP_FAILED", message: "GitHub connection request could not be completed." });
    expect(existsSync(selected.configFile)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("protected GitHub App configuration", () => {
  it("round-trips complete configuration privately, without replacing an existing file", () => {
    const selected = options();
    expect(readStoredGithubConfig(selected.configFile, origin)).toBeUndefined();
    persistGithubConfig(selected.configFile, config);
    expect(readStoredGithubConfig(selected.configFile, origin)).toEqual(config);
    expect(statSync(selected.configFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(selected.configFile, "..")).mode & 0o777).toBe(0o700);
    expect(() => { persistGithubConfig(selected.configFile, { ...config, clientSecret: "other" }); }).toThrow(GithubError);
    expect(readStoredGithubConfig(selected.configFile, origin)).toEqual(config);
    expect(readdirSync(join(selected.configFile, ".."))).toEqual(["github.json"]);
  });
  it("loads persisted configuration for startup and cleanup while rejecting mixed credential sources", () => {
    const selected = options(); persistGithubConfig(selected.configFile, config);
    const env = { CAPYKIT_PUBLIC_BASE_URL: origin, CAPYKIT_GITHUB_CONFIG_FILE: selected.configFile };
    expect(loadHostedGithubConfig(env)).toEqual(config);
    const manual = JSON.parse(readFileSync(selected.configFile, "utf8")) as NodeJS.ProcessEnv;
    expect(() => loadHostedGithubConfig({ ...env, ...manual })).toThrow(GithubError);
    expect(() => loadHostedGithubConfig({ ...env, CAPYKIT_GITHUB_CLIENT_ID: "partial" })).toThrow(GithubError);
  });
  it("rejects corrupt, partial, excessive, unknown-field, mismatched-origin and unsafe-permission storage", () => {
    const selected = options(); persistGithubConfig(selected.configFile, config);
    const valid = readFileSync(selected.configFile, "utf8");
    for (const value of ["{", "{}", " ".repeat(65 * 1024), JSON.stringify({ ...(JSON.parse(valid) as object), CAPYKIT_GITHUB_PRIVATE_KEY_FILE: "/another/file" })]) {
      writeFileSync(selected.configFile, value);
      expect(() => readStoredGithubConfig(selected.configFile, origin)).toThrow(GithubError);
    }
    writeFileSync(selected.configFile, valid);
    expect(() => readStoredGithubConfig(selected.configFile, "https://other.test")).toThrow(GithubError);
    chmodSync(selected.configFile, 0o644);
    expect(() => readStoredGithubConfig(selected.configFile, origin)).toThrow(GithubError);
    chmodSync(selected.configFile, 0o600); chmodSync(join(selected.configFile, ".."), 0o755);
    expect(() => readStoredGithubConfig(selected.configFile, origin)).toThrow(GithubError);
  });
  it("rejects symlink files and directories without altering their targets", () => {
    const selected = options(); const directory = join(selected.configFile, ".."); mkdirSync(directory, { mode: 0o700 });
    const target = join(directory, "target"); writeFileSync(target, "untouched", { mode: 0o600 }); symlinkSync(target, selected.configFile);
    expect(() => readStoredGithubConfig(selected.configFile, origin)).toThrow(GithubError);
    expect(() => { persistGithubConfig(selected.configFile, config); }).toThrow(GithubError);
    expect(readFileSync(target, "utf8")).toBe("untouched");
    const linked = join(directory, "linked"); symlinkSync(directory, linked);
    expect(() => { persistGithubConfig(join(linked, "new.json"), config); }).toThrow(GithubError);
    expect(existsSync(join(directory, "new.json"))).toBe(false);
  });
});
