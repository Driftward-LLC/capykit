import { defineConfig } from "tsup";
export default defineConfig({
  entry: { core: "src/core/index.ts", cli: "src/cli/index.ts", mcp: "src/mcp/index.ts", schemas: "src/schemas/index.ts" },
  format: ["esm"], target: "node22", clean: true, dts: true, sourcemap: true, splitting: false,
  banner: { js: "#!/usr/bin/env node" },
});