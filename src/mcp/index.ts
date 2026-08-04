import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPYKIT_VERSION } from "../core/index.js";
export function createServer(): McpServer { return new McpServer({ name: "capykit", version: CAPYKIT_VERSION }); }
export async function main(): Promise<void> { await createServer().connect(new StdioServerTransport()); }
function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  try { return realpathSync(entryPath) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isDirectExecution()) main().catch((error: unknown) => { process.stderr.write(`capykit-mcp failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
