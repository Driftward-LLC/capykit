#!/usr/bin/env node
// Operator-only, bounded maintenance. Uses the same restricted runtime database
// login and optional GitHub secrets as the API, never a schema-owner login.
import { Pool } from "pg";
import { ConnectionStore, GithubProvider, loadGithubConfig } from "../dist/hosted-api.js";

const limit = Number(process.argv[2] ?? 50);
if (!process.env.DATABASE_URL || !Number.isInteger(limit) || limit < 1 || limit > 100) {
  console.error("Supply DATABASE_URL and an optional batch size from 1 to 100.");
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    const config = loadGithubConfig();
    const provider = config ? new GithubProvider(config) : undefined;
    console.log(JSON.stringify(await new ConnectionStore(pool, provider, config).cleanup(limit)));
  } catch {
    console.error("Connection cleanup failed. Check configuration and database availability.");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
