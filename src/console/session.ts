let refreshing: Promise<boolean> | undefined;
let loggingOut: Promise<Response> | undefined;
let refreshVersion = 0;
let sessionGeneration = 0;
let csrfCookieName = "capykit_csrf";

export function setPublicSignupSession(enabled: boolean): void {
  csrfCookieName = enabled ? "capykit_public_csrf" : "capykit_csrf";
}

const renewalUnavailable = "Could not renew your session. Check your connection and try again. Your unsaved work is still here.";

function csrfToken(): string | undefined {
  const prefix = `${csrfCookieName}=`;
  return document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) || undefined;
}

function request(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD", "OPTIONS"].includes((init.method ?? "GET").toUpperCase())) {
    const csrf = csrfToken();
    if (csrf === undefined) headers.delete("x-csrf-token"); else headers.set("x-csrf-token", csrf);
  }
  return fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
}

function sessionLocks(): LockManager | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as Partial<Navigator>).locks;
}

async function sessionLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = sessionLocks();
  return locks === undefined ? run() : await locks.request("capykit-session", run);
}

function current(generation: number): void {
  if (generation !== sessionGeneration || loggingOut !== undefined) throw new Error("Your session changed. Try again after signing in or out.");
}

async function authenticationRequired(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const value = await response.clone().json().catch(() => null) as { error?: { code?: unknown } } | null;
  return value?.error?.code === "AUTHENTICATION_REQUIRED";
}

function refresh(generation: number): Promise<boolean> {
  refreshing ??= sessionLock(async () => {
    current(generation);
    try {
      if (sessionLocks() !== undefined) {
        // Another tab may have renewed while this tab waited for the lock.
        const identity = await request("/v1/me", {});
        if (identity.ok) return true;
        if (identity.status === 401 && !await authenticationRequired(identity)) return false;
        if (identity.status !== 401) throw new Error(renewalUnavailable);
      }
      const response = await request("/v1/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (response.status === 401) return false;
      if (response.status !== 200) throw new Error(renewalUnavailable);
      return true;
    } catch { throw new Error(renewalUnavailable); }
  }).then((renewed) => { if (renewed) refreshVersion++; return renewed; }).finally(() => { refreshing = undefined; });
  return refreshing;
}

function waitForRefresh(promise: Promise<boolean>, signal: AbortSignal | null | undefined): Promise<boolean> {
  if (signal === undefined || signal === null) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason instanceof Error ? signal.reason : new DOMException("The request was canceled.", "AbortError")); };
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => { signal.removeEventListener("abort", aborted); });
  });
}

function logout(init: RequestInit): Promise<Response> {
  if (loggingOut !== undefined) return loggingOut;
  // Fence responses and retries that began before the user's sign-out action.
  sessionGeneration++;
  const pendingRefresh = refreshing;
  loggingOut = (async () => {
    await pendingRefresh?.catch(() => {});
    return sessionLock(() => request("/v1/auth/logout", init));
  })().finally(() => { loggingOut = undefined; });
  return loggingOut;
}

/** Console requests use replayable JSON strings, never streaming request bodies. */
export async function sessionFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (path === "/v1/auth/logout") return logout(init);
  if (path.startsWith("/v1/auth/")) {
    const response = await request(path, init);
    if (["/v1/auth/verify", "/v1/auth/tailscale"].includes(path) && response.ok) sessionGeneration++;
    return response;
  }
  const generation = sessionGeneration;
  const version = refreshVersion;
  current(generation);
  const response = await request(path, init);
  const expired = await authenticationRequired(response);
  init.signal?.throwIfAborted();
  current(generation);
  if (!expired || csrfToken() === undefined) return response;
  const renewed = version !== refreshVersion || await waitForRefresh(refresh(generation), init.signal);
  init.signal?.throwIfAborted();
  current(generation);
  if (!renewed) return response;
  // Only an authentication denial is replayed, once, with fresh cookies and CSRF.
  const retried = await request(path, init);
  current(generation);
  return retried;
}

export function writeRequest(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<Response> {
  return sessionFetch(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
}
