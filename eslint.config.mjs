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
    // Nested build artifacts (git worktrees under .claude carry their own .next/).
    "**/.next/**",
    ".claude/**",
  ]),
  {
    // The fetch-on-mount data hooks call an async fetcher from useEffect. The
    // React 19 rule cannot prove the setState calls happen post-await (they do,
    // inside try/finally after `await fetch`), so it false-positives on the
    // canonical data-fetching effect. Keep it as a warning so genuine cascading
    // setState patterns still surface without blocking on known-safe fetches.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
