import { CAPYKIT_VERSION, REGISTRY_LAYERS, loadRegistryCatalog, RegistryLoadError, type RegistryLayer, type RegistrySource, type RegistryTool, type ResolvedRegistryTool } from "../core/index.js";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_SUCCESS = 0;
export const EXIT_OPERATIONAL_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;

interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly registries: readonly string[];
  readonly fields: readonly string[];
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
}

interface SearchOptions {
  readonly query: string;
  readonly fields: readonly string[];
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
}

type OutputTool = ResolvedRegistryTool;

const fieldAliases = new Map<string, string>([
  ["owner", "owners.id"],
  ["owners", "owners.id"],
  ["interface", "interfaces.type"],
  ["interfaces", "interfaces.type"],
  ["visibility", "scope.visibility"],
  ["audience", "scope.audiences"],
  ["platform", "scope.platforms"],
  ["risk", "safety.risk"],
  ["approval", "safety.approval"],
  ["status", "lifecycle.status"],
]);

export function helpText(): string {
  return `capykit ${CAPYKIT_VERSION}\n\nUsage: capykit <command> [options]\n\nCommands:\n  list                  List discovered tools\n  search <query>        Search tools by id, name, summary, fields, tags, or capabilities\n  show <tool-id>        Show one tool\n  examples <tool-id>    Show examples for one tool\n  help                  Show this help\n  version               Print the version\n\nRead options:\n  --registry <path>     Absolute path to a registry JSON document (repeatable)\n  --json                Emit deterministic JSON\n\nSearch filters:\n  --field <path=value>  Match a dotted field path; ':' may replace '='\n  --tag <tag>           Match a derived tag such as interface:cli or platform:linux\n  --capability <query>  Match interface capability name, summary, or usage\n\nExit codes:\n  0 success\n  1 operational failure while reading registries\n  2 usage or validation error\n  3 requested command completed but found no matching tool\n`;
}

function normalize(value: unknown): string {
  return String(value).trim().toLocaleLowerCase("en-US");
}

function usage(message: string): never {
  throw Object.assign(new Error(message), { exitCode: EXIT_USAGE });
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [first, ...rest] = argv;
  const command = first ?? "help";
  const positionals: string[] = [];
  const registries: string[] = [];
  const fields: string[] = [];
  const tags: string[] = [];
  const capabilities: string[] = [];
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) continue;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--registry") {
      const value = rest[index + 1];
      if (value === undefined) usage("--registry requires an absolute path.");
      registries.push(value);
      index += 1;
      continue;
    }
    if (arg === "--field") {
      const value = rest[index + 1];
      if (value === undefined) usage("--field requires a dotted path filter.");
      fields.push(value);
      index += 1;
      continue;
    }
    if (arg === "--tag") {
      const value = rest[index + 1];
      if (value === undefined) usage("--tag requires a tag value.");
      tags.push(value);
      index += 1;
      continue;
    }
    if (arg === "--capability") {
      const value = rest[index + 1];
      if (value === undefined) usage("--capability requires a query value.");
      capabilities.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--registry=")) { registries.push(arg.slice("--registry=".length)); continue; }
    if (arg.startsWith("--field=")) { fields.push(arg.slice("--field=".length)); continue; }
    if (arg.startsWith("--tag=")) { tags.push(arg.slice("--tag=".length)); continue; }
    if (arg.startsWith("--capability=")) { capabilities.push(arg.slice("--capability=".length)); continue; }
    if (arg.startsWith("-")) usage(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  return { command, positionals, json, registries, fields, tags, capabilities };
}

function isRegistryLayer(value: string): value is RegistryLayer {
  return (REGISTRY_LAYERS as readonly string[]).includes(value);
}

function stableSourceId(layer: RegistryLayer, absolutePath: string): string {
  const digest = createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
  return `cli-${layer}-${digest}`;
}

function parseRegistrySpec(registry: string): { readonly id?: string; readonly layer: RegistryLayer; readonly path: string } {
  const match = /^(?:(?<id>[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)@)?(?<layer>builtin|organization|host|user)=(?<path>.+)$/u.exec(registry);
  if (match?.groups !== undefined) {
    const { id, layer, path } = match.groups;
    if (layer === undefined || path === undefined || !isRegistryLayer(layer)) usage(`Unsupported registry layer in --registry source: ${registry}`);
    return id === undefined ? { layer, path } : { id, layer, path };
  }
  return { layer: "user", path: registry };
}

function registrySources(registries: readonly string[]): RegistrySource[] {
  return registries.map((registry) => {
    const parsed = parseRegistrySpec(registry);
    if (!isAbsolute(parsed.path)) usage(`Registry paths must be absolute for cwd-independent operation: ${parsed.path}`);
    const absolutePath = resolve(parsed.path);
    return {
      id: parsed.id ?? stableSourceId(parsed.layer, absolutePath),
      layer: parsed.layer,
      type: "file",
      root: dirname(absolutePath),
      path: absolutePath.split(/[\\/]/u).at(-1) ?? "registry.json",
    } satisfies RegistrySource;
  });
}

function validateCommand(parsed: ParsedArgs): void {
  const searchOnlyFilters = parsed.fields.length > 0 || parsed.tags.length > 0 || parsed.capabilities.length > 0;
  if (searchOnlyFilters && parsed.command !== "search") usage("--field, --tag, and --capability are only valid with the search command.");
  if (parsed.command === "list" && parsed.positionals.length > 0) usage("list does not accept positional arguments.");
  if (parsed.command === "show" && parsed.positionals.length !== 1) usage("show requires exactly one tool id.");
  if (parsed.command === "examples" && parsed.positionals.length !== 1) usage("examples requires exactly one tool id.");
}

async function loadTools(parsed: ParsedArgs): Promise<readonly OutputTool[]> {
  const catalog = await loadRegistryCatalog(registrySources(parsed.registries), { now: () => new Date("1970-01-01T00:00:00Z") });
  return catalog.tools;
}

function readPath(value: unknown, path: string): readonly unknown[] {
  const [head, ...tail] = path.split(".");
  if (head === undefined || head.length === 0) return [];
  const values = Array.isArray(value) ? value : [value];
  const next = values.flatMap((entry): unknown[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const child = (entry as Record<string, unknown>)[head];
    return Array.isArray(child) ? child : child === undefined ? [] : [child];
  });
  return tail.length === 0 ? next : readPath(next, tail.join("."));
}

function parseFieldFilter(filter: string): { readonly path: string; readonly expected: string } {
  const separatorIndex = filter.search(/[=:]/u);
  if (separatorIndex < 1) usage(`--field filters must use path=value or path:value: ${filter}`);
  const rawPath = filter.slice(0, separatorIndex);
  const expected = filter.slice(separatorIndex + 1);
  if (expected.length === 0) usage(`--field filters require a non-empty value: ${filter}`);
  return { path: fieldAliases.get(rawPath) ?? rawPath, expected };
}

function capabilityObjects(tool: RegistryTool): readonly Record<string, unknown>[] {
  const interfaces = Array.isArray(tool.interfaces) ? tool.interfaces : [];
  return interfaces.flatMap((iface): Record<string, unknown>[] => {
    if (typeof iface !== "object" || iface === null || Array.isArray(iface)) return [];
    const capabilities = (iface as Record<string, unknown>).capabilities;
    if (!Array.isArray(capabilities)) return [];
    return capabilities.filter((capability): capability is Record<string, unknown> => typeof capability === "object" && capability !== null && !Array.isArray(capability));
  });
}

function toolTags(tool: RegistryTool): readonly string[] {
  const tags = new Set<string>();
  for (const path of ["interfaces.type", "scope.visibility", "scope.audiences", "scope.platforms", "authentication.mode", "safety.risk", "safety.approval", "lifecycle.status"]) {
    for (const value of readPath(tool, path)) tags.add(`${path}:${String(value)}`);
  }
  for (const value of readPath(tool, "interfaces.type")) tags.add(`interface:${String(value)}`);
  for (const value of readPath(tool, "scope.platforms")) tags.add(`platform:${String(value)}`);
  for (const value of readPath(tool, "scope.audiences")) tags.add(`audience:${String(value)}`);
  for (const value of readPath(tool, "lifecycle.status")) tags.add(`status:${String(value)}`);
  for (const owner of readPath(tool, "owners.id")) tags.add(`owner:${String(owner)}`);
  for (const capability of capabilityObjects(tool)) tags.add(`capability:${String(capability.name)}`);
  return [...tags].map(normalize).sort((left, right) => left.localeCompare(right, "en-US"));
}

function matchesQuery(tool: RegistryTool, query: string): boolean {
  const normalized = normalize(query);
  if (normalized.length === 0) return true;
  const haystack = [tool.id, tool.name, tool.summary, ...readPath(tool, "owners.name"), ...readPath(tool, "interfaces.id"), ...readPath(tool, "interfaces.type")];
  return haystack.some((value) => normalize(value).includes(normalized));
}

function matchesField(tool: RegistryTool, filter: string): boolean {
  const { path, expected } = parseFieldFilter(filter);
  const normalizedExpected = normalize(expected);
  return readPath(tool, path).some((value) => normalize(value).includes(normalizedExpected));
}

function matchesCapability(tool: RegistryTool, query: string): boolean {
  const normalized = normalize(query);
  return capabilityObjects(tool).some((capability) => [capability.name, capability.summary, capability.usage].some((value) => value !== undefined && normalize(value).includes(normalized)));
}

function searchTools(tools: readonly OutputTool[], options: SearchOptions): readonly OutputTool[] {
  return tools.filter((tool) => matchesQuery(tool.record, options.query))
    .filter((tool) => options.fields.every((field) => matchesField(tool.record, field)))
    .filter((tool) => {
      const tags = toolTags(tool.record);
      return options.tags.every((tag) => tags.includes(normalize(tag)) || tags.some((candidate) => candidate.endsWith(`:${normalize(tag)}`)));
    })
    .filter((tool) => options.capabilities.every((capability) => matchesCapability(tool.record, capability)))
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

function summary(tool: OutputTool): Record<string, unknown> {
  return {
    id: tool.id,
    name: tool.record.name,
    summary: tool.record.summary,
    tags: toolTags(tool.record),
    source: tool.provenance.sourceId,
  };
}

function examples(tool: OutputTool): readonly unknown[] {
  return Array.isArray(tool.record.examples) ? tool.record.examples : [];
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeList(tools: readonly OutputTool[], json: boolean): void {
  if (json) { writeJson(tools.map(summary)); return; }
  for (const tool of tools) process.stdout.write(`${tool.id}\t${String(tool.record.name)}\t${String(tool.record.summary)}\n`);
}

function formatScalarList(values: readonly unknown[]): string {
  return values.map((value) => String(value)).sort((left, right) => left.localeCompare(right, "en-US")).join(", ");
}

function formatRecord(value: unknown): string {
  return JSON.stringify(value, null, 2).replaceAll("\n", "\n    ");
}

function writeTool(tool: OutputTool, json: boolean): void {
  if (json) { writeJson(tool); return; }
  const record = tool.record;
  const lines: string[] = [
    tool.id,
    `  name: ${String(record.name)}`,
    `  summary: ${String(record.summary)}`,
    `  owners: ${formatScalarList(readPath(record, "owners.name"))}`,
    `  scope: ${formatRecord(record.scope)}`,
    `  authentication: ${formatRecord(record.authentication)}`,
    `  safety: ${formatRecord(record.safety)}`,
    `  lifecycle: ${formatRecord(record.lifecycle)}`,
    "  interfaces:",
  ];
  const interfaces = Array.isArray(record.interfaces) ? record.interfaces : [];
  for (const iface of interfaces) lines.push(`    - ${formatRecord(iface)}`);
  lines.push("  documentation:");
  const documents = Array.isArray(record.documentation) ? record.documentation : [];
  for (const document of documents) lines.push(`    - ${formatRecord(document)}`);
  lines.push("  provenance:");
  lines.push(`    sourceId: ${tool.provenance.sourceId}`);
  lines.push(`    layer: ${tool.provenance.layer}`);
  lines.push(`    registryId: ${tool.provenance.registryId}`);
  lines.push(`    sourceUri: ${tool.provenance.sourceUri}`);
  lines.push(`    revision: ${tool.provenance.revision}`);
  lines.push(`    sha256: ${tool.provenance.sha256}`);
  lines.push(`  overridden: ${tool.overridden.map((source) => source.sourceId).join(", ")}`);
  lines.push(`  tags: ${toolTags(record).join(", ")}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function writeExamples(tool: OutputTool, json: boolean): void {
  const toolExamples = examples(tool);
  if (json) { writeJson({ toolId: tool.id, examples: toolExamples }); return; }
  if (toolExamples.length === 0) return;
  for (const example of toolExamples) {
    const record = example as Record<string, unknown>;
    process.stdout.write(`${String(record.title)}\n  interface: ${String(record.interfaceId)}\n  usage: ${String(record.usage)}\n`);
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (["help", "--help", "-h"].includes(parsed.command)) { process.stdout.write(helpText()); return EXIT_SUCCESS; }
  if (["version", "--version", "-v"].includes(parsed.command)) { process.stdout.write(`${CAPYKIT_VERSION}\n`); return EXIT_SUCCESS; }
  if (!["list", "search", "show", "examples"].includes(parsed.command)) usage(`Unknown command: ${parsed.command}`);
  validateCommand(parsed);

  const tools = await loadTools(parsed);
  if (parsed.command === "list") {
    writeList(tools, parsed.json);
    return EXIT_SUCCESS;
  }

  if (parsed.command === "search") {
    const query = parsed.positionals.join(" ");
    const matches = searchTools(tools, { query, fields: parsed.fields, tags: parsed.tags, capabilities: parsed.capabilities });
    writeList(matches, parsed.json);
    return matches.length === 0 ? EXIT_NOT_FOUND : EXIT_SUCCESS;
  }

  const toolId = parsed.positionals[0];
  if (toolId === undefined) usage(`${parsed.command} requires a tool id.`);
  const tool = tools.find((candidate) => candidate.id === toolId);
  if (tool === undefined) {
    if (parsed.json) writeJson({ error: "not_found", toolId });
    else process.stderr.write(`No tool found for id: ${toolId}\n`);
    return EXIT_NOT_FOUND;
  }
  if (parsed.command === "show") writeTool(tool, parsed.json);
  else writeExamples(tool, parsed.json);
  return EXIT_SUCCESS;
}

async function main(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await run(argv);
  } catch (error: unknown) {
    const exitCode = error instanceof RegistryLoadError ? EXIT_OPERATIONAL_FAILURE : typeof error === "object" && error !== null && "exitCode" in error ? Number(error.exitCode) : EXIT_OPERATIONAL_FAILURE;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = Number.isInteger(exitCode) ? exitCode : EXIT_OPERATIONAL_FAILURE;
  }
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  try { return realpathSync(entryPath) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isDirectExecution()) void main(process.argv.slice(2));
