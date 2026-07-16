# Adversarial Review — Round 3 (2026-07-16) — Final Verification

Two-agent sweep: (1) re-test every R1+R2 fix live, (2) green up the pre-existing test debt. Verdict: **the R1/R2 remediation HOLDS** — one real residual + one straggler, both fixed here.

## Verification (all HOLD, live/code-confirmed)
- Non-UUID `[id]` → 404/400 (5 spot-checks); valid UUID → 200.
- reports / insights / operations render real data (no 500, no endless skeleton).
- Mutation validation: malformed JSON→400, memberPrice>price→400, name>200→400, price/minCents overflow→400.
- **Auto-assign hard gate INTACT** (the scoped fallback): unclassified→first-fit, classified-no-match→`[]`; suggest panel still gets a fallback shortlist.
- Portal pay: strict `amount==balance` (no $0.01 trickle).
- **Perf improved**: ai-insights 4.1s→**0.8s**, dispatch/map 2.2s→**1.4s**, conversations 1.6s→**0.64s**.
- `adminFetch` 401→login across hooks; AbortController/run-counter preserved.
- Admin `error.tsx` present; a11y (scope=col, no `tr role`, contrast AA, Alert politeness) all in place.
- `isFetchingRef`→latest-wins holds in the 3 R1 hooks; `use-reviews` uses runRef.
- Security: `clientIp()` (x-real-ip preferred) is the sole XFF parser — 0 raw `x-forwarded-for` outside it.

## Fixed this round
- **[MEDIUM] Dup unique-key → 500 instead of 409 (root-caused).** The `isUniqueViolation` copies in 8 routes checked the TOP-LEVEL `.code`, but Drizzle wraps the driver error in a `DrizzleQueryError` whose `.code` is `undefined` — the real `23505`/`.constraint` live on `.cause`. That's why the fix failed twice. New shared `src/lib/db/unique-violation.ts` walks the `.cause` chain; all 8 routes now use it. Verified live: dup SKU → **409**.
- **[LOW] `use-admin-requests` / `use-reviews` latest-wins.** Both still had the `isFetchingRef` drop-guard (R2 added `adminFetch` but not the runRef conversion) — converted to the monotonic run-counter.
- **Test debt green (0 failures, 3781 pass):** `tests/api/{invoice-pay-link,invoice-send-reminder,money-routes}` updated to use valid UUIDs (the isUuid guards are correct) + the no-money-values audit assertion; `money-triggers` given a `server-only` mock.

## Known residual (INFO — documented, not regressions, out of 3-round scope)
- **~11 other hooks** still use the `isFetchingRef` drop-guard (`use-estimates`, `use-admin-staff`, `use-bot-analytics`, `use-dashboard-overview`, `use-org-settings`, etc.). Low risk (drop only on rapid interaction during a poll, self-heals). Convert opportunistically.
- Deferred infra/consistency (from R2): Upstash cross-instance rate limits; operations-metrics `first_in_progress_at` trigger; canonical `formatAdminDateTime` across ~15 sites; `motion-reduce` on spinners; demo-org cross-origin session guard.
- Dev-only: pino `MaxListenersExceededWarning` (cosmetic).

**3-round program complete.** ~55 real defects fixed across R1 (blockers/500s/audit/AR), R2 (security/perf/error/a11y), R3 (dup-key/latest-wins/tests). Money engine independently confirmed atomic; security posture solid.
