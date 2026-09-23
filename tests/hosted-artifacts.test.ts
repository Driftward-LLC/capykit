import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArtifactError, artifactSummary, GITHUB_ISSUES_CONTRACT_ID, githubIssuesListContract, parseIssuesInput, validateArtifact, verifyArtifact } from "../src/hosted/artifacts.js";

const skillText = "---\nname: test-skill\ndescription: A complete test skill.\n---\nRead references/help.md, then run scripts/run.sh.\n";
const source = "export async function handler(input, { github }) { return github.listIssues(input); }\n";
const file = (path: string, bytes: string | Buffer, executable = false) => ({ path, contentBase64: Buffer.from(bytes).toString("base64"), executable, type: "file" as const });
const skill = () => [file("SKILL.md", skillText), file("scripts/run.sh", "#!/bin/sh\nprintf '%s' complete\n", true), file("references/help.md", "Supporting information.\n"), file("assets/pixel.bin", Buffer.from([0, 255, 12, 128, 0]))];
function expectCode(run: () => unknown, code: string) {
  expect(run).toThrow(ArtifactError);
  try { run(); } catch (error) { expect((error as ArtifactError).code).toBe(code); }
}

describe("hosted artifact integrity", () => {
  it("preserves complete files, binary bytes, executable flags, and the existing skill bundle digest", () => {
    const upload = skill();
    const artifact = validateArtifact("skill", { files: upload });
    const expected = createHash("sha256");
    for (const entry of upload.sort((a, b) => a.path.localeCompare(b.path, "en-US"))) {
      const bytes = Buffer.from(entry.contentBase64, "base64");
      expected.update(JSON.stringify([entry.path, bytes.length, entry.executable])).update(bytes);
    }
    expect(artifact.digest).toBe(expected.digest("hex"));
    expect(artifact.files.map(({ path, contentBase64, executable, type }) => ({ path, contentBase64, executable, type }))).toEqual(upload);
    expect(verifyArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
    expect(artifactSummary(artifact).files.every((entry) => !("contentBase64" in entry))).toBe(true);
    expect(artifact.byteCount).toBe(upload.reduce((count, entry) => count + Buffer.from(entry.contentBase64, "base64").length, 0));
    expect(artifact.contract).toBe(null);
  });

  it("is order independent and changes with bytes, paths, or executable flags", () => {
    const original = skill();
    const digest = validateArtifact("skill", { files: original }).digest;
    expect(validateArtifact("skill", { files: [...original].reverse() }).digest).toBe(digest);
    for (const changed of [
      original.map((entry) => entry.path === "scripts/run.sh" ? { ...entry, executable: false } : entry),
      original.map((entry) => entry.path === "scripts/run.sh" ? { ...entry, path: "scripts/renamed.sh" } : entry),
      original.map((entry) => entry.path === "scripts/run.sh" ? { ...entry, contentBase64: Buffer.from("different").toString("base64") } : entry),
    ]) expect(validateArtifact("skill", { files: changed }).digest).not.toBe(digest);
  });

  it("orders distinct Unicode paths deterministically when locale comparison ties", () => {
    for (const [left, right] of [["a.txt", "a\uFE0F.txt"], ["foo", "f\u200Doo"]]) {
      if (left === undefined || right === undefined) throw new Error("Invalid path fixture");
      expect(left.localeCompare(right, "en-US")).toBe(0);
      const files = [file("SKILL.md", skillText), file(left, "first"), file(right, "second")];
      expect(validateArtifact("skill", { files }).digest).toBe(validateArtifact("skill", { files: [...files].reverse() }).digest);
    }
  });

  it("binds function source and the application-owned contract and never executes source", () => {
    const artifact = validateArtifact("function", { files: [file("index.mjs", `${source}\nthrow new Error('must never execute');`)] });
    expect(artifact.contract).toEqual(githubIssuesListContract);
    expect((artifact.contract as { id: string }).id).toBe(GITHUB_ISSUES_CONTRACT_ID);
    expect(verifyArtifact(artifact)).toEqual(artifact);
    expect(validateArtifact("function", { files: [file("index.mjs", source)] }).digest).not.toBe(artifact.digest);
    const changedContract = structuredClone(artifact);
    (changedContract.contract as { id: string }).id = "unreviewed.v2";
    expectCode(() => verifyArtifact(changedContract), "ARTIFACT_CORRUPT");
  });

  it("fails closed on missing files, changed bytes, metadata, contract, or digest", () => {
    const artifact = validateArtifact("skill", { files: skill() });
    for (const tamper of [
      (copy: typeof artifact) => ({ ...copy, files: copy.files.slice(1) }),
      (copy: typeof artifact) => ({ ...copy, files: copy.files.map((entry, index) => index === 0 ? { ...entry, contentBase64: "" } : entry) }),
      (copy: typeof artifact) => ({ ...copy, files: copy.files.map((entry, index) => index === 0 ? { ...entry, byteLength: entry.byteLength + 1 } : entry) }),
      (copy: typeof artifact) => ({ ...copy, files: copy.files.map((entry, index) => index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry) }),
      (copy: typeof artifact) => ({ ...copy, files: copy.files.map((entry, index) => index === 0 ? { ...entry, executable: !entry.executable } : entry) }),
      (copy: typeof artifact) => ({ ...copy, digest: "0".repeat(64) }),
      (copy: typeof artifact) => ({ ...copy, byteCount: copy.byteCount + 1 }),
      (copy: typeof artifact) => ({ ...copy, fileCount: copy.fileCount + 1 }),
      (copy: typeof artifact) => ({ ...copy, contract: {} }),
    ]) expectCode(() => verifyArtifact(tamper(artifact)), "ARTIFACT_CORRUPT");
    expectCode(() => verifyArtifact(null), "ARTIFACT_CORRUPT");
  });
});

describe("hosted artifact trust boundary", () => {
  it.each(["../secret", "/absolute", "C:/drive", "a\\b", "a/./b", "a//b", "./file", "trailing.", "space ", "CON", "a/nul.txt", "a\0b", "e\u0301.txt", "invalid-\uD800.txt"])("rejects unsafe path %j", (path) => {
    expectCode(() => validateArtifact("skill", { files: [file("SKILL.md", skillText), file(path, "") ] }), "ARTIFACT_INVALID");
  });

  it("rejects links, unsupported entry types and unknown uploaded contracts or fields", () => {
    for (const type of ["symlink", "hardlink", "directory", "fifo"]) expectCode(() => validateArtifact("skill", { files: [{ ...file("SKILL.md", skillText), type }] }), "ARTIFACT_INVALID");
    expectCode(() => validateArtifact("skill", { files: [{ ...file("SKILL.md", skillText), linkTarget: "target" }] }), "ARTIFACT_INVALID");
    expectCode(() => validateArtifact("function", { files: [file("index.mjs", source)], contract: {} }), "ARTIFACT_INVALID");
    expectCode(() => validateArtifact("function", { files: [file("index.mjs", source)], image: "custom" }), "ARTIFACT_INVALID");
    expectCode(() => validateArtifact("skill", { files: [{ ...file("SKILL.md", skillText), executable: "false" }] }), "ARTIFACT_INVALID");
  });

  it("rejects duplicate, case-alias, and file/directory prefix collisions in either upload order", () => {
    for (const paths of [["a", "a"], ["a", "A"], ["folder/a", "FOLDER/b"], ["a", "a/b"]]) {
      for (const order of [paths, [...paths].reverse()]) expectCode(() => validateArtifact("skill", { files: [file("SKILL.md", skillText), ...order.map((path) => file(path, ""))] }), "ARTIFACT_INVALID");
    }
  });

  it.each([".env", "dir/.env.local", "credentials.json", "cookies.json", ".git/config", "node_modules/package.js", "private.pem", ".ssh/config"])("rejects credential/dependency path %s", (path) => {
    expectCode(() => validateArtifact("skill", { files: [file("SKILL.md", skillText), file(path, "")] }), "ARTIFACT_INVALID");
  });

  it("rejects detected secret values without reflecting contents", () => {
    for (const secret of ["gh" + "p_" + "a".repeat(36), "api_key=" + "b".repeat(24), '"client_secret": "' + "c".repeat(25) + '"']) {
      try { validateArtifact("skill", { files: [file("SKILL.md", skillText), file("references/setup.md", secret)] }); throw new Error("expected rejection"); }
      catch (error) { expect(error).toBeInstanceOf(ArtifactError); expect((error as Error).message).not.toContain(secret); }
    }
  });

  it("requires valid SKILL.md metadata and UTF-8 while preserving arbitrary asset bytes", () => {
    for (const text of ["no metadata", "---\nname: bad Name\ndescription: valid\n---", "---\nname: valid\n---", "---\nname: valid\ndescription: \n---", "---\nname: valid\ndescription: ''\n---", '---\nname: valid\ndescription: "  "\n---', "---\nname: valid\ndescription: >\n   \n---", "---\nname: valid\ndescription: # comment\n---", "---\nname: valid\ndescription:\nother: value\n---", Buffer.from([0xff, 0xfe])]) expectCode(() => validateArtifact("skill", { files: [file("SKILL.md", text)] }), "ARTIFACT_INVALID");
    expect(validateArtifact("skill", { files: [file("SKILL.md", "---\nname: valid\ndescription: >\n  A meaningful description.\n---")] }).fileCount).toBe(1);
    expectCode(() => validateArtifact("skill", { files: [file("skill.md", skillText)] }), "ARTIFACT_INVALID");
    expectCode(() => validateArtifact("skill", { files: [] }), "ARTIFACT_INVALID");
  });

  it.each(["YQ", "YR==", "YQ===", "Y Q==", "YQ==\n", "====", "AA-_", "AA==AA=="])("rejects noncanonical base64 %j", (contentBase64) => {
    expectCode(() => validateArtifact("skill", { files: [{ ...file("SKILL.md", skillText), contentBase64 }] }), "ARTIFACT_INVALID");
  });

  it("parses ESM without trusting comments, strings, sync handlers, generators, imports, or extra files", () => {
    for (const invalidSource of [
      "// export async function handler() {}", 'const source = "export async function handler() {}";',
      "export function handler() {}", "export async function* handler() {}", "export default async function handler() {}",
      "export async function handler( {}", "export let handler = async () => {};", "export { handler } from './other.mjs';",
      "import x from 'dependency'; export async function handler() {}", "export async function handler() { return import('dependency'); }", "export * from './other.mjs';",
    ]) expectCode(() => validateArtifact("function", { files: [file("index.mjs", invalidSource)] }), "ARTIFACT_INVALID");
    expectCode(() => validateArtifact("function", { files: [file("index.mjs", Buffer.from([0xff]))] }), "ARTIFACT_INVALID");
    expectCode(() => validateArtifact("function", { files: [file("index.mjs", source), file("other.mjs", "")] }), "ARTIFACT_INVALID");
    for (const valid of [source, "export const handler = async () => {};", "const run = async function () {}; export { run as handler };", "async function run() {} export { run as handler };"]) expect(validateArtifact("function", { files: [file("index.mjs", valid)] }).fileCount).toBe(1);
  });
});

describe("hosted artifact size boundaries", () => {
  it("accepts 512 files and rejects 513", () => {
    const files = [file("SKILL.md", skillText), ...Array.from({ length: 511 }, (_, index) => file(`assets/file-${String(index)}`, ""))];
    expect(validateArtifact("skill", { files }).fileCount).toBe(512);
    expectCode(() => validateArtifact("skill", { files: [...files, file("one-too-many", "")] }), "ARTIFACT_LIMIT_EXCEEDED");
  });
  it("accepts 8 MiB per skill file and rejects one extra byte", () => {
    const files = [file("SKILL.md", skillText), file("assets/full.bin", Buffer.alloc(8 * 1024 * 1024))];
    expect(validateArtifact("skill", { files }).files.find((entry) => entry.path === "assets/full.bin")?.byteLength).toBe(8 * 1024 * 1024);
    expectCode(() => validateArtifact("skill", { files: [files[0], file("assets/full.bin", Buffer.alloc(8 * 1024 * 1024 + 1))] }), "ARTIFACT_LIMIT_EXCEEDED");
  });
  it("accepts exactly 32 MiB per bundle and rejects one extra byte", () => {
    const files = [file("SKILL.md", skillText), ...Array.from({ length: 3 }, (_, index) => file(`assets/${String(index)}.bin`, Buffer.alloc(8 * 1024 * 1024))), file("assets/remainder.bin", Buffer.alloc(8 * 1024 * 1024 - Buffer.byteLength(skillText)))];
    expect(validateArtifact("skill", { files }).byteCount).toBe(32 * 1024 * 1024);
    expectCode(() => validateArtifact("skill", { files: [...files, file("assets/extra.bin", Buffer.alloc(1))] }), "ARTIFACT_LIMIT_EXCEEDED");
  });
  it("accepts a 1 MiB function and rejects one extra byte", () => {
    const exact = source + " ".repeat(1024 * 1024 - Buffer.byteLength(source));
    expect(validateArtifact("function", { files: [file("index.mjs", exact)] }).byteCount).toBe(1024 * 1024);
    expectCode(() => validateArtifact("function", { files: [file("index.mjs", exact + " ")] }), "ARTIFACT_LIMIT_EXCEEDED");
  });
});

describe("reviewed GitHub issues input", () => {
  it("uses bounded defaults and accepts documented endpoints", () => {
    expect(parseIssuesInput({ repositoryId: "123" })).toEqual({ repositoryId: "123", state: "open", page: 1, limit: 20 });
    expect(parseIssuesInput({ repositoryId: "1", state: "all", page: 100, limit: 50 })).toEqual({ repositoryId: "1", state: "all", page: 100, limit: 50 });
    expect(parseIssuesInput({ repositoryId: "1", state: "closed", page: 1, limit: 1 }).state).toBe("closed");
  });
  it("rejects unknown fields, bad IDs/enums/ranges, and coercion", () => {
    for (const input of [
      {}, { repositoryId: 123 }, { repositoryId: "owner/repo" }, { repositoryId: "01" }, { repositoryId: "0" }, { repositoryId: "1".repeat(21) },
      { repositoryId: "1", state: "pending" }, ...[0, 101, 1.2, "1", null].map((page) => ({ repositoryId: "1", page })),
      ...[0, 51, 1.2, "20", null].map((limit) => ({ repositoryId: "1", limit })),
      ...["url", "headers", "method", "token", "scope"].map((key) => ({ repositoryId: "1", [key]: "forbidden" })),
    ]) expectCode(() => parseIssuesInput(input), "INVALID_REQUEST");
  });
});
