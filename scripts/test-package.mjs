import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  const importSmoke = join(installRoot, "smoke.mjs");
  await writeFile(importSmoke, `
    import { access } from "node:fs/promises";
    import { CAPYKIT_VERSION } from "@driftward/capykit";
    import { registrySchemaUrl } from "@driftward/capykit/schemas";
    if (CAPYKIT_VERSION !== "0.0.0") throw new Error("unexpected package version");
    await access(registrySchemaUrl());
  `, "utf8");
  execFileSync(process.execPath, [importSmoke], { cwd: installRoot, stdio: "pipe" });

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

  console.log("Packed package smoke test passed: CLI, imports, schema asset, and MCP server.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
