import { ConnectionError } from "./connections.js";
import { simulatedProviderJson } from "./preview-simulation.js";

/** Fixed provider URLs only. Never forward redirects, cookies or raw errors. */
export async function providerJson(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const simulated = simulatedProviderJson(url, init);
  if (simulated !== undefined) return simulated;
  const deadline = AbortSignal.timeout(10_000);
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline }); }
  catch { throw new ConnectionError("PROVIDER_UNAVAILABLE", 502); }
  if (!response.ok && !(url === "https://oauth2.googleapis.com/token" && response.status === 400)) {
    await response.body?.cancel();
    throw new ConnectionError(response.status === 401 ? "PROVIDER_AUTHORIZATION_EXPIRED" : response.status === 404 ? "PROVIDER_RESOURCE_NOT_FOUND" : "PROVIDER_REQUEST_FAILED", 502);
  }
  if (!response.body) throw new ConnectionError("PROVIDER_RESPONSE_INVALID", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) throw new Error("size");
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("shape");
    if (!response.ok) throw new ConnectionError((data as Record<string, unknown>).error === "invalid_grant" ? "PROVIDER_AUTHORIZATION_EXPIRED" : "PROVIDER_REQUEST_FAILED", 502);
    return data as Record<string, unknown>;
  } catch(error) { if (error instanceof ConnectionError) throw error; throw new ConnectionError("PROVIDER_RESPONSE_INVALID", 502); }
  finally { await reader.cancel().catch(() => {}); }
}
