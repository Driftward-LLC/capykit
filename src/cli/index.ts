import { CAPYKIT_VERSION } from "../core/index.js";
import { pathToFileURL } from "node:url";
export function helpText(): string { return `capykit ${CAPYKIT_VERSION}\n\nUsage: capykit <command>\n\nCommands:\n  help       Show this help\n  version    Print the version\n`; }
export function run(argv: readonly string[]): number {
  const command = argv[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(helpText()); return 0; }
  if (["version", "--version", "-v"].includes(command)) { process.stdout.write(`${CAPYKIT_VERSION}\n`); return 0; }
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`); return 2;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = run(process.argv.slice(2));