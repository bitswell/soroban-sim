import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  // Dev + Playwright leave PAGES_BASE unset -> base "/". The GitHub Pages build
  // sets PAGES_BASE=/soroban-sim/ so the jco glue's `new URL(core.wasm,
  // import.meta.url)` and all emitted assets resolve under the project path.
  base: process.env.PAGES_BASE ?? "/",
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  worker: {
    format: "es",
  },
});
