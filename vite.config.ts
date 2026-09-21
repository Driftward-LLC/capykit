import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/console",
  build: { outDir: "../../dist/console", emptyOutDir: false },
});
