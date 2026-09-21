import { build } from "tsup";

await build({
  entry: { "hosted-api": "src/hosted/server.ts", "hosted-worker": "src/hosted/worker.ts" },
  format: ["esm"],
  target: "node22",
  clean: false,
  dts: true,
  sourcemap: true,
  splitting: false,
  banner: { js: "#!/usr/bin/env node" },
});
