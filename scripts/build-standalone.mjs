import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = join(repositoryRoot, "dist");
const standaloneRoot = join(distRoot, "standalone");
const cliEntry = join(distRoot, "cli.js");
const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

function artifactName(target) {
  return `capykit-${target}`;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

await rm(standaloneRoot, { recursive: true, force: true });
await mkdir(standaloneRoot, { recursive: true });

const manifest = {
  format: "capykit.standaloneArtifacts.v0.1",
  note: "v0.1 standalone artifacts are executable Node.js launchers with the Capykit CLI bundled in dist/cli.js. Release automation publishes these files with SHA-256 checksums alongside npm provenance.",
  artifacts: [],
};

for (const target of targets) {
  const outputPath = join(standaloneRoot, artifactName(target));
  await copyFile(cliEntry, outputPath);
  await chmod(outputPath, 0o755);
  manifest.artifacts.push({
    target,
    file: `dist/standalone/${basename(outputPath)}`,
    sha256: await sha256(outputPath),
  });
}

const manifestPath = join(standaloneRoot, "checksums.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const checksumLines = manifest.artifacts.map((artifact) => `${artifact.sha256}  ${basename(artifact.file)}`);
await writeFile(join(standaloneRoot, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");

console.log(`Generated ${manifest.artifacts.length} standalone artifacts in ${standaloneRoot}`);
