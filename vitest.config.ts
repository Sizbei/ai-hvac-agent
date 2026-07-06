import { defineConfig } from "vitest/config";
import path from "path";

// Suites that cannot run in the offline CI unit gate: they import a real
// database connection (DATABASE_URL) or pull `server-only` through an
// unmocked server module, so they throw at IMPORT time before any assertion
// runs. They are NOT regressions — they need a provisioned DB + secrets. They
// run via `npm run test:integration` (locally / a DB-backed CI job), and are
// excluded from `npm run test:unit` (the blocking gate) so it stays green and
// meaningful. See TESTING.md.
const INTEGRATION_SUITES = [
  "tests/api/fieldpulse-connect.test.ts",
  "tests/api/fieldpulse-job-sync.test.ts",
  "tests/api/fieldpulse-webhook-security.test.ts",
  // Technician field-app API suites: import real DB-backed query modules
  // (DATABASE_URL) and throw at import in the offline gate — same class as the
  // FieldPulse suites above.
  "tests/api/tech-photo.test.ts",
  "tests/api/tech-timeline.test.ts",
];

// `npm run test:integration` sets this to invert the selection: run ONLY the
// DB/secret-dependent suites instead of excluding them.
const RUN_INTEGRATION = process.env.VITEST_INTEGRATION === "1";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: RUN_INTEGRATION
      ? INTEGRATION_SUITES
      : ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    exclude: RUN_INTEGRATION
      ? []
      : ["**/node_modules/**", "**/dist/**", ...INTEGRATION_SUITES],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/db/**",
        "src/lib/logger.ts",
        "src/lib/session.ts",
        "src/lib/ai/extract.ts",
        "src/lib/ai/system-prompt.ts",
        "**/*.test.ts",
      ],
      // Coverage runs in REPORT-ONLY mode by default so CI is never blocked on
      // an unmet number while the gate is being established. Target is 80% on
      // src/lib/**; flip enforcement on (locally or in CI) with
      // VITEST_COVERAGE_ENFORCE=1 once the suite reliably clears it.
      thresholds:
        process.env.VITEST_COVERAGE_ENFORCE === "1"
          ? { lines: 80, functions: 80, branches: 80, statements: 80 }
          : undefined,
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
