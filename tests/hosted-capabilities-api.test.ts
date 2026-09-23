import { randomUUID } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedServer } from "../src/hosted/server.js";
import { createHostedDatabase } from "../src/hosted/db.js";
import { loadHostedConfig } from "../src/hosted/config.js";
import type { ValidatedArtifact } from "../src/hosted/artifacts.js";

const databaseUrl = process.env.CAPYKIT_TEST_POSTGRES_URL;
const origin = "https://capykit.example.test";

describe.skipIf(databaseUrl === undefined)("capability HTTP and PostgreSQL integration", () => {
  const schema = `capykit_api_${randomUUID().replaceAll("-", "")}`;
  const runtimeRole = `${schema}_runtime`;
  const admin = new Pool({ connectionString: databaseUrl });
  const scoped = new URL(databaseUrl ?? "postgres://localhost/capykit_test");
  scoped.searchParams.set("options", `-c search_path=${schema},public -c role=${runtimeRole}`);
  const identities = new Map<string, { provider: "gotrue"; subject: string; email: string }>();
  const workspaces = [randomUUID(), randomUUID()];
  let app = server();
  let ownerPrincipal: string;

  function server(): FastifyInstance {
    const database = createHostedDatabase(scoped.toString());
    if (database === undefined) throw new Error("Missing disposable test database");
    return createHostedServer({ database, config: loadHostedConfig({ DATABASE_URL: scoped.toString(), CAPYKIT_PUBLIC_BASE_URL: origin, CAPYKIT_AUTH_URL: "http://auth:9999" }), auth: {
      verifyBearer: (token) => Promise.resolve(identities.get(token)),
      verifyOtp: () => Promise.resolve(undefined), requestOtp: async () => {}, signOut: async () => {},
    } });
  }
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    const client = await admin.connect();
    try {
      await client.query(`set search_path=${schema},public`);
      for (const name of ["001_hosted_workspace_identity.sql", "002_hosted_database_access.sql", "003_hosted_capabilities.sql"]) {
        await client.query((await readFile(new URL(`../scripts/migrations/${name}`, import.meta.url), "utf8")).replaceAll("capykit_runtime", runtimeRole));
      }
      for (const id of workspaces) await client.query("insert into workspaces(id,slug,name) values($1,$2,'HTTP test')", [id, id]);
      for (const [token, workspace, kind, role] of [
        ["owner", workspaces[0], "human", "owner"], ["member", workspaces[0], "human", "member"],
        ["agent", workspaces[0], "agent", "owner"], ["other-owner", workspaces[1], "human", "owner"],
      ]) {
        if (token === undefined) throw new Error("Invalid fixture");
        const id = randomUUID();
        const subject = randomUUID();
        if (token === "owner") ownerPrincipal = id;
        identities.set(token, { provider: "gotrue", subject, email: `${token}@example.test` });
        await client.query("insert into principals(id,workspace_id,kind,display_name) values($1,$2,$3,$4)", [id, workspace, kind, token]);
        await client.query("insert into workspace_memberships(workspace_id,principal_id,role) values($1,$2,$3)", [workspace, id, role]);
        await client.query("insert into identity_bindings(principal_id,provider,provider_subject,email,verified_at) values($1,'gotrue',$2,$3,now())", [id, subject, `${token}@example.test`]);
      }
    } finally { client.release(); }
  });
  afterAll(async () => {
    await app.close();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.query(`drop role if exists ${runtimeRole}`);
    await admin.end();
  });
  const headers = { authorization: "Bearer owner" };
  interface Detail { id: string; draft: { version: string; digest: string } | null; versions: { version: string; digest: string }[] }
  it("publishes complete files, removes the upload directory, reopens the API, and downloads identical private bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capykit-upload-"));
    const source = new Map([
      ["SKILL.md", Buffer.from("---\nname: complete-skill\ndescription: A complete portable test skill\n---\nRead references/guide.md and run scripts/check.sh.")],
      ["scripts/check.sh", Buffer.from("#!/bin/sh\nprintf 'test'\n")],
      ["references/guide.md", Buffer.from("Supporting reference")],
      ["assets/picture.bin", Buffer.from([0, 255, 128, 64, 1])],
    ]);
    let files;
    try {
      for (const [path, bytes] of source) { await mkdir(join(directory, path, ".."), { recursive: true }); await writeFile(join(directory, path), bytes); }
      files = await Promise.all([...source].map(async ([path]) => ({ path, type: "file", executable: path.endsWith(".sh"), contentBase64: (await readFile(join(directory, path))).toString("base64") })));
    } finally { await rm(directory, { recursive: true, force: true }); }
    const created = await app.inject({ method: "POST", url: "/v1/capabilities", headers, payload: { slug: "complete-skill", name: "Complete skill", kind: "skill" } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<Detail>().id;
    const url = `/v1/capabilities/${id}`;
    const saved = await app.inject({ method: "PUT", url: `${url}/draft`, headers, payload: { version: "1.0.0", artifact: { files } } });
    expect(saved.statusCode, saved.body).toBe(200);
    const digest = saved.json<Detail>().draft?.digest;
    expect(saved.body).not.toContain("contentBase64");
    expect((await app.inject({ method: "POST", url: `${url}/publish`, headers, payload: { version: "1.0.0", digest } })).statusCode).toBe(200);
    await app.close(); app = server();
    const path = `${url}/versions/1.0.0/download`;
    const result = await app.inject({ url: path, headers });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["content-disposition"]).toContain("attachment;");
    const artifact = result.json<{ artifact: ValidatedArtifact }>().artifact;
    expect(artifact.digest).toBe(digest);
    expect(artifact.files).toHaveLength(source.size);
    for (const file of artifact.files) {
      expect(Buffer.from(file.contentBase64, "base64")).toEqual(source.get(file.path));
      expect(file.executable).toBe(file.path.endsWith(".sh"));
    }
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    for (const token of ["member", "agent", "other-owner"]) {
      const denied = { authorization: `Bearer ${token}` };
      expect((await app.inject({ url: path, headers: denied })).statusCode).toBe(token === "other-owner" ? 404 : 403);
      expect((await app.inject({ method: "POST", url: `${url}/publish`, headers: denied, payload: { version: "1.0.0", digest } })).statusCode).toBe(token === "other-owner" ? 404 : 403);
    }
    const cookie = "capykit_session=owner; capykit_csrf=csrf-test";
    expect((await app.inject({ method: "DELETE", url, headers: { cookie, origin } })).statusCode).toBe(403);
    await admin.query(`update ${schema}.workspace_memberships set active=false where principal_id=$1`, [ownerPrincipal]);
    expect((await app.inject({ url: path, headers })).statusCode).toBe(401);
    await admin.query(`update ${schema}.workspace_memberships set active=true where principal_id=$1`, [ownerPrincipal]);
    expect((await app.inject({ method: "DELETE", url, headers: { cookie, origin, "x-csrf-token": "csrf-test" } })).statusCode).toBe(204);
    expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
  });

  it("stores the fixed function without evaluating its top-level code and rejects schema replacement", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/capabilities", headers, payload: { slug: "list-issues", name: "List issues", kind: "function" } });
    const url = `/v1/capabilities/${created.json<Detail>().id}`;
    const artifact = { files: [{ type: "file", path: "index.mjs", executable: false, contentBase64: Buffer.from('throw new Error("MUST_NOT_EXECUTE"); export async function handler(input, github) { return github.listIssues(input); }').toString("base64") }] };
    const bad = await app.inject({ method: "PUT", url: `${url}/draft`, headers, payload: { version: "1", artifact: { ...artifact, contract: { id: "untrusted" } } } });
    expect(bad.statusCode).toBe(400);
    const saved = await app.inject({ method: "PUT", url: `${url}/draft`, headers, payload: { version: "1", artifact } });
    expect(saved.statusCode, saved.body).toBe(200);
    const digest = saved.json<Detail>().draft?.digest;
    expect((await app.inject({ method: "POST", url: `${url}/publish`, headers, payload: { version: "1", digest } })).statusCode).toBe(200);
    const downloaded = await app.inject({ url: `${url}/versions/1/download`, headers });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.body).toContain("github.issues.list.v1");
    expect(downloaded.json<{ artifact: ValidatedArtifact }>().artifact.files[0]?.contentBase64).toBe(artifact.files[0]?.contentBase64);
  });

  it("releases bounded upload slots after a disconnected body, socket timeout, and invalid JSON", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/capabilities", headers, payload: { slug: "bounded-upload", name: "Bounded upload", kind: "function" } });
    expect(created.statusCode).toBe(201);
    const path = `/v1/capabilities/${created.json<Detail>().id}/draft`;
    const artifact = { files: [{ type: "file", path: "index.mjs", executable: false, contentBase64: Buffer.from("export async function handler(input, github) { return github.listIssues(input); }").toString("base64") }] };
    const valid = () => app.inject({ method: "PUT", url: path, headers, payload: { version: "1", artifact } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected bound HTTP port");
    const port = address.port;
    const held: ClientRequest[] = [];
    let reading = false;
    const observeBody = (incoming: IncomingMessage) => {
      if (incoming.headers["x-test-upload"] === "held") incoming.once("resume", () => { reading = true; });
    };
    app.server.on("request", observeBody);
    function startPartial(): ClientRequest {
      reading = false;
      const partial = httpRequest({ hostname: "127.0.0.1", port, path, method: "PUT", headers: { ...headers, "content-type": "application/json", "content-length": 1000, "x-test-upload": "held" } });
      partial.on("error", () => {});
      partial.on("response", (response) => response.resume());
      partial.write('{"version":"1",');
      held.push(partial);
      return partial;
    }
    try {
      const disconnected = startPartial();
      await expect.poll(() => reading).toBe(true);
      expect((await valid()).statusCode).toBe(429);
      disconnected.destroy();
      await expect.poll(async () => (await valid()).statusCode).toBe(200);

      app.server.setTimeout(200);
      const timedOut = startPartial();
      let closed = false;
      timedOut.once("close", () => { closed = true; });
      await expect.poll(() => reading, { interval: 10 }).toBe(true);
      expect((await valid()).statusCode).toBe(429);
      await expect.poll(() => closed).toBe(true);
      await expect.poll(async () => (await valid()).statusCode).toBe(200);

      const invalid = await app.inject({ method: "PUT", url: path, headers: { ...headers, "content-type": "application/json" }, payload: "{" });
      expect(invalid.statusCode).toBe(400);
      expect((await valid()).statusCode).toBe(200);
    } finally {
      app.server.setTimeout(30_000);
      app.server.removeListener("request", observeBody);
      for (const request of held) request.destroy();
    }
  });


  it("releases the shared artifact slot when a client disconnects during a streamed download", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/capabilities", headers, payload: { slug: "interrupted-download", name: "Interrupted download", kind: "skill" } });
    expect(created.statusCode).toBe(201);
    const url = `/v1/capabilities/${created.json<Detail>().id}`;
    const metadata = { type: "file", path: "SKILL.md", executable: false, contentBase64: Buffer.from("---\nname: interrupted-download\ndescription: Download interruption fixture\n---\nFixture").toString("base64") };
    const saved = await app.inject({ method: "PUT", url: `${url}/draft`, headers, payload: { version: "1", artifact: { files: [metadata, { type: "file", path: "asset.bin", executable: false, contentBase64: Buffer.alloc(8 * 1024 * 1024).toString("base64") }] } } });
    expect(saved.statusCode, saved.body).toBe(200);
    const digest = saved.json<Detail>().draft?.digest;
    expect((await app.inject({ method: "POST", url: `${url}/publish`, headers, payload: { version: "1", digest } })).statusCode).toBe(200);
    if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected bound HTTP port");
    const download = httpRequest({ hostname: "127.0.0.1", port: address.port, path: `${url}/versions/1/download`, headers });
    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        download.once("response", resolve);
        download.once("error", reject);
        download.end();
      });
      expect(response.statusCode).toBe(200);
      response.pause();
      response.destroy();
      download.destroy();
      await expect.poll(async () => (await app.inject({ method: "PUT", url: `${url}/draft`, headers, payload: { version: "2", artifact: { files: [metadata] } } })).statusCode).toBe(200);
    } finally { download.destroy(); }
  });

});
