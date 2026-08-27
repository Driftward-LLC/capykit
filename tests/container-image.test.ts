import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const nodeCommand = process.execPath;
const scriptPath = fileURLToPath(new URL("../scripts/container-image.mjs", import.meta.url));
const releaseWorkflowPath = fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url));

function runScript(...args: readonly string[]): string {
  return execFileSync(nodeCommand, [scriptPath, ...args], { encoding: "utf8" });
}

describe("container image packaging contract", () => {
  it("generates a pinned non-root runtime Containerfile without bundled registry credentials", () => {
    const containerfile = runScript("print-containerfile");

    expect(containerfile).toContain("FROM node:22.18.0-bookworm-slim@sha256:0d130e2ee18e88e1561375276daced6bff032539200173f2daf48c2e33f38ff5 AS runtime");
    expect(containerfile).toContain("USER node");
    expect(containerfile).toContain('VOLUME ["/registries"]');
    expect(containerfile).toContain("HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3");
    expect(containerfile).toContain('ENTRYPOINT ["node", "dist/mcp.js"]');
    expect(containerfile).toContain('CMD ["--registry", "/registries/registry.json"]');
    expect(containerfile).not.toMatch(/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|npmrc/i);
  });

  it("publishes deterministic image metadata for versioned GHCR builds", () => {
    const metadata = JSON.parse(runScript("print-metadata", "1.2.3")) as Record<string, unknown>;

    expect(metadata).toEqual(expect.objectContaining({
      image: "ghcr.io/driftward-llc/capykit",
      version: "1.2.3",
      user: "node",
      registryMount: "/registries/registry.json",
      defaultRegistryMountMode: "read-only",
    }));
    expect(metadata.baseImage).toEqual(expect.stringMatching(/^node:22\.18\.0-bookworm-slim@sha256:[a-f0-9]{64}$/));
    expect(metadata.requiredBuildArtifacts).toEqual(["dist", "schemas", "package.json", "package-lock.json", "README.md", "LICENSE"]);
  });

  it("publishes versioned multi-architecture GHCR images from tagged releases", () => {
    const workflow = readFileSync(releaseWorkflowPath, "utf8");

    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("CAPYKIT_IMAGE: ghcr.io/driftward-llc/capykit");
    expect(workflow).toContain("node scripts/container-image.mjs print-containerfile");
    expect(workflow).toContain("docker/setup-buildx-action@v3");
    expect(workflow).toContain("docker/login-action@v3");
    expect(workflow).toContain("docker/build-push-action@v6");
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
    expect(workflow).toContain("push: true");
    expect(workflow).toContain("${{ env.CAPYKIT_IMAGE }}:${{ steps.release.outputs.version }}");
    expect(workflow).toContain("${{ env.CAPYKIT_IMAGE }}:sha-${{ steps.release.outputs.short_sha }}");
    expect(workflow).toContain("provenance: true");
    expect(workflow).toContain("sbom: true");
    expect(workflow).not.toMatch(/ghcr\.io\/driftward-llc\/capykit:latest/u);
  });
});
