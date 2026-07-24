# Dispatch & Scheduling

How a booked job gets a technician: the intake → geocode → quality-gate → score →
confidence-gate → place pipeline, plus technician location tracking, duration
estimation, the dispatch map, and delay detection. Ends with a **roadmap** of the
next improvements.

## Pipeline overview

```
booking ─▶ geocode-at-intake ─▶ booking-quality gate ─▶ score & rank ─▶ confidence gate ─▶ place
          (customer_locations)   (clean-before-assign)   (skills/travel/load)  (commit vs queue)  (race-safe)
```

Entry point: `autoAssignBookedRequest()` in `src/lib/admin/scheduling-queries.ts`,
run on the booking's `after()` path so it never blocks the customer response.

### 1. Geocode at intake
`persistJobLocation` (`src/lib/requests/persist-job-location.ts`) geocodes the
service address once at booking and stores lat/lng on `customer_locations`, linked
from `service_requests.location_id`. Everything downstream (travel scoring, the
dispatch map) reads these cached coords — no per-request re-geocoding.

### 2. Booking-quality gate (scored mode only)
`assessBookingQualityForRequest` holds a *dirty* booking (missing address / missing
contact / out of service area) as `queued_needs_review` for a human to clean, rather
than auto-assigning a tech to a bad job. First-fit mode skips the gate.

### 3. Score & rank — `src/lib/ai/dispatch/score.ts`
`loadDispatchSignals` (`signals.ts`) gathers per-tech signals; `scoreTechnician`
combines them into a `[0,1]` score (weights sum to 1.0, **provisional — tune on
pilot data**):

- **Skill depth** — capped at `SKILL_DEPTH_CAP=10` matched jobs; `skillMatched` requires ≥1.
- **Quality** — historical `avgRating`.
- **Conversion** — revenue-adjacent history.
- **Load** — `1 − min(sameDayJobCount, 6)/6` (busier techs score lower).
- **Job value** — revenue-band term (`W_VALUE`); higher-value jobs weight experience more.
- **Travel** — from the tech's anchor (latest live GPS fix, else configured home base) to the job. When a routing provider is configured (`ROUTING_PROVIDER`), the term uses real **road drive-time** in minutes (`TRAVEL_CAP_MIN=45`); otherwise straight-line haversine km (`TRAVEL_CAP_KM=40`). `W_TRAVEL` weight, floors at 0 beyond the cap. Only applied once job coords exist. See **Travel-time provider** below.

### 4. Confidence gate — `classifyDispatch`
Auto-commit only a **clear winner**: `gap = top.score − second.score` must be
`≥ MIN_CONFIDENCE_GAP` (**0.08**, or **0.02** for emergencies). Otherwise the job is
routed to the exception queue with an outcome stamped on
`service_requests.auto_dispatch_outcome`:

| Outcome | Meaning |
|---|---|
| `committed` | Clear winner auto-assigned |
| `queued_ambiguous` | Near-tie — needs a human decision |
| `queued_no_fit` | No skill-matched tech |
| `queued_needs_review` | Dirty booking (quality gate) |

Every scored decision is written to `dispatch_decisions` (explainable "why this tech").

### 5. Race-safe placement — `placeAndAssignRequest`
A status CAS (`WHERE status = <read status>`) guards concurrent writes. Background
auto-dispatch additionally passes `requireUnassigned: true`, adding
`assignedTo IS NULL` to the guard so it can **never overwrite a dispatcher's manual
calendar assignment** made during the scoring window. Capacity is reserved before the
response and released once a real tech is committed. External-scheduler orgs
(`scheduling_source='external'`, FieldPulse/HCP own the calendar) are skipped entirely.

## Duration estimation — `src/lib/ai/dispatch/duration.ts`
`estimateJobDuration` returns a deterministic base (base-by-type × system/age
modifiers), clamped to `[15, 480]` min and rounded to 15-min calendar blocks. An
optional LLM refinement is **bounded to `[0.5×, 2×]` the base** and falls back to the
base on any error — dispatch never depends on the LLM.

## Technician location — `src/lib/tech/location-queries.ts`
Consent-gated: the tech toggles sharing → `watchPosition` → throttled ingest into
`technician_locations`, enforced by a **server-side consent gate** (revoke is
immediate). The dispatch scorer uses the latest fix within a freshness window as the
travel anchor; stale/absent fixes fall back to the configured home base.

## Dispatch map — `GET /api/admin/dispatch/map`
Admin-only, PII-light (reference/status/urgency + coords, no name/raw address). Jobs
use the **cached `customer_locations` coords**; only jobs not yet geocoded fall back to
a capped live lookup. Technician pins use the latest consent-gated fix (last 4h).

## Travel-time provider — `src/lib/ai/dispatch/travel.ts`
Off by default (`ROUTING_PROVIDER=none`) → the travel term is straight-line haversine
(historical behavior, byte-identical). Set a provider + key to score by **road
drive-time**:

- **`ors`** (OpenRouteService) — free tier, OSM-native, `ORS_API_KEY`. **Implemented.**
- **`mapbox`** / **`google`** — traffic-aware, paid; recognized names, adapters TBD.

`durationMatrix(origins, dest)` makes **one** matrix request (N tech anchors → the job)
and returns minutes per anchor. It **never throws**: missing key, timeout (1.5 s),
error, or an unpriced origin → `null`, and that tech falls back to haversine. Runs on
the `after()` dispatch path, so the call never blocks the customer. `scoreTechnician`
prefers `travelMinutes`; `travelKm` remains the fallback and the reason line.

### Enabling road drive-time
1. Get a free key: sign up at [openrouteservice.org/dev](https://openrouteservice.org/dev/) (free tier ≈ 2k matrix requests/day — plenty for pilot volume).
2. Set two env vars, locally (`.env.local`) **and** in Vercel → Project → Settings → Environment Variables:
   ```
   ROUTING_PROVIDER=ors
   ORS_API_KEY=<your key>
   ```
3. Redeploy. No code or migration changes — scoring switches to drive-minutes wherever a tech can be priced, and silently falls back to haversine everywhere else.

To turn it off, unset `ROUTING_PROVIDER` (or set `none`). Behavior reverts exactly.

### Measuring routing vs haversine
Every scored decision stores **both** signals per candidate in
`dispatch_decisions.candidates` (`travelKm` + `travelMinutes`, nullable), so the
comparison reads straight off recorded decisions — no extra instrumentation:

- **Disagreement rate** — for each decision, re-rank candidates by the km-based term
  vs the minutes-based term; count decisions where the top tech differs. High
  disagreement = routing is changing real outcomes and is worth its cost.
- **Override correlation** — join with dispatcher overrides: does routing-ranked
  order predict the human's final pick better than haversine order?
- **Tuning inputs** — the same rows feed `W_TRAVEL` / `TRAVEL_CAP_MIN` /
  `MIN_CONFIDENCE_GAP` tuning once pilot volume exists.

## Delay detection & forecasting
- `src/lib/dispatch/delay-detection.ts` (+ cron sweep) flags behind-schedule jobs.
- `src/lib/forecasting/` (`revenue`, `rollups`, `seasonal-naive`) powers demand/revenue rollups adjacent to scheduling.

---

## Roadmap — next steps to improve dispatch

**Immediate hardening — ✅ done** (from the #18 review; correctness/perf, no behavior change):
1. ✅ **N+1 tech-location reads** — `loadTechAnchors` now calls a single batch `getLatestTechnicianLocations` (one query, dedupe-in-memory) instead of one query per tech.
2. ✅ **Timezone off-by-one** — the same-day load count anchors its window with `businessWallClockToUtc` via `businessDayUtcRange`, so late-evening Eastern jobs are counted on the right day.
3. ✅ **Signature-write TOCTOU** — `recordSignature` re-asserts `assignedTo = <tech>` in the `UPDATE` (0 rows → `not_owned`), so a reassigned job can't receive another tech's signature.
4. ✅ **Redundant classification read** — `rankedTechnicianOrder` returns `{ ranked, job }`; the confidence gate reuses the classification (one fewer DB read per scored auto-assign).
5. ✅ **Test-coverage gaps** — legacy `afterHoursShown="1"` latch mapping, `offer_next_day` non-stacking, and isolated `readUrgencySignal` tests added.
6. ✅ **Urgency negation** — `readUrgencySignal` now checks negated urgency ("not urgent" / "not an emergency" / "isn't urgent") before the affirmative match, so a clear no is no longer read as urgent. A contradictory "no, it's an emergency" still reads urgent.

**Near-term dispatch quality:**
- ✅ **Real travel time** — road drive-time now drives the travel term when `ROUTING_PROVIDER` is set (OpenRouteService adapter shipped; see *Travel-time provider* above). Follow-ups: a persistent `travel_estimate` cache (rounded origin×dest, TTL) once volume hits ORS rate limits; traffic-aware `mapbox`/`google` adapters. ✅ Decisions now log `travelKm` + `travelMinutes` per candidate in `dispatch_decisions.candidates`, so the routing-vs-haversine A/B and `W_TRAVEL`/cap tuning read straight off recorded decisions.
- **Confidence-gate tuning** — `MIN_CONFIDENCE_GAP` (0.08) and the scoring weights are provisional constants; tune them on pilot **override-rate** data (how often dispatchers override auto-commits) and outcome data.
- **Explicit skill matrix** — `skillJobsCompleted` is a proxy; add a technician skill/certification matrix (by system type, refrigeration, gas) so the skill gate is capability-based, not just history-based.

**Data & tuning loop** (make autopilot self-improving — highest-leverage next work):
- **Override telemetry** — when a dispatcher reassigns an auto-committed job or manually places a queued one, record it against the `dispatch_decisions` row (autopilot's pick vs the human's final pick, who/when). This is the ground-truth label every tuning effort needs; without it "override rate" is anecdote. Small: one nullable column set from `assignTechnician`/`placeAndAssignRequest` when the request has a decision row.
- **Shadow mode** — for orgs with `auto_dispatch_enabled` OFF, still run scoring and record the decision (never commit). Builds the tuning dataset and lets an org preview "what autopilot would have done" before opting in.
- **"Why this tech?" UI** — the decision audit (scores, reasons, both travel signals) is already recorded; surface it as a popover on assigned jobs and in the exception queue. Dispatcher trust in autopilot comes from seeing its reasoning.
- **Outcome digest + canary** — a daily rollup of committed vs queued vs overridden, and an alert when the commit rate collapses (the canary for silently broken geocoding, signals, or a bad weight change).

**Scoring accuracy:**
- **Chain-aware travel origin** — for a job later today, the tech's true origin is their *previous scheduled job's* location, not their current GPS/home anchor. Use the calendar predecessor's coords when one exists.
- **Duration-fit availability** — the load term counts same-day jobs but not whether the tech's remaining open window actually fits `estimateJobDuration` before close; down-rank techs who can't fit the job.
- **Recency-weighted signals** — `skillJobsCompleted`/`avgRating`/conversion are all-time; apply a ~90-day half-life so scores track current performance, not history.
- **Actual-duration recalibration** — status transitions/timesheets yield actual on-site durations; compare against estimates and recalibrate the deterministic base table per org (no ML needed — a periodic multiplier per job type).

**Operations:**
- **Exception-queue one-click** — show the `suggestTechnicians` shortlist (with reasons) inline on `queued_*` jobs with a one-tap accept. A fast human loop also produces clean override labels.
- **Emergency displacement suggestions** — when an emergency lands and nobody fits, suggest the lowest-cost existing job to bump (latest window, non-urgent, closest replacement tech) instead of just queueing.
- **Geofenced auto-status** — the consent-gated location stream can suggest "en route"/"arrived" transitions when a fix enters the job's geofence — better delay detection and free actual-duration data.
- **Weekly fairness term** — same-day load alone lets the top-scoring tech absorb every high-value job; add a rolling-week balance term (or tiebreak) to spread work and avoid burnout + self-reinforcing score skew.

**Longer-term:**
- **Route optimization** — sequence each tech's day (multi-stop ordering) rather than scoring one job at a time; minimize total drive time across the schedule.
- **SLA / priority-aware scheduling** — emergency response-time targets that pre-empt and re-sequence.
- **Real-time re-dispatch** — feed `delay-detection` back into placement to auto-reflow a slipping day (offer reschedules, reassign the tail).
- **Learning loop** — feed the booking-outcome classifier (`booking-quality.ts` QA labels) and `dispatch_decisions` history back into the scoring weights (offline, then online).

---

## Sequenced plan

The roadmap above, ordered by dependency. Rule of thumb: **measurement before
tuning, trust before autonomy, data-producing work before data-consuming work.**

### Phase 1 — Measure (no external dependencies)
The prerequisite for everything below: turn dispatch from "it ran" into a labeled
dataset. All reads/writes org-scoped (`withTenant`); the decision lookup contract
everywhere is **latest row per request** (`created_at DESC LIMIT 1`).
Sequencing: items 1 + 2 ship as **one migration** (all four new
`dispatch_decisions` columns — parallel migrations to the same table would
conflict in the drizzle journal) and as **one sequenced task** (they modify the
same orchestrator + the same mock-queue test harness); item 3 builds on their
schema and follows them.

1. **Override telemetry** — migration adds three nullable columns to
   `dispatch_decisions`: `overridden_technician_id` (uuid, FK `users.id`),
   `overridden_by_user_id` (uuid, FK `users.id`), `overridden_at` (timestamptz).
   Stamp rule: whenever a **human** (re)assigns a request — `assignTechnician`,
   `reassignTechnician`, and the human scheduling path into
   `placeAndAssignRequest` — look up the request's latest decision row; if it
   exists and `chosen_technician_id IS DISTINCT FROM` the human's pick, stamp all
   three fields on that row. **Plumbing:** none of these functions currently take
   a caller identity — each gains an `actingUserId` parameter threaded from
   `session.userId` in its route (assign route for the first two; the calendar
   scheduling route for the third). The background auto-dispatch path passes no
   actor and never stamps. Queued rows have `chosen_technician_id = NULL`, so the
   condition fires on any human pick — intentional. Stamps are
   **last-write-wins**: a second human reassignment overwrites the stamp (the
   latest human decision is the tuning label). The stamp is a **best-effort
   second write** (not batched with the assignment): losing a label on a crash is
   acceptable for telemetry; money-grade atomicity is deliberately not required.
   File split: `assignTechnician`/`reassignTechnician` live in
   `src/lib/admin/queries.ts`; the scheduling path in `scheduling-queries.ts` —
   the stamp helper should be shared. Analysis segments by `outcome`: a stamped
   `committed` row = true override; a stamped `queued_*` row = human resolution
   label.
2. **Shadow mode** — migration adds `is_shadow boolean NOT NULL DEFAULT false` to
   `dispatch_decisions`. In `autoAssignBookedRequest`, when the org has autopilot
   **off** (and is not external-scheduler): run the same classification + ranking
   + confidence gate, and if the job is classifiable record the decision row with
   `is_shadow = true` and the outcome the gate *would* have produced — then
   continue into today's first-fit behavior unchanged. Shadow never touches
   `service_requests` (no `auto_dispatch_outcome` stamp, no assignment) and
   **skips the booking-quality gate** (its stamps write to `service_requests`).
   `recordDispatchDecision` gains an `isShadow` param. Shadow scoring **skips the
   routing-provider call** (haversine-only — a preview must not spend ORS quota;
   the travel fallback already exists). Unclassifiable bookings (no
   `jobType`/`systemType`) record nothing. Activation is implicit — every
   autopilot-off org shadows (that *is* the preview feature); no new toggle. Runs
   on the existing `after()` path, so the added scoring cost never blocks the
   customer. Every consumer of `dispatch_decisions` must filter on `is_shadow`
   (operational reads: `false`; tuning/health reads: both, split).
3. **Outcome rollup + canary** — three deliberately small pieces:
   (a) pure helper `getDispatchOutcomeRollup(orgId, days)` → counts by outcome +
   override count + commit rate, split real/shadow; (b) a **"Dispatch health"
   card on `/admin/operations`** rendering the 7-day rollup (the existing owner
   scorecard page — no new surface); (c) a weekly cron
   `/api/cron/dispatch-digest` (+ `vercel.json` entry) that computes the per-org
   rollup and fires the **existing** `dispatch_alert_phone` SMS path when the
   commit rate collapses — computed over **all decision rows, real + shadow
   together** (shadow exercises the same geocode/signal/weight pipeline, so a
   shadow collapse signals the same breakage — and autopilot-off orgs would
   otherwise never alert). Collapse = this week's commit rate < 50% of the
   trailing-28-day rate, with ≥ 20 decisions in EACH of the two windows (guards the empty
   denominator); log-only when no alert phone is set. Wrap the SMS send in a
   per-org try/catch as `delay-sweep` does — `sendSms` **throws** when
   `TWILIO_PHONE_NUMBER` is unset, and one org's config must not abort the run.
   The Operations card goes through the existing metrics pipeline (type + query +
   hook + card — a four-file chain, not a drop-in). **No email digest** — the
   repo has no admin-email infrastructure and this phase does not invent one.
4. **Register the orphaned `delay-sweep` cron** — the fully-built
   `/api/cron/delay-sweep` route is missing from `vercel.json`, so behind-schedule
   SMS alerts never fire in production. One JSON entry.

*Exit criteria: every classifiable booking yields a decision row (real or shadow);
human picks are labeled on the decision row; the rollup renders on Operations; the
digest + delay-sweep crons are registered.*

### Phase 2 — Operator trust & speed (parallel with Phase 1)
5. **"Why this tech?" decision panel** — surface the **recorded** decision, not a
   live re-score (the sheet's existing "Suggested technicians" card already does
   live scoring and stays as the action path). New `GET
   /api/admin/requests/[id]/decision` returns the latest decision row: outcome,
   `is_shadow`, chosen tech, `top_score`, `confidence_gap`, per-candidate
   `candidates` (score, reasons, **`travelKm` + `travelMinutes`** — the client
   type currently drops the travel fields; add them), and `overridden_*`. The
   `candidates` JSONB stores tech **UUIDs only** — the route resolves display
   names with one org-scoped `inArray` lookup over `users`. Render
   as a collapsible "Dispatch decision" section in `RequestDetailSheet` for any
   request that has a row (assigned *and* queued; shadow rows labeled
   "preview"). No new popover primitive (the repo has none; the sheet section is
   the surface). Tests: route + query only — **no jsdom/RTL** (repo policy).
6. **Exceptions rail** — the one-click accept **already exists** (the sheet's
   suggest card assigns via the same path as the dropdown); the missing piece is
   the view. This is a **separate, day-independent query**, not a board-query
   tweak: the board query is bounded to the selected day and filters
   `isNotNull(arrivalWindowStart)`, which hides windowless bookings and lets a
   yesterday's queued job scroll out of sight. The rail queries: unassigned +
   `auto_dispatch_outcome IN (queued_*)` + status not cancelled/completed,
   ordered by `createdAt` ascending (oldest first), capped (~20). Renders above/beside the board (outcome badge +
   age), each row opening the existing detail sheet. Override labels come free
   via item 1's `assignTechnician` hook.

*Exit criteria: a dispatcher can resolve a queued job in one click from the
Exceptions rail and see the recorded reasoning on any decided job.*

### Phase 3 — Scoring accuracy (ship behind tests; items 7 + 9 share
`signals.ts` and are one task or strictly sequenced — item 8 (`score.ts`) is
independent)
7. **Chain-aware travel origin** — one batched query (`DISTINCT ON` tech over the
   candidate set — no N+1): each tech's latest non-cancelled same-business-day
   job with `arrival_window_start` before the scored job's window start and
   non-null cached coords (excluding the scored request itself). The scored job's
   window start is **read from the DB inside the query** (join on the `requestId`
   already passed to `loadDispatchSignals` — no signature change; this also works
   for the live `suggestTechnicians` path). A windowless scored job (`NULL`
   window) skips chain logic entirely. When a predecessor is found, its coords
   replace the GPS/home anchor as the travel origin; otherwise the existing
   fallback chain is unchanged. Point-in-time by design — a predecessor cancelled
   after scoring is accepted staleness (decisions re-run on re-dispatch).
8. **Duration-fit down-rank** — explicit proxy v1: per tech, `bookedMinutes` =
   Σ `estimated_duration_minutes` (60 when null) over same-day non-cancelled
   assigned jobs (one grouped query); `dayMinutes` from a **new ~10-line pure
   helper `sumAvailabilityMinutes(slots)`** — no existing helper computes span;
   it sums `endMinute − startMinute` over the tech's weekday slots and falls back
   to the same `DEFAULT_BUSINESS_DAY` (8:00–20:00 → 720 min) the coverage check
   uses. If `bookedMinutes + thisJobEstimate > dayMinutes`: fixed **−0.1 score
   penalty** + reason `"day likely full"`. Down-rank only — the hard gate remains
   `placeAndAssignRequest`'s conflict/availability check. Full gap-finding
   (contiguous-window math) is deliberately deferred.
9. **Recency-windowed signals** — skill/rating/conversion aggregates take a
   **180-day window** (a simple cutoff approximating the 90-day half-life intent;
   per-row exponential decay SQL is deliberately not built). The **skill gate
   stays all-time** — `skillMatched` keeps using the all-time count so a proven
   tech is never locked out by a quiet quarter; only skill *depth* uses the
   windowed count. One query returns both counts via a `count(*) FILTER (WHERE …)` pair (the
   pattern the conversion query already uses); the windowed count travels as
   `skillJobsCompletedRecent` through the signals merge loop into the scorer.

*(Geofenced auto-status moved to Phase 4: it needs a status-model or suggestion
surface that doesn't exist, and its actual-duration output only feeds Phase 4
consumers.)*

### Phase 4 — Data-gated tuning (needs ~2–4 weeks of pilot traffic + Phase 1)
10. **Weight/gap tuning** — fit `W_TRAVEL`, `TRAVEL_CAP_MIN`, `MIN_CONFIDENCE_GAP`
    to override-rate + shadow data; adopt per-org overrides only if orgs diverge.
11. **Routing A/B verdict** — disagreement rate + override correlation (see
    *Measuring* above) decides: keep ORS, upgrade to a traffic-aware provider
    (Mapbox/Google adapter), or drop routing.
12. **Geofenced auto-status** (moved from Phase 3) — en-route/arrived suggestions
    when a location fix enters a job's geofence. Needs design decisions that don't
    exist yet: a suggestion surface (the status enum has no `en_route`; the FSM
    would race a system actor against the tech's manual updates), an ingest-hook
    vs cron-sweep evaluation path, and a neighbor-overlap de-dup rule. Produces
    the actual-duration data item 13 consumes.
13. **Actual-duration recalibration** — periodic per-org multiplier on the duration
    base table from item 12's actuals (or timesheet transitions as a proxy).
14. **Travel cache** — only if ORS rate limits are actually hit.

### Phase 5 — Structural bets (scope on demand, after Phase 4 evidence)
15. **Explicit skill matrix** → 16. **Weekly fairness term** → 17. **Emergency
    displacement** → 18. **Route optimization** → 19. **SLA pre-emption /
    real-time re-dispatch** → 20. **Learning loop** (closed-loop weights — the
    end state the earlier phases make safe).

### External-dependency ledger (operator actions)
| Needed for | Action |
|---|---|
| Activate road drive-time now | Free ORS key → set `ROUTING_PROVIDER=ors` + `ORS_API_KEY` (local + Vercel) |
| Phase 4 tuning | Real pilot bookings flowing through intake |
| Traffic-aware routing (Phase 4, optional) | Mapbox/Google account + budget decision |
