import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, type Node } from "acorn";
import { rejectCredentials } from "../core/registry.js";

export type CapabilityKind = "skill" | "function";
export interface ArtifactFile {
  readonly path: string;
  readonly contentBase64: string;
  readonly executable: boolean;
  readonly type: "file";
  readonly byteLength: number;
  readonly sha256: string;
}
export interface ValidatedArtifact {
  readonly kind: CapabilityKind;
  readonly digest: string;
  readonly byteCount: number;
  readonly fileCount: number;
  readonly contract: object | null;
  readonly files: readonly ArtifactFile[];
}
export class ArtifactError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export const GITHUB_ISSUES_CONTRACT_ID = "github.issues.list.v1";
const repositoryIdSchema = { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 20 };
const urlSchema = { type: "string", format: "uri" };
export const githubIssuesListContract = {
  id: GITHUB_ISSUES_CONTRACT_ID,
  entrypoint: "index.mjs",
  handler: "handler",
  runtime: "node22-esm",
  facade: { github: ["listIssues"] },
  input: {
    type: "object", additionalProperties: false, required: ["repositoryId"],
    properties: {
      repositoryId: repositoryIdSchema,
      state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
      page: { type: "integer", minimum: 1, maximum: 100, default: 1 },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
  },
  output: {
    type: "object", additionalProperties: false, required: ["repository", "issues", "nextPage"],
    properties: {
      repository: {
        type: "object", additionalProperties: false, required: ["id", "fullName", "url"],
        properties: { id: repositoryIdSchema, fullName: { type: "string" }, url: urlSchema },
      },
      issues: {
        type: "array", maxItems: 50,
        items: {
          type: "object", additionalProperties: false,
          required: ["id", "number", "title", "state", "url", "labels", "author", "updatedAt"],
          properties: {
            id: repositoryIdSchema, number: { type: "integer", minimum: 1 }, title: { type: "string" },
            state: { type: "string", enum: ["open", "closed"] }, url: urlSchema,
            labels: { type: "array", items: { type: "string" } },
            author: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["login", "url"], properties: { login: { type: "string" }, url: urlSchema } }] },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
      },
      nextPage: { anyOf: [{ type: "integer", minimum: 2, maximum: 100 }, { type: "null" }] },
    },
  },
  pagination: {
    providerPagesPerRun: 1,
    perPageInput: "limit",
    continuation: "Compute continuation from the provider page before removing pull-request records. Short or empty issue pages can have a next page. At page 100, nextPage is null.",
  },
} as const;
// Keep the reviewed representation private: mutation of an exported object cannot change publication integrity.
const contractJson = JSON.stringify(githubIssuesListContract);

export interface IssuesInput { repositoryId: string; state: "open" | "closed" | "all"; page: number; limit: number }
export function parseIssuesInput(value: unknown): IssuesInput {
  const invalid = () => new ArtifactError("INVALID_REQUEST", 400, "Input does not match github.issues.list.v1.");
  if (!record(value) || Object.keys(value).some((key) => !["repositoryId", "state", "page", "limit"].includes(key))) throw invalid();
  const { repositoryId, state = "open", page = 1, limit = 20 } = value;
  if (typeof repositoryId !== "string" || repositoryId.length > 20 || !/^[1-9][0-9]*$/u.test(repositoryId)
    || (state !== "open" && state !== "closed" && state !== "all")
    || typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 100
    || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
  return { repositoryId, state, page, limit };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function invalid(message: string): never { throw new ArtifactError("ARTIFACT_INVALID", 400, message); }
function limit(): never { throw new ArtifactError("ARTIFACT_LIMIT_EXCEEDED", 413, "Artifact exceeds its file, byte, or path limit."); }
function utf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return invalid("Required text files must contain valid UTF-8."); }
}
function checkPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.includes(":") || path !== path.normalize("NFC") || Buffer.from(path).toString("utf8") !== path
    || path.split("/").some((part) => !part || part === "." || part === ".." || /[<>"|?*]/u.test(part) || Array.from(part).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) invalid("Artifact paths must be portable, relative file paths.");
  if (path.length > 1024 || path.split("/").length > 33) limit();
  if (path.split("/").some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git|\.ssh|\.aws|\.kube|node_modules|credentials?\.json|cookies?\.json|secrets?\.json|tokens?\.json|service[-_]account\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.+\.(?:pem|key))$/iu.test(part))) invalid("Artifacts must not contain credential files or dependency directories.");
}
function checkCredentials(bytes: Buffer): void {
  const text = bytes.toString("utf8");
  try { rejectCredentials(text, "hosted-artifact"); }
  catch { invalid("Artifact contains credential-like material; contents redacted."); }
  if (/(?:api[_-]?key|access[_-]?token|client[_-]?secret|refresh[_-]?token|password|passwd)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_/-]{20,}/iu.test(text)) invalid("Artifact contains a credential-like assignment; contents redacted.");
}

function validateSkillMetadata(bytes: Buffer): void {
  const frontmatter = utf8(bytes).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  const lines = frontmatter?.split(/\r?\n/u) ?? [];
  const descriptionIndex = lines.findIndex((line) => /^description:/u.test(line));
  let description = lines[descriptionIndex]?.replace(/^description:[ \t]*/u, "").trim() ?? "";
  if (/^[>|][-+]?$/u.test(description)) {
    const block: string[] = [];
    for (const line of lines.slice(descriptionIndex + 1)) {
      if (line && !/^[ \t]/u.test(line)) break;
      block.push(line);
    }
    description = block.join("\n").trim();
  } else if (/^["']/u.test(description)) {
    if (description.at(-1) !== description[0]) invalid("SKILL.md contains invalid description metadata.");
    description = description.slice(1, -1).trim();
  } else if (description.startsWith("#")) description = "";
  if (!frontmatter?.match(/^name:[ \t]*(["']?)[a-z0-9-]+\1[ \t]*$/mu) || !description) invalid("SKILL.md requires frontmatter with a lowercase skill name and nonempty description.");
}

function validateFunction(bytes: Buffer): void {
  let program;
  try { program = parse(utf8(bytes), { ecmaVersion: 2022, sourceType: "module" }); }
  catch { return invalid("Function must be valid UTF-8 ESM source exporting an async handler."); }
  const asyncBindings = new Set<string>();
  const handlerBindings = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" || statement.type === "ExportAllDeclaration" || (statement.type === "ExportNamedDeclaration" && statement.source)) invalid("Pilot functions cannot import dependencies or re-export modules.");
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.async && !declaration.generator) asyncBindings.add(declaration.id.name);
    if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
      for (const binding of declaration.declarations) {
        if (binding.id.type === "Identifier" && (binding.init?.type === "ArrowFunctionExpression" || binding.init?.type === "FunctionExpression") && binding.init.async && !binding.init.generator) asyncBindings.add(binding.id.name);
      }
    }
    if (statement.type === "ExportNamedDeclaration") {
      if (declaration?.type === "FunctionDeclaration" && declaration.id.name === "handler") handlerBindings.add("handler");
      if (declaration?.type === "VariableDeclaration" && declaration.declarations.some((entry) => entry.id.type === "Identifier" && entry.id.name === "handler")) handlerBindings.add("handler");
      for (const specifier of statement.specifiers) {
        if ((specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value) === "handler" && specifier.local.type === "Identifier") handlerBindings.add(specifier.local.name);
      }
    }
  }
  // Inspect syntax only. Never import/evaluate source, including its top-level statements.
  const pending: Node[] = [program];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (node.type === "ImportExpression") invalid("Pilot functions cannot import dependencies.");
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) { if (record(item) && typeof item.type === "string") pending.push(item as unknown as Node); }
      else if (record(value) && typeof value.type === "string") pending.push(value as unknown as Node);
    }
  }
  if (![...handlerBindings].some((name) => asyncBindings.has(name))) invalid("Function must export an async handler declaration or constant.");
}

export function validateArtifact(kind: CapabilityKind, input: unknown): ValidatedArtifact {
  if (!["skill", "function"].includes(kind)) invalid("Unknown capability kind.");
  if (!record(input) || !exactKeys(input, ["files"]) || !Array.isArray(input.files) || input.files.length === 0) invalid("An artifact must contain a regular-file manifest.");
  if (input.files.length > 512) limit();
  if (kind === "function" && (input.files.length !== 1 || !record(input.files[0]) || input.files[0].path !== "index.mjs")) invalid("A pilot function contains only index.mjs.");
  const paths = new Map<string, string>();
  const filePaths = new Set<string>();
  const files: ArtifactFile[] = [];
  let byteCount = 0;
  const hash = createHash("sha256");
  // Preserve profile ordering, with a deterministic tie-break for distinct
  // Unicode paths that the locale collator considers equivalent.
  for (const file of [...input.files as unknown[]].sort((a, b) => {
    const left = String(record(a) ? a.path : ""), right = String(record(b) ? b.path : "");
    return left.localeCompare(right, "en-US") || (left < right ? -1 : left > right ? 1 : 0);
  })) {
    if (!record(file) || !exactKeys(file, ["path", "contentBase64", "executable", "type"]) || file.type !== "file" || typeof file.executable !== "boolean" || typeof file.contentBase64 !== "string") invalid("Artifact entries must declare only a path, base64 bytes, executable flag, and regular-file type.");
    checkPath(file.path);
    const parts = file.path.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const path = parts.slice(0, count).join("/");
      const folded = path.toLowerCase();
      if ((paths.has(folded) && paths.get(folded) !== path) || filePaths.has(folded) || (count === parts.length && paths.has(folded))) invalid("Artifact file paths conflict.");
      paths.set(folded, path);
    }
    filePaths.add(file.path.toLowerCase());
    const encoded = file.contentBase64;
    const maxFileBytes = (kind === "function" ? 1 : 8) * 1024 * 1024;
    if (encoded.length > Math.ceil(maxFileBytes / 3) * 4) limit();
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(encoded)) invalid("Artifact bytes must use canonical base64.");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) invalid("Artifact bytes must use canonical base64.");
    byteCount += bytes.length;
    if (bytes.length > maxFileBytes || byteCount > 32 * 1024 * 1024) limit();
    checkCredentials(bytes);
    if (kind === "function") validateFunction(bytes);
    if (kind === "skill" && file.path === "SKILL.md") validateSkillMetadata(bytes);
    hash.update(JSON.stringify([file.path, bytes.length, file.executable])).update(bytes);
    files.push({ path: file.path, contentBase64: encoded, executable: file.executable, type: "file", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (kind === "skill" && !files.some((file) => file.path === "SKILL.md")) invalid("Skill artifacts require a root SKILL.md.");
  if (kind === "function") hash.update(JSON.stringify(["contract", Buffer.byteLength(contractJson)])).update(contractJson);
  return { kind, digest: hash.digest("hex"), byteCount, fileCount: files.length, contract: kind === "function" ? JSON.parse(contractJson) as object : null, files };
}

export function artifactSummary(artifact: ValidatedArtifact) {
  return { ...artifact, files: artifact.files.map(({ path, executable, type, byteLength, sha256 }) => ({ path, executable, type, byteLength, sha256 })) };
}

export function verifyArtifact(stored: unknown): ValidatedArtifact {
  try {
    if (!record(stored) || !exactKeys(stored, ["kind", "digest", "byteCount", "fileCount", "contract", "files"]) || (stored.kind !== "skill" && stored.kind !== "function") || !Array.isArray(stored.files)) throw new Error();
    const upload = { files: stored.files.map((file: unknown) => {
      if (!record(file) || !exactKeys(file, ["path", "contentBase64", "executable", "type", "byteLength", "sha256"])) throw new Error();
      return { path: file.path, contentBase64: file.contentBase64, executable: file.executable, type: file.type };
    }) };
    const actual = validateArtifact(stored.kind, upload);
    if (!isDeepStrictEqual(actual, stored)) throw new Error();
    return actual;
  } catch { throw new ArtifactError("ARTIFACT_CORRUPT", 500, "Stored artifact failed its integrity check."); }
}
