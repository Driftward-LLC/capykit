import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).filter(existsSync);
const forbiddenFiles = files.filter((path) => /(^|\/)(\.env(?:\..*)?|credentials?\.json|cookies?\.json)$/i.test(path) || path.startsWith("registries/private/") || /^docs\/driftward-private-capability-registry(?:\.registry\.json|\.md)$/i.test(path));
const detectors = [["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/], ["GitHub token", /gh[pousr]_[A-Za-z0-9]{30,}/], ["generic secret assignment", /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/i]];
const findings = [];
for (const path of files) {
  // This public negative-test fixture intentionally contains detector-shaped placeholders.
  if (path === "examples/security-policy-cases.json") continue;
  let content; try { content = readFileSync(path, "utf8"); } catch { continue; }
  for (const [name, pattern] of detectors) if (pattern.test(content)) findings.push(`${path}: ${name}`);
}
if (forbiddenFiles.length || findings.length) { process.stderr.write(["Public repository safety check failed.", ...forbiddenFiles, ...findings].join("\n") + "\n"); process.exit(1); }
console.log(`Public repository safety check passed for ${files.length} tracked files.`);
