import { describe, expect, it } from "vitest";
import { environmentProfileSchema, parseEnvironmentProfile } from "../src/core/profile-schema.js";

const minimalProfile = {
  format: "capykit.environmentProfile.v0.1",
  id: "research-tools",
  version: "1.2.3",
  name: "Research tools",
  registry: "registry/tools.json",
};

describe("portable environment profile schema", () => {
  it("defaults optional arrays and accepts pinned tools, skills, and connection instructions", () => {
    expect(parseEnvironmentProfile(minimalProfile)).toEqual({ ...minimalProfile, skills: [], tools: [], connections: [] });
    const complete = {
      ...minimalProfile,
      version: "1.2.3-beta.2",
      skills: [{ id: "research-sources", path: "skills/research-sources" }],
      tools: [
        { command: "capykit", npm: { package: "@driftward/capykit", version: "0.1.1" } },
        { command: "jq", instructions: "Install jq using your operating system package manager." },
      ],
      connections: [{ id: "workspace", summary: "Workspace access", instructions: "Sign in with the workspace CLI." }],
    };
    expect(parseEnvironmentProfile(complete)).toEqual(complete);
  });

  it.each(["/registry.json", "../registry.json", "registry/../file.json", "./registry.json", "registry/./file.json", "registry//file.json", "registry/", "", ".", "..", "C:/registry.json", "C:registry.json", "registry\\file.json", "registry/\0file.json"])("rejects unsafe or ambiguous bundled path %j", (path) => {
    expect(environmentProfileSchema.safeParse({ ...minimalProfile, registry: path }).success).toBe(false);
    expect(environmentProfileSchema.safeParse({ ...minimalProfile, skills: [{ id: "research", path }] }).success).toBe(false);
  });

  it.each(["^1.2.3", "~1.2.3", "1.x", "latest", "1.2", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3-", "1.2.3+build", "https://example.com/package.tgz", "1.2.3 --ignore-scripts"])("rejects unpinned or invalid version %j", (version) => {
    expect(environmentProfileSchema.safeParse({ ...minimalProfile, version }).success).toBe(false);
    expect(environmentProfileSchema.safeParse({ ...minimalProfile, tools: [{ command: "example", npm: { package: "example", version } }] }).success).toBe(false);
  });

  it.each([".env.json", "node_modules/registry.json", ".GIT/registry.json", "data/credentials.json", "cookies.json"])("rejects reserved bundle path %j before installation", (registry) => {
    expect(() => parseEnvironmentProfile({ ...minimalProfile, registry })).toThrow(/credential, environment, or dependency/);
    expect(() => parseEnvironmentProfile({ ...minimalProfile, skills: [{ id: "review", path: `${registry}/review` }] })).toThrow(/credential, environment, or dependency/);
  });

  it.each(["0.0.0", "10.20.30", "1.2.3-alpha", "1.2.3-0", "1.2.3-01alpha.2.beta-3"])("accepts exact semantic version %j", (version) => {
    expect(environmentProfileSchema.safeParse({ ...minimalProfile, version }).success).toBe(true);
  });

  it.each(["../package", "file:package", "https://example.com/package.tgz", "git+https://example.com/package", "package@latest", "package --registry=https://example.com", "--global", "Package", "@Scope/package", "@scope/../package", "@scope/.package", "node_modules", "favicon.ico", "package;whoami", "$(whoami)"])("rejects invalid npm package or install argument %j", (packageName) => {
    expect(environmentProfileSchema.safeParse({ ...minimalProfile, tools: [{ command: "example", npm: { package: packageName, version: "1.2.3" } }] }).success).toBe(false);
  });

  it.each(["/bin/tool", "../tool", "tool --flag", "tool;whoami", "$(whoami)", "--option", ""])("rejects non-executable command token %j", (command) => {
    expect(environmentProfileSchema.safeParse({ ...minimalProfile, tools: [{ command }] }).success).toBe(false);
  });

  it.each([
    { skills: [{ id: "same", path: "skills/one" }, { id: "same", path: "skills/two" }] },
    { skills: [{ id: "one", path: "skills/same" }, { id: "two", path: "skills/same" }] },
    { tools: [{ command: "same" }, { command: "same", instructions: "Install it." }] },
    { connections: [{ id: "same", summary: "First", instructions: "Sign in." }, { id: "same", summary: "Second", instructions: "Sign in." }] },
  ])("rejects duplicate declared entries: %j", (entries) => {
    expect(() => parseEnvironmentProfile({ ...minimalProfile, ...entries })).toThrow(/Duplicate/);
  });

  it("requires Agent Skills names and matching, non-overlapping directory roots", () => {
    for (const id of ["research.sources", "research_sources", "Research", "research--sources", "-research", "research-", "a".repeat(65)]) {
      expect(environmentProfileSchema.safeParse({ ...minimalProfile, skills: [{ id, path: `skills/${id}` }] }).success).toBe(false);
    }
    expect(() => parseEnvironmentProfile({ ...minimalProfile, skills: [{ id: "research", path: "skills/other" }] })).toThrow(/directory name must match/);
    expect(() => parseEnvironmentProfile({ ...minimalProfile, skills: [{ id: "research", path: "skills/research" }, { id: "sources", path: "skills/research/sources" }] })).toThrow(/must not be nested/);
    for (const registry of ["skills/research", "skills/research/registry.json"]) {
      expect(() => parseEnvironmentProfile({ ...minimalProfile, registry, skills: [{ id: "research", path: "skills/research" }] })).toThrow(/outside all declared skill directories/);
    }
    expect(environmentProfileSchema.safeParse({ ...minimalProfile, registry: "skills/research-other/registry.json", skills: [{ id: "research", path: "skills/research" }] }).success).toBe(true);
  });

  it("allows commands sharing one pinned package and rejects conflicting versions", () => {
    const tools = [
      { command: "example", npm: { package: "example", version: "1.2.3" } },
      { command: "example-server", npm: { package: "example", version: "1.2.3" } },
    ];
    expect(parseEnvironmentProfile({ ...minimalProfile, tools }).tools).toEqual(tools);
    expect(() => parseEnvironmentProfile({ ...minimalProfile, tools: [...tools, { command: "example-other", npm: { package: "example", version: "2.0.0" } }] })).toThrow(/same exact version/);
  });

  it("rejects unsupported fields at every object boundary without leaking keys or values", () => {
    for (const fields of [
      { "private-field-marker": "private-value-marker" },
      { skills: [{ id: "research", path: "skills/research", "private-field-marker": "private-value-marker" }] },
      { tools: [{ command: "example", "private-field-marker": "private-value-marker" }] },
      { tools: [{ command: "example", npm: { package: "example", version: "1.2.3", "private-field-marker": "private-value-marker" } }] },
      { connections: [{ id: "workspace", summary: "Access", instructions: "Sign in.", "private-field-marker": "private-value-marker" }] },
    ]) {
      let error: unknown;
      try { parseEnvironmentProfile({ ...minimalProfile, ...fields }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Remove unsupported fields");
      expect(String(error)).not.toMatch(/private-field-marker|private-value-marker/);
    }
    expect(() => parseEnvironmentProfile({ ...minimalProfile, id: "PRIVATE-VALUE-MARKER" })).toThrow(/id: Use a lowercase identifier/);
    expect(() => parseEnvironmentProfile({ ...minimalProfile, id: "PRIVATE-VALUE-MARKER" })).not.toThrow(/PRIVATE-VALUE-MARKER/);
  });

  it("enforces bounded text and array sizes and rejects blank descriptions", () => {
    for (const fields of [
      { name: " " },
      { registry: "a".repeat(1025) },
      { tools: [{ command: "example", instructions: " " }] },
      { tools: [{ command: "example", instructions: "a".repeat(8001) }] },
      { skills: Array.from({ length: 65 }, (_, index) => ({ id: `skill-${String(index)}`, path: `skills/skill-${String(index)}` })) },
      { tools: Array.from({ length: 65 }, (_, index) => ({ command: `tool-${String(index)}` })) },
      { connections: Array.from({ length: 65 }, (_, index) => ({ id: `connection-${String(index)}`, summary: "Access", instructions: "Sign in." })) },
      { connections: [{ id: "workspace", summary: " ", instructions: "Sign in." }] },
    ]) expect(environmentProfileSchema.safeParse({ ...minimalProfile, ...fields }).success).toBe(false);
  });

  it("rejects trailing line breaks that regular expression dollar anchors would otherwise accept", () => {
    for (const fields of [
      { id: "research\n" },
      { version: "1.2.3\n" },
      { registry: "registry.json\n" },
      { tools: [{ command: "example\n" }] },
      { tools: [{ command: "example", npm: { package: "example\n", version: "1.2.3" } }] },
      { skills: [{ id: "research\n", path: "skills/research\n" }] },
    ]) expect(environmentProfileSchema.safeParse({ ...minimalProfile, ...fields }).success).toBe(false);
  });

  it.each(["profile.json", "PROFILE.JSON", "Profile.Json/registry.json"])("reserves the snapshot manifest path %j", (registry) => {
    expect(() => parseEnvironmentProfile({ ...minimalProfile, registry })).toThrow(/reserved for the profile manifest/);
  });

  it.each(["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9", "con.txt", "aux.tar.gz", "name."])("rejects nonportable filename %j in ids and path segments", (name) => {
    for (const fields of [
      { id: name },
      { registry: `registry/${name.toUpperCase()}/tools.json` },
      { registry: `registry/${name}` },
      { skills: [{ id: name, path: `skills/${name}` }] },
      { skills: [{ id: "research", path: `${name.toUpperCase()}/research` }] },
    ]) expect(environmentProfileSchema.safeParse({ ...minimalProfile, ...fields }).success).toBe(false);
  });

  it("compares Windows command and skill path collisions without case sensitivity", () => {
    expect(() => parseEnvironmentProfile({ ...minimalProfile, tools: [{ command: "Example" }, { command: "example" }] })).toThrow(/Duplicate command/);
    expect(() => parseEnvironmentProfile({ ...minimalProfile, skills: [{ id: "research", path: "skills/research" }, { id: "research", path: "SKILLS/research" }] })).toThrow(/Duplicate path/);
    expect(() => parseEnvironmentProfile({ ...minimalProfile, skills: [{ id: "research", path: "skills/research" }, { id: "sources", path: "SKILLS/RESEARCH/sources" }] })).toThrow(/must not be nested/);
    expect(() => parseEnvironmentProfile({ ...minimalProfile, registry: "SKILLS/RESEARCH/registry.json", skills: [{ id: "research", path: "skills/research" }] })).toThrow(/outside all declared skill directories/);
    expect(environmentProfileSchema.safeParse({ ...minimalProfile, id: "com10", registry: "registries/profile.json", skills: [{ id: "lpt10", path: "skills/lpt10" }] }).success).toBe(true);
  });
});
