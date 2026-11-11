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
  // Technician field-app API suite: imports real DB-backed query modules
  // (DATABASE_URL) and throws at import in the offline gate — same class as the
  // FieldPulse suites above. (tests/api/tech-photo.test.ts is fully mocked and
  // runs in the unit gate.)
  "tests/api/tech-timeline.test.ts",
  // Setup guide stamps/flags against the dev DB (throwaway orgs; refuses prod).
  "tests/integration/onboarding-state.test.ts",
  // M3b field invoices: writers + idempotency against the dev DB (throwaway org).
  "tests/integration/field-invoice.test.ts",
  // Technician getting-started guide: derivation + stamps against the dev DB (two throwaway orgs).
  "tests/integration/tech-guide.test.ts",
  // Hold → schedule next visit: office placement vs the technician's phone (one throwaway org).
  "tests/integration/hold-next-visit.test.ts",
  // M3c sell on site: estimates, bill once, equipment against the dev DB (two throwaway orgs).
  "tests/integration/field-estimate.test.ts",
  // M3d forms + site view: writers, trigger, erase and site reads against the dev DB (throwaway orgs).
  "tests/integration/field-forms.test.ts",
  // Go-live: hidden_from_org un-hide triggers (migration 0059) against the dev DB (throwaway org).
  "tests/integration/golive-unhide.test.ts",
  // Go-live: activity un-hides work (migration 0061): requests, visits, invoices, messages (throwaway org).
  "tests/integration/golive-unhide-activity.test.ts",
  // Go-live marking builders + script: both modes, timezone boundary, refusals (one throwaway org).
  "tests/integration/golive-marking.test.ts",
  // Go-live hidden history: each sweep's reads against visibility-fixture.ts (one throwaway org each).
  "tests/integration/visibility-requests.test.ts",
  "tests/integration/visibility-customers.test.ts",
  "tests/integration/visibility-money.test.ts",
  "tests/integration/visibility-insights.test.ts",
  // Onboarding D1: per-user admin guide merge, isolation and read-only preview (two throwaway orgs).
  "tests/integration/admin-guide-state.test.ts",
  // P8 M7: go-live audit cutoff builder, CLI and since-bound reads (one throwaway org).
  "tests/integration/audit-history-cutoff.test.ts",
  // Final wave I1: badge count, dispatch link and calendar rail share one unscheduled set (one throwaway org).
  "tests/integration/unscheduled-set.test.ts",
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
