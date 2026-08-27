import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;
const exampleRegistry = resolve(repositoryRoot, "examples/all-interfaces.registry.json");

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { cwd: repositoryRoot, stdio: "inherit", shell: process.platform === "win32", ...options });
}

function output(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", shell: process.platform === "win32", ...options });
}

function changedFiles() {
  const explicitBase = process.env.FACTORY_VERIFY_BASE_REF;
  const githubBase = process.env.GITHUB_BASE_REF === undefined ? undefined : `origin/${process.env.GITHUB_BASE_REF}`;
  const base = explicitBase ?? githubBase;
  if (base !== undefined && base.length > 0) {
    try {
      return output("git", ["diff", "--name-only", `${base}...HEAD`]).trim().split(/\r?\n/u).filter(Boolean);
    } catch {
      return output("git", ["diff", "--name-only", "HEAD~1...HEAD"]).trim().split(/\r?\n/u).filter(Boolean);
    }
  }
  try {
    return output("git", ["diff", "--name-only", "origin/main...HEAD"]).trim().split(/\r?\n/u).filter(Boolean);
  } catch {
    return [];
  }
}

function checkChangedFileScope() {
  const files = changedFiles();
  if (files.length === 0) {
    console.log("Changed-file scope: no comparison base available; skipped.");
    return;
  }

  const allowedExact = new Set([
    ".github/workflows/factory-verification.yml",
    ".github/workflows/release.yml",
    ".gitignore",
    ".npmrc",
    "LICENSE",
    "README.md",
    "eslint.config.mjs",
    "package-lock.json",
    "package.json",
    "tsconfig.json",
    "tsup.config.ts",
    "vitest.config.ts",
  ]);
  const allowedPrefixes = ["docs/", "examples/", "policies/", "schemas/", "scripts/", "src/", "tests/"];
  const forbidden = [
    [/^\.env(?:\..*)?$/iu, "env-file"],
    [/(^|\/)(?:credentials?|cookies?)\.json$/iu, "credential-file"],
    [/^registries\/private\//iu, "private-registry"],
    [/(^|\/)Dockerfile$/u, "dockerfile"],
    [/(^|\/)docker-compose\.ya?ml$/iu, "docker-compose"],
    [/^\.github\/workflows\/(?!(?:factory-verification|release)\.yml$)/u, "workflow-mutation"],
  ];

  const failures = [];
  for (const file of files) {
    const forbiddenReason = forbidden.find(([pattern]) => pattern.test(file))?.[1];
    if (forbiddenReason !== undefined) {
      failures.push(`${file}: forbidden ${forbiddenReason}`);
      continue;
    }
    if (!allowedExact.has(file) && !allowedPrefixes.some((prefix) => file.startsWith(prefix))) {
      failures.push(`${file}: outside factory changed-file scope`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Changed-file scope check failed:\n${failures.join("\n")}`);
  }
  console.log(`Changed-file scope passed for ${files.length} changed file(s).`);
}

async function smokeMcp() {
  const transport = new StdioClientTransport({ command: nodeCommand, args: ["dist/mcp.js", "--registry", exampleRegistry] });
  const client = new Client({ name: "capykit-factory-verification", version: "0.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["check_availability", "get_tool", "list_capabilities", "search_tools"]);
    const result = await client.callTool({ name: "search_tools", arguments: { query: "jq" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.count, 1);
    assert.equal(result.structuredContent?.tools?.[0]?.id, "jq");
  } finally {
    await client.close();
  }
  console.log("MCP smoke passed.");
}

function smokeAdapters(helpText) {
  if (!helpText.includes("adapters <registry.json>")) {
    console.log("Adapter smoke skipped: built CLI does not expose adapters command.");
    return;
  }
  const raw = output(nodeCommand, ["dist/cli.js", "adapters", exampleRegistry]);
  const bundle = JSON.parse(raw);
  assert.equal(bundle.format, "capykit.discoveryAdapters.v0.1");
  assert.match(bundle.catalogDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(bundle.files.map((file) => file.path), ["AGENTS.md", ".codex/capykit.discovery.json", ".hermes/references/capykit-discovery.md"]);
  assert.equal(bundle.files.some((file) => /credential values/u.test(file.content)), true);
  assert.doesNotMatch(JSON.stringify(bundle), /-----BEGIN [A-Z ]*PRIVATE KEY-----|(^|\s)(Bearer|Basic)\s+\S+|gh[pousr]_|github_pat_|sk-|xox[baprs]-/iu);
  console.log("Adapter smoke passed.");
}

function smokeCli() {
  const help = output(nodeCommand, ["dist/cli.js", "--help"]);
  assert.match(help, /Usage: capykit <command>/u);
  const doctor = spawnSync(nodeCommand, ["dist/cli.js", "doctor", exampleRegistry], { cwd: repositoryRoot, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).format, "capykit.registryDoctor.v0.1");
  smokeAdapters(help);
  console.log("CLI smoke passed.");
}

function checkGeneratedArtifacts() {
  const forbiddenGenerated = [];
  for (const path of ["AGENTS.md", ".codex/capykit.discovery.json", ".hermes/references/capykit-discovery.md"]) {
    try {
      const content = readFileSync(join(repositoryRoot, path), "utf8");
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|(^|\s)(Bearer|Basic)\s+\S+|gh[pousr]_|github_pat_|sk-|xox[baprs]-/iu.test(content)) {
        forbiddenGenerated.push(path);
      }
    } catch {
      // Generated adapter files are usually emitted to stdout, not checked in.
    }
  }
  if (forbiddenGenerated.length > 0) {
    throw new Error(`Generated artifact secret boundary failed: ${forbiddenGenerated.join(", ")}`);
  }
  console.log("Generated artifact credential-boundary check passed.");
}

checkChangedFileScope();
run(npmCommand, ["run", "lint"]);
run(npmCommand, ["run", "typecheck"]);
run(npmCommand, ["test"]);
run(npmCommand, ["run", "build"]);
run(npmCommand, ["run", "test:package"]);
run(npmCommand, ["run", "check:schema"]);
run(npmCommand, ["run", "check:secrets"]);
run(npmCommand, ["audit", "--omit=dev"]);
smokeCli();
await smokeMcp();
checkGeneratedArtifacts();

console.log("factory-verification passed.");
