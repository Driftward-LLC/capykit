import { readFile } from "node:fs/promises";
import { Pool } from "pg";
const [email, workspaceName = "Pilot workspace"] = process.argv.slice(2);
if (!email) { process.stderr.write("Usage: node scripts/bootstrap-owner.mjs owner@example.com [workspace name]\n"); process.exit(2); }
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try { const sql = await readFile(new URL("../src/app/migrations/001_workspace_identity.sql", import.meta.url), "utf8"); await pool.query(sql); await pool.query("select bootstrap_owner($1, $2)", [email, workspaceName]); console.log(`Bootstrapped owner ${email} for ${workspaceName}`); } finally { await pool.end(); }
