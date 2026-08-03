import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(
  readFileSync(join(root, "policies/v0.1/security-policy.json"), "utf8"),
);
const cases = JSON.parse(
  readFileSync(join(root, "examples/security-policy-cases.json"), "utf8"),
);

function isWithin(path, rootPath) {
  const candidate = relative(rootPath, path);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== "..");
}

function safeRegistryPath(testCase) {
  if (testCase.input.includes("\0") || !testCase.regularFile) {
    return false;
  }

  if (testCase.input.split(/[\\/]/).includes("..")) {
    return false;
  }

  if (!isAbsolute(testCase.resolvedPath)) {
    return false;
  }

  return testCase.allowedRoots.some((rootPath) => isWithin(testCase.resolvedPath, rootPath));
}

function isPrivateHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }

  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }

  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function safeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return policy.sourceSafety.urls.schemes.includes(parsed.protocol.slice(0, -1)) &&
    !parsed.username && !parsed.password && !parsed.hash && !isPrivateHostname(parsed.hostname);
}

const forbiddenKeyPatterns = policy.credentials.forbiddenKeyPatterns.map(
  (pattern) => new RegExp(pattern, "i"),
);
const forbiddenValuePatterns = policy.credentials.forbiddenValuePatterns.map(
  (pattern) => new RegExp(pattern, "i"),
);

function containsSecret(key, value) {
  return forbiddenKeyPatterns.some((pattern) => pattern.test(key)) ||
    forbiddenValuePatterns.some((pattern) => pattern.test(value));
}

function validHealthCheck(check) {
  const contract = policy.healthChecks.kinds[check.kind];
  if (!contract) {
    return false;
  }

  const fields = Object.keys(check);
  if (fields.some((field) => !contract.fields.includes(field))) {
    return false;
  }

  if (fields.some((field) => policy.healthChecks.forbiddenFields.includes(field))) {
    return false;
  }

  if (check.kind === "command-available") {
    return new RegExp(contract.executablePattern).test(check.command);
  }

  if (check.kind === "http-get") {
    return safeUrl(check.url);
  }

  if (check.kind === "file-readable") {
    return isAbsolute(check.path) && !check.path.includes("\0") &&
      !check.path.split(/[\\/]/).includes("..");
  }

  return typeof check.interfaceId === "string" && check.interfaceId.length > 0;
}

function validMcpTool(name) {
  const forbidden = policy.mcp.forbiddenNamePatterns.some(
    (pattern) => new RegExp(pattern, "i").test(name),
  );
  return !forbidden && policy.mcp.tools.includes(name);
}

assert.equal(policy.policyVersion, "0.1.0");
assert.deepEqual(policy.registryTrust.precedence, ["operator-approved", "bundled", "untrusted"]);
assert.equal(policy.registryTrust.updates.defaultMode, "manual");
assert.equal(policy.registryTrust.updates.validateBeforeActivation, true);
assert.equal(policy.credentials.dereferenceDuring.length, 0);
assert.equal(policy.mcp.mode, "read-only");
assert.equal(policy.mcp.genericRemoteExecution, false);

for (const testCase of cases.pathCases) {
  assert.equal(safeRegistryPath(testCase), testCase.expected, testCase.name);
}

for (const testCase of cases.urlCases) {
  assert.equal(safeUrl(testCase.url), testCase.expected, testCase.name);
}

for (const testCase of cases.secretCases) {
  assert.equal(containsSecret(testCase.key, testCase.value), testCase.expected, testCase.name);
}

for (const testCase of cases.healthCheckCases) {
  assert.equal(validHealthCheck(testCase.check), testCase.expected, testCase.name);
}

for (const testCase of cases.mcpToolCases) {
  assert.equal(validMcpTool(testCase.tool), testCase.expected, testCase.name);
}

const total = Object.values(cases).reduce((sum, entries) => sum + entries.length, 0);
console.log(`Security policy contract passed: ${total} positive and negative cases.`);
