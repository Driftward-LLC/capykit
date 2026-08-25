const baseImage = "node:22.18.0-bookworm-slim@sha256:0d130e2ee18e88e1561375276daced6bff032539200173f2daf48c2e33f38ff5";
const imageName = "ghcr.io/driftward-llc/capykit";
const registryMount = "/registries/registry.json";

const containerfile = `ARG BASE_IMAGE=${baseImage}
FROM ${baseImage} AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    CAPYKIT_REGISTRY=${registryMount}

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY --chown=node:node dist ./dist
COPY --chown=node:node schemas ./schemas
COPY --chown=node:node README.md LICENSE ./

USER node
VOLUME ["/registries"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "import('./dist/mcp.js').then((m) => { m.createServer({ sources: [] }); })"]
ENTRYPOINT ["node", "dist/mcp.js"]
CMD ["--registry", "${registryMount}"]
`;

function metadata(version = "0.0.0") {
  return {
    image: imageName,
    version,
    baseImage,
    user: "node",
    registryMount,
    defaultRegistryMountMode: "read-only",
    healthCheck: "node -e import('./dist/mcp.js').then((m) => { m.createServer({ sources: [] }); })",
    requiredBuildArtifacts: ["dist", "schemas", "package.json", "package-lock.json", "README.md", "LICENSE"],
  };
}

function usage() {
  return [
    "Usage: node scripts/container-image.mjs <command>",
    "",
    "Commands:",
    "  print-containerfile       Print the generated pinned runtime Containerfile",
    "  print-metadata [version]  Print image metadata as JSON",
    "",
  ].join("\n");
}

const command = process.argv[2] ?? "help";
if (command === "print-containerfile") {
  process.stdout.write(containerfile);
} else if (command === "print-metadata") {
  process.stdout.write(`${JSON.stringify(metadata(process.argv[3] ?? "0.0.0"), null, 2)}\n`);
} else if (["help", "--help", "-h"].includes(command)) {
  process.stdout.write(usage());
} else {
  process.stderr.write(`Unknown container image command: ${command}\n\n${usage()}`);
  process.exitCode = 2;
}

export { baseImage, containerfile, imageName, metadata, registryMount };
