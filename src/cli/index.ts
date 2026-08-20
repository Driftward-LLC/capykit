import { CAPYKIT_VERSION, doctorRegistryFile } from "../core/index.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function helpText(): string {
  return `capykit ${CAPYKIT_VERSION}\n\nUsage: capykit <command>\n\nCommands:\n  help                    Show this help\n  version                 Print the version\n  doctor <registry.json>  Validate a registry and print capykit.registryDoctor.v0.1 JSON\n`;
}

function doctorUsage(): string {
  return "Usage: capykit doctor <registry.json> [--allow-command <name>] [--path <path>]\n";
}

interface ParsedDoctorArgs {
  readonly registryPath: string | undefined;
  readonly approvedCommands: string[];
  readonly path: string | undefined;
  readonly error: string | undefined;
}

function parseDoctorArgs(argv: readonly string[]): ParsedDoctorArgs {
  const approvedCommands: string[] = [];
  let registryPath: string | undefined;
  let path: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-command") {
      const command = argv[index + 1];
      if (command === undefined) return { approvedCommands, path, registryPath, error: "Missing value for --allow-command." };
      approvedCommands.push(command);
      index += 1;
      continue;
    }
    if (argument === "--path") {
      path = argv[index + 1];
      if (path === undefined) return { approvedCommands, path, registryPath, error: "Missing value for --path." };
      index += 1;
      continue;
    }
    if (argument === undefined) return { approvedCommands, path, registryPath, error: "Missing doctor argument." };
    if (argument.startsWith("--")) return { approvedCommands, path, registryPath, error: `Unknown doctor option: ${argument}` };
    if (registryPath !== undefined) return { approvedCommands, path, registryPath, error: `Unexpected doctor argument: ${argument}` };
    registryPath = argument;
  }
  return { approvedCommands, path, registryPath, error: undefined };
}

export function run(argv: readonly string[]): number {
  const command = argv[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(helpText()); return 0; }
  if (["version", "--version", "-v"].includes(command)) { process.stdout.write(`${CAPYKIT_VERSION}\n`); return 0; }
  if (command === "doctor") {
    const parsed = parseDoctorArgs(argv.slice(1));
    if (parsed.registryPath === undefined || parsed.error !== undefined) {
      process.stderr.write(`${parsed.error ?? "Missing registry path."}\n\n${doctorUsage()}`);
      return 2;
    }
    return 0;
  }
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`); return 2;
}

export async function runAsync(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "help";
  if (command !== "doctor") return run(argv);
  const parsed = parseDoctorArgs(argv.slice(1));
  if (parsed.registryPath === undefined || parsed.error !== undefined) {
    process.stderr.write(`${parsed.error ?? "Missing registry path."}\n\n${doctorUsage()}`);
    return 2;
  }
  const options = parsed.path === undefined ? { approvedCommands: parsed.approvedCommands } : { approvedCommands: parsed.approvedCommands, path: parsed.path };
  const report = await doctorRegistryFile(parsed.registryPath, options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  try { return realpathSync(entryPath) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isDirectExecution()) runAsync(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; }, (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
