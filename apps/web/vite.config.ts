import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "/widthwatch/",
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        docs: resolve(root, "docs.html"),
        proofBaseline: resolve(root, "proof-baseline.html"),
        proofCandidate: resolve(root, "proof-candidate.html"),
      },
    },
  },
});
