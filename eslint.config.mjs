import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Python service. Its virtualenv vendors scikit-learn, which ships
    // JavaScript for notebook widgets — several thousand files of third-party
    // code that ESLint walked on every run and reported warnings from. Ignoring
    // the whole `ml/` tree is right regardless: it is a separate language with
    // its own tooling, and `npm run ml:test` is its quality gate.
    "ml/**",
  ]),
]);

export default eslintConfig;
