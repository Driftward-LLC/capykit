import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "capykit-package-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const binSuffix = process.platform === "win32" ? ".cmd" : "";

try {
  const archiveOutput = execFileSync(
    npmCommand,
    ["pack", "--pack-destination", temporaryRoot],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const archiveName = archiveOutput.trim().split(/\r?\n/).at(-1);
  assert.ok(archiveName, "npm pack did not return an archive name");

  const installRoot = join(temporaryRoot, "install");
  await writeFile(join(temporaryRoot, "package.json"), JSON.stringify({ private: true }), "utf8");
  execFileSync(
    npmCommand,
    ["install", "--ignore-scripts", join(temporaryRoot, basename(archiveName)), "--prefix", installRoot],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const binRoot = join(installRoot, "node_modules", ".bin");
  const cliOutput = execFileSync(join(binRoot, `capykit${binSuffix}`), ["--help"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.match(cliOutput, /Usage: capykit <command>/);
  const completionOutput = execFileSync(join(binRoot, `capykit${binSuffix}`), ["completion", "bash"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.match(completionOutput, /complete -F _capykit capykit/);

  const importSmoke = join(installRoot, "smoke.mjs");
  await writeFile(importSmoke, `
    import { access } from "node:fs/promises";
    import { CAPYKIT_VERSION } from "@driftward/capykit";
    import { registrySchemaUrl } from "@driftward/capykit/schemas";
    if (CAPYKIT_VERSION !== "0.0.0") throw new Error("unexpected package version");
    await access(registrySchemaUrl());
  `, "utf8");
  execFileSync(process.execPath, [importSmoke], { cwd: installRoot, stdio: "pipe" });

  const maliciousSchemaRoot = join(installRoot, "node_modules", "@driftward", "schemas", "v0.1");
  await mkdir(maliciousSchemaRoot, { recursive: true });
  await writeFile(join(maliciousSchemaRoot, "registry.schema.json"), JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: true,
  }), "utf8");

  const invalidRegistryRoot = join(installRoot, "registries");
  await mkdir(invalidRegistryRoot);
  await writeFile(join(invalidRegistryRoot, "invalid.registry.json"), JSON.stringify({
    schemaVersion: "0.1.0",
    registry: { id: "invalid-installed-package", name: "Invalid installed package" },
    tools: [{ id: "missing-required-fields" }],
  }), "utf8");
  const installedValidatorSmoke = join(installRoot, "installed-validator-smoke.mjs");
  await writeFile(installedValidatorSmoke, `
    import { strict as assert } from "node:assert";
    import { loadRegistryCatalog, RegistryLoadError } from "@driftward/capykit";
    let rejection;
    try {
      await loadRegistryCatalog([{ id: "invalid-installed", layer: "builtin", type: "file", root: ${JSON.stringify(invalidRegistryRoot)}, path: "invalid.registry.json" }]);
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection instanceof RegistryLoadError, "installed package must reject schema-invalid registries with its own validator");
    assert.match(String(rejection), /node_modules[\\\\/]@driftward[\\\\/]capykit[\\\\/]schemas[\\\\/]v0\\.1[\\\\/]registry\\.schema\\.json/);
    assert.doesNotMatch(String(rejection), /node_modules[\\\\/]@driftward[\\\\/]schemas[\\\\/]v0\\.1[\\\\/]registry\\.schema\\.json/);
  `, "utf8");
  execFileSync(process.execPath, [installedValidatorSmoke], { cwd: installRoot, stdio: "pipe" });

  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "capykit-package-smoke", version: "0.0.0" },
    },
  });
  const mcpResult = spawnSync(join(binRoot, `capykit-mcp${binSuffix}`), [], {
    encoding: "utf8",
    input: `${request}\n`,
    shell: process.platform === "win32",
    timeout: 5_000,
  });
  assert.ifError(mcpResult.error);
  assert.equal(mcpResult.status, 0, mcpResult.stderr);
  const responseLine = mcpResult.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  assert.ok(responseLine, "installed MCP server did not respond");
  const response = JSON.parse(responseLine);
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "capykit");

  execFileSync(npmCommand, ["run", "build:standalone"], { cwd: repositoryRoot, stdio: "pipe", shell: process.platform === "win32" });
  const standaloneTarget = process.platform === "darwin" ? "darwin" : "linux";
  const standaloneArch = process.arch === "arm64" ? "arm64" : "x64";
  const standaloneName = `capykit-${standaloneTarget}-${standaloneArch}`;
  const standaloneOutput = execFileSync(join(repositoryRoot, "dist", "standalone", standaloneName), ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(standaloneOutput.trim(), "0.0.0");
  const checksums = JSON.parse(await readFile(join(repositoryRoot, "dist", "standalone", "checksums.json"), "utf8"));
  assert.equal(checksums.format, "capykit.standaloneArtifacts.v0.1");
  assert.equal(checksums.artifacts.length, 4);
  assert.ok(checksums.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)), "standalone artifacts must publish sha256 checksums");

  console.log("Packed package smoke test passed: CLI, completions, imports, schema asset, installed validator, MCP server, and standalone artifacts.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
