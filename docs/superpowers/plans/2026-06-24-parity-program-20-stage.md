# 20-Stage Parity Program

**Date:** 2026-06-24
**Status:** roadmap — each stage gets its own spec → plan → implementation when picked up
**Theme:** Close parity gaps across the three asymmetric surfaces — **voice↔chat**, **FieldPulse↔HCP**, and **dispatch v1→v2 (Probook)** — plus the highest-leverage half-built admin/field surfaces. Built from an evidence-grounded survey (3 parallel code audits); every stage cites the real file(s).

## How to run this program

- Stages are **leverage-ordered** (safety/trust first). Take the lowest-numbered unblocked stage.
- **Each stage begins by re-confirming the gap against current code** — some voice↔chat gaps may already be partly closed by prior parity work (see [[voice-chatbot-parity]]). If a gap is already closed, mark the stage done and move on; do not rebuild.
- Each stage is self-contained and independently shippable: spec (if design choices) → plan → TDD → gates (`tsc`, `lint`, `test:unit`, `build`) → commit on branch.
- **Preserve invariants:** frozen-safety-text in `hvac-knowledge.ts` (run `npm run eval` 30/30 after any prompt edit), money-safety guards (synced invoices read-only → 409), `metadata.verify` survival through voice gather extraction, tenant scoping (`withTenant`), no secrets/PII.

---

## Group A — Voice ↔ Chat parity (safety & trust first)

### Stage 1 — Voice post-reply safety screening **[H, SAFETY] — ✅ ALREADY DONE**
- **Re-confirmed 2026-06-24:** the gap is closed in current code. `voice-turn.ts:943-954` already routes the LLM reply through `screenAssistantReply` (all four detectors: pricing / false-booking / dangerous-diy / credentials) before TTS and persist. The original audit was stale. No work needed.

### Stage 2 — After-hours booking-target inference on voice **[H, money/trust] — ✅ DONE 2026-06-24**
- **Was real:** voice passed no `bookingTarget`, so an after-hours caller wanting a daytime slot was wrongly warned of a charge.
- **Done:** extracted `inferBookingTarget` from the chat route into shared `after-hours-chat.ts` (DRY, now unit-tested), and voice (`voice-turn.ts`) now computes + passes `bookingTarget` from the preferred window — parity with chat's Fix 2. Commit pairs the refactor + wiring; full suite green.

### Stage 3 — Voice service-history enrichment **[M]**
- **Gap:** Chat enriches a resolved repeat customer with a PII-free one-liner via `enrichWithServiceHistory` (`src/lib/ai/customer-context.ts`); voice only gets raw counts, so it can't personalize.
- **Do:** Call `enrichWithServiceHistory` in `voice-turn.ts` when `resolveVoiceIdentity` matches a customer.
- **Verify:** unit test: resolved caller → context carries the history one-liner; degrade-safe on fetch failure.

### Stage 4 — Chat repeat-customer resolution at session start **[M]**
- **Gap:** Voice auto-resolves identity via ANI (`src/lib/voice/resolve-voice-identity.ts`); chat only resolves once the user types an email and does not pre-populate from a known contact at session start, forcing re-asks.
- **Do:** In `src/app/api/chat/route.ts` session init, if an email is supplied (widget context / prior session), resolve via the email blind index and pre-load `lookupCustomerContext`.
- **Verify:** unit test: known email at init → name/address pre-populated, no re-ask.

### Stage 5 — Reconcile the account-data verify gate across channels **[H, SECURITY]**
- **Gap (confirm first):** Voice gates financial account-lookup intents behind a ZIP-verify state machine (`src/lib/ai/account-verify.ts`, `voice-turn.ts`); the audit reports chat serves the same intents without a verify step. **This contradicts [[voice-chatbot-parity]]** which lists the ZIP-verify gate as shipped — so Stage 1 step is to verify which is actually true in `src/app/api/chat/route.ts`.
- **Do:** If chat truly lacks it, add the `requiresVerify` gate to the chat ACCOUNT_LOOKUP path, reusing `account-verify.ts`. If already present, close the stage.
- **Verify:** unit test: unverified chat session requesting balance → verify challenge, not data.

---

## Group B — FieldPulse ↔ HCP integration parity

### Stage 6 — HCP technician roster sync **[H, foundational]**
- **Gap:** FieldPulse has a real roster sync that upserts `users` (`src/lib/integrations/fieldpulse/technician-sync.ts`); HCP infers **synthetic** technician IDs from availability windows (`technician-mapping.ts`) — no true roster. This undercuts dispatch scoring for HCP orgs.
- **Do:** Add `src/lib/integrations/housecall-pro/technician-sync.ts` mirroring the FP pattern (admin-triggered upsert of real techs via the HCP client).
- **Verify:** unit test for upsert/dedupe; existing FP test as the template.

### Stage 7 — HCP durable availability sync **[M]**
- **Gap:** FP syncs availability to the `technician_availability` table via cron (`fieldpulse/availability-sync.ts` + `cron/sync-fieldpulse-availability`); HCP is cache-only (30s TTL, no persistence) via `housecall-pro/scheduling-source.ts`.
- **Do:** Add an HCP availability sync to persist into `technician_availability` + a cron, mirroring FP. Decide cache-vs-DB consistency.
- **Verify:** unit test for mapping HCP windows → availability rows.

### Stage 8 — HCP address validation on customer sync **[M]**
- **Gap:** FP validates addresses before sync (`fieldpulse/address-validation.ts`, Photon + geocode fallback); HCP customer-sync accepts free-text street only.
- **Do:** Apply the shared address-validation path in `housecall-pro/customer-sync.ts`.
- **Verify:** unit test: low-quality address → flagged/normalized identically to FP.

### Stage 9 — HCP client rate limiter **[M, reliability]**
- **Gap:** FP has a token-bucket adaptive limiter (`fieldpulse/rate-limiter.ts`); the HCP client has none.
- **Do:** Wrap the HCP client calls with the same limiter pattern (extract a shared limiter if clean).
- **Verify:** unit test: burst calls throttled; 429 backoff honored.

### Stage 10 — HCP bulk operations + admin endpoint **[M, ops]**
- **Gap:** FP has chunked bulk-update with partial-success/retries (`fieldpulse/bulk-operations.ts` + `/api/admin/integrations/fieldpulse/bulk-update`); HCP has no equivalent.
- **Do:** Add `housecall-pro/bulk-operations.ts` + `/api/admin/integrations/housecall/bulk-update` if the HCP API supports it; else document HCP-only limitation explicitly.
- **Verify:** unit test: partial failure reported per-item.

### Stage 11 — FieldPulse job line-items on push **[M]**
- **Gap:** HCP job push includes cost line-items (`housecall-pro/line-items.ts`); FP job push (`fieldpulse/job-sync.ts`) sends no line items.
- **Do:** Add line-items to the FP job-create payload if the FP API supports it; align the shape with HCP.
- **Verify:** unit test: pushed FP job carries the expected line items.

---

## Group C — Dispatch v1 → v2 (Probook parity)

### Stage 12 — `technician_skills` table + CRUD UI **[H]**
- **Gap:** Skill is derived from `jobType`/`systemType` completion history only (`src/lib/ai/dispatch/signals.ts`); no explicit skills. A new tech with real certs but no completed jobs is never auto-assigned.
- **Do:** Add a `technician_skills` table + admin CRUD; make `signals.ts` prefer explicit skills, falling back to completion history.
- **Verify:** unit tests for the skill source precedence; migration is additive.

### Stage 13 — Technician base location + proximity scoring **[H, Probook core]**
- **Gap:** No tech coordinates anywhere (`users` has no lat/long); `score.ts` has no proximity term — deferred in the dispatch spec.
- **Do:** Add `users.baseLat/baseLng` (+ geocode on save), a customer-site distance, and a proximity weight in `src/lib/ai/dispatch/score.ts` (re-balance weights; keep the pure-function + unit-test discipline).
- **Verify:** scoring unit tests for the proximity term and weight sum = 1.0.

### Stage 14 — Tunable confidence threshold **[M]**
- **Gap:** Hard boolean gate `skillMatched = skillJobsCompleted > 0` (`score.ts:scoreTechnician`); no org-level tuning.
- **Do:** Add an org-level minimum-score/threshold config (extend `organization_settings` + the dispatch panel) and gate on it instead of the boolean.
- **Verify:** unit test: threshold filters as configured; default preserves current behavior.

### Stage 15 — Failed-auto-assign reconcile sweep (cron) **[M, reliability]**
- **Gap:** Auto-assign is best-effort in `after()`; an unassigned soft-held job is only re-attempted when a dispatcher acts. No sweep.
- **Do:** Add a cron that re-runs `autoAssignBookedRequest` for recently-unassigned soft-held requests (idempotent; respects the opt-in flag).
- **Verify:** unit test: a previously-unassignable job that now has a free qualified tech gets placed.

### Stage 16 — Real-time availability (PTO / sick / live load) **[M]**
- **Gap:** Only same-day conflict + static weekly slots (`scheduling-queries.ts:checkScheduleConflict`); no PTO/sick/multi-day load.
- **Do:** Add a time-off table and fold it into the availability/conflict gate and the load signal.
- **Verify:** unit test: a tech on PTO is excluded from auto-assign and the board.

### Stage 17 — Technician push notification (`tech_assigned`) **[M, the deferred v2 item]**
- **Gap:** No staff-facing notification at all — `communication_trigger_type` is customer-only, `users` has no phone column, `communication_jobs` has no idempotency column (see the dispatch spec's deferral rationale).
- **Do:** Add `users.phone`, a `tech_assigned` trigger enum + template, a staff-contact send path with a consent bypass, and an idempotency key; enqueue on successful auto-assign in `scheduling-queries.ts`.
- **Verify:** unit test: one notification per assignment (idempotent); degrade-safe.

### Stage 18 — Customer "your technician is X" messaging **[M]**
- **Gap:** No customer notification on assignment (deferred in the dispatch spec to avoid naming a tech before the team confirms).
- **Do:** Add a customer template + send trigger on a *confirmed* assignment (not the provisional auto-assign), respecting consent/quiet-hours via the existing comms queue.
- **Verify:** unit test: confirmed assignment → one consent-gated customer message.

---

## Group D — Highest-leverage half-built surfaces

### Stage 19 — Membership plans edit flow **[M, CRUD completeness]**
- **Gap:** Plans can be created/deleted but **not edited** — no `/admin/membership-plans/[id]` page and no PATCH (`src/app/api/admin/membership-plans/route.ts` has POST only). Editing means delete + recreate.
- **Do:** Add the detail/edit page + a PATCH route (guard active-subscription side effects).
- **Verify:** unit/integration test for update; existing list test unaffected.

### Stage 20 — Tech portal mutations (photos / notes / timeline) **[M, field UX]**
- **Gap:** The tech portal is read-only + mark-complete (`src/app/tech/jobs/[id]/page.tsx`); no photo upload, job notes, or timeline. No `/api/tech/*` mutation endpoints.
- **Do:** Add tech-scoped endpoints for job notes + photo attachment + a timeline view, reusing existing storage/notes patterns.
- **Verify:** integration test for a tech adding a note/photo to an assigned job (tenant + role scoped).

---

## Explicitly NOT in this program (tracked, not dropped)

- **Full day-route optimization** (the dispatch spec's "day optimizer" tier — TSP/clustering). A large standalone epic; out of scope for a parity program. Schedule separately.
- **Request detail URL page** (`/admin/requests/[id]`) — currently an in-modal sheet only; a UX nicety, lower leverage than the above.
- **Staffed-inbox UI** (two-way SMS conversation thread/filter view) — the reply endpoint exists; the admin thread UI is a separate feature, not a parity gap.
- **Estimates→Invoice automation / promo codes** — money-flow feature work, not parity; sequence with the money roadmap.
- **General-HVAC educational KB expansion** beyond the 53 intents — content work, not structural parity.

## Sequencing note

Stages 1–2 and 5 are the highest-leverage (safety/trust/security parity) and should go first regardless of group order. Group B (FieldPulse↔HCP) Stage 6 unblocks better HCP-org dispatch and pairs naturally with Group C. The heavy stages (13 proximity, 16 real-time availability, 17 tech notification) each warrant their own design spec before implementation.
