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
- **Travel** — from the tech's anchor (latest live GPS fix, else configured home base) to the job via haversine; `W_TRAVEL` weight, floors at 0 beyond `TRAVEL_CAP_KM=40`. Only applied once job coords exist.

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
- **Real travel time** — replace haversine with a routing/ETA API (traffic-aware) for the travel term; haversine under-penalizes cross-town jobs.
- **Confidence-gate tuning** — `MIN_CONFIDENCE_GAP` (0.08) and the scoring weights are provisional constants; tune them on pilot **override-rate** data (how often dispatchers override auto-commits) and outcome data.
- **Explicit skill matrix** — `skillJobsCompleted` is a proxy; add a technician skill/certification matrix (by system type, refrigeration, gas) so the skill gate is capability-based, not just history-based.

**Longer-term:**
- **Route optimization** — sequence each tech's day (multi-stop ordering) rather than scoring one job at a time; minimize total drive time across the schedule.
- **SLA / priority-aware scheduling** — emergency response-time targets that pre-empt and re-sequence.
- **Real-time re-dispatch** — feed `delay-detection` back into placement to auto-reflow a slipping day (offer reschedules, reassign the tail).
- **Learning loop** — feed the booking-outcome classifier (`booking-quality.ts` QA labels) and `dispatch_decisions` history back into the scoring weights (offline, then online).
