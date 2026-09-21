import { createHostedApi } from "./http.js";
import { loadHostedConfig } from "./config.js";
import { PgIdentityStore } from "./identity.js";

const config = loadHostedConfig();
if (config.databaseUrl === undefined) throw new Error("DATABASE_URL is required for the hosted API process");
const store = new PgIdentityStore(config.databaseUrl);
const app = await createHostedApi({ config, identityStore: store });
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
try { await app.listen({ host: "0.0.0.0", port }); } finally { await store.close(); }
