# Tech Location + Autodispatch — Program Plan

> Source: adversarially-verified multi-agent design workflow (2026-07-01). Folds 5 component designs + their verifier blockers. Companion to `docs/superpowers/specs/2026-07-01-dispatch-automation-design.md`. Each phase becomes its own task-by-task plan.

**Goal:** location + confidence-gated autodispatch for technicians; mobile tech view with all job info + live-location tracking; running-behind notifications; an AI assist.

## Cross-cutting blocker (promoted to Phase 0)
**Technician auth does not exist.** `src/lib/auth/types.ts` `AdminRole = "super_admin" | "admin"`; `src/lib/auth/config.ts` `verifyToken` hard-rejects any other role; `/api/tech/*` gates only on `if(!session)` (no role check), so it's reachable ONLY by admins today. 4 of 5 components key on a technician identity that cannot authenticate.

## Dependency-ordered phases
- **Phase 0 — Technician auth enablement (FOUNDATION).** `AdminRole` gains `"technician"`; `verifyToken` accepts it; login issues a tech session; a `getTechSession`/role-gate protects `/api/tech/*` (gate on this, NOT `getAdminSession`); post-login redirect to `/tech/jobs`. **Security caveat:** admin routes must enforce role ≥ admin so a technician session can't reach admin endpoints that only check session presence.
- **Phase 1 — Geo + duration foundation (deterministic, no auth dep).** 1a: geocode at intake (Photon) → populate `service_requests.location_id` → `customer_locations.lat/lng`; add `users.home_base_lat/lng`. 1b: `JOB_DURATION_DEFAULTS` table + `service_requests.estimated_duration_minutes/_source`, written synchronously at booking (NO LLM yet).
- **Phase 2 — Technician location capture** (needs P0 auth + P1a geo): consent-gated `watchPosition` client + `technician_locations` table + `/api/tech/location` ingest (server-side open-time-entry check; after(); db.batch).
- **Phase 3 — Confidence-gated autodispatch** (needs P1a coords/home_base + P1b duration; optional P2 live fix): extend `suggestTechnicians`/`score.ts`; auto-commit only high-confidence via `placeAndAssignRequest`; `scheduling_source` org gate.
- **Phase 4 — Tech mobile "All Info" view** (needs P0 only; verified=true, no migration): `GET /api/tech/jobs/[id]` summary + render header + status controls.
- **Phase 5 — Running-behind detection** (needs P2 + P1a; degrades to daily cron): deterministic arrival-lateness; dispatcher SMS (seed an `escalation` template; flush via `processPendingJobs()`).
- **Phase 6 — AI assist** (layers on P1b): clamped LLM duration refinement in `after()` over the deterministic base; deterministic fallback.

## First buildable slice (build now)
**Phase 0 tech-auth + Phase 4 read-only tech view.** A real technician logs in on mobile, opens an assigned job, sees customer/address/issue/schedule, taps-to-call, advances status. No new tables.

1. **Auth** — `auth/types.ts` add `"technician"`; `auth/config.ts` `verifyToken` accepts it; `auth/login/route.ts` + `auth/google-login.ts` issue tech session; add `getTechSession`/role gate for `/api/tech/*` (NOT `getAdminSession`); post-login redirect `/tech/jobs`. Verify admin routes reject technician sessions.
2. **Summary endpoint** — `field-queries.ts` `getTechJobSummary(orgId, techUserId, requestId)` (reuse owned-job guard; decrypt name/phone/address; compute `allowedNextStatuses = allowedTransitions(status) ∩ MANUAL_TARGET_STATUSES`); NEW `GET /api/tech/jobs/[id]/route.ts`.
3. **Mobile UI** — `tech-job-summary.tsx` (customer, tel:/sms:, maps directions, pills, window, access notes, timeline) + `tech-status-control.tsx` (one button per allowed next status → existing status route) wired into `tech-job-detail-client.tsx`. `?today=1` on the list predicates on `COALESCE(scheduledDate, arrivalWindowStart)` within per-org `settings.timezone`.

## Consolidated data-model additions
- **New** `technician_locations` (P2): org_id, technician_id, service_request_id NULL, lat/lng NOT NULL, accuracy_m, heading, captured_at; indexes (org), (org,tech,captured_at DESC), (captured_at).
- **users:** `location_sharing_enabled` bool default false (P2), `location_consent_updated_at` (P2), `home_base_lat/lng` (P1a).
- **service_requests:** `estimated_duration_minutes` int (P1b), `estimated_duration_source` text default 'default' (P1b), `auto_dispatch_outcome` enum (P3). `location_id` already exists (P1a backfills).
- **organization_settings:** `scheduling_source` enum('native','external') default 'native' (P3); `dispatch_alert_phone` (P5); `notify_customer_on_delay` (P5, defer).
- **enum:** `communicationTriggerTypeEnum += 'appointment_delayed'` (P5 optional). **Seed:** add `escalation` SMS template to `seeds.ts` (folded behind-detection blocker — the dispatcher path is NOT zero-infra).
- Each phase = one additive drizzle migration (hand-reconciled journal+snapshot); run `npm run db:migrate` after deploy.

## Open risks (post-fix)
Mobile geolocation isn't real-time (no service worker; throttled when locked). Off-shift PII guarantee is best-effort (consent + open-time-entry check + 7-day retention + opt-out delete). `slidingWindow` rate limit is per-instance. Haversine ignores roads/traffic. Confidence thresholds are guesses; auto-commit rate drops by design; one threshold must not straddle travel vs no-travel score regimes. `scheduling_source` defaults native (onboarding must flip to external when an external scheduler is connected). `technician_availability` fails closed when empty until the P0 bug-fix default-hours change lands. Vercel Hobby = daily crons only (near-real-time delay needs the P2 location-ingest tick). Delay-alert needs an immediate `processPendingJobs()` flush. Job coords frequently NULL until P1a backfill. AI duration refinement extends the locked spec (needs knowing sign-off; clamp [0.5×,2×]∩[15,480]).
