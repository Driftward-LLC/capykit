import assert from "node:assert/strict";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { BlockList, isIP } from "node:net";
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

const blockedAddresses = {
  ipv4: new BlockList(),
  ipv6: new BlockList(),
};
for (const [network, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 96, "ipv6"],
  ["::1", 128, "ipv6"],
  ["::ffff:0:0", 96, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["fec0::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
]) {
  blockedAddresses[type].addSubnet(network, prefix, type);
}

function isNonPublicAddress(address) {
  const normalized = address.replace(/^\[|\]$/g, "");
  const version = isIP(normalized);
  if (version === 0) {
    return true;
  }

  const type = version === 4 ? "ipv4" : "ipv6";
  return blockedAddresses[type].check(normalized, type);
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
  const candidates = [value];
  if (policy.credentials.normalizeUrlsBeforeMatch) {
    try {
      candidates.push(new URL(value).href);
    } catch {
      // Non-URL values still use the raw detectors.
    }
  }

  return forbiddenKeyPatterns.some((pattern) => pattern.test(key)) || candidates.some((candidate) =>
    forbiddenValuePatterns.some((pattern) => pattern.test(candidate)),
  );
}

function validProvenance(provenance) {
  const required = policy.registryTrust.updates.requiredProvenance;
  if (!required.every((field) => typeof provenance[field] === "string" && provenance[field])) {
    return false;
  }

  let source;
  try {
    source = new URL(provenance.sourceUri);
  } catch {
    return false;
  }

  const trustTiers = policy.registryTrust.tiers.map((tier) => tier.id);
  const validTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
    provenance.fetchedAt,
  ) && !Number.isNaN(Date.parse(provenance.fetchedAt));
  const normalizedTimestamp = provenance.fetchedAt.includes(".") ? provenance.fetchedAt :
    provenance.fetchedAt.replace(/Z$/, ".000Z");
  const exactTimestamp = validTimestamp &&
    new Date(provenance.fetchedAt).toISOString() === normalizedTimestamp;
  const canonicalSource = source.href === provenance.sourceUri &&
    (source.protocol !== "file:" ||
      (source.hostname === "" && source.pathname.startsWith("/") && provenance.sourceUri.startsWith("file:///")));

  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(provenance.sourceId) &&
    canonicalSource && ["file:", "https:"].includes(source.protocol) &&
    !source.username && !source.password && !source.hash &&
    trustTiers.includes(provenance.trustTier) && /^[a-f0-9]{64}$/i.test(provenance.sha256) &&
    exactTimestamp && (provenance.revision === undefined ||
      (typeof provenance.revision === "string" && provenance.revision.length > 0));
}

function validRuntime(runtime) {
  return runtime && runtime.durationMs <= policy.healthChecks.maximumDurationMs &&
    runtime.responseBytes <= policy.healthChecks.maximumResponseBytes &&
    runtime.hasStdin === false && Array.isArray(runtime.credentialNames) &&
    runtime.credentialNames.length === 0 &&
    runtime.hasAmbientEnvironment === policy.healthChecks.inheritEnvironment &&
    runtime.pathSource === policy.healthChecks.pathSource;
}

function safeReadablePath(declaredPath, context) {
  if (declaredPath.includes("\0") || declaredPath.split(/[\\/]/).includes("..")) {
    return false;
  }

  const sandbox = mkdtempSync(join(tmpdir(), "capykit-health-path-"));
  const approvedRoot = join(sandbox, "approved");
  const outsideFile = join(sandbox, "outside");
  mkdirSync(approvedRoot);
  writeFileSync(outsideFile, "not registry data\n");

  try {
    const candidate = isAbsolute(declaredPath) ? declaredPath : resolve(approvedRoot, declaredPath);
    if (!isWithin(candidate, approvedRoot)) {
      return false;
    }

    const credentialPaths = (context.authenticationReferencePaths ?? []).map((path) =>
      isAbsolute(path) ? resolve(path) : resolve(approvedRoot, path),
    );
    if (credentialPaths.includes(candidate)) {
      return false;
    }

    if (context.fileSetup === "regular-file") {
      mkdirSync(dirname(candidate), { recursive: true });
      writeFileSync(candidate, "fixture\n");
    } else if (context.fileSetup === "symlink-outside") {
      mkdirSync(dirname(candidate), { recursive: true });
      symlinkSync(outsideFile, candidate);
    } else if (context.fileSetup === "symlink-auth-reference") {
      const credentialPath = resolve(approvedRoot, context.authenticationReferencePaths[0]);
      mkdirSync(dirname(candidate), { recursive: true });
      mkdirSync(dirname(credentialPath), { recursive: true });
      writeFileSync(credentialPath, "synthetic credential\n");
      symlinkSync(credentialPath, candidate);
    }

    const canonical = realpathSync(candidate);
    if (!isWithin(canonical, approvedRoot) || !statSync(canonical).isFile()) {
      return false;
    }
    const canonicalCredentialPaths = credentialPaths.flatMap((path) => {
      try {
        return [realpathSync(path)];
      } catch {
        return [];
      }
    });
    if (canonicalCredentialPaths.includes(canonical)) {
      return false;
    }
    accessSync(canonical, constants.R_OK);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
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
    return safeReadablePath(check.path, context);
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
assert.equal(policy.healthChecks.inheritEnvironment, false);
assert.equal(policy.healthChecks.pathSource, "operator");
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
