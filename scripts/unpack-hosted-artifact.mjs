#!/usr/bin/env node
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyArtifact } from "../dist/hosted-api.js";

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
let created;
try {
  const [input, destination, ...extra] = process.argv.slice(2);
  if (!input || !destination || extra.length) throw Object.assign(new Error(), { code: "UNPACK_USAGE" });
  const source = await open(input, "r");
  let download;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size > 46 * 1024 * 1024) throw new Error("Download must be a regular file of at most 46 MiB.");
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await source.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error("Download changed while reading.");
    download = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { await source.close(); }
  if (!keys(download, ["format", "capability", "version", "artifact", "guidance"]) || download.format !== "capykit.artifact.v1"
    || !keys(download.capability, ["id", "slug", "name", "kind"])
    || typeof download.capability.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(download.capability.id)
    || typeof download.capability.slug !== "string" || download.capability.slug.length > 80 || !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(download.capability.slug)
    || typeof download.capability.name !== "string" || !download.capability.name.trim() || download.capability.name.length > 120
    || typeof download.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(download.version)
    || !Array.isArray(download.guidance) || !download.guidance.every((entry) => typeof entry === "string" && entry.length <= 4096)) throw new Error("Invalid Capykit download envelope.");
  const artifact = verifyArtifact(download.artifact);
  if (download.capability.kind !== artifact.kind) throw new Error("Capability kind does not match its artifact.");
  const target = resolve(destination);
  await mkdir(target, { mode: 0o700 }); // Exclusive: existing directories and symlinks fail.
  created = target;
  for (const file of artifact.files) {
    const path = join(target, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(file.contentBase64, "base64"), { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ capabilityId: download.capability.id, version: download.version, digest: artifact.digest, fileCount: artifact.fileCount, directory: target })}\n`);
} catch (error) {
  if (created) await rm(created, { recursive: true, force: true });
  // Parser and filesystem errors can contain private bytes or paths.
  process.stderr.write(`${error?.code === "UNPACK_USAGE" ? "Usage: node scripts/unpack-hosted-artifact.mjs download.capykit.json NEW_DIRECTORY" : error?.code === "EEXIST" ? "Destination already exists." : "Artifact unpack failed; verify the input and choose a new directory."}\n`);
  process.exitCode = 1;
}
