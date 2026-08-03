import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  if (testCase.input.includes("\0")) {
    return false;
  }

  if (testCase.input.split(/[\\/]/).includes("..")) {
    return false;
  }

  const sandbox = mkdtempSync(join(tmpdir(), "capykit-path-policy-"));
  const allowedRoot = join(sandbox, "registries");
  const outsideFile = join(sandbox, "outside.registry.json");
  mkdirSync(allowedRoot);
  writeFileSync(outsideFile, "{}\n");

  let input = testCase.input;
  const insidePath = join(allowedRoot, input);

  try {
    if (testCase.setup === "regular-file" || testCase.setup === "absolute-regular-file") {
      mkdirSync(dirname(insidePath), { recursive: true });
      writeFileSync(insidePath, "{}\n");
      if (testCase.setup === "absolute-regular-file") {
        input = insidePath;
      }
    } else if (testCase.setup === "symlink-outside") {
      symlinkSync(outsideFile, insidePath);
    } else if (testCase.setup === "directory") {
      mkdirSync(insidePath, { recursive: true });
    }

    const candidate = isAbsolute(input) ? input : resolve(allowedRoot, input);
    const canonical = realpathSync(candidate);
    return statSync(canonical).isFile() && isWithin(canonical, allowedRoot);
  } catch {
    return false;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function isNonPublicAddress(address) {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = normalized.match(/^::ffff:([0-9]+(?:\.[0-9]+){3})$/);
  if (mapped) {
    return isNonPublicAddress(mapped[1]);
  }

  if (normalized.includes(":")) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
  }

  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
    octets[0] >= 224;
}

function parseSafeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localName = hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local");
  return policy.sourceSafety.urls.schemes.includes(parsed.protocol.slice(0, -1)) &&
    !parsed.username && !parsed.password && !parsed.hash && !localName &&
    (!hostname.match(/^[0-9a-f:.]+$/i) || !isNonPublicAddress(hostname)) ? parsed : null;
}

function safeUrl(testCase) {
  const initial = parseSafeUrl(testCase.url);
  if (!initial || !Array.isArray(testCase.resolvedAddresses) ||
      testCase.resolvedAddresses.length === 0 ||
      testCase.resolvedAddresses.some(isNonPublicAddress)) {
    return false;
  }

  if (testCase.usesAmbientProxy === true ||
      (testCase.durationMs ?? 0) > policy.sourceSafety.urls.maximumDurationMs ||
      (testCase.responseBytes ?? 0) > policy.sourceSafety.urls.maximumResponseBytes) {
    return false;
  }

  const redirects = testCase.redirects ?? [];
  if (redirects.length > policy.registryTrust.updates.maximumRedirects) {
    return false;
  }

  return redirects.every((redirect) => {
    const parsed = parseSafeUrl(redirect.url);
    return parsed && parsed.origin === initial.origin &&
      Array.isArray(redirect.resolvedAddresses) && redirect.resolvedAddresses.length > 0 &&
      !redirect.resolvedAddresses.some(isNonPublicAddress);
  });
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

function validProvenance(provenance) {
  const required = policy.registryTrust.updates.requiredProvenance;
  if (!required.every((field) => typeof provenance[field] === "string" && provenance[field])) {
    return false;
  }

  return provenance.revision === undefined ||
    (typeof provenance.revision === "string" && provenance.revision.length > 0);
}

function validRuntime(runtime) {
  return runtime && runtime.durationMs <= policy.healthChecks.maximumDurationMs &&
    runtime.responseBytes <= policy.healthChecks.maximumResponseBytes &&
    runtime.hasStdin === false && Array.isArray(runtime.credentialNames) &&
    runtime.credentialNames.length === 0;
}

function validHealthCheck(testCase) {
  const { check, context = {}, runtime, network = {} } = testCase;
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

  if (!validRuntime(runtime)) {
    return false;
  }

  if (check.kind === "command-available") {
    return new RegExp(contract.executablePattern).test(check.command) &&
      Array.isArray(context.approvedCommands) && context.approvedCommands.includes(check.command);
  }

  if (check.kind === "http-get") {
    return safeUrl({
      url: check.url,
      ...network,
      durationMs: runtime.durationMs,
      responseBytes: runtime.responseBytes,
    });
  }

  if (check.kind === "file-readable") {
    return !check.path.includes("\0") && !check.path.split(/[\\/]/).includes("..") &&
      isAbsolute(context.resolvedFilePath ?? "") &&
      Array.isArray(context.approvedFileRoots) &&
      context.approvedFileRoots.some((rootPath) => isWithin(context.resolvedFilePath, rootPath));
  }

  if (check.kind === "service-active") {
    return Array.isArray(context.approvedServiceInterfaces) &&
      context.approvedServiceInterfaces.includes(check.interfaceId);
  }

  const entry = context.interfaces?.find((candidate) => candidate.id === check.interfaceId);
  if (!entry || entry.type !== "mcp" || !Array.isArray(context.approvedMcpTransports)) {
    return false;
  }

  const endpoint = entry.transport === "stdio" ? entry.command : entry.url;
  const fingerprint = `${entry.id}:${entry.transport}:${endpoint}`;
  if (!context.approvedMcpTransports.includes(fingerprint)) {
    return false;
  }

  if (entry.transport === "http") {
    return safeUrl({
      url: entry.url,
      ...(context.mcpNetwork ?? {}),
      durationMs: runtime.durationMs,
      responseBytes: runtime.responseBytes,
    });
  }

  return entry.transport === "stdio" && typeof entry.command === "string" && entry.command.length > 0;
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
assert.equal(policy.registryTrust.updates.requiredProvenance.includes("revision"), false);
assert.equal(policy.registryTrust.updates.optionalProvenance.includes("revision"), true);
assert.equal(policy.registryTrust.updates.revisionFallback, "sha256");
assert.equal(policy.credentials.dereferenceDuring.length, 0);
assert.equal(policy.sourceSafety.paths.verifyOpenedDescriptor, true);
assert.equal(policy.sourceSafety.urls.allowAmbientProxy, false);
assert.equal(policy.mcp.mode, "read-only");
assert.equal(policy.mcp.genericRemoteExecution, false);

for (const testCase of cases.pathCases) {
  assert.equal(safeRegistryPath(testCase), testCase.expected, testCase.name);
}

for (const testCase of cases.urlCases) {
  assert.equal(safeUrl(testCase), testCase.expected, testCase.name);
}

for (const testCase of cases.secretCases) {
  assert.equal(containsSecret(testCase.key, testCase.value), testCase.expected, testCase.name);
}

for (const testCase of cases.provenanceCases) {
  assert.equal(validProvenance(testCase.provenance), testCase.expected, testCase.name);
}

for (const testCase of cases.healthCheckCases) {
  assert.equal(validHealthCheck(testCase), testCase.expected, testCase.name);
}

for (const testCase of cases.mcpToolCases) {
  assert.equal(validMcpTool(testCase.tool), testCase.expected, testCase.name);
}

const total = Object.values(cases).reduce((sum, entries) => sum + entries.length, 0);
console.log(`Security policy contract passed: ${total} positive and negative cases.`);
