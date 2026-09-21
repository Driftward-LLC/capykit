import { z } from "zod";

const token = z.string().refine((value) => value === value.trim(), "Remove surrounding whitespace.");
function portableFilename(value: string): boolean {
  return !value.endsWith(".") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);
}
const identifier = token.max(128).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, "Use a lowercase identifier with letters, numbers, and single '.', '_', or '-' separators.");
const exactVersion = token.max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/, "Use an exact X.Y.Z version with an optional valid prerelease; ranges, tags, and URLs are not supported.");
const portablePath = token.min(1).max(1024).refine(
  (value) => /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) && value.split("/").every(portableFilename),
  "Use a bundle-relative POSIX path with letters, numbers, '.', '_', or '-'; absolute paths, backslashes, empty segments, trailing dots, and Windows device names are not supported.",
).refine((value) => value.split("/").every((part) => !/^(?:\.env(?:\..*)?|\.npmrc|\.git|node_modules|credentials?\.json|cookies?\.json)$/iu.test(part)), "Bundle paths must not use credential, environment, or dependency directory names.");
const instructions = z.string().min(1).max(8000).refine((value) => value.trim().length > 0, "Provide nonempty instructions.");
const npmPackage = token.max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "Use a lowercase npm package name or @scope/name; URLs, paths, and install arguments are not supported.")
  .refine((value) => value !== "node_modules" && value !== "favicon.ico", "Use a valid npm package name; reserved names are not supported.");

export const environmentProfileSchema = z.strictObject({
  format: z.literal("capykit.environmentProfile.v0.1"),
  id: identifier.refine(portableFilename, "Profile ids must not use Windows device names or end with a dot."),
  version: exactVersion,
  name: z.string().min(1).max(256).refine((value) => value.trim().length > 0, "Provide a nonempty profile name."),
  registry: portablePath.refine((value) => value.toLowerCase() !== "profile.json" && !value.toLowerCase().startsWith("profile.json/"), "The root profile.json path is reserved for the profile manifest; choose a separate registry path."),
  skills: z.array(z.strictObject({
    id: token.max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use an Agent Skills name with lowercase letters, numbers, and single hyphen separators.")
      .refine(portableFilename, "Skill ids must not use Windows device names or end with a dot."),
    path: portablePath,
  })).max(64).default([]),
  tools: z.array(z.strictObject({
    command: token.max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "Use a single executable name without paths, whitespace, or shell arguments."),
    npm: z.strictObject({ package: npmPackage, version: exactVersion }).optional(),
    instructions: instructions.optional(),
  })).max(64).default([]),
  connections: z.array(z.strictObject({
    id: identifier,
    summary: z.string().min(1).max(1024).refine((value) => value.trim().length > 0, "Provide a nonempty connection summary."),
    instructions,
  })).max(64).default([]),
}).superRefine((profile, context) => {
  for (const { field, key, values } of [
    { field: "skills", key: "id", values: profile.skills.map((skill) => skill.id) },
    { field: "skills", key: "path", values: profile.skills.map((skill) => skill.path.toLowerCase()) },
    { field: "tools", key: "command", values: profile.tools.map((tool) => tool.command.toLowerCase()) },
    { field: "connections", key: "id", values: profile.connections.map((connection) => connection.id) },
  ]) {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) context.addIssue({ code: "custom", path: [field, index, key], message: `Duplicate ${key}; each ${field} entry must be unique.` });
      seen.add(value);
    });
  }
  profile.skills.forEach((skill, index) => {
    if (skill.path.split("/").at(-1) !== skill.id) {
      context.addIssue({ code: "custom", path: ["skills", index, "path"], message: "The skill directory name must match its id." });
    }
    if (profile.skills.some((other) => skill.path.toLowerCase().startsWith(`${other.path.toLowerCase()}/`))) {
      context.addIssue({ code: "custom", path: ["skills", index, "path"], message: "Skill directories must not be nested inside another declared skill directory." });
    }
    if (profile.registry.toLowerCase() === skill.path.toLowerCase() || profile.registry.toLowerCase().startsWith(`${skill.path.toLowerCase()}/`)) {
      context.addIssue({ code: "custom", path: ["registry"], message: "The registry file must be outside all declared skill directories." });
    }
  });
  const packageVersions = new Map<string, string>();
  profile.tools.forEach((tool, index) => {
    if (tool.npm === undefined) return;
    const previous = packageVersions.get(tool.npm.package);
    if (previous !== undefined && previous !== tool.npm.version) {
      context.addIssue({ code: "custom", path: ["tools", index, "npm", "version"], message: "Commands sharing an npm package must use the same exact version." });
    }
    packageVersions.set(tool.npm.package, tool.npm.version);
  });
});

export type EnvironmentProfile = z.infer<typeof environmentProfileSchema>;

export function parseEnvironmentProfile(value: unknown): EnvironmentProfile {
  const parsed = environmentProfileSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((issue) => {
    const location = issue.path.length === 0 ? "profile" : issue.path.join(".");
    const message = issue.code === "unrecognized_keys" ? "Remove unsupported fields; only declared profile fields are allowed." : issue.message;
    return `${location}: ${message}`;
  });
  throw new Error(`Invalid environment profile: ${issues.join("; ")} Profile values were redacted.`);
}
