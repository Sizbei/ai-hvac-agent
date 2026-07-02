# Probook-style AI Auto-Dispatch (v1) — Design

**Date:** 2026-06-24
**Status:** design, awaiting review → implementation plan
**Inspiration:** [Probook](https://www.unite.ai/probook-raises-34-million-series-a-to-bring-ai-into-the-operational-core-of-home-services/) (a16z/Sequoia, $40M, June 2026) — "dispatch is the operational brain": assign **which technician → which job, in what order, at what time**, on **expertise, availability, performance history, job value** (not just proximity).

This spec was hardened by a 4-critic adversarial review; the verified findings reshaped it (see "Why this is small").

## Problem

The system **already auto-assigns** a freshly-booked request at intake, but the assignment is **first-fit**: `autoAssignBookedRequest` (`src/lib/admin/scheduling-queries.ts:723`) selects active technicians in DB order and assigns the **first one whose calendar fits** (via `placeAndAssignRequest`'s conflict/availability gate). It does **not** consider whether the tech can actually do the job (skill), how good they are (performance), or their load. It also **does not notify** the assigned technician. That is the opposite of Probook's thesis — a calendar-fit pick, not a *smart* one.

## Goal

Make the existing auto-assign **Probook-style**: rank technicians by a deterministic, explainable score and assign the **best** one that fits — **gated on skill** so an unqualified tech is never auto-sent. Keep the existing degrade-safe behavior (no qualified+available tech → leave soft-held in the Unassigned column for a dispatcher). The assignment is immediately **visible** to the tech (their portal job list) and the dispatcher (board) with no outbound message — a tech-facing push notification is deferred to v2 (see Scope; the existing comms path is customer-only and techs have no phone on file).

## Why this is small (verified against the codebase)

| Critic claim | Verified fact | Consequence |
|---|---|---|
| "Build auto-dispatch" | Auto-assign already exists + is wired at intake (`submit-session-request.ts:313` → `autoAssignBookedRequest` in `after()`) | We **upgrade** one function, not build a pipeline |
| Skill-match needs a new taxonomy | `issueType` is free-text, but **`jobType` + `systemType` are pgEnums** on `serviceRequests` (`schema.ts:486,488`) and captured at intake | Skill signal = `jobType`/`systemType`, **no new skills table in v1** |
| Proximity scoring | **No tech coordinates / base location** anywhere (`users` has no lat/long) | **Proximity deferred to v2** |
| Exceptions queue UI | Dispatch board already renders an **"Unassigned" column** (`dispatch/page.tsx:113-117`) for jobs that didn't auto-assign | **Reuse it**, no new surface |
| `dispatchStatus` enum + threshold config | Over-built | **One boolean** `auto_assigned` + **one boolean** `autoDispatchEnabled` |

## Architecture

Three small additions on top of the existing flow; no new request lifecycle, no new UI page.

### 1. Scoring engine — pure, deterministic, unit-tested
`src/lib/ai/dispatch/score.ts`

```
interface DispatchSignals {
  readonly job: { jobType: string | null; systemType: string | null; urgency: string };
  readonly tech: {
    technicianId: string;
    // count of this tech's completed jobs whose jobType OR systemType matches
    // the incoming job (a job matching both is counted once) — skill proxy
    skillJobsCompleted: number;
    avgRating: number | null;       // from getTechnicianScorecards
    jobsCompleted: number;          // overall, from scorecards
    sameDayJobCount: number;        // load: jobs already on the held day
  };
}
interface DispatchScore { score: number; reasons: string[]; skillMatched: boolean; }

scoreTechnician(signals: DispatchSignals): DispatchScore
```

Rules (deterministic, explainable):
- **Skill gate (hard):** `skillMatched = skillJobsCompleted > 0` (tech has completed ≥1 job of this `jobType` OR `systemType`). When false, the tech is **ineligible for auto-assign** (score still computed for transparency, but the orchestrator skips them).
- **Score (0–1), only meaningful for skill-matched techs:** weighted blend —
  - skill depth: `min(skillJobsCompleted, 10)/10` × 0.5
  - quality: `((avgRating ?? 3.5) / 5)` × 0.3
  - load (lighter day preferred): `(1 - min(sameDayJobCount, 6)/6)` × 0.2
- `reasons[]`: human-readable (`"HVAC: 7 prior no_cool jobs"`, `"4.9★"`, `"2 jobs today"`) for the board badge / tooltip and the tech notification context.

No LLM: an auto-assignment is a money/ops decision that must be explainable, cheap, and hallucination-free. (Weights are constants now; ML-tunable later.)

### 2. Upgraded orchestrator — `autoAssignBookedRequest` (modify in place)
`src/lib/admin/scheduling-queries.ts:723`

Change the loop from "techs in DB order, first calendar-fit" to:
1. Load active technicians (unchanged, org-scoped) **plus their signals**: per-tech `skillJobsCompleted` for the job's `jobType`/`systemType` (one grouped query over completed `serviceRequests`), `avgRating`+`jobsCompleted` (reuse `getTechnicianScorecards` shape), and `sameDayJobCount` (count of the tech's jobs on `isoDay`).
2. `scoreTechnician` each; **drop non-skill-matched** techs; sort by score desc.
3. Iterate the ranked, skill-matched list calling the existing `placeAndAssignRequest` (its conflict/availability gate is unchanged — the **first ranked tech that also clears the calendar** wins; a busy top pick falls through to the next, exactly as today). This preserves the existing race-safety (status-guarded write + conflict check).
4. On success: set `auto_assigned = true`, return `{assigned:true, technicianId}`.
5. No skill-matched+available tech → `{assigned:false}` → unchanged degrade-safe behavior (soft-held → Unassigned column).

Gated by org config (§5): if `autoDispatchEnabled` is false, **fall back to today's first-fit** (or skip auto-assign per existing behavior) — zero behavior change for orgs that don't opt in.

### 3. Technician notification — DEFERRED to v2
The spec originally proposed an idempotency-keyed tech notification "via the existing comms path." Verified against the code, that path doesn't fit and it is **not a small addition**: every `communication_trigger_type` enum value is customer-facing (no `tech_assigned`), `users` has **no phone column** (SMS impossible), the send path (`checkSendAllowed`) is keyed to *customer* consent prefs, and `communication_jobs` has **no idempotency column** (dedupe lives in a separate `outbound_message_ledger`). Building it means a new trigger enum + migration, a seeded tech template, a staff-contact path that doesn't exist, a consent bypass, and an idempotency mechanism — its own subsystem. The auto-assignment is already **visible** to the tech (portal job list) and dispatcher (board), so v1 ships without an outbound message. Notification is tracked in Scope/v2.

### 4. Data: one boolean + one config flag
- Migration: `ALTER TABLE service_requests ADD COLUMN auto_assigned boolean NOT NULL DEFAULT false;` (hand-authored, `IF NOT EXISTS`, + snapshot — per the repo's drizzle convention).
- Migration: `ALTER TABLE organization_settings ADD COLUMN auto_dispatch_enabled boolean NOT NULL DEFAULT false;` (opt-in; default OFF preserves current behavior). Add both to `schema.ts`.

### 5. UI (minimal)
- Dispatch board job cards (`dispatch-column.tsx`) show a small **"auto"** badge when `auto_assigned`. No other change.
- Jobs that don't auto-assign already appear in the **"Unassigned" column** — that *is* the exceptions queue. (Optional, deferrable: surface the top scored suggestion + reason in the detail sheet's assignment section for one-click manual assign.)
- A settings toggle for `autoDispatchEnabled` (admin settings page) — a single `Switch`.

## Data flow

```
intake (chat/voice/admin) → request booked with held window
  → after(): autoAssignBookedRequest(org, id, heldSlot)
      if !autoDispatchEnabled → existing behavior (first-fit or none)
      load techs + signals (skill history, scorecard, same-day load)
      scoreTechnician each → drop non-skill-matched → sort desc
      for tech in ranked: placeAndAssignRequest(...) → first calendar-fit wins
        on success: set auto_assigned=true (tech sees it in portal/board — no outbound msg in v1)
      none fit → {assigned:false} → soft-held → Unassigned column (unchanged)
```

## Error handling / degrade-safety
- Runs in `after()` (off the latency-bound intake turn) and is **best-effort** — exactly the existing, accepted property. A lambda freeze leaves the job soft-held in **Unassigned** (visible + dispatchable), never lost. No new reconcile sweep required in v1 (the dispatcher sees unassigned jobs); a sweep is a v2 nice-to-have.
- Tenant isolation: all reads/writes stay `withTenant`-scoped (existing pattern; verified clean by review).
- neon-http has no transactions: `placeAndAssignRequest` already writes the assignment atomically in one guarded UPDATE; setting `auto_assigned=true` is a second guarded write on the row it just assigned (a freeze between them leaves an assigned job whose `auto_assigned` flag is false — harmless; the job is correctly assigned, only the cosmetic "auto" badge is missing).

## Testing
- **Scoring (pure, unit):** skill gate (0 prior jobs → not matched), skill depth/quality/load weighting, reasons text, tie-breaks, null avgRating fallback.
- **Orchestrator:** ranked order is honored (best skill-matched tech tried first); a busy top pick falls through to the next; no skill-matched tech → `{assigned:false}`; `autoDispatchEnabled=false` → unchanged behavior; a successful auto-assign sets `auto_assigned=true`. (DB mocked, matching the repo's query-test style.)
- **Gate:** `npm run test:unit` + `tsc` + `lint` 0 errors + `npm run build`; `npm run eval` 30/30 unaffected (no chatbot change).

## Scope

**In v1:** scored + skill-gated upgrade to `autoAssignBookedRequest`; the pure scoring module; `auto_assigned` boolean + board badge; `auto_dispatch_enabled` org toggle (default OFF); tests.

**Out (deferred to v2, tracked not faked):**
- **Technician push notification** (SMS/email on assign). Requires a new `tech_assigned` trigger enum + migration, a seeded tech template, a `users.phone`/staff-contact path that doesn't exist, a consent-gate bypass, and an idempotency mechanism — its own subsystem. v1 relies on the assignment being visible in the tech portal + dispatch board.
- Dedicated `technician_skills` table + CRUD UI (v1 derives skill from `jobType`/`systemType` completion history).
- **Proximity** scoring (needs tech base coordinates + geocoding — neither exists).
- Tunable confidence threshold (v1 is a hard skill gate + best-of-fit).
- Customer-facing "your tech is X" messaging.
- Failed-auto-assign **reconcile sweep** (cron).
- Real-time availability (PTO / sick / live load beyond the same-day conflict check).
- Full **day-route optimization** (the "day optimizer" autonomy tier).
