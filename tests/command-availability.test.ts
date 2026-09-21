import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCommandAvailability } from "../src/core/registry.js";

describe("command availability across platforms", () => {
  let directory: string;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "capykit-command-path-"));
  });

  afterEach(async () => {
    if (originalPlatform !== undefined) Object.defineProperty(process, "platform", originalPlatform);
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("finds Windows npm shims and executables through PATHEXT without requiring POSIX executable bits", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "portable-tool.cmd"), "@echo off\nexit /b 1\n", { mode: 0o600 });
    await writeFile(join(bin, "native-tool.exe"), "fixture executable presence only", { mode: 0o600 });
    const path = `${join(directory, "missing")};${bin}`;

    for (const command of ["portable-tool", "portable-tool.cmd", "native-tool"]) {
      expect(await checkCommandAvailability(command, { path })).toEqual({ status: "available", command, checked: true, reason: "present_on_path" });
    }
    expect(await checkCommandAvailability("missing-tool", { path })).toMatchObject({ status: "unavailable", reason: "missing_on_path" });
  });

  it("uses default Windows extensions when PATHEXT is absent and respects explicit PATH isolation", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("PATHEXT", undefined);
    vi.stubEnv("PATH", directory);
    await writeFile(join(directory, "portable-tool.cmd"), "fixture", { mode: 0o600 });

    expect(await checkCommandAvailability("portable-tool")).toMatchObject({ status: "available" });
    expect(await checkCommandAvailability("portable-tool", { path: join(directory, "missing") })).toMatchObject({ status: "unavailable" });
    expect(await checkCommandAvailability("portable-tool", { path: "" })).toMatchObject({ status: "unavailable" });
  });

  it("ignores unsafe PATHEXT entries and preserves command validation and approval checks", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("PATHEXT", ".CMD;.foo/../../outside;.foo\\..\\outside;.CMD --unsafe");
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "outside"), "fixture", { mode: 0o600 });
    await mkdir(join(directory, "nested", "portable-tool.foo"));
    await mkdir(join(directory, "nested", "directory-tool.cmd"));
    const path = join(directory, "nested");

    expect(await checkCommandAvailability("portable-tool", { path })).toMatchObject({ status: "unavailable" });
    expect(await checkCommandAvailability("directory-tool", { path })).toMatchObject({ status: "unavailable" });
    expect(await checkCommandAvailability("portable-tool --unsafe", { path })).toEqual({ status: "skipped", command: undefined, checked: false, reason: "invalid_command" });
    expect(await checkCommandAvailability("portable-tool", { path, approvedCommands: [] })).toMatchObject({ status: "skipped", checked: false, reason: "not_approved" });
  });

  it("keeps POSIX lookup exact and requires executable permissions", async () => {
    if (originalPlatform?.value === "win32") return;
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("PATHEXT", ".CMD");
    await writeFile(join(directory, "exact-tool"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await writeFile(join(directory, "not-executable"), "fixture", { mode: 0o600 });
    await writeFile(join(directory, "portable-tool.cmd"), "fixture", { mode: 0o700 });
    const path = [join(directory, "missing"), directory].join(delimiter);

    expect(await checkCommandAvailability("exact-tool", { path })).toMatchObject({ status: "available" });
    expect(await checkCommandAvailability("not-executable", { path })).toMatchObject({ status: "unavailable" });
    expect(await checkCommandAvailability("portable-tool", { path })).toMatchObject({ status: "unavailable" });
  });
});
