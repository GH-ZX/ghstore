// pnpm lint: the checks the type checker does not make. A promise nobody awaits
// can be cut off when the Worker's request ends (or fail without a trace), and an
// import cycle makes a module see another half-loaded. Formatting is left alone.
import tseslint from "typescript-eslint";
import { createNodeResolver, importX } from "eslint-plugin-import-x";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "apps/web/public/**", "apps/web/.wrangler/**"] },
  {
    files: ["store.config.ts", "packages/*/src/**/*.ts", "apps/web/src/**/*.ts", "apps/web/client/src/**/*.{ts,tsx}"],
    extends: [tseslint.configs.base],
    languageOptions: {
      // Each file is checked with the tsconfig.json nearest to it (root, apps/web, apps/web/client).
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "import-x": importX },
    settings: {
      "import-x/resolver-next": [
        createNodeResolver({
          extensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
          tsconfig: { configFile: "tsconfig.base.json" },
        }),
      ],
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      "import-x/no-cycle": "error",
    },
  },
  {
    // The web app: React's event props take async handlers (each handles its own errors);
    // everything else about promises is checked as on the server.
    files: ["apps/web/client/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
