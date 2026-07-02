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
