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

**Verified execution order** (skip 19, 8, 11; safety/security first, then integration, then dispatch-v2):
**5** (security parity) → **6** → **9** → **10** → **7** (Group B) → **12** → **14** → **15** → **13** → **16** → **17** → **18** (Group C) → **20** (Group D). **Done: 1–6, 9.** Closed/no-op: **8** (parity already satisfied), **11** (description-parity; structured form blocked on FP API), **19** (already shipped).

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
- **Follow-up DONE:** refactored voice-turn to call the shared `advanceVerify` too — deleted its ~100-line inline state machine (the duplicate security logic) in favor of the one tested engine. Voice's 3 financial-verify tests (first-ask, ZIP-pass, 2-mismatch lockout) stay green, proving the engine reproduces voice's behavior exactly. One latent quirk shed in the process (an already-passed caller whose account tool returns null now falls through to the LLM instead of being re-challenged — matches chat + the reviewed engine). Voice & chat can no longer drift.
- **🔴 v2 review finding (2026-06-24) — SECURE but a MAJOR FUNCTIONAL bug to fix (Stage 5b, queued):** the v2 adversarial review (verifier `sound`) confirmed **no financial-data bypass** — security is solid (cross-org ZIP impossible, lockout closed at all sites). BUT `pending → passed` is **unreachable via a natural bare-ZIP reply** on BOTH channels: `routeMessage('37601')` returns FALLBACK (the router is keyword/phrase-driven, not stateful), so the verify block (gated on `verdict.action === 'ACCOUNT_LOOKUP'`) is never re-entered on the answer turn — the ZIP is dropped to the LLM and the customer is stuck at the challenge unless they re-state the keyword + ZIP together ("my balance 37601"). Voice DTMF is dead the same way (empty `SpeechResult` → `routeMessage('')` → FALLBACK). The gate **fails closed** (no data leaks), so it's safe but broken UX. **Pre-existing voice limitation faithfully ported to chat — not introduced by Stage 5.** The ZIP-pass tests only pass because they MOCK `routeMessage`, which masked the dead-end.
  - **Stage 5b — CHAT FIXED 2026-06-24; voice + route-harness remain.** Shipped: pure `advanceVerifyAnswer(state, zipAnswer, onFileZips)` (extracted DRY — `advanceVerify` delegates to it) + `looksLikeZipAnswer(msg)` (reduces to exactly 5 digits — recognizes typed/DTMF/spoken ZIP, ignores prose so a topic change never burns an attempt), both exhaustively unit-tested (7 new cases). Wired a chat answer-turn block: when `verify.status==='pending'` + identified customer + `looksLikeZipAnswer` + verdict≠ACCOUNT_LOOKUP, run `advanceVerifyAnswer` and reply ASK/DEFER/PASSED — **this block NEVER serves data** (on pass it invites the re-ask, which the gate serves on the next turn now that verify is `passed`), so it cannot leak even if the heuristic misfires. pending→passed is now reachable on a natural bare-ZIP reply in chat.
    - **VOICE FIXED 2026-06-24 (test-first):** mirrored the chat fix in `voice-turn` — hoisted the `verifyState` read above the gate, broadened it to `(ACCOUNT_LOOKUP || isVerifyAnswerTurn)`, and on the answer turn (`pending` + identified + `dtmfDigits || looksLikeZipAnswer(userMessage)` + verdict≠ACCOUNT_LOOKUP) run `advanceVerifyAnswer` → ASK/DEFER/PASSED via `persistAccountTurn`. Same safety property (never serves data on the answer turn). **Tested via the `voiceReply` harness with `routeMock` returning FALLBACK** (the real router's behavior on a bare ZIP — NOT the ACCOUNT_LOOKUP mock that masked the bug); the 3 existing financial-verify tests stay green (broadened gate didn't break the normal path).
    - **Remaining (Stage 5b):** a **chat route-level test harness** driving the real router (the chat answer-turn fix is verified by the pure-engine tests + build, but the route POST still has no unit harness — that absence is why the original bug shipped unnoticed). This is an infra task, not a behavior change.
- **Defense-in-depth DONE (this tick):** `preserveVerifyKey` added at the **4th** metadata-rebuild site the plan missed (`route.ts` escalation path) — non-exploitable today (escalation is terminal → next turn blocked) but kept consistent with the other three sites.

---

## Group B — FieldPulse ↔ HCP integration parity

### Stage 6 — HCP technician roster sync **[H, foundational] — ✅ DONE 2026-06-24**
- **Was real:** HCP had no roster sync (only synthetic tech IDs); FP upserts `users`.
- **Done:** added `housecall-pro/technician-sync.ts` (`syncTechniciansFromHousecall`) mirroring FP — email-keyed upsert into `users` (role=technician, `setWhere` guards human admins), `housecallProUserId` identity column (+ per-org partial unique index, migration `0022`), and the **guarded** soft-deactivate (no mass-deactivate on an empty/failed roster). Captured `email` on `HousecallTechnician` + `toTechnician` (HCP has no role field, so every employee is a tech candidate; skip no-email/name). 5 new tests (4 sync incl. empty-roster-no-deactivate + degrade; 1 client email-parse). Degrade-safe, tenant-scoped, neon-http sequential awaits.
- **Operator action:** migration `0022` is generated but NOT applied — run `npm run db:migrate` (shared-DB change, operator's call; pairs with the still-pending dispatch `0021`). The module is unwired (no admin route) — **matches FP, which also has no route** (avoids over-delivering vs the template); wiring a "Sync Technicians" button for both is a separate small follow-up.
- **Verify:** ✅ tsc + lint + full suite (2880) + build; no prompt/money/safety surfaces touched.

### Stage 7 — HCP durable availability sync **[M] — ⚠️ PARTIALLY-DONE (see results doc; a literal `technician_availability` mirror is structurally blocked — HCP techs are synthetic)**
- **Gap:** FP syncs availability to the `technician_availability` table via cron (`fieldpulse/availability-sync.ts` + `cron/sync-fieldpulse-availability`); HCP is cache-only (30s TTL, no persistence) via `housecall-pro/scheduling-source.ts`.
- **Do:** Add an HCP availability sync to persist into `technician_availability` + a cron, mirroring FP. Decide cache-vs-DB consistency.
- **Verify:** unit test for mapping HCP windows → availability rows.

### Stage 8 — HCP address validation on customer sync **[M] — ✅ CLOSED (no-op): parity already satisfied (verified 2026-06-24)**
- **The "gap" is illusory.** FP's address validation is **dead code on the free-text customer-sync path**, verified against the code:
  - HCP `customer-sync.ts:85` writes `{ street: contact.address }` as-is (no validation).
  - FP `customer-sync.ts:92` only validates `if (contact.address && hasMinimumAddressQuality({ street: contact.address }))`.
  - `hasMinimumAddressQuality` (`address-validation.ts:299`) returns `street && (city || state || zip)`. The path supplies **only a street** (our `customers.addressEncrypted` is one free-text field) → city/state/zip undefined → **always false** → FP takes the `else if` branch and writes `{ street }` as-is. Photon/geocode are **never reached**.
- **Therefore HCP already matches FP's actual runtime behavior** (both write street-as-is). Building Photon enrichment for HCP would make it **exceed** FP — an asymmetry, the opposite of parity, and over-building. **Skip.**
- **Separate finding (NOT a parity gap — user's call):** FP's `hasMinimumAddressQuality({ street })` guard makes its own validation unreachable for single-field free-text addresses. If address normalization is actually wanted, the real fix is to make validation fire for free-text on the FP path (then mirror to HCP) — a shared improvement, tracked here, not built autonomously since it changes (improves) live FP behavior beyond a parity bar.

### Stage 9 — HCP client rate limiter **[M, reliability] — ✅ DONE 2026-06-24**
- **Was real:** HCP had only per-request retry; FP has a token-bucket adaptive limiter.
- **Done (the verified approach, not a naive client wrap):** **extracted** the token-bucket `RateLimiter` to `integrations/shared/rate-limiter.ts` (with a local `RateLimitInfo` to keep the dependency arrow one-way), left `fieldpulse/rate-limiter.ts` as a re-export shim (**FP suites pass unchanged → proves the extract is behavior-preserving**), and added a `housecallRateLimiter` singleton + a `withHcpRateLimit(orgId, fn)` consumer helper (wait → reportSuccess / reportThrottle-on-429). It sits at the BATCH layer like FP's `bulk-operations`, NOT around `client.request()` (which already retries 429/5xx — wrapping would double-handle). 4 new HCP tests (success/throttle/non-429/per-org isolation).
- **Scope (matches FP precedent):** the limiter + helper are the deliverable; the live consumer is **Stage 10 (HCP bulk-ops)** — FP's limiter is likewise consumed only by bulk-ops, never by wrapping the client. No forced call-site wire (would over-build vs the template).
- **Verify:** ✅ tsc + lint + full suite (2884, incl. unchanged FP rate-limiter + bulk-ops suites) + build; no DB/prompt/money/safety surfaces (limiter is in-memory, keyed by orgId = tenant scope).

### Stage 10 — HCP bulk operations + admin endpoint **[M, ops] — 🟡 QUEUED (scoped; ~500-LOC port → a focused multi-tick effort, not a tick-end rush)**
- **Gap:** FP has chunked bulk-update w/ partial-success/retries (`fieldpulse/bulk-operations.ts` + `/api/admin/integrations/fieldpulse/bulk-update`); HCP has none.
- **Refined approach (assessed 2026-06-24):**
  - **Option A (arbitrary status) is BLOCKED:** HCP `UpdateJobInput`/`updateJob` (`client.ts:399`) have **no `work_status`** field — only `cancelJob` (`PUT /jobs/{id}/cancel`) and `addJobNote` (`POST /jobs/{id}/notes`, note: "ASSUMED HCP SHAPE") mutate a job. A verbatim FP port (`updateJob({workStatus})`) would silently no-op.
  - **Do Option B:** `BulkJobOperation = {hcpJobId, serviceRequestId, action: 'note'|'cancel', note?}` (drop `workStatus`). Port FP's bounded-worker-pool + validate + error-aggregation; `processSingleUpdate` → `cancelJob`/`addJobNote`. **Wire the Stage-9 limiter** (`withHcpRateLimit(orgId, fn)` — now exists) around each item — this also gives Stage 9's limiter its live consumer. Then the admin route (`/api/admin/integrations/housecall/bulk-update`, mirror FP route: `getAdminSession` 401, `slidingWindow(admin:housecall-bulk:…, adminMutation)`, `Array.isArray` body guard, `getHousecallClient` → NOT_CONFIGURED, clientId=`org:${orgId}`). No DB writes (pure HCP API + session) → no neon-http concern.
  - **Document** the no-arbitrary-status limitation (HCP-only) per the plan's escape hatch — do NOT add an unverified `work_status` path.
- **Verify:** unit tests — partial failure per-item, order preserved, continueOnError abort, validate rejects bad action / missing note / >1000; route tests (401/400/NOT_CONFIGURED/happy/tenant-scope).

### Stage 11 — FieldPulse job line-items on push **[M] — ✅ CLOSED at description-parity (verified 2026-06-24); structured form BLOCKED on FP API**
- **Information parity already exists:** FP's job *description* already conveys the same classification HCP packs into structured line items — `Work Type: {jobType}`, `System: {systemType}`, `Issue`, `Urgency`, `Details`, `Access` (`fieldpulse/job-mapping.ts:buildDescription`). Only the wire-format differs (labelled lines vs a `line_items` array).
- **Structured FP line items NOT built (BLOCKED — needs user/operator input):** there is **no evidence FieldPulse's `POST /jobs` accepts a `line_items` array** — the codebase only READS `line_items` off `/invoices`. Building it would (a) guess at an external API (risking a silently-4xx-dropped or job-sync-degrading payload) while (b) mirroring an *already-assumed* HCP shape (`client.ts:169` "ASSUMED HCP SHAPE"), and (c) add data redundant with the description. Per "don't guess at external APIs," deferred until **FieldPulse vendor docs / a sandbox confirm `/jobs` line-item support** (operator can confirm). Documented the design choice in `job-mapping.ts` to prevent future churn.

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
