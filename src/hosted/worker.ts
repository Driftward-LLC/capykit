import { loadHostedConfig, missingHostedConfig } from "./config.js";
import { checkDatabaseReadiness, createHostedDatabase } from "./db.js";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export async function runHostedWorkerHealthcheck(): Promise<{ readonly status: "ready" | "unavailable"; readonly database: string; readonly missing: readonly string[] }> {
  const config = loadHostedConfig();
  const database = createHostedDatabase(config.databaseUrl);
  const readiness = await checkDatabaseReadiness(database);
  await database?.close();
  const missing = missingHostedConfig(config);
  return { status: missing.length === 0 ? readiness.status : "unavailable", database: readiness.reason, missing };
}

export async function startHostedWorker(): Promise<void> {
  const health = await runHostedWorkerHealthcheck();
  process.stdout.write(`${JSON.stringify({ process: "capykit-hosted-worker", ...health })}\n`);
  if (health.status !== "ready") process.exitCode = 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) void startHostedWorker();
