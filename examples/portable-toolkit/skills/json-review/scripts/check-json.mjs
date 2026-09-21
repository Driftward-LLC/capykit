import { readFile } from "node:fs/promises";
import process from "node:process";

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("Usage: node scripts/check-json.mjs <file.json>...\n");
  process.exitCode = 2;
}
for (const file of files) {
  try {
    JSON.parse(await readFile(file, "utf8"));
    process.stdout.write(`${file}: valid JSON\n`);
  } catch {
    process.stderr.write(`${file}: unreadable file or invalid JSON (contents omitted)\n`);
    process.exitCode = 1;
  }
}
