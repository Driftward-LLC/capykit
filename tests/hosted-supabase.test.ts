import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostedConfig } from "../src/hosted/config.js";
import { createSupabaseAuthGateway } from "../src/hosted/supabase.js";

const methods = vi.hoisted(() => ({ signInWithOtp: vi.fn(), verifyOtp: vi.fn(), getUser: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ auth: methods })) }));
const config = loadHostedConfig({ SUPABASE_URL: "https://auth.example.test", SUPABASE_SERVICE_ROLE_KEY: "test-only-placeholder" });
beforeEach(() => { vi.clearAllMocks(); });

describe("Supabase authentication boundary", () => {
  it("disables account creation and keeps invited/unknown email responses indistinguishable", async () => {
    const gateway = createSupabaseAuthGateway(config);
    if (gateway === undefined) throw new Error("test auth configuration missing");
    methods.signInWithOtp.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "user not found" } });
    await expect(gateway.requestOtp("owner@example.test", "https://app.example.test")).resolves.toBeUndefined();
    await expect(gateway.requestOtp("unknown@example.test", "https://app.example.test")).resolves.toBeUndefined();
    expect(methods.signInWithOtp).toHaveBeenCalledWith({ email: "unknown@example.test", options: { emailRedirectTo: "https://app.example.test", shouldCreateUser: false } });
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("verifies codes through the provider and rejects expired codes without returning session state", async () => {
    const gateway = createSupabaseAuthGateway(config);
    if (gateway === undefined) throw new Error("test auth configuration missing");
    methods.verifyOtp.mockResolvedValueOnce({ data: { session: { access_token: "verified-token" } }, error: null });
    methods.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: { message: "expired" } });
    await expect(gateway.verifyOtp("owner@example.test", "123456")).resolves.toBe("verified-token");
    await expect(gateway.verifyOtp("owner@example.test", "654321")).resolves.toBeUndefined();
    expect(methods.verifyOtp).toHaveBeenCalledWith({ email: "owner@example.test", token: "123456", type: "email" });
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("uses server-verified user identity for every explicit token, never cached SDK identity", async () => {
    const gateway = createSupabaseAuthGateway(config);
    if (gateway === undefined) throw new Error("test auth configuration missing");
    methods.getUser.mockResolvedValueOnce({ data: { user: { id: "owner-1", email: "owner@example.test" } }, error: null });
    methods.getUser.mockResolvedValueOnce({ data: { user: null }, error: { message: "invalid token" } });
    await expect(gateway.verifyBearer("verified-token")).resolves.toEqual({ provider: "supabase", subject: "owner-1", email: "owner@example.test" });
    await expect(gateway.verifyBearer("forged-token")).resolves.toBeUndefined();
    expect(methods.getUser).toHaveBeenLastCalledWith("forged-token");
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});
