import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { parseEnvironmentProfile, type EnvironmentProfile } from "./profile-schema.js";

const execFileAsync = promisify(execFile);

export function profileNpmInstallPlan(profile: EnvironmentProfile, prefix: string): { command: string; args: string[]; binPath: string; packages: string[] } {
  const validated = parseEnvironmentProfile(profile);
  if (!isAbsolute(prefix)) throw new Error("Dependency installation requires an absolute managed prefix.");
  const packages = [...new Set(validated.tools.flatMap((tool) => tool.npm === undefined ? [] : [`${tool.npm.package}@${tool.npm.version}`]))];
  const args = ["install", "--prefix", prefix, "--global=false", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--package-lock=true", "--bin-links=true", ...packages];
  const binPath = join(prefix, "node_modules", ".bin");
  if (process.platform !== "win32") return { command: "npm", args, binPath, packages };
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return { command: process.execPath, args: [npmCli, ...args], binPath, packages };
}

export async function installProfileDependencies(profile: EnvironmentProfile, prefix: string, options: { execFile?: (command: string, args: readonly string[]) => Promise<void> } = {}): Promise<void> {
  const plan = profileNpmInstallPlan(profile, prefix);
  if (plan.packages.length === 0) return;
  if (process.platform === "win32" && options.execFile === undefined && !existsSync(plan.args[0] ?? "")) throw new Error("Automatic npm installation is unavailable on this Windows Node installation; manual installation required. Install Node with its bundled npm or follow the profile's installation instructions.");
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  if (!(await lstat(prefix)).isDirectory()) throw new Error("Dependency installation prefix must be a directory, not a symlink.");
  for (const name of ["package-lock.json", "npm-shrinkwrap.json", "node_modules", ".npmrc"]) {
    try {
      const info = await lstat(join(prefix, name));
      if (info.isSymbolicLink() || (name === "node_modules" ? !info.isDirectory() : !info.isFile())) throw new Error("Managed npm files and directories must not be symlinks or special files.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const manifestPath = join(prefix, "package.json");
  try {
    await writeFile(manifestPath, `${JSON.stringify({ private: true }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lstat(manifestPath)).isFile()) throw new Error("Dependency package.json must be a regular file, not a symlink.");
  }
  try {
    if (options.execFile !== undefined) await options.execFile(plan.command, plan.args);
    else await execFileAsync(plan.command, plan.args, { shell: false, timeout: 120_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
  } catch {
    throw new Error("Pinned npm dependency installation failed. Check npm availability and registry access, then retry. Installer output was suppressed.");
  }
}
