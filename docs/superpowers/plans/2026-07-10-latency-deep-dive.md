# Latency Deep-Dive — findings + fix plan

**User report:** "everything is taking too long to load; latency is really bad; the site feels unintuitive."

## Root causes (measured live, 2026-07-10)

### ✅ FIXED-1: every lambda crashed after serving (the ~800ms flat tax)
`instrumentation.ts` → `validateEnvVars()` threw on missing `NEXT_PUBLIC_APP_URL`
(set locally, never set in Vercel) → `process exited with status 128` after each
request → **every request paid a full cold start**. Measured: `/api/health`
930ms → **310ms** after setting the env var (prod + preview) + redeploy
(`960a655`). ~310ms ≈ Asia→us-east network floor + ~50ms work.

### ✅ FIXED-2: dashboard stats endpoint 500 (not slow — broken)
`getDashboardStats` emergencyOpen CASE rendered `status IN [$1]` (invalid SQL,
Postgres 42601) via a raw template. Stat cards never loaded. Fixed with a
`sql.join` parameterized IN list; live 200 with correct source-aware counts.

### Remaining, in fix order
- **R1 — 900KB payloads:** `/api/admin/invoices` (860KB) and `/api/admin/customers`
  (919KB) ship every row+field on each visit — ~1s transfer on top of TTFB, per
  navigation, uncached.
- **R2 — zero client caching:** every navigation refetches everything; no
  stale-while-revalidate; bouncing between pages repays full latency each time.
- **R3 — perceived latency:** heavy pages render nothing until data lands (no
  skeletons); FP-import page polls at 10s even when idle.
- **R4 — sequential query chains:** e.g. invoices GET = listInvoices THEN
  collectedThisMonthCents. Second-order now that FIX-1 landed.
- **R5 — geography:** client (Asia) ↔ iad1 ≈ 250ms/request floor. Mitigate by not
  BLOCKING on requests (R2/R3); compute must stay near the DB.
- **R6 — DB divergence (fold in):** `.env.local` switched to `ep-patient-surf`
  Jul 9 19:30 (user action — Neon branch?). Prod (`ep-withered-hill`) is missing
  the custom-fields backfill (2 rows) + 6 customers that landed on patient-surf.
  Re-run `fp:import --phase customers` against PROD; confirm with the user what
  patient-surf is + which URL `.env.local` should carry (GH nightly secret +
  prior tooling target prod ✓).

## Fix plan
### Phase A — slim + cache the heavy endpoints (R1, R2)
Slim list rows to rendered fields (audit hook consumers; target ≤250KB);
`Cache-Control: private, stale-while-revalidate=30` on list GETs; hooks keep
last-good data in a module cache (render instantly, revalidate in background).
No new deps.
### Phase B — perceived performance (R3)
Skeletons on requests/invoices/customers/operations; sidebar `<Link>` prefetch
audit; FP-import page stops polling when no run is active.
### Phase C — parallelize route internals (R4)
Promise.all independent queries in invoices GET / dashboard overview /
operations metrics (verify each; some already parallel).
### Phase D — data re-sync + env hygiene (R6)
Customers re-run at prod; document per-env DB targets; wire patient-surf into
the environments plan once the user confirms its purpose.
### Phase E — measure + close
Re-run the timing battery; targets (warm, from Asia): health ≤350ms, list
endpoints ≤600ms TTFB + ≤300KB, in-app back-nav instant from cache.
Before/after table here.

## Deferred — "unintuitive"
IA/navigation polish is its own brainstorm once speed lands (speed may resolve
much of the feel).

---

## Phase E — closing measurements (2026-07-10, from Asia, warm)

| Path | Before | After | Change |
|---|---|---|---|
| `/api/health` (1 DB query) | 930ms every hit | **~310ms** | crash-loop fix; now ≈ network floor |
| `/api/admin/stats` | **HTTP 500** | 200, ~350ms warm | SQL fix |
| List pages, first uncached load | ~1.2s TTFB + blank screen | same TTFB, instant shell + skeletons | Phase B |
| List pages, revisit | full refetch ~1.2s+transfer | **instant** (SWR cache, bg revalidate) | Phase A |
| Invoices GET round trips | 2 sequential | 1 (parallel) | Phase C (+3 more routes) |

Authenticated re-measurement is now user-side only (password login removed by the
google-only-login feature); the felt verdict comes from the user's click-around.

**Status: Phases A/B/C shipped (each reviewed + squashed). Open: server-side
pagination decision (R1 residual), `ep-patient-surf` purpose + prod re-sync of
2 custom-field rows + 6 customers (R6/Phase D).**
