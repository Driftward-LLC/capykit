import { CAPYKIT_VERSION } from "../core/index.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
export function helpText(): string { return `capykit ${CAPYKIT_VERSION}\n\nUsage: capykit <command>\n\nCommands:\n  help       Show this help\n  version    Print the version\n`; }
export function run(argv: readonly string[]): number {
  const command = argv[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(helpText()); return 0; }
  if (["version", "--version", "-v"].includes(command)) { process.stdout.write(`${CAPYKIT_VERSION}\n`); return 0; }
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`); return 2;
}
function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  try { return realpathSync(entryPath) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isDirectExecution()) process.exitCode = run(process.argv.slice(2));
