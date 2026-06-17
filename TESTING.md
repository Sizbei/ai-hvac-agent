# Testing

## Test layers

| Command | What it runs | Blocks CI? | Needs a DB/secrets? |
| --- | --- | --- | --- |
| `npm run test:unit` | Vitest, offline suites only (excludes the integration suites below) | **Yes** (blocking gate) | No |
| `npm run test:integration` | Vitest, ONLY the DB/secret-dependent suites | No | Yes |
| `npm run test:coverage` | `test:unit` + V8 coverage report (report-only) | No | No |
| `npm run test:e2e` | Playwright | No (non-blocking) | Yes (live server + DB) |
| `npm test` | Alias for the full Vitest run | — | — |

`test` and `test:unit` are both `vitest run`; the unit gate's exclusions live in
`vitest.config.ts`, so the plain run already skips the integration suites.

## The CI unit gate

`.github/workflows/ci.yml` runs `npm run test:unit` as a **blocking** job
(`unit-tests`). It must stay green on every PR. Playwright (`e2e` job) and the
DB-dependent integration suites are **not** part of this gate.

Before today, CI ran only Playwright — which cannot pass without a live database
— so the ~2,300 Vitest tests gated nothing. The `unit-tests` job makes those
tests meaningful.

## Excluded suites (and why)

These suites throw at **import time** (before any assertion) because they open a
real database connection or pull `server-only` through an unmocked server
module. They are environment-gated, **not** regressions, and cannot pass in the
offline gate. They are excluded from `test:unit` and run via
`test:integration`:

- `tests/api/fieldpulse-connect.test.ts` — imports `server-only` via an unmocked
  server module ("This module cannot be imported from a Client Component").
- `tests/api/fieldpulse-job-sync.test.ts` — requires `DATABASE_URL`.
- `tests/api/fieldpulse-webhook-security.test.ts` — requires `DATABASE_URL`.

(`tests/api/fieldpulse-invoice-webhook.test.ts` mocks its dependencies and runs
fine in the unit gate, so it is **not** excluded.)

The exclusion list is defined once in `vitest.config.ts` (`INTEGRATION_SUITES`).
To run only those suites against a real DB:

```bash
DATABASE_URL=... npm run test:integration
```

## Coverage

Coverage runs in **report-only** mode: the 80% threshold on `src/lib/**` is the
target but is **not** enforced yet, so CI is never blocked on an unmet number
while the gate is being established. Enforce it once the suite reliably clears
it:

```bash
VITEST_COVERAGE_ENFORCE=1 npm run test:coverage
```
