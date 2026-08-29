import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = join(root, "schemas/v0.1/registry.schema.json");
const example = join(root, "examples/all-interfaces.registry.json");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "capykit-schema-"));

function clone(value) {
  return structuredClone(value);
}

function runAjv(command, dataFile) {
  const args = [
    "--yes",
    "ajv-cli@5.0.0",
    command,
    "--spec=draft2020",
    "--strict=true",
    "-s",
    schema,
  ];

  if (dataFile) {
    args.push("-d", dataFile);
  }

  return spawnSync(npx, args, {
    cwd: root,
    encoding: "utf8",
  });
}

function assertAjvResult(result, expectedSuccess, label) {
  const succeeded = result.status === 0;
  if (succeeded === expectedSuccess) {
    return;
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new Error(`${label}: unexpected AJV result\n${output}`);
}

function writeFixture(name, value) {
  const path = join(temporaryDirectory, `${name}.registry.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function semanticErrors(document) {
  const errors = [];
  const toolIds = new Set();

  for (const [toolIndex, tool] of document.tools.entries()) {
    const toolPath = `/tools/${toolIndex}`;
    if (toolIds.has(tool.id)) {
      errors.push({
        code: "duplicate-tool-id",
        path: `${toolPath}/id`,
        message: `Duplicate tool id: ${tool.id}`,
      });
    }
    toolIds.add(tool.id);
  }

  for (const [toolIndex, tool] of document.tools.entries()) {
    const toolPath = `/tools/${toolIndex}`;
    const interfaces = new Map();

    for (const [interfaceIndex, entry] of tool.interfaces.entries()) {
      if (interfaces.has(entry.id)) {
        errors.push({
          code: "duplicate-interface-id",
          path: `${toolPath}/interfaces/${interfaceIndex}/id`,
          message: `Duplicate interface id on ${tool.id}: ${entry.id}`,
        });
      }
      interfaces.set(entry.id, entry);
    }

    for (const [relationshipIndex, relationship] of tool.relationships.entries()) {
      if (!toolIds.has(relationship.target)) {
        errors.push({
          code: "unknown-relationship-target",
          path: `${toolPath}/relationships/${relationshipIndex}/target`,
          message: `Unknown tool id: ${relationship.target}`,
        });
      }
    }

    for (const [exampleIndex, entry] of tool.examples.entries()) {
      if (!interfaces.has(entry.interfaceId)) {
        errors.push({
          code: "unknown-example-interface",
          path: `${toolPath}/examples/${exampleIndex}/interfaceId`,
          message: `Unknown interface id on ${tool.id}: ${entry.interfaceId}`,
        });
      }
    }

    for (const [checkIndex, check] of tool.healthChecks.entries()) {
      if (!["mcp-initialize", "service-active"].includes(check.kind)) {
        continue;
      }

      const expectedType = check.kind === "mcp-initialize" ? "mcp" : "service";
      const target = interfaces.get(check.interfaceId);
      if (!target || target.type !== expectedType) {
        errors.push({
          code: "invalid-health-interface",
          path: `${toolPath}/healthChecks/${checkIndex}/interfaceId`,
          message: `${check.kind} requires a ${expectedType} interface on ${tool.id}`,
        });
      }
    }

    if (tool.lifecycle.replacement && !toolIds.has(tool.lifecycle.replacement)) {
      errors.push({
        code: "unknown-lifecycle-replacement",
        path: `${toolPath}/lifecycle/replacement`,
        message: `Unknown replacement tool id: ${tool.lifecycle.replacement}`,
      });
    }
  }

  return errors;
}

const validDocument = JSON.parse(readFileSync(example, "utf8"));

const schemaInvalidCases = [
  {
    name: "unsupported-schema-version",
    build() {
      const document = clone(validDocument);
      document.schemaVersion = "0.2.0";
      return document;
    },
  },
  {
    name: "credential-value",
    build() {
      const document = clone(validDocument);
      document.tools[1].authentication.requirements[0].value = "not-allowed";
      return document;
    },
  },
  {
    name: "invalid-interface",
    build() {
      const document = clone(validDocument);
      document.tools[0].interfaces[0].type = "browser";
      return document;
    },
  },
  {
    name: "unsafe-health-check",
    build() {
      const document = clone(validDocument);
      document.tools[0].healthChecks[0] = {
        id: "unsafe-command",
        kind: "command",
        command: "rm",
        arguments: ["-rf", "/"],
      };
      return document;
    },
  },
  {
    name: "invalid-extension-namespace",
    build() {
      const document = clone(validDocument);
      document.extensions = { tier: "private" };
      return document;
    },
  },
  {
    name: "credential-like-extension",
    build() {
      const document = clone(validDocument);
      document.extensions = { "x-api-key": "not-allowed" };
      return document;
    },
  },
  {
    name: "missing-scope-context",
    build() {
      const document = clone(validDocument);
      delete document.tools[1].scope.contexts;
      return document;
    },
  },
  {
    name: "none-mode-with-auth-requirements",
    build() {
      const document = clone(validDocument);
      document.tools[1].authentication.mode = "none";
      return document;
    },
  },
];

const semanticInvalidCases = [
  {
    name: "duplicate-tool-id",
    expectedCode: "duplicate-tool-id",
    build() {
      const document = clone(validDocument);
      document.tools.push(clone(document.tools[0]));
      return document;
    },
  },
  {
    name: "duplicate-interface-id",
    expectedCode: "duplicate-interface-id",
    build() {
      const document = clone(validDocument);
      document.tools[0].interfaces.push(clone(document.tools[0].interfaces[0]));
      return document;
    },
  },
  {
    name: "unknown-relationship-target",
    expectedCode: "unknown-relationship-target",
    build() {
      const document = clone(validDocument);
      document.tools[4].relationships[0].target = "missing-tool";
      return document;
    },
  },
  {
    name: "unknown-example-interface",
    expectedCode: "unknown-example-interface",
    build() {
      const document = clone(validDocument);
      document.tools[0].examples[0].interfaceId = "missing-interface";
      return document;
    },
  },
  {
    name: "invalid-health-interface",
    expectedCode: "invalid-health-interface",
    build() {
      const document = clone(validDocument);
      document.tools[1].healthChecks[0].interfaceId = "missing-interface";
      return document;
    },
  },
  {
    name: "unknown-lifecycle-replacement",
    expectedCode: "unknown-lifecycle-replacement",
    build() {
      const document = clone(validDocument);
      document.tools[0].lifecycle.replacement = "missing-tool";
      return document;
    },
  },
];

try {
  assertAjvResult(runAjv("compile"), true, "schema compile");
  assertAjvResult(runAjv("validate", example), true, "valid example");

  const validSemanticErrors = semanticErrors(validDocument);
  if (validSemanticErrors.length > 0) {
    throw new Error(`valid example has semantic errors: ${JSON.stringify(validSemanticErrors)}`);
  }

  for (const testCase of schemaInvalidCases) {
    const fixture = writeFixture(testCase.name, testCase.build());
    assertAjvResult(runAjv("validate", fixture), false, testCase.name);
  }

  for (const testCase of semanticInvalidCases) {
    const document = testCase.build();
    const fixture = writeFixture(testCase.name, document);
    assertAjvResult(runAjv("validate", fixture), true, `${testCase.name} shape`);

    const errors = semanticErrors(document);
    if (!errors.some((error) => error.code === testCase.expectedCode)) {
      throw new Error(
        `${testCase.name}: expected ${testCase.expectedCode}, got ${JSON.stringify(errors)}`,
      );
    }
  }

  console.log(
    `Schema contract passed: 2 valid fixtures, ${schemaInvalidCases.length} schema-invalid cases, ` +
      `${semanticInvalidCases.length} semantic-invalid cases.`,
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
