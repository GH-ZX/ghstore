import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@store/core": r("./packages/core/src/index.ts"),
      "@store/suppliers": r("./packages/suppliers/src/index.ts"),
      "@store/payments": r("./packages/payments/src/index.ts"),
      "@store/api": r("./packages/api/src/index.ts"),
      "@store/ui": r("./packages/ui/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // API tests share one database; run files one after another.
    fileParallelism: false,
  },
});
