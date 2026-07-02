# Avoca Council Plan — The Revenue-Moat Bet (Book-on-the-Call + AI Outbound Voice)

**Date:** 2026-06-25
**Status:** roadmap (program-level) — synthesized by the council from 4 advisor proposals + 3 judge verdicts. This is a **second, deliberately divergent strategic bet** that runs alongside (not replacing) the existing QA-first plan (`2026-06-24-avoca-parity-20-stage-program.md`). Each stage becomes its own brainstorm → spec → `writing-plans` cycle before implementation.
**Lead bet (council winner):** `revenue-moat-first` — won "impact-and-differentiation" and "feasibility-on-our-stack" outright; runner-up on "risk-and-compliance." Grafted with the best risk/compliance primitives from `compliance-trust-as-product` and the cheapest first-value QA tier from `call-intelligence-first`.

---

## 1. Lead thesis — why this bet, per the judges

**Bet the program on dollars-recovered, on the FSM we can actually write to today.** Two of three judges ranked `revenue-moat-first` first, and both did so for the same code-verified reason: the booking write-path is **not greenfield and not blocked** the way the existing QA-first plan assumes. `submit-session-request.ts` already fires `pushJobToFieldpulse` + `autoAssignBookedRequest` inside `after()`; `createJob` exists in the FieldPulse client; `leadSourceEnum` and `service_requests.leadSource` already exist and are simply never populated; the slot-hold concurrency guard has a direct neon-http-safe precedent in `availability-sync.ts` (conditional `UPDATE`, no transaction). So "answer the call → offer a real open slot → commit it → write a dispatchable, tech-assigned FieldPulse job → attribute the booking to a tracking number → swing again by **AI outbound voice** on the ones we miss" is roughly **80% built infrastructure plus a small, well-bounded set of new stages**. The single most defensible *new* differentiator — **AI outbound voice callback via `calls.create`** — was verified novel (that Twilio call is used nowhere in the repo) and is an explicit open gap the existing plan lists as "not built."

The honest-but-saleable claim to an HVAC owner is **"we book the jobs your team misses, into FieldPulse, and we call back the ones who hung up"** — the thing a contractor actually pays first dollar for. We concede the real-time voice-quality gap openly (turn-based `<Gather>`, not Media Streams) rather than claiming Avoca parity.

---

## 2. How this differs from the existing QA-first plan

| Axis | Existing QA-first plan (2026-06-24) | This plan (revenue-moat) |
|---|---|---|
| Center of gravity | Grade our own AI calls; recovery; QA as the product | Capture dollars; QA demoted to a **booking-outcome classifier** |
| FSM booking | Treated as blocked Stage-19 sub-program (scoped to HCP MAX-plan + ServiceTitan-plan-only) | **Booked TODAY on FieldPulse** — the write path already fires in `after()`; this is the spine, not a deferral |
| Headline differentiator | 100%-call QA + missed/unbooked recovery (SMS) | **AI outbound VOICE recovery** (`calls.create` → same `voice-turn` engine) — verified novel |
| First move | Stage 0 = number→org table for QA attribution | Stage 0 = same `inbound_numbers` registry, but it unblocks **multi-tenancy AND lead-source attribution AND revenue** in one change |
| QA role | The deliverable | A downstream label (booked / declined / abandoned / pricing-leak-lost) on `call_records`, plus a cheap deterministic dashboard tier |
| Recording / external-LLM | Earlier in sequence | Hard-gated **after** consent-free revenue value lands |

This is a genuine strategic correction grounded in the code, not a re-ordering of the same QA thesis.

---

## 3. The 20 stages, grouped into phases

Flags: **[MIGRATION]** = schema change · **[GATE]** = operator/legal/infra/config gate · **[PURE]** = no migration, wiring/lib only. Every PII-bearing table flag also lists its cascade obligation.

### Phase A — Unblock tenancy + attribution + the call spine (Stages 0–3)
*The dependency root. Nothing books or attributes without these.*

**Stage 0 — Tracking-number → org + lead-source registry (`inbound_numbers`).**
Replace `voice/incoming`'s hardcoded `DEMO_ORG_ID` by resolving the dialed Twilio number (`params.To`) to an org and a lead source. *The single change that unblocks multi-tenancy AND attribution.* `sms/incoming` + `webhooks/housecall` share the same hardcode — move them together or tenant isolation is illusory.
**[MIGRATION]** `inbound_numbers(org_id, e164_did UNIQUE, lead_source leadSourceEnum, label, enabled)`. DID is **not** PII → no erasure/export cascade burden. **[GATE]** operator provisions DIDs in Twilio.
*Reuses:* `voice/incoming`, `leadSourceEnum` (exists), `twilio-signature.ts`.

**Stage 1 — Cascade-coverage CI test (the load-bearing safety primitive — grafted from `compliance-trust-as-product`).**
A CI test that **fails the build** if any new PII-bearing table is absent from EITHER `anonymizeCustomer` (erasure) OR `exportOrganization` (export). Both are hand-enumerated `db.batch` lists that silently skip new tables; this test is the regression guard for every later PII migration in this plan. Ship it *before* the first PII table (Stage 3).
**[PURE]** (test + a registry of PII tables). **[GATE]** none — this is the gate everything else trips.
*Reuses:* existing `anonymizeCustomer` / `exportOrganization` enumerations.

**Stage 2 — Caller-jurisdiction consent resolver (pure lib — grafted from `compliance-trust-as-product`).**
Pure, versioned, unit-testable function mapping caller E.164 ANI → one-party / two-party recording regime → disclosure script + whether affirmative consent is required. Johnson City base is one-party, but callers may be anywhere. **Default = always-disclose, affirmative-consent-on-uncertainty** (area code ≠ physical location: VoIP/portability). This is a prerequisite for *both* Stage 8 (outbound voice) and Stage 11 (recording).
**[PURE]** `src/lib/voice/recording-jurisdiction.ts` (mirrors `resolve-voice-identity.ts`). **[GATE]** legal-reviewed state table is the compliance source of truth; version it; counsel sign-off on the limitation.

**Stage 3 — `call_records`: the call's row of record.**
Keyed on `CallSid`: `org_id`, `fromAni` (encrypted PII), `toDid`, `lead_source`, started/ended, duration, disposition (answered/missed/abandoned/refused-recording/after-hours), linked `service_request_id` + `customer_session_id`, `language`, retention TTL. The spine every later stage joins to; written from `voice/incoming` + Twilio status callbacks.
**[MIGRATION]** `call_records`. **COMPLIANCE:** `fromAni` is PII → must join BOTH cascades (Stage 1 test enforces) + retention TTL. neon-http aggregates return strings → cast in later rollups.

### Phase B — Stamp the source, see real availability (Stages 4–5)

**Stage 4 — Stamp `leadSource` on every booking from the resolving DID.**
Thread the resolved `lead_source` from `inbound_numbers` through `submit-session-request` so `service_requests.leadSource` is set deterministically per call instead of NULL. Web sessions default to `'website'`; tracked DIDs override. `voice-turn` already calls `submitSessionServiceRequest` → this is a param add, not new plumbing.
**[PURE]** (`leadSourceEnum` + column already exist). Tests assert source provenance.

**Stage 5 — Live-availability slot offer inside the voice turn (not just preference).**
Upgrade the voice WINDOW step from preference-only copy to offering concrete bookable bands from the existing `SchedulingSource` seam (FieldPulse `availability-sync` already populates it). The prerequisite to committing a time on the call.
**[PURE]** Reuse `getSchedulingSource` + `OpenAvailability`. **[GATE]** FieldPulse availability endpoint may 404 (`scheduling-source.ts` falls back to the DB source) — degrade-safe; keep the band/count surface PII-free.

### Phase C — Book on the call (the verified ~80%-built moat) (Stages 6–7)

**Stage 6 — Commit-on-call: write the chosen slot into the FieldPulse job.**
When the caller picks an offered band, set `arrivalWindowStart/End` on the `service_request` before submit, so `pushJobToFieldpulse` (`createJob` exists) writes a **time-bound dispatchable** job and `autoAssignBookedRequest` attaches a tech. Turns "preference captured" into "job booked" on the FieldPulse system of record. *Highest-ROI, lowest-net-new-code stage on the council.*
**[PURE]** Reuse `createJob`/`updateJob` + `autoAssignBookedRequest` (already fire in `after()`). **[GATE]** Keep the **frozen** no-"booked"/"confirmed" safety text honest — only claim *booked* once the FP write + auto-assign actually succeed (respect `after()` ordering); fall back to preference language if assign fails.

**Stage 7 — Slot-hold concurrency guard (no double-book on neon-http).**
Short-lived slot reservation so two concurrent callers can't be offered+committed the same opening. Implement as a compare-and-set claim row via a **single atomic `UPDATE`/`db.batch`** — explicitly **NOT** `db.transaction` (throws at runtime on neon-http). Mirrors the verified `availability-sync.ts` claim precedent. Expires on submit-failure.
**[MIGRATION]** `slot_holds(org_id, slot_key, expires_at, claimed_by)`. No PII. CAS via single-statement update.

### Phase D — Detect the misses, swing again by VOICE (the differentiator) (Stages 8–10)

**Stage 8 — Missed-call detection via Twilio status callbacks.**
Register a `statusCallback` on inbound DIDs so no-answer / busy / failed / short-abandon land in `call_records` as `'missed'` — the trigger source the whole recovery loop depends on. Reconcile against whether a `service_request` was created so a missed call that still booked isn't double-counted.
**[GATE]** Twilio `statusCallback` URL config (operator) + reuse `twilio-signature.ts`. No migration beyond Stage 3 fields.

**Stage 9 — AI outbound-VOICE recovery engine (the marquee NEW differentiator).**
Build an outbound-call placer using `calls.create` (**verified used nowhere today**) that dials a missed/abandoned caller back and connects them into the **same `voice-turn` engine** via a TwiML callback URL. The first AI outbound voice in the stack, replacing SMS-only recovery for the missed-call class.
**[GATE — the plan's sharpest legal risk]** A missed inbound dial is **NOT TCPA consent** to robo-call back. Out-of-state callers are two-party for recording. One-party-consent only safe for TN-jurisdiction callers (Stage 2 resolver decides); out-of-state callers get the disclosure/decline path. Operator + legal gated; cap attempts; quiet-hours via `checkSendAllowed`. **Do not make this the live headline until the Stage 10 suppression ledger is proven.**
*Reuses:* `voice-turn`, `call_records`, `outboundMessageLedger`.

**Stage 10 — Recovery orchestration + enforced callback consent/suppression ledger.**
Extend the `booking-recovery` cron to a channel ladder: attempt outbound voice first (Stage 9), fall back to existing SMS recovery on no-answer/decline, over a unified missed+abandoned queue with per-attempt dedupe via `claimOutboundOnce`. Record per-caller callback consent/suppression ("do not call back", prior decline) and **enforce it at the code boundary**, mirroring `checkSendAllowed` — a declined caller is never re-dialed.
**[GATE]** Add `missed_call` to the **closed** `CommTrigger` union with a real `TRIGGER_RULES` entry (a test asserts every trigger has rules or `checkSendAllowed` throws). Extend existing `communication_preferences` with a voice/callback opt-out rather than a new table; confirm export-cascade coverage (Stage 1 test). Cron ships unscheduled.

### Phase E — Classify, gate recording, prove the dollars (Stages 11–15)

**Stage 11 — Booking-outcome classifier per call (QA demoted, deterministic-first).**
Reuse the already-built, inert `qa/` primitives (`transcript-adapter` + `transcript-flags` + `call-qa` `hardFail`) **NOT as a rubric score** but as a booking-outcome label — booked / declined / abandoned-mid-intake / pricing-leak-lost — persisted on `call_records`, so the ROI report can attribute WHY a tracked call didn't convert. Runs in `after()` on session finalization (NOT a floating promise — Vercel freeze).
**[PURE]** Label columns on `call_records` (Stage 3). Reuse `output-guardrail` deterministic flags first; **no external LLM on the critical path.**

**Stage 12 — Recording on the booking-critical path (consent-correct, gated late).**
Add `<Record>` for booked/recovery calls with disclosure-BEFORE-record (Stage 2 resolver), a **decline → non-recorded flow that still books** (never hang up), Twilio-side deletion after R2 pull, R2 encryption-at-rest, retention TTL. Fetch/encrypt in `after()`/cron. Sequenced here — *after* consent-free revenue value — because audio is the heaviest compliance load and the revenue loop does not need it.
**[GATE — COMPLIANCE BLOCKER]** Per-CALLER-jurisdiction consent; always-disclose default. **[MIGRATION]** `call_recordings(org_id, call_sid, r2_key, consent_basis, caller_state, ttl_at)` → BOTH cascades (Stage 1 test) + retention purge cron. `messages` plaintext transcript inherits the existing `messages` erasure path; verify coverage.
*Reuses:* aws-sdk/R2, `twilio-signature.ts`, audit-log access pattern.

**Stage 13 — Retention/TTL enforcement cron.**
Daily cron (mirror `cron/cleanup` + `webhook-cleanup`) deletes R2 audio + scrubs `call_recordings` rows past `ttl_at`; enforces per-org retention. Deletion evidence to `audit_log` (PII-free per the audit rule). Trust requires data that provably goes away.
**[GATE]** `vercel.json` cron entry; per-org retention setting on `organization_settings` (small migration); `after()`-style batching for R2 deletes; ships unscheduled then operator-enabled.

**Stage 14 — Booking-rate-by-source report (the dollars dashboard).**
The headline ROI view: calls → answered → booked → recovered, broken down by `lead_source`/DID, with conversion% and recovered-job counts. Aggregates over `call_records` + `service_requests`. **neon-http aggregates return STRINGS → `Number()`-cast everything** or it silently sums as strings. Honest metric definitions (a recovered job credited once). Role-gated to admin.
**[PURE]** Read-model query + admin page.

**Stage 15 — Revenue attribution: join booked jobs to mirrored invoices.**
Close the dollars loop by linking each attributed booking to the READ-ONLY FieldPulse/HCP invoice mirror (`fieldpulse_invoice_id`), so the report shows **revenue-by-source** and **revenue-recovered**, not just counts — answering "what did this tracking number earn?"
**[PURE]** Invoice mirrors + `service_requests.invoiceStatus` exist. Respect the read-only money guard (`fieldpulse_invoice_id IS NOT NULL`). Best-effort where the invoice link is absent.

### Phase F — Harden, expand, prove the loop closes (Stages 16–19)

**Stage 16 — After-hours / overflow auto-answer routing per DID.**
Use `organization_settings` business-hours + the existing after-hours voice path so tracked DIDs auto-answer 24/7 and still book live-availability slots — the Avoca "answer the calls you miss" promise, measured as after-hours booking-rate in Stage 14. Ensure the slot offer respects next-business-day windows after hours.
**[PURE]** after-hours logic + `isAfterHours` flag exist.

**Stage 17 — Auto-assign + dispatch reconciliation for booked-on-call jobs.**
Harden `autoAssignBookedRequest` for higher booked-on-call volume — surface auto-assign failures (no tech for the committed window) as a dispatch alert + a graceful "we'll confirm the exact time" fallback rather than a silently unassigned job, keeping the FieldPulse job + our board in lockstep. *Load-bearing: a booked time the team can't honor erodes trust faster than a missed call.*
**[PURE]** Reuse `autoAssignBookedRequest` + `requestStatusEvents`. `after()`-based, never on the latency-bound voice turn. Degrade-safe.

**Stage 18 — Optional LLM booking-judge (gated, redacted, off the critical path).**
Run `eval/judge.ts` `judgeTranscript` over real booked/lost transcripts to grade `falseBooking` + `completion` as an accuracy check on Stage 11's deterministic labels — **strictly behind per-org opt-in + a signed DPA + PII redaction** (name/phone/address/email stripped before any transcript touches the external Qwen/GLM endpoint), grafted from `compliance-trust-as-product`'s redaction boundary (redact, don't merely gate the org). Degrade-safe: deterministic labels carry the ROI report if the judge is off.
**[GATE — COMPLIANCE BLOCKER]** Signed DPA / zero-retention config; per-org AI-QA opt-in separate from recording opt-in; cross-border check for non-US callers; redacted-transcript-only. Operator + legal gated; offline until satisfied.

**Stage 19 — Recovery effectiveness attribution loop + cross-org anonymized benchmarking.**
(a) Link recovery sends/calls back to subsequent sessions/outcomes to measure recovered-booking lift, surfaced on the dashboard as recovered revenue — proving the expansion's ROI. (b) **Cross-org anonymized k-anonymity benchmarking** (grafted from `call-intelligence-first`) so each operator sees how their booking-rate ranks vs peers — a network-effect moat neither Avoca's per-account model nor the existing plan offers.
**[GATE — BLOCKER for (b)]** k-anonymity minimum org count; aggregate-only (no row-level / no per-call cross-org leakage); separate consent for benchmarking; aggregates cast from strings. (a) is `[PURE]` (join over existing sessions + `communication_jobs` ledger).

### Cross-cutting / continuous

**Stage 20 — Spanish booking + recovery path (market expansion of the moat).**
Add Spanish to `voice-turn` intake + slot-offer + recovery scripts (shared chat+voice engine + `cannedResponses`), since callers may be anywhere; language detected per call and stamped on `call_records` for source/language conversion analysis.
**[PURE]** `language` column on `call_records` (Stage 3), no PII. **[GATE]** ElevenLabs Spanish voice config; **frozen-safety-text must be translated AND stay FROZEN** in both languages; QA flags + jurisdiction disclosure (Stage 2) must cover Spanish.

---

## 4. Compliance spine (cross-cutting — applies to every PII stage above)

This is the council's grafted backbone; it is not a phase, it is a standing invariant.

1. **Cascade coverage (Stage 1, load-bearing).** `anonymizeCustomer` and `exportOrganization` are two independent hand-enumerated `db.batch` lists that silently skip new tables. Every PII table in this plan — `call_records` (Stage 3), `communication_preferences` callback opt-out (Stage 10), `call_recordings` (Stage 12) — MUST join BOTH, enforced by the CI test that fails the build. Schema drift here is a privacy breach, not a bug.
2. **Recording = per-CALLER-jurisdiction consent (Stage 2 → 12).** Caller may be in a two-party state. Default always-disclose, affirmative-consent-on-uncertainty, decline→non-recorded-but-still-books path. Area code ≠ physical location — documented legal limitation, counsel-signed state table.
3. **Outbound voice = NOT TCPA-consented by a missed inbound dial (Stage 9 → 10).** Enforced suppression ledger at the code boundary; attempt caps; quiet-hours via `checkSendAllowed`; `missed_call` added to the closed `CommTrigger` union with a real rule.
4. **External-LLM egress = DPA + redaction (Stage 18).** No transcript reaches the external Qwen/GLM judge un-redacted or un-gated. Per-org opt-in, cross-border check for non-US callers, zero-retention/DPA. The revenue loop and the deterministic classifier (Stage 11) work entirely without it.
5. **Retention/TTL (Stage 13).** R2 audio + `call_records` purged on schedule; deletion evidence to `audit_log` (PII-free).
6. **neon-http realities (everywhere).** No interactive transactions → `db.batch` / single-statement CAS (Stage 7). Aggregates return strings → `Number()`-cast (Stages 14, 19). All FSM writes / recording fetches / judge runs in `after()` or cron, never detached promises (Vercel freeze).

---

## 5. Sequencing / dependency note

- **Stage 0 is the root** — every other stage depends on org+source resolution. Stage 1 (cascade test) and Stage 2 (jurisdiction lib) are **pure and can start immediately, migration-free**, in parallel with Stage 0.
- **Critical path to first dollar:** 0 → 3 → 4 → 5 → 6 (book on the call). Stage 7 (slot-hold) gates *safe* booking at concurrency but a single-pilot org can soft-launch Stage 6 before 7.
- **Differentiator path:** 3 → 8 → 9 → 10 (outbound voice), gated on Stage 2 (jurisdiction) + Stage 10's own suppression ledger before going live.
- **Recording (12) and external-LLM judge (18) are deliberately late** — the revenue loop and the deterministic dashboard (11/14) carry first value with ZERO new compliance load.
- **Multi-tenancy is built in at Stage 0**, not deferred — this plan can onboard a second pilot org early (unlike the call-intelligence proposal, which deferred it to Stage 12).

---

## 6. Honest parity gaps / deliberate deferrals

- **Real-time full-duplex voice (Media Streams) — NOT in this plan.** This is Avoca's actual moat and is genuinely absent from the repo (no `<Connect><Stream>`, no persistent WS process; Vercel serverless + neon-http cannot host the socket). The `realtime-voice-first` advisor proposed a separate off-Vercel media-gateway; all three judges flagged it as the highest-variance, possibly-rejected infra fork and the wrong first bet to fund alongside the existing hardened plan. We **keep turn-based `<Gather>` as the permanent answer path** and concede the voice-quality gap openly. (If the org later funds the gateway, that becomes its own program — do not deprecate `<Gather>`.)
- **`<Gather>` deprecation/cutover — explicitly dropped** by two judges as a self-inflicted reliability cliff. Never retire the only working answer path.
- **ServiceTitan write-path adapter — deferred, not built.** ServiceTitan is plan-only with zero API access today; a generalized seam now is speculative scaffolding (violates simplicity-first), untestable against live ServiceTitan. FieldPulse is the shipping write path; generalize only when access lands.
- **HCP write-path booking — blocked** (needs MAX-plan). FieldPulse is the FSM we book to; HCP/FieldPulse invoice mirrors stay READ-ONLY (money guard).
- **CSR copilot / per-rep coaching — deferred.** PURE-AI pilot decision stands; roles are `admin`/`technician` only, no `csr`, no human call-center to copilot.
- **Insurer-facing compliance-evidence dashboard — demoted to a supporting feature**, not a headline (judges: most HVAC owners buy revenue, not an insurer screen). The compliance spine still ships; we just don't sell it as the wedge.
- **Training simulator — folded into the existing offline `eval/judge` fixtures path**, not a standalone program stage (every advisor duplicated it; the judges said collapse it).

**Honest stage count.** This is a genuinely 20-substantial-stage program *only because* the differentiator (outbound voice, Stages 8–10) and the compliance spine (Stages 1, 2, 12, 13) are real, separable work on top of the ~80%-built booking core. The booking core itself (Stages 4–7) is light net-new code riding existing plumbing — that is the bet's strength, not padding. If forced to be blunt: the **heavy** stages are 0, 3, 9, 10, 12, 13, 18, 19; the **light/wiring** stages are 4, 5, 6, 11, 15, 16, 17. None is filler.

---

## 7. Open questions for the operator

1. **TCPA basis for outbound voice (Stage 9).** Do we have, or can we obtain, a documented consent/relationship basis to call back a missed inbound caller — or do we restrict outbound voice to TN one-party callers only and SMS-fallback everyone else? This gates the marquee differentiator.
2. **FieldPulse live availability reliability.** `scheduling-source.ts` warns the FP availability endpoint may 404 and fall back to the DB source. If FP availability is unreliable in practice, "commit a real slot on the call" degrades to preference-capture. Can we confirm FP availability is live for the pilot org?
3. **DID provisioning discipline.** Attribution truth depends on one source per DID. Will the operator commit to not sharing/repointing tracking numbers? Garbage DID mapping = a garbage dollars dashboard.
4. **Recording retention window + per-org policy** (Stage 13) and **signed DPA + zero-retention config** for the external Qwen/GLM judge (Stage 18) — who owns getting these legally executed, and by when?
5. **Auto-assign capacity (Stage 17).** At booked-on-call volume, how often will there be no tech free for a committed window? The fallback ("we'll confirm the exact time") must be acceptable to the pilot, or commit-on-call over-promises.
6. **Cross-org benchmarking consent (Stage 19b).** Is there appetite (and the org count) for the k-anonymity benchmarking network effect, or do we drop it as out-of-scope for a single/early pilot?
