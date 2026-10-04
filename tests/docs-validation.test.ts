import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(root, ".docs-lint-test-"));
const cli = join(root, "node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs");

afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

function lint(name: string, content: string) {
  const path = join(directory, `${name}.md`);
  writeFileSync(path, content);
  return spawnSync(process.execPath, [cli, path], { cwd: root, encoding: "utf8" });
}

describe("shared Markdown validation", () => {
  it("accepts the long command that blocked ENG-149", () => {
    const result = lint("command", "# Fixture\n\n```bash\nnode dist/cli.js sources inspect --config /absolute/path/to/registry-sources.json --json\n```\n");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("still rejects long prose and invalid heading structure", () => {
    const prose = lint("prose", `# Fixture\n\n${"word ".repeat(18).trim()}\n`);
    expect(prose.status).not.toBe(0);
    expect(prose.stdout + prose.stderr).toContain("MD013/line-length");
    const headings = lint("headings", "# Fixture\n\n### Skipped level\n");
    expect(headings.status).not.toBe(0);
    expect(headings.stdout + headings.stderr).toContain("MD001/heading-increment");
  });

  it("runs the same pinned docs check locally, in Factory and in CI", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>; scripts: Record<string, string>;
    };
    expect(pkg.devDependencies["markdownlint-cli2"]).toBe("0.23.2");
    expect(pkg.scripts["check:docs"]).toBe('markdownlint-cli2 README.md "docs/**/*.md"');
    expect(pkg.scripts.check).toMatch(/^npm run check:docs && /u);
    const verifier = readFileSync(join(root, "scripts/factory-verification.mjs"), "utf8");
    expect(verifier).toContain('run(npmCommand, ["run", "check:docs"]);');
    const workflow = readFileSync(join(root, ".github/workflows/schema.yml"), "utf8");
    expect(workflow).toContain("  docs-lint:");
    expect(workflow).toContain("run: npm run check:docs");
    expect(workflow).not.toContain("npx --yes");
  });
});
