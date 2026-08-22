import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  worker: {
    format: "es",
  },
});
