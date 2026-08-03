import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { CAPYKIT_VERSION } from "../core/index.js";
export function createServer(): McpServer { return new McpServer({ name: "capykit", version: CAPYKIT_VERSION }); }
export async function main(): Promise<void> { await createServer().connect(new StdioServerTransport()); }
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error: unknown) => { process.stderr.write(`capykit-mcp failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });