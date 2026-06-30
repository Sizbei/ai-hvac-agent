# Dispatch Automation — Design Spec

**Status:** Approved direction (signed off 2026-07-01) · **Owner:** Raymond Chen
**Supersedes/extends:** `.planning/SPEC_STAGE_B_SMART_SCHEDULING.md` (the detailed 14‑week algorithm/architecture reference). This spec records the *decisions, grounded current-state, corrected sequencing, and the two bug fixes* — it does not restate Stage B's algorithm derivations; it adjusts and slims them.

---

## 1. Goal

Remove as much human intervention from technician dispatch as is safe — auto-assign the best technician, schedule by real job duration **and travel time**, and run it on a premium in-house calendar. Maps is a follow-on, but its geo foundation is pulled forward because travel-aware scheduling depends on it.

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | **Autonomy** | **Confidence-gated auto-commit.** High-confidence assignment → auto-commit (job live, tech notified); ambiguous → 1-click queue; no eligible tech → exception queue. (Matches Stage B "high-confidence only" auto-pilot.) |
| D2 | **Time model** | **Minute-level durations, estimations-first.** Seed from a duration table (job-type base + system/age modifiers, per Stage B §1.4); refine from actuals later. Replaces the rigid 4‑hour arrival block. |
| D3 | **Travel** | **Drive-time is a first-class scheduling constraint**, not just a ranking input. A tech's day = job + travel + job + travel. Straight-line (haversine) first; real routing API later. |
| D4 | **Calendar** | **Premium in-house calendar** (Notion-Calendar-class): fast, keyboard-driven, per-tech lanes showing jobs **and travel blocks**. |
| D5 | **Skills** | **Hard eligibility filter** (ineligible tech scores 0), minimal boolean `tech × jobType/systemType` to start — NOT the full cert/brand/physical model in Stage B §1.1 yet. |
| D6 | **Efficiency metric** | **Scorecard only** (not a dispatch factor; at most a low-weight tiebreaker), sourced from `technician_time_entries.laborCostCents` snapshots — never the mutable `users.laborRateCents`. |
| D7 | **Travel anchor** | Per-tech **home base** + their **prior job of the day** when one exists. No live GPS in v1. |
| D8 | **Geo source** | **Self-geocode** addresses via the already-wired **Photon** client. FieldPulse is not a reliable coordinate source. |

## 3. Grounded current-state (verified against code)

- **Auto-assign already exists but is naive:** `autoAssignBookedRequest` (`src/lib/admin/scheduling-queries.ts:723`) — first-fit, booking-time, best-effort. The hook to replace.
- **Conflict detection already exists:** `checkScheduleConflict` + `placeAndAssignRequest` (`scheduling-queries.ts`) gate overlaps and availability. Auto-dispatch MUST route through `placeAndAssignRequest` (conflict-gated), **not** `assignTechnician` (`queries.ts:378`, which has no overlap check).
- **Missing data (all net-new modeling — this is the bulk of the work, not a tweak):** techs have **no skills, no home location** (`users`, `schema.ts:258`); jobs store **no coordinates** (only `addressEncrypted`); there is **no job-duration field**. `customer_locations` has lat/lng columns but `upsertCustomerLocation` has **zero non-test callers** (dead infra to revive).
- **Arrival window is a TS const-union** (`morning|afternoon|evening|anytime`, `arrival-window.ts`), **not a pgEnum**; `anytime` is 12h not 4h; the request row already persists `arrivalWindowStart/End` **timestamps** (so no enum migration needed — lowers cost).
- **`arrivalWindow` reach = 39–64 files / ~328 refs:** capacity CAS (`capacity-hold.ts`; neon-http has **no transactions** — band CAS is the booking-race guard), customer portal, tech jobs, reporting/QA, and **3 external mappers** (FieldPulse, Housecall, Google Calendar). The time-model change is the riskiest item in the program.
- **FieldPulse (per the 2026-06-19 verified audit):** `/jobs` exposes real `start_time`/`end_time` → derivable **scheduled** duration; but **no completion timestamps, no job-type field, no coordinates, no travel data**; the `/company/availability` and `/addresses/validate` endpoints are **speculative (may 404)**. Integration is **blocked on a fresh API key**. Reusable as-is: per-org auth seam, resilient `request()`+pagination, rate limiter, and the `sync-fieldpulse-invoices` cron skeleton (`after()` + cron-secret + atomic claim).

## 4. The two bug fixes (root-caused)

**Bug 1 — "everything out of hours."** Root cause: `technician_availability` is empty for a normal org, and coverage **fails closed** — `spanIsCovered` returns `false` for zero slots (`availability-coverage.ts:52`, deliberate per `:68-78`). The same gate blocks server assign in `placeAndAssignRequest`. There is **no UI** to set tech hours (`setTechnicianAvailability` has zero callers); the only writer is the FieldPulse availability sync — itself built on a **speculative endpoint**.
**Fix (NOT blanket fail-open — that would let auto-assign place jobs at any hour):**
1. Add an **org-level default business-hours** setting; when a tech has no explicit availability, coverage falls back to the org default (bounded), not unbounded-open.
2. Add an **availability-editing UI** (shift start/end times — duration-migration-safe), writing via `setTechnicianAvailability`.
3. Define **precedence**: manual edits vs. FieldPulse sync (manual wins, or per-org source flag) so the delete-then-insert sync can't silently clobber manual hours.

**Bug 2 — drag-back-to-plate doesn't unschedule.** Root cause: the unscheduled panel is **not a `useDroppable`** (`draggable-unscheduled-panel.tsx`); the drop handler early-returns unless target `kind === "window"` (`interactive-scheduling-calendar.tsx:464-470`, "we never auto-unassign on a drop"); and the reschedule route **requires** date+window with no null path, while `placeAndAssignRequest` only ever *sets* placement.
**Fix:** register the panel as a droppable "unscheduled" zone; add an unschedule branch in the drop handler; add a server path that nulls `scheduledDate`/`arrivalWindow*`/`assignedTo` and resets status to `pending`.

## 5. Assignment algorithm (reconciled with Stage B)

This is the **target** algorithm. It ships in two steps: P2 builds the band-based subset (steps 1–3 with *least-busy* standing in for travel, no travel blocks); P3 upgrades step 2 to drive-time-aware and step 4 to block travel time. Exact score weights are tuned during P2/P3 against real override-rate data; the **priority order is fixed** (travel → availability → workload).

1. **Hard eligibility filter** — tech must be active, working (or default hours), conflict-free for the slot+travel, and **skill-eligible** for the job (D5). Ineligible → excluded.
2. **Score eligible techs** — weighted, with **travel primacy** per the user's priority (adjust Stage B's 40/30/20/10): **Travel/proximity (drive-time) highest → Availability fit → Workload balance.** Skills already gated in step 1; brand/cert bonuses deferred.
3. **Confidence gate (D1)** — commit automatically only when the top-vs-second score gap is high (Stage B "high" tier). Else → 1-click queue. No eligible tech → exception queue.
4. **Commit path** — via `placeAndAssignRequest` (conflict-gated), blocking travel time before the job; on commit, **notify the tech** (SMS/calendar seam) and write an assignment log with `actorType:"auto"`.
5. **Guards:** skip auto-dispatch entirely for orgs where **FieldPulse/HCP own scheduling** (avoid double-source double-booking); re-run assignment when a reschedule/cancel frees a slot.

## 6. Data model additions

- `technician_skills` (org, tech, jobType/systemType, eligible bool) — minimal; expandable to Stage B's proficiency model later.
- `users`: `homeBaseLat/homeBaseLng` (+ optional label) for the travel anchor.
- `service_requests`: persist `lat/lng` (geocoded at intake via Photon — revive `upsertCustomerLocation` / store on the request), and `estimatedDurationMinutes`.
- `job_duration_defaults` (jobType → base minutes) + modifier rules (systemType, equipment age) — seed table (Stage B §1.4 values).
- Org settings: `defaultBusinessHours`, `schedulingSource` (native vs external).

## 7. Phased roadmap (corrected sequencing)

The adversarial review's load-bearing correction: **do not gate the headline (autopilot) behind the full duration rewrite, and stage the 328-ref change carefully.** Each phase ships independently and is useful on its own.

- **P0 — Bug fixes** (small, unblocks daily use): Bug 1 (org default hours + availability UI + precedence) and Bug 2 (drag-to-unschedule). Ships first.
- **P1 — Foundations + data**: skills table + admin UI/seed; per-tech home base; geocode-on-intake (Photon) + backfill existing open jobs; duration seed table. *Includes the seeding/backfill the review flagged as missing.*
- **P2 — Autopilot v1 (confidence-gated)** on the **current band model**: hard skills filter → least-busy among conflict-free eligible techs → confidence-gated commit + override UI + tech notification + exception queue + external-source guard. Delivers the headline goal early, before the time-model rewrite.
- **P3 — Time-model rewrite** (its own mini-roadmap, highest risk): minute-level durations + travel-time blocks, replacing 4‑hour bands. Order: schema + backfill → capacity/CAS rewrite (no-transaction-safe) → intake → calendar → 3 integration mappers → QA. Upgrades P2's ranking to drive-time-aware.
- **P4 — Premium calendar** (Notion-Calendar-class): rebuilt fast/keyboard-driven calendar showing jobs + travel blocks per tech. Naturally bridges into the deferred **maps** feature (shared geo + routing).
- **P5 — Efficiency scorecard** (read-only, last): revenue ÷ service-time net of snapshot labor cost.
- **FieldPulse enrichment (opportunistic, blocked on key):** a duration-seeding pull cron (modeled on `sync-fieldpulse-invoices`) mining `start_time`/`end_time` deltas to refine estimates. Never a hard dependency.

## 8. Risks & open items (honest)

- **Time-model rewrite (P3) is genuinely large** (~328 refs, no-transaction CAS, 3 external mappers). Treat as multi-week; do not ship behind P2.
- **FieldPulse is blocked on a live API key** and exposes only scheduled (not actual) durations and no job-type — so duration "learning" from FieldPulse is limited; our seed table is the source of truth.
- **Confidence-gating needs real override-rate data** to tune the threshold; start conservative ("high" only), widen as Stage B's "80% accepted without override" proves out.
- **Premium calendar (P4)** is a large UI effort; scope it as its own design pass (apply the design-principles checklist).
- **Travel-time without a routing API** is straight-line only in early phases; real drive-time (traffic, roads) needs a maps/routing provider (Mapbox/OSRM/Google) — deferred with maps.

## 9. Out of scope (deferred)

Full route-optimization engine, technician mobile PWA, live GPS tracking, ML duration model, and the customer-facing map — all in Stage B but intentionally **not** in this initiative. The premium calendar (P4) + geo foundation (P1) are the bridge to the maps feature when it gets its own spec.
