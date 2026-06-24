# 20-Stage Parity Program

**Date:** 2026-06-24
**Status:** roadmap — each stage gets its own spec → plan → implementation when picked up
**Theme:** Close parity gaps across the three asymmetric surfaces — **voice↔chat**, **FieldPulse↔HCP**, and **dispatch v1→v2 (Probook)** — plus the highest-leverage half-built admin/field surfaces. Built from an evidence-grounded survey (3 parallel code audits); every stage cites the real file(s).

## How to run this program

- Stages are **leverage-ordered** (safety/trust first). Take the lowest-numbered unblocked stage.
- **Each stage begins by re-confirming the gap against current code** — some voice↔chat gaps may already be partly closed by prior parity work (see [[voice-chatbot-parity]]). If a gap is already closed, mark the stage done and move on; do not rebuild.
- Each stage is self-contained and independently shippable: spec (if design choices) → plan → TDD → gates (`tsc`, `lint`, `test:unit`, `build`) → commit on branch.
- **Preserve invariants:** frozen-safety-text in `hvac-knowledge.ts` (run `npm run eval` 30/30 after any prompt edit), money-safety guards (synced invoices read-only → 409), `metadata.verify` survival through voice gather extraction, tenant scoping (`withTenant`), no secrets/PII.

## Plan & Review verification (2026-06-24)

A 40-agent workflow re-confirmed, planned, and independently verified all 20 stages against current code. **Full per-stage plans, reviews, and verifier corrections live in [`2026-06-24-parity-review-results.md`](./2026-06-24-parity-review-results.md)** — read that before implementing any stage. Headline outcomes:

- **Shipped Stages 1–4: all `shipped-correct`** (verifiers sound/minor). No code bugs found in merged work; only doc-precision nits (e.g. the Stage 1 line cite, fixed above). A latent cross-channel safety gap (spoken-form prices bypass `PRICE_REGEX`) is noted for a future detector-hardening stage — not a parity regression.
- **Stage 19 is `already-closed`** — membership plans already have an edit/detail flow + PATCH (the audit premise was stale). Drop it from the backlog.
- **Stage 5 contradiction resolved → `real-gap`:** chat genuinely lacks the ZIP-verify gate. **Security-critical plan correction:** the gate must wire `preserveVerifyKey` into chat's metadata writes (`route.ts:1286/1511` + the `1730-1797` re-read), or an intervening intake turn wipes the lockout → unlimited ZIP retries. Do not implement S5 without this.
- **Stages 7 & 20 are `partially-done`** (not greenfield): S7 — HCP availability is cache-only; a literal `technician_availability` mirror is structurally blocked (HCP techs are synthetic), so the plan adapts. S20 — reuse `request_status_events` for the timeline and pass `ADMIN_DOCUMENT_MIME_TYPES` for HEIC (both already exist).
- **Plan corrections to heed:** S8 — FP address validation is *dead code* on free-text input, so true "parity" = write street unchanged (Photon enrichment would exceed FP). S13 — the proximity weight rebalance breaks 3 score tests, not 1. S15 — window reconstruction must read the BUSINESS-tz hour (not `getUTCHours`), and `isAutoDispatchEnabled` must be exported. S12 — 3 interface touch-points, not 2.

**Verified execution order** (skip 19; safety/security first, then integration, then dispatch-v2):
**5** (security parity) → **6** → **9** → **8** → **11** → **10** → **7** (Group B) → **12** → **14** → **15** → **13** → **16** → **17** → **18** (Group C) → **20** (Group D). Stages 1–4 done; 19 closed.

---

## Group A — Voice ↔ Chat parity (safety & trust first)

### Stage 1 — Voice post-reply safety screening **[H, SAFETY] — ✅ ALREADY DONE**
- **Re-confirmed 2026-06-24:** the gap is closed in current code. `voice-turn.ts:971` (`screenAssistantReply(text)`) already routes the LLM reply through all four detectors (pricing / false-booking / dangerous-diy / credentials) before TTS and persist; the screened text is what is both spoken (`:978`) and persisted (`:986`). The original audit was stale. No work needed. (Latent cross-channel gap, not a regression: `PRICE_REGEX` only catches `$`-prefixed numerals, so spoken-form prices — "two hundred dollars" — pass on BOTH voice and chat; tracked for a future detector-hardening stage.)

### Stage 2 — After-hours booking-target inference on voice **[H, money/trust] — ✅ DONE 2026-06-24**
- **Was real:** voice passed no `bookingTarget`, so an after-hours caller wanting a daytime slot was wrongly warned of a charge.
- **Done:** extracted `inferBookingTarget` from the chat route into shared `after-hours-chat.ts` (DRY, now unit-tested), and voice (`voice-turn.ts`) now computes + passes `bookingTarget` from the preferred window — parity with chat's Fix 2. Commit pairs the refactor + wiring; full suite green.

### Stage 3 — Voice returning-customer recognition **[M] — ✅ DONE 2026-06-24 (core); HCP note sub-deferred**
- **Was real:** voice resolved the caller (set `session.customerId`) but surfaced NO customer context in the LLM prompt — `buildCustomerContextHint` was chat-only.
- **Done:** extracted `loadCustomerContextById` from `lookupCustomerContext` (refactor + export, unit-tested); voice-turn now loads the resolved customer's context by id and injects `buildCustomerContextHint` (first name + prior-request count + membership) into the LLM system prompt, degrade-safe — parity with chat's recognition. Tests assert the hint reaches the prompt and is absent for unknown callers.
- **Sub-deferred (with reason):** the HCP `enrichWithServiceHistory` *note* (prior-service one-liner) is an EXTERNAL fetch; adding it to every voice LLM turn would put network latency on the latency-bound spoken turn. Needs a once-per-call cache (e.g. resolve+enrich at call start in `voice/incoming`, stash a compact hint on the session). Tracked as a follow-up; core recognition lands now with no external call.
- **Note:** appended the existing vetted chat hint to the voice system prompt; `hvac-knowledge.ts` frozen safety blocks untouched. Recommend `npm run eval` 30/30 when keys are available (couldn't run headless).

### Stage 4 — Chat customer-context persistence on linked sessions **[M] — ✅ DONE 2026-06-24**
- **Was real (and sharper than the audit framing):** chat only resolved `customerContext` for an UNLINKED session (`!session.customerId && (email||phone)`). Once linked (turn 2+, or a resumed session), the load gate only ran the do-not-service check and never re-built the context — so the returning-customer hint + name pre-fill **vanished after turn 1**. The in-code comment even wrongly claimed "the load gate above handles linked sessions."
- **Done:** chat now loads context by id (reusing Stage 3's `loadCustomerContextById`) on every turn of a linked session, degrade-safe; the email/phone resolution is unchanged for unlinked sessions (still links + enforces do-not-service mid-turn). This subsumes the "email supplied upfront" case (the widget/resume links the session → next turn hydrates by id) and achieves true voice↔chat persistence parity. Stale comment corrected.
- **Verify:** `loadCustomerContextById` + `buildCustomerContextHint` are unit-tested (Stage 3); the route has no unit-test harness, so verified via `tsc` + full suite + `npm run build` (all green).

### Stage 5 — Reconcile the account-data verify gate across channels **[H, SECURITY] — ✅ DONE 2026-06-24**
- **Was real:** chat served financial account intents (balance, membership-status) with NO verify step; voice gated them. (Resolved the `[[voice-chatbot-parity]]` contradiction — the gate had NOT shipped on chat.)
- **Done (2 commits):** (1) extracted the pure channel-agnostic `advanceVerify(intentId, state, zipAnswer, onFileZips) → {serve|ask|defer, verify}` into `account-verify.ts`, **exhaustively unit-tested** (8 cases incl. lockout at `MAX_VERIFY_ATTEMPTS` and empty-on-file-ZIPs-never-pass). (2) wired it into the chat ACCOUNT_LOOKUP block: reads `metadata.verify`, loads on-file ZIPs (`customers` + `customerLocations`, `withTenant`-scoped + `decrypt`, degrade-safe) only on a pending financial turn, persists merged `{...meta, verify}`, replies with chat-worded ASK/DEFER (no DTMF copy). **`preserveVerifyKey` wired into all 3 chat metadata-rebuild sites** (`route.ts` extraction writes + the async re-read) so an intervening intake turn can't wipe the lockout → unlimited retries. The shared engine means voice & chat can't drift.
- **Verify:** ✅ advanceVerify 8 unit tests; tsc + lint + full suite (2875) + build all green; no `hvac-knowledge.ts` change → eval not required; money-safety untouched (`buildAccountLookupReply` unchanged). (Chat route POST has no unit harness — same verification standard as Stages 4/3.)
- **Optional follow-up:** refactor voice-turn to call `advanceVerify` too (would validate parity against voice's existing tests; voice currently has its own inline-but-equivalent copy).

---

## Group B — FieldPulse ↔ HCP integration parity

### Stage 6 — HCP technician roster sync **[H, foundational]**
- **Gap:** FieldPulse has a real roster sync that upserts `users` (`src/lib/integrations/fieldpulse/technician-sync.ts`); HCP infers **synthetic** technician IDs from availability windows (`technician-mapping.ts`) — no true roster. This undercuts dispatch scoring for HCP orgs.
- **Do:** Add `src/lib/integrations/housecall-pro/technician-sync.ts` mirroring the FP pattern (admin-triggered upsert of real techs via the HCP client).
- **Verify:** unit test for upsert/dedupe; existing FP test as the template.

### Stage 7 — HCP durable availability sync **[M] — ⚠️ PARTIALLY-DONE (see results doc; a literal `technician_availability` mirror is structurally blocked — HCP techs are synthetic)**
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

### Stage 19 — Membership plans edit flow **[M] — ✅ ALREADY CLOSED (verified 2026-06-24)**
- **Re-confirmed:** the edit/detail flow + PATCH already exist (the audit premise was stale). Drop from the backlog. See results doc for evidence.

#### (original gap, now obsolete)
- **Gap:** Plans can be created/deleted but **not edited** — no `/admin/membership-plans/[id]` page and no PATCH (`src/app/api/admin/membership-plans/route.ts` has POST only). Editing means delete + recreate.
- **Do:** Add the detail/edit page + a PATCH route (guard active-subscription side effects).
- **Verify:** unit/integration test for update; existing list test unaffected.

### Stage 20 — Tech portal mutations (photos / notes / timeline) **[M] — ⚠️ PARTIALLY-DONE (see results doc: reuse `request_status_events` for the timeline; pass `ADMIN_DOCUMENT_MIME_TYPES` for HEIC — both already exist)**
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
