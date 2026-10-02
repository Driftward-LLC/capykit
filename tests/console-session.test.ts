import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function response(status = 200, code = "AUTHENTICATION_REQUIRED"): Response {
  return new Response(JSON.stringify(status === 200 ? {} : { error: { code } }), { status, headers: { "content-type": "application/json" } });
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("console session renewal", () => {
  const fetcher = vi.fn<typeof fetch>();
  const cookies = { cookie: "capykit_csrf=original-csrf" };

  beforeEach(() => {
    vi.resetModules(); fetcher.mockReset(); cookies.cookie = "capykit_csrf=original-csrf";
    vi.stubGlobal("document", cookies); vi.stubGlobal("navigator", {}); vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("renews one time and replays the same JSON mutation with fresh CSRF", async () => {
    const { writeRequest } = await import("../src/console/session.js");
    fetcher.mockResolvedValueOnce(response(401)).mockImplementationOnce(() => {
      cookies.cookie = "capykit_csrf=renewed-csrf";
      return Promise.resolve(response());
    }).mockResolvedValueOnce(response());
    expect((await writeRequest("/v1/connections/github/callback", "POST", { code: "one-use-code", state: "state" })).status).toBe(200);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/v1/connections/github/callback", "/v1/auth/refresh", "/v1/connections/github/callback"]);
    const first = fetcher.mock.calls[0]?.[1];
    const renewal = fetcher.mock.calls[1]?.[1];
    const retry = fetcher.mock.calls[2]?.[1];
    expect(first?.body).toBe(retry?.body);
    if (typeof retry?.body !== "string") throw new Error("Expected a replayable JSON request body");
    expect(JSON.parse(retry.body)).toEqual({ code: "one-use-code", state: "state" });
    expect(new Headers(first?.headers).get("x-csrf-token")).toBe("original-csrf");
    expect(new Headers(retry.headers).get("x-csrf-token")).toBe("renewed-csrf");
    expect(renewal).toMatchObject({ method: "POST", credentials: "same-origin", body: "{}" });
    expect(new Headers(renewal?.headers).has("authorization")).toBe(false);
  });

  it("does not renew membership denials, other failures, or authentication endpoints", async () => {
    const { sessionFetch, writeRequest } = await import("../src/console/session.js");
    for (const [status, code] of [[401, "MEMBERSHIP_INACTIVE"], [403, "FORBIDDEN"], [503, "UNAVAILABLE"]] as const) {
      fetcher.mockResolvedValueOnce(response(status, code));
      expect((await sessionFetch("/v1/capabilities")).status).toBe(status);
    }
    for (const action of ["otp", "verify", "tailscale", "session", "logout"]) {
      fetcher.mockResolvedValueOnce(response(401));
      expect((await writeRequest(`/v1/auth/${action}`, "POST", {})).status).toBe(401);
    }
    expect(fetcher.mock.calls.some(([path]) => path === "/v1/auth/refresh")).toBe(false);
  });

  it("shows normal sign-in for a cold browser without a CSRF cookie", async () => {
    const { sessionFetch } = await import("../src/console/session.js");
    cookies.cookie = "";
    fetcher.mockResolvedValueOnce(response(401));
    expect((await sessionFetch("/v1/me")).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns terminal 401 and never retries a second API denial", async () => {
    const { sessionFetch } = await import("../src/console/session.js");
    fetcher.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(401));
    expect((await sessionFetch("/v1/me")).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response()).mockResolvedValueOnce(response(401));
    expect((await sessionFetch("/v1/me")).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("throws a recoverable error on transient renewal failure without returning 401", async () => {
    const { sessionFetch } = await import("../src/console/session.js");
    fetcher.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(503));
    await expect(sessionFetch("/v1/capabilities")).rejects.toThrow("Your unsaved work is still here");
    fetcher.mockResolvedValueOnce(response(401)).mockRejectedValueOnce(new Error("provider details"));
    await expect(sessionFetch("/v1/capabilities")).rejects.toThrow("Could not renew your session");
    expect(fetcher.mock.calls.filter(([path]) => path === "/v1/auth/refresh")).toHaveLength(2);
  });

  it("shares renewal and lets a canceled caller stop without canceling the shared request", async () => {
    const { sessionFetch } = await import("../src/console/session.js");
    const renewal = deferred<Response>();
    const entered = deferred<boolean>();
    let ready = false;
    fetcher.mockImplementation((path) => {
      if (path === "/v1/auth/refresh") { entered.resolve(true); return renewal.promise; }
      return Promise.resolve(response(ready ? 200 : 401));
    });
    const controller = new AbortController();
    const canceled = sessionFetch("/v1/capabilities", { signal: controller.signal });
    const rejected = expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    const active = sessionFetch("/v1/connections");
    await entered.promise;
    controller.abort();
    await rejected;
    expect(fetcher.mock.calls.find(([path]) => path === "/v1/auth/refresh")?.[1]?.signal).toBeUndefined();
    ready = true; renewal.resolve(response());
    expect((await active).status).toBe(200);
    expect(fetcher.mock.calls.filter(([path]) => path === "/v1/auth/refresh")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([path]) => path === "/v1/capabilities")).toHaveLength(1);
  });

  it("reuses completed renewal when another original 401 arrives late", async () => {
    const { sessionFetch } = await import("../src/console/session.js");
    const late = deferred<Response>();
    let first = true;
    fetcher.mockImplementation((path) => {
      if (path === "/v1/connections" && first) { first = false; return late.promise; }
      return Promise.resolve(response(path === "/v1/me" && fetcher.mock.calls.filter(([value]) => value === path).length === 1 ? 401 : 200));
    });
    const pending = sessionFetch("/v1/connections");
    expect((await sessionFetch("/v1/me")).status).toBe(200);
    late.resolve(response(401));
    expect((await pending).status).toBe(200);
    expect(fetcher.mock.calls.filter(([path]) => path === "/v1/auth/refresh")).toHaveLength(1);
  });

  it("waits for refresh before logout and fences old requests from replay", async () => {
    const { sessionFetch, writeRequest } = await import("../src/console/session.js");
    const renewal = deferred<Response>();
    const entered = deferred<boolean>();
    fetcher.mockImplementation((path) => {
      if (path === "/v1/auth/refresh") { entered.resolve(true); return renewal.promise; }
      return Promise.resolve(response(path === "/v1/auth/logout" ? 200 : 401));
    });
    const request = sessionFetch("/v1/capabilities");
    const deniedRetry = expect(request).rejects.toThrow("Your session changed");
    await entered.promise;
    const logout = writeRequest("/v1/auth/logout", "POST", {});
    expect(fetcher.mock.calls.some(([path]) => path === "/v1/auth/logout")).toBe(false);
    renewal.resolve(response());
    expect((await logout).status).toBe(200);
    await deniedRetry;
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/v1/capabilities", "/v1/auth/refresh", "/v1/auth/logout"]);
  });

  it.each(["logout", "verify", "tailscale"])("fences a successful identity response arriving after %s", async (action) => {
    const { sessionFetch, writeRequest } = await import("../src/console/session.js");
    const identity = deferred<Response>();
    fetcher.mockImplementation((path) => path === "/v1/me" ? identity.promise : Promise.resolve(response()));
    const request = sessionFetch("/v1/me");
    const rejected = expect(request).rejects.toThrow("Your session changed");
    await writeRequest(`/v1/auth/${action}`, "POST", {});
    identity.resolve(response());
    await rejected;
  });

  it("checks whether another tab renewed before rotating under the shared lock", async () => {
    const locks = vi.fn((_name: string, run: () => Promise<unknown>) => run());
    vi.stubGlobal("navigator", { locks: { request: locks } });
    const { sessionFetch, writeRequest } = await import("../src/console/session.js");
    fetcher.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response()).mockResolvedValueOnce(response());
    expect((await sessionFetch("/v1/connections")).status).toBe(200);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/v1/connections", "/v1/me", "/v1/connections"]);
    expect(locks.mock.calls[0]?.[0]).toBe("capykit-session");
    fetcher.mockResolvedValueOnce(response());
    await writeRequest("/v1/auth/logout", "POST", {});
    expect(locks.mock.calls.map(([name]) => name)).toEqual(["capykit-session", "capykit-session"]);
  });

  it("does not replay GitHub callbacks after transient renewal or provider denial", async () => {
    const { writeRequest } = await import("../src/console/session.js");
    fetcher.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(503));
    await expect(writeRequest("/v1/connections/github/callback", "POST", { code: "code", state: "state" })).rejects.toThrow("Could not renew your session");
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/v1/connections/github/callback", "/v1/auth/refresh"]);
    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(response(401, "GITHUB_ACCESS_REVOKED"));
    expect((await writeRequest("/v1/connections/github/callback", "POST", { code: "code", state: "state" })).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
