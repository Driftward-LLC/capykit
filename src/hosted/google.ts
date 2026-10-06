import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ConnectionError } from "./connections.js";
import { seal, unseal, pkce } from "./github.js";
import { providerJson } from "./provider-http.js";
import { authorizeWorkspace, requireWorkspaceOwner } from "./workspace-access.js";
import type { AuthenticatedContext } from "./identity.js";

export const driveScope = "https://www.googleapis.com/auth/drive.metadata.readonly";
export interface GoogleConfig { clientId: string; clientSecret: string; encryptionKey: Buffer; keyVersion: string; callbackUrl: string }
export function loadGoogleConfig(env: NodeJS.ProcessEnv, base: string): GoogleConfig | undefined {
  const names = ["CAPYKIT_GOOGLE_CLIENT_ID", "CAPYKIT_GOOGLE_CLIENT_SECRET", "CAPYKIT_GOOGLE_ENCRYPTION_KEY"];
  if (!names.some(name => env[name])) return undefined;
  const key = Buffer.from(env.CAPYKIT_GOOGLE_ENCRYPTION_KEY ?? "", "base64");
  if (!env.CAPYKIT_GOOGLE_CLIENT_ID?.endsWith(".apps.googleusercontent.com") || !env.CAPYKIT_GOOGLE_CLIENT_SECRET || key.length !== 32 || key.toString("base64") !== env.CAPYKIT_GOOGLE_ENCRYPTION_KEY) throw new ConnectionError("CONFIGURATION_UNAVAILABLE", 503);
  return { clientId: env.CAPYKIT_GOOGLE_CLIENT_ID, clientSecret: env.CAPYKIT_GOOGLE_CLIENT_SECRET, encryptionKey: key, keyVersion: "google-v1", callbackUrl: `${base}/v1/connections/google/callback` };
}
const fail = (code: string, status = 400): never => { throw new ConnectionError(code, status); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenString = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\r\n\0]/.test(value) ? value : fail("PROVIDER_RESPONSE_INVALID", 502);
export class GoogleProvider {
  constructor(readonly config: GoogleConfig) {}
  authorizationUrl(state: string, challenge: string): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.callbackUrl, response_type: "code", scope: `openid email ${driveScope}`, state, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent select_account" }).toString();
    return url.href;
  }
  private async token(fields: Record<string, string>): Promise<Record<string, unknown>> {
    return providerJson("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ ...fields, client_id: this.config.clientId, client_secret: this.config.clientSecret }) });
  }
  async exchange(code: string, verifier: string): Promise<{ refreshToken: string; subject: string; email: string }> {
    const data = await this.token({ code, code_verifier: verifier, redirect_uri: this.config.callbackUrl, grant_type: "authorization_code" });
    const access = tokenString(data.access_token);
    {
      if (typeof data.scope !== "string" || !data.scope.split(" ").includes(driveScope) || data.token_type !== "Bearer") fail("PROVIDER_SCOPE_REQUIRED", 403);
      const refreshToken = tokenString(data.refresh_token);
      const user = await providerJson("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${access}` } });
      if (typeof user.sub !== "string" || !/^[0-9]{1,255}$/.test(user.sub) || user.email_verified !== true || typeof user.email !== "string" || user.email.length > 254) fail("PROVIDER_RESPONSE_INVALID", 502);
      return { refreshToken, subject: user.sub as string, email: user.email as string };
    }
  }
  async refresh(refreshToken: string): Promise<string> {
    const data = await this.token({ refresh_token: refreshToken, grant_type: "refresh_token" });
    if (data.token_type !== "Bearer" || (typeof data.scope === "string" && !data.scope.split(" ").includes(driveScope))) fail("PROVIDER_SCOPE_REQUIRED", 403);
    return tokenString(data.access_token);
  }

}
interface GoogleRow {
  workspace_id: string; status: "pending" | "active" | "revoked" | "reconnect_required"; generation: number;
  email: string | null; subject: string | null; principal_id: string; session_hash: string | null;
  state_hash: string | null; verifier: unknown; refresh_token: unknown; expires_at: Date | null; updated_at: Date;
}
export class GoogleConnections {
  constructor(private readonly pool: Pool, private readonly provider?: Pick<GoogleProvider, "authorizationUrl" | "exchange" | "refresh">, private readonly config?: GoogleConfig) {}
  private configured() {
    if (!this.provider || !this.config) return fail("CONFIGURATION_UNAVAILABLE", 503);
    return { provider: this.provider, config: this.config };
  }
  private async owner<T>(context: AuthenticatedContext, run: (client: PoolClient, row: GoogleRow | undefined) => Promise<T> | T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      requireWorkspaceOwner(await authorizeWorkspace(client, context));
      // Serialize setup/disconnect even when the connection row does not exist yet.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`google:${context.membership.workspaceId}`]);
      const row = (await client.query<GoogleRow>("select * from google_connections where workspace_id=$1 for update", [context.membership.workspaceId])).rows[0];
      const result = await run(client, row);
      await client.query("commit"); return result;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
  private aad(row: Pick<GoogleRow, "workspace_id" | "generation">, kind: string): string { return JSON.stringify(["google", row.workspace_id, row.generation, kind]); }
  private async audit(client: PoolClient, context: AuthenticatedContext, action: string): Promise<void> {
    await client.query("insert into app_connection_audit(workspace_id,principal_id,app,action) values($1,$2,'google-drive',$3)", [context.membership.workspaceId, context.membership.principalId, action]);
  }
  async detail(context: AuthenticatedContext) {
    return this.owner(context, (_client, row) => ({ configured: Boolean(this.provider), connection: row ? { status: row.status, email: row.email, updatedAt: row.updated_at.toISOString() } : null }));
  }
  async start(context: AuthenticatedContext, session: string): Promise<{ authorizationUrl: string }> {
    const { provider, config } = this.configured();
    const state = randomBytes(32).toString("base64url"); const { verifier, challenge } = pkce();
    await this.owner(context, async (client, row) => {
      // Never silently replace a live account. Disconnect first, so consent is explicit.
      if (row?.status === "active") fail("CONNECTION_ALREADY_ACTIVE", 409);
      const generation = (row?.generation ?? 0) + 1;
      const encrypted = seal(config, verifier, this.aad({ workspace_id: context.membership.workspaceId, generation }, "verifier"));
      await client.query(`insert into google_connections(workspace_id,generation,principal_id,session_hash,state_hash,verifier,expires_at)
        values($1,$2,$3,$4,$5,$6,now()+interval '10 minutes') on conflict(workspace_id) do update set status='pending',generation=$2,principal_id=$3,session_hash=$4,state_hash=$5,verifier=$6,refresh_token=null,expires_at=now()+interval '10 minutes',updated_at=now()`, [context.membership.workspaceId,generation,context.membership.principalId,hash(session),hash(state),encrypted]);
      await this.audit(client, context, "setup_started");
    });
    return { authorizationUrl: provider.authorizationUrl(state, challenge) };
  }
  async callback(context: AuthenticatedContext, session: string, body: { state: string; code: string }): Promise<void> {
    const { provider, config } = this.configured();
    const setup = await this.owner(context, async (client, row) => {
      if (!row || row.status !== "pending" || row.state_hash !== hash(body.state) || row.session_hash !== hash(session) || row.principal_id !== context.membership.principalId || !row.expires_at || row.expires_at.getTime() <= Date.now()) return fail("CONNECT_STATE_INVALID");
      const verifier = unseal<string>(config, row.verifier, this.aad(row, "verifier"));
      await client.query("update google_connections set state_hash=null,verifier=null where workspace_id=$1", [row.workspace_id]);
      return { row, verifier };
    });
    try {
      const verified = await provider.exchange(body.code, setup.verifier);
      await this.owner(context, async (client, row) => {
        if (!row || row.generation !== setup.row.generation || row.status !== "pending" || !row.expires_at || row.expires_at.getTime() <= Date.now()) return fail("CONNECT_STATE_INVALID");
        await client.query("update google_connections set status='active',email=$2,subject=$3,refresh_token=$4,session_hash=null,expires_at=null,updated_at=now() where workspace_id=$1", [row.workspace_id,verified.email,verified.subject,seal(config, verified.refreshToken, this.aad(row,"refresh"))]);
        await this.audit(client,context,"connected");
      });
    } catch (error) {
      // Google revocation affects every token for this user/project. Never revoke
      // a superseded token: a newer setup or another workspace may be using it.
      await this.owner(context, async (client, row) => {
        if (row?.generation === setup.row.generation && row.status === "pending") await client.query("update google_connections set status='reconnect_required',state_hash=null,verifier=null,session_hash=null,expires_at=null where workspace_id=$1", [row.workspace_id]);
      }).catch(() => {});
      throw error;
    }
  }
  async disconnect(context: AuthenticatedContext): Promise<void> {
    await this.owner(context, async (client, row) => {
      if (!row) return;
      await client.query("update google_connections set status='revoked',generation=generation+1,refresh_token=null,verifier=null,state_hash=null,session_hash=null,expires_at=null,email=null,subject=null,updated_at=now() where workspace_id=$1", [row.workspace_id]);
      await this.audit(client,context,"disconnected");
    });
    // Disconnect is local to this workspace. The console separately links to
    // Google's account settings for explicit project-wide revocation.
  }

  async withToken<T>(context: AuthenticatedContext, run: (token: string, check: () => Promise<void>) => Promise<T>, authorize?: () => Promise<void>): Promise<T> {
    // An explicit action authorization may permit a member/agent read. Management remains owner-only.
    const read = async <R>(fn: (row: GoogleRow | undefined) => R): Promise<R> => {
      if (!authorize) return this.owner(context, (_client, row) => fn(row));
      await authorize();
      const client = await this.pool.connect();
      try {
        await client.query("begin"); await authorizeWorkspace(client, context);
        const row = (await client.query<GoogleRow>("select * from google_connections where workspace_id=$1", [context.membership.workspaceId])).rows[0];
        const value = fn(row); await client.query("commit"); return value;
      } catch(error) { await client.query("rollback"); throw error; } finally { client.release(); }
    };
    const { provider, config } = this.configured();
    const initial = await read(row => {
      if (!row || row.status !== "active" || !row.refresh_token) return fail("CONNECTION_INACTIVE",403);
      return row;
    });
    const check = async () => { await read(row => {
      if (row?.status !== "active" || row.generation !== initial.generation) fail("CONNECTION_INACTIVE",403);
    }); };
    let token: string;
    try { token = await provider.refresh(unseal<string>(config,initial.refresh_token,this.aad(initial,"refresh"))); }
    catch(error) {
      if (error instanceof ConnectionError && error.code === "PROVIDER_AUTHORIZATION_EXPIRED" && context.membership.principalKind === "human" && context.membership.role === "owner") {
        await this.owner(context, async (client,row) => {
          if (row?.generation === initial.generation && row.status === "active") await client.query("update google_connections set status='reconnect_required',generation=generation+1,refresh_token=null,updated_at=now() where workspace_id=$1", [row.workspace_id]);
        });
      }
      throw error;
    }
    await check();
    const result = await run(token,check); await check(); return result;
  }
}
