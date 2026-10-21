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
  // Workers load the component glue after the page, so Vite would discover
  // its WASI shims (and the plan importer's YAML parser) late, re-optimize,
  // and reload every open page. Bundle them up front.
  optimizeDeps: {
    include: [
      "@theahaco/soroban-sim > @bytecodealliance/preview2-shim/cli",
      "@theahaco/soroban-sim > @bytecodealliance/preview2-shim/clocks",
      "@theahaco/soroban-sim > @bytecodealliance/preview2-shim/io",
      "yaml",
    ],
  },
});
