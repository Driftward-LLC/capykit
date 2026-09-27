import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { actions, invoke, PilotError } from "./pilot.mjs";
import { demo, example, githubRequest, driveRequest, githubFixture, driveFixture } from "./demo.mjs";

test("pinned packages execute both actions with exact URLs and bearer headers", async () => {
  const require = createRequire(import.meta.url);
  for (const entry of Object.values(actions)) {
    assert.equal(require(`${entry.package}/package.json`).version, entry.version);
  }
  const result = await demo();
  assert.equal(result.reads.length, 2);
  assert.deepEqual(result.reads.map((r) => r.result), [githubFixture.body, driveFixture.body]);
  assert.ok(result.reads.every((r) => r.transport === "fixture"));
  assert.equal(result.checks.length, 4);
  assert.ok(result.checks.every((r) => r.denied));
});

test("a human and an agent can each use an explicit grant", async () => {
  for (const principalId of ["human-owner", "external-agent"]) {
    const context = example();
    context.principal.id = principalId;
    context.grants[1].principalId = principalId;
    const result = await invoke(context, driveRequest, { fixture: driveFixture });
    assert.deepEqual(result.result, driveFixture.body);
  }
});

const denials = [
  ["inactive identity", "PRINCIPAL_INACTIVE", (c) => { c.principal.active = false; }],
  ["foreign workspace", "CONNECTION_NOT_FOUND", (c) => { c.principal.workspaceId = "foreign"; }],
  ["foreign principal", "FORBIDDEN", (c) => { c.principal.id = "foreign"; }],
  ["revoked grant", "FORBIDDEN", (c) => { c.grants[0].active = false; }],
  ["foreign grant", "FORBIDDEN", (c) => { c.grants[0].workspaceId = "foreign"; }],
  ["expired grant", "FORBIDDEN", (c) => { c.grants[0].expiresAt = Date.now() - 1; }],
  ["wrong connection grant", "FORBIDDEN", (c) => { c.grants[0].connectionId = "other"; }],
  ["wrong resource grant", "FORBIDDEN", (c) => { c.grants[0].resources = ["other/project"]; }],
  ["wrong operation grant", "FORBIDDEN", (c) => { c.grants[0].action = "github.issue.write"; }],
  ["disconnected account", "CONNECTION_INACTIVE", (c) => { c.connections[0].active = false; }],
  ["connection resource removed", "FORBIDDEN", (c) => { c.connections[0].resources = []; }],
  ["provider mismatch", "PROVIDER_MISMATCH", (c) => { c.connections[0].provider = "google-drive"; }],
  ["expired credential", "CONNECTION_EXPIRED", (c) => { c.connections[0].expiresAt = Date.now() - 1; }],
  ["missing credential", "CONNECTION_EXPIRED", (c) => { c.connections[0].token = ""; }],
];
for (const [name, code, change] of denials) {
  test(`denies ${name}`, async () => {
    const context = example(); change(context);
    await assert.rejects(invoke(context, githubRequest, { fixture: githubFixture }), { code });
  });
}

test("grants cannot be combined to authorize a request", async () => {
  const context = example();
  const grant = context.grants[0];
  context.grants = [{ ...grant, resources: [] }, { ...grant, action: "other-action" }];
  await assert.rejects(invoke(context, githubRequest, { fixture: githubFixture }), { code: "FORBIDDEN" });
});

test("rejects arbitrary actions, URLs, paths and invalid issue numbers", async () => {
  for (const change of [
    { action: "custom_api_call" }, { action: "__proto__" }, { action: "github.issue.write" },
    { resource: "example/.." }, { resource: "example/project/../../user" },
    { resource: "https://localhost" }, { issueNumber: 0 }, { issueNumber: "1" },
    { issueNumber: 1.5 }, { issueNumber: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    await assert.rejects(invoke(example(), { ...githubRequest, ...change }, { fixture: githubFixture }), (error) => error instanceof PilotError && ["INVALID_INPUT", "ACTION_NOT_ALLOWED"].includes(error.code));
  }
  await assert.rejects(invoke(example(), { ...driveRequest, resource: "../other?alt=media" }, { fixture: driveFixture }), { code: "INVALID_INPUT" });
});

test("revocation during a read suppresses the result and blocks the next call", async () => {
  for (const change of [
    (c) => { c.grants[0].active = false; },
    (c) => { c.connections[0].active = false; },
    (c) => { c.connections[0].generation += 1; },
  ]) {
    const context = example();
    const reading = invoke(context, githubRequest, { fixture: githubFixture });
    change(context);
    await assert.rejects(reading, (error) => ["FORBIDDEN", "CONNECTION_INACTIVE"].includes(error.code));
    context.connections[0].active = false;
    await assert.rejects(invoke(context, githubRequest, { fixture: githubFixture }), { code: "CONNECTION_INACTIVE" });
  }
});

test("changing caller identity while awaiting a connector never releases its result", async () => {
  const context = example();
  const reading = invoke(context, githubRequest, { fixture: githubFixture });
  context.principal.id = "other-principal";
  await assert.rejects(reading, { code: "PRINCIPAL_CHANGED" });
});

test("input mutation cannot change the authorized target", async () => {
  const request = { ...githubRequest };
  const reading = invoke(example(), request, { fixture: githubFixture });
  request.resource = "other/project";
  const result = await reading;
  assert.deepEqual(result.result, githubFixture.body);
});

test("raw provider failures, headers and echoed tokens are never returned", async () => {
  const context = example();
  const token = context.connections[0].token;
  for (const status of [401, 403, 404]) {
    await assert.rejects(invoke(context, githubRequest, { fixture: { status, body: { message: token } } }), (error) => error.code === "PROVIDER_REQUEST_FAILED" && !String(error).includes(token));
  }
  await assert.rejects(invoke(context, githubRequest, { fixture: { body: { ...githubFixture.body, title: token } } }), { code: "PROVIDER_REQUEST_FAILED" });
  await assert.rejects(invoke(context, driveRequest, { fixture: { body: { ...driveFixture.body, id: "wrong-file" } } }), { code: "PROVIDER_REQUEST_FAILED" });
});

test("returns only bounded, selected fields", async () => {
  const result = await invoke(example(), githubRequest, { fixture: { body: { ...githubFixture.body, title: "x".repeat(50000), privateField: "must-not-return" } } });
  assert.deepEqual(Object.keys(result.result), ["number", "title", "state"]);
  assert.equal(result.result.title.length, 4096);
});

test("a stalled connector is killed at the action deadline", async () => {
  await assert.rejects(invoke(example(), driveRequest, { fixture: { ...driveFixture, delayMs: 10000 }, timeoutMs: 1000 }), { code: "CONNECTOR_TIMEOUT" });
});

test("live probe refuses ambient provider credentials and reports only a missing variable", () => {
  const result = spawnSync(process.execPath, [new URL("./live.mjs", import.meta.url).pathname, "github", "example/project", "1"], {
    env: { GITHUB_TOKEN: "fixture-ambient-token", GOOGLE_TOKEN: "fixture-ambient-token" }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "MISSING_CAPYKIT_POC_GITHUB_TOKEN");
});
