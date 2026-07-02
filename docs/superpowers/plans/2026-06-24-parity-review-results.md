# Parity Program — Plan & Review Results (v2, refreshed 2026-06-24)

Second 40-agent pass, re-run against the CURRENT code after Stages 1–6 & 9 shipped. Modes: **review** (bug-hunt shipped stages), **closure** (independently verify the close decisions), **plan** (refresh pending stages). Each assessment independently verified by a skeptic. Supersedes the v1 results.

## Status summary

| Stage | Title | Mode | Verified status | Verify | Effort |
|---|---|---|---|---|---|
| 1 | Voice post-reply safety screening | review | shipped-correct | sound | none |
| 2 | After-hours booking-target inference on voice | review | shipped-correct | sound | S |
| 3 | Voice returning-customer recognition | review | shipped-correct | sound | S |
| 4 | Chat customer-context persistence on linked sessions | review | shipped-correct | sound | S |
| 5 | Account-data verify gate (chat) + shared advanceVerify + voice refactor | review | shipped-with-issues | sound | M |
| 6 | HCP technician roster sync | review | shipped-correct | sound | none |
| 7 | HCP durable availability sync | plan | real-gap | sound | M |
| 8 | HCP address validation on customer sync | closure | closure-correct | sound | none |
| 9 | HCP rate limiter (shared token-bucket extract) | review | shipped-correct | sound | none |
| 10 | HCP bulk operations + admin endpoint | plan | real-gap | minor-corrections | M |
| 11 | FieldPulse job line-items on push | closure | closure-correct | sound | none |
| 12 | technician_skills table + CRUD UI | plan | real-gap | sound | M |
| 13 | Technician base location + proximity scoring | plan | real-gap | minor-corrections | M |
| 14 | Tunable confidence threshold (org-level) | plan | real-gap | minor-corrections | M |
| 15 | Failed-auto-assign reconcile sweep (cron) | plan | real-gap | sound | M |
| 16 | Real-time availability (PTO / sick / live load) | plan | real-gap | minor-corrections | M |
| 17 | Technician push notification (tech_assigned) | plan | real-gap | minor-corrections | M |
| 18 | Customer "your technician is X" messaging | plan | real-gap | sound | M |
| 19 | Membership plans edit flow | closure | closure-correct | sound | none |
| 20 | Tech portal mutations (photos / notes / timeline) | plan | partially-done | minor-corrections | M |

> **Headline:** all shipped stages secure/correct EXCEPT **S5 has a confirmed major FUNCTIONAL bug** (gate fails closed — secure — but `pending→passed` is unreachable via a natural bare-ZIP reply on BOTH channels; pre-existing voice limitation ported to chat). Closures **8, 11, 19** all independently confirmed correct. See each stage below.

---

## Stage 1 — Voice post-reply safety screening  _(review)_

**Verified status:** shipped-correct  **·  Verify:** sound  **·  Effort:** none

**Evidence:**
- src/lib/ai/voice-turn.ts:929 — the single free-form `generateText` call (the only LLM-fallback reply on voice; grep confirms no other generateText/streamText/generateObject in file)
- src/lib/ai/voice-turn.ts:939 — `const screened = screenAssistantReply(text);` runs BEFORE TTS+persist (line cite drifted again: plan/results docs say :971, prior reviews said :943-954 — actual is now :939)
- src/lib/ai/voice-turn.ts:946 — `const reply = toSpokenReply(screened.reply, { nearLimit })` uses screened text; phone-agent.ts:62-83 toSpokenReply only strips markdown/escalation + optionally appends a fixed safe sentence, cannot reintroduce price/booking
- src/lib/ai/voice-turn.ts:954 (persist content=reply) + :987 (return reply) both derive from screened.reply
- src/lib/ai/output-guardrail.ts:107-134 — screenAssistantReply runs all four detectors (PRICE_REGEX/FALSE_BOOKING_REGEX/DANGEROUS_DIY_REGEX/CREDENTIAL_REGEX); dangerous-diy/credentials replaced first
- src/lib/ai/voice-turn.test.ts:763-791 — WS1 test mocks generateText to emit "...all booked...$200", drives the real voiceReply FALLBACK_LLM path, asserts BOTH returned reply and persisted assistant message are scrubbed (passed: 1/1, 26 skipped)
- Parity confirmed: chat route.ts:2049 and voice voice-turn.ts:939 both call the same screenAssistantReply; eval run-eval.ts:20 imports PRICE_REGEX/FALSE_BOOKING_REGEX/screenAssistantReply — runtime + CI cannot drift
- Tests green: output-guardrail.test.ts 60/60; voice-turn 'output guardrail' 1/1
- src/lib/ai/output-guardrail.ts:20 — PRICE_REGEX = /\$\s?\d/ catches only $-prefixed numerals (the spoken-form gap)

**Assessment:**

No behavioral bugs. Re-confirmed against current (shifted) code: the voice LLM-fallback reply is screened through screenAssistantReply (all four detectors) at voice-turn.ts:939, between generateText (:929) and toSpokenReply/persist (:946/:954). The screened text is what is both spoken and persisted; toSpokenReply (phone-agent.ts:62-83) is a pure markdown-strip + fixed-sentence-append and cannot reintroduce a violation, including on the near-limit branch (it operates on screened.reply). The LLM call is the ONLY free-form path (grep: one generateText, no streamText/generateObject); the other 8 voice return points use deterministic templates and correctly bypass screening. Chat and voice share the single-source-of-truth detectors, which the eval gate also imports, so runtime and CI cannot drift. metadata.verify, money-safety, and hvac-knowledge.ts frozen safety text are not touched by this path. The WS1 test exercises the real path end-to-end, not just the detector unit. Two minor, non-blocking, non-regression notes carry forward: (1) DOC DRIFT — the screen-call line cite is stale in BOTH plan docs (cite :971; actual :939) and in prior reviews (cited :943-954); worth correcting to avoid the 'stale audit' failure the program itself warns about. (2) DETECTOR SCOPE (pre-existing, shared with chat) — PRICE_REGEX only catches '$'-prefixed numerals, so spoken-form prices ('two hundred dollars', '200 bucks') pass unflagged; since TTS never renders a literal '$' this detector is effectively weaker on voice, but the limitation is identical on chat so voice↔chat parity (the stage's goal) is preserved. Latent safety-coverage gap for a future detector-hardening stage, not a Stage-1 defect.

**Key risks:**
- Spoken-form/word prices ('two hundred dollars', '200 bucks', 'around two-fifty') bypass PRICE_REGEX on voice — a latent safety-coverage gap shared identically with chat, NOT a Stage-1 parity regression; candidate for a future detector-hardening stage
- Line-cite drift in both plan docs (2026-06-24-parity-program §Stage 1 and parity-review-results §Stage 1 cite :971; actual is :939) — cosmetic, prose claims remain correct, but it is exactly the 'stale audit' pattern the program flags

**Verifier (sound):** confirmed; no corrections.

_Notes:_ Independently re-derived against current code; every load-bearing claim holds. CONFIRMED: voice-turn.ts:929 is the only free-form LLM call (grep: one generateText, no streamText/generateObject). screenAssistantReply(text) at :939 runs all four detectors (output-guardrail.ts:107-134) BEFORE toSpokenReply (:946), persist (content=reply :954), and return (:987) — all derive from screened.reply. toSpokenReply (phone-agent.ts:62-83) is a pure markdown-strip + near-limit fixed-sentence append on screened.reply, so it cannot reintroduce price/booking violations, including the near-limit branch. Deterministic return points (e.g. :700, :719 use VOICE_OFFICE_REPLY-style templates) genuinely bypass screening and are safe. Parity verified: chat route.ts:2049 and eval run-eval.ts:20 import the same screenAssistantReply/PRICE_REGEX/FALSE_BOOKING_REGEX from output-guardrail.ts — single source of truth, runtime+CI cannot drift. RAN the suites: src/lib/ai/voice-turn.test.ts (WS1 'screens an unsafe LLM reply' at :763-791 drives the real FALLBACK_LLM path, asserts both returned reply and persisted assistant message are scrubbed of $-price and 'booked') + output-guardrail.test.ts — 59 passed, 28 skipped, 0 failed.

MINOR NOTES BOTH CONFIRMED, NON-BLOCKING:
(1) Doc-drift is REAL and the assessment's correction is right: docs/.../2026-06-24-parity-review-results.md and parity-program-20-stage.md cite voice-turn.ts:971/:978/:986 for the screen/spoken/persist calls, but current actual is :939/:946/:954. The ~32-line shift was caused by commit 5b96554 ('Stage 5 follow-up' deleting a duplicate gate). The assessment correctly cites :939 against current code; only the older plan docs are stale. Cosmetic — prose claims remain accurate.
(2) PRICE_REGEX = /\$\s?\d/ (output-guardrail.ts:20) only matches $-prefixed numerals, so spoken-form prices ('two hundred dollars', '200 bucks') pass unflagged. This is a latent safety-coverage gap shared IDENTICALLY with chat (same regex, same module), so voice↔chat parity — the stage's actual goal — is preserved. Correctly characterized as a future detector-hardening candidate, not a Stage-1 defect or Stage-5 financial bypass.

No missed bug, no over-rated non-issue, no invariant violation (metadata.verify, money-safety, hvac-knowledge.ts frozen text untouched by this path). Closure decision is correct. Relevant files: /Users/sizbei/Documents/GitHub/ai-hvac-agent/src/lib/ai/voice-turn.ts, /Users/sizbei/Documents/GitHub/ai-hvac-agent/src/lib/ai/output-guardrail.ts, /Users/sizbei/Documents/GitHub/ai-hvac-agent/src/lib/ai/phone-agent.ts, /Users/sizbei/Documents/GitHub/ai-hvac-agent/src/lib/ai/voice-turn.test.ts, /Users/sizbei/Documents/GitHub/ai-hvac-agent/src/lib/ai/eval/run-eval.ts, /Users/sizbei/Documents/GitHub/ai-hvac-agent/src/app/api/chat/route.ts.

---

## Stage 2 — After-hours booking-target inference on voice  _(review)_

**Verified status:** shipped-correct  **·  Verify:** sound  **·  Effort:** S

**Evidence:**
- src/lib/ai/after-hours-chat.ts:144-159 — inferBookingTarget shared pure helper: asap->now; morning/afternoon/evening->business_hours; not_urgent->business_hours; urgent->now; else unknown
- src/lib/ai/after-hours-chat.ts:176-182 — business_hours branch returns offer_next_day BEFORE the urgent branch (187-197), so an after-hours daytime-window request never reaches disclose_charge (the Stage 2 bug fix)
- src/lib/ai/voice-turn.ts:21,760 — voice imports inferBookingTarget and passes bookingTarget: inferBookingTarget(merged.extras?.preferredWindow, "unknown") into decideAfterHoursDisclosure (the prior gap, now closed)
- src/app/api/chat/route.ts:18,1509-1518 — chat imports the SAME shared helper; git show 7d2783b: route.ts -36 lines (inline copy DELETED, not duplicated) — true DRY parity
- src/lib/ai/triage.ts:425,570 + extraction-schema.ts:63-68 — full live wiring: preferred_window step -> preferredWindow extras key -> enum morning/afternoon/evening/asap -> matches helper's recognized strings; captureEnrichmentAnswer (triage.ts:641-691) populates merged.extras.preferredWindow
- src/lib/ai/voice-turn.ts:762-773 — afterHoursShown latch fires ONLY in disclose_charge branch; suppressed (offer_next_day) cases neither speak a charge nor consume the once-per-session flag
- src/lib/ai/voice-turn.ts:745,774-779 — ah-config load wrapped in try/catch that logs + skips disclosure on failure; inferBookingTarget takes unknown and returns "unknown" for SKIP_SENTINEL/unrecognized input -> fails SAFE
- git show --stat 7d2783b — diff touches only after-hours-chat.ts, voice-turn.ts(+6), chat/route.ts(-36), tests, plan doc; hvac-knowledge.ts NOT in diff (frozen safety text intact); no money-safety surface touched
- Tests: after-hours-chat.test.ts 19/19 pass, voice-turn.test.ts 27/27 pass (re-run 2026-06-24)

**Assessment:**

No Stage 2 defects after a genuine adversarial hunt. The shipped implementation is correct and matches intent. Re-confirmed against CURRENT code (line numbers shifted since the first review — chat caller now at route.ts:1509, voice at voice-turn.ts:760 — but logic identical): (1) single shared pure helper, inline chat copy deleted (DRY parity); (2) business_hours branch overrides urgency so an 11pm caller wanting a tomorrow-morning slot gets offer_next_day, never disclose_charge; (3) the preferred_window->preferredWindow->enum pipeline is genuinely live end-to-end (verified STEP_TO_EXTRA, ENUM_STEP_VALUES, captureEnrichmentAnswer), not inert; (4) degrade-safe via try/catch + unknown-fallback; (5) latch only consumed in the disclose path; (6) frozen safety text and money-safety untouched.

Edge-case probes I ran that came back clean for Stage 2: a SKIP_SENTINEL on the optional preferred_window step (triage.ts:654-656) yields extras.preferredWindow="__skipped__", which inferBookingTarget treats as unknown -> falls to customerSignal "unknown" -> "unknown" -> ask/disclose (fails safe, never wrongly suppresses). The voice hardcoded customerSignal:"unknown" (voice-turn.ts:756) means voice's target is driven solely by the named window, never a spoken "it can wait" — a pre-existing voice limitation (voice never parsed spoken urgency into a CustomerUrgencySignal), out of Stage 2's preferredWindow charter, and it fails SAFE.

CROSS-STAGE finding (NOT a Stage 2 defect — flag for Stage 5): voice-turn.ts never calls preserveVerifyKey, whereas chat wires it at all three metadata-rebuild sites (route.ts:1430,1659,1949). Voice's main extraction write at voice-turn.ts:647 (metadataStr = JSON.stringify(buildExtraction(merged,...))) and the Stage-2 after-hours latch write at line 771 both use buildExtraction, which emits ONLY slot/extras fields (chat-slots.ts:182-192) and drops any top-level metadata.verify key. So a non-account intake turn carrying slot data wipes a previously-persisted financial-verify lockout on voice -> potential unlimited-retry bypass. This is the exact failure Stage 5 fixed for CHAT but NOT for voice. Crucially this is PRE-EXISTING relative to Stage 2: the lossy write at line 647 wipes verify on any intake turn regardless of the after-hours latch, so the Stage 2 latch (line 771) adds no new exposure (it is only reached on non-account turns where line 647 already wiped verify). The ACCOUNT_LOOKUP/verify path returns early via persistAccountTurn (voice-turn.ts:290-417) which preserves verify, so the wipe requires an intervening non-financial intake turn between financial turns. Belongs to the Stage 5 review, not Stage 2.

**Key risks:**
- OUT-OF-SCOPE for Stage 2, route to Stage 5: voice-turn.ts has NO preserveVerifyKey; voice-turn.ts:647 (and the Stage 2 latch at :771) rebuild metadata via buildExtraction, which omits the top-level verify key (chat-slots.ts:182-192), so an intervening non-financial intake turn can wipe a financial-verify lockout on voice -> retry-bypass. Chat guards this (route.ts:1430,1659,1949); voice does not. Pre-existing vs the Stage 2 latch (line 647 already wipes), so not a Stage 2 regression.
- Voice hardcodes customerSignal:"unknown" (voice-turn.ts:756) so a caller who SAYS "it can wait until tomorrow" without naming a window can't reach the not_urgent->business_hours no-charge affirmation chat gives. Pre-existing voice gap, fails SAFE, out of Stage 2's preferredWindow charter.
- Voice after-hours tests mock decideAfterHoursDisclosure (voice-turn.test.ts:86-94) while keeping the real inferBookingTarget, so no voice test asserts the computed bookingTarget arg value reaching the decision; correctness rests on after-hours-chat.test.ts. Adequate; a wiring-level arg assertion would harden against future regression.

**Verifier (sound):** confirmed; no corrections.

_Notes:_ Independently verified every material claim against current code; all hold. (1) inferBookingTarget logic (after-hours-chat.ts:144-159) is exactly as quoted: asap->now, morning/afternoon/evening->business_hours, not_urgent->business_hours, urgent->now, else unknown. (2) The business_hours branch (176-182) returns offer_next_day BEFORE the urgent branch (187-197), so an after-hours daytime-window request never reaches disclose_charge — the Stage 2 bug fix holds. (3) Voice wiring confirmed: import at voice-turn.ts:21, inferBookingTarget(merged.extras?.preferredWindow,"unknown") passed at :760, latch fires only in disclose_charge branch (763-773). (4) Chat uses the SAME shared helper (route.ts:1509-1518); git show 7d2783b confirms route.ts -36 lines (inline copy deleted) — true DRY. (5) Live pipeline verified end-to-end: triage.ts STEP_TO_EXTRA preferred_window->preferredWindow (:425), ENUM_STEP_VALUES (:570) = [morning,afternoon,evening,asap], matching extraction-schema preferredWindowValues and the helper's recognized strings exactly; SKIP_SENTINEL="__skipped__" (:559) falls through inferBookingTarget to "unknown" (fails safe). (6) Degrade-safe try/catch wraps the ah-config load (744-779). (7) Frozen safety text untouched: hvac-knowledge.ts not in commit 7d2783b; diff touches only the cited files; no money-safety surface. (8) Tests re-run: after-hours-chat.test.ts + voice-turn.test.ts = 46 passed (19+27 as claimed).

CRITICAL cross-stage finding independently CONFIRMED REAL and correctly scoped: voice-turn.ts has NO preserveVerifyKey. buildExtraction (chat-slots.ts:173-192) returns only slot/extras fields plus a fixed set — it emits NO top-level verify key. voice-turn.ts:647 (metadataStr = JSON.stringify(buildExtraction(merged,...))) and the Stage 2 latch write at :771 both use buildExtraction, so on a non-account intake turn they overwrite session.metadata and drop the persisted top-level verify lockout (read at voice-turn.ts:293-300). The ACCOUNT_LOOKUP/verify path (290-417) returns early via persistAccountTurn which DOES preserve verify (334-336). Chat guards all three rebuild sites with preserveVerifyKey (route.ts:1430,1659,1949); voice does not. The assessment correctly classifies this as PRE-EXISTING relative to the Stage 2 latch (line 647 already wipes verify on any intake turn regardless of the latch, so the latch at :771 adds no new exposure) and correctly routes it to Stage 5, NOT a Stage 2 defect. This is a genuine voice financial-verify retry-bypass that Stage 5 must close.

keyRisk #2 (voice hardcodes customerSignal:"unknown" at :756, so a caller who SAYS "it can wait" without naming a window can't reach not_urgent->business_hours) confirmed: chat derives a real urgencySignal via readUrgencySignal (route.ts:881) and passes it (1511,1517); voice cannot. Pre-existing, fails safe, out of Stage 2's preferredWindow charter. keyRisk #3 confirmed: voice-turn.test.ts:86-94 mocks decideAfterHoursDisclosure while keeping the real inferBookingTarget, so no voice test asserts the computed bookingTarget arg; correctness rests on after-hours-chat.test.ts. Adequate.

No Stage 2 defect missed, no non-issue over-rated. Closure decision is correct.

---

## Stage 3 — Voice returning-customer recognition  _(review)_

**Verified status:** shipped-correct  **·  Verify:** sound  **·  Effort:** S

**Evidence:**
- src/lib/ai/customer-context.ts:113-158 — loadCustomerContextById: single tenant-scoped query via withTenant(customers, organizationId, eq(customers.id, customerId)); returns null on raced delete (line 138)
- src/lib/ai/customer-context.ts:103 — lookupCustomerContext delegates to loadCustomerContextById (chat behavior unchanged)
- src/lib/ai/voice-turn.ts:920-927 — voice loads ctx by session.customerId, degrade-safe via .catch(() => null), then buildCustomerContextHint
- src/lib/ai/voice-turn.ts:931 — customerHint appended to PHONE_SYSTEM_PROMPT + slotContextHint for the LLM turn
- src/lib/ai/voice-turn.ts:939 — reply still routed through screenAssistantReply after hint injection
- src/lib/ai/voice-turn.ts:246-277 — do-not-service gate is upstream, independent, returns early (line 272) before the hint path
- src/lib/ai/voice-turn.ts:290 — ACCOUNT_LOOKUP financial branch returns via persistAccountTurn before the hint+LLM path; hint cannot bypass verify gate or clobber metadata.verify
- src/lib/voice/resolve-voice-identity.ts:24 — ANI->customerId via lookupCustomerContext(organizationId,{phone}), org-scoped; session.customerId is tenant-correct
- customer-context.ts:236-263 — hint surfaces only firstName + counts/enums; fullName/email/phone/hcpCustomerId kept out of prompt
- git diff 7d2783b..25e721c — hvac-knowledge.ts absent from diff (frozen safety text intact); 5 files
- vitest: customer-context.test.ts + voice-turn.test.ts = 46 passed

**Assessment:**

No issues after an adversarial hunt. RE-CONFIRMED against current code (line numbers drifted ~30 lines from the prior review since later stages shipped, but logic is byte-identical).

Tenant scope: clean. session.customerId is resolved org-scoped at call start (resolve-voice-identity.ts:24 -> lookupCustomerContext -> findCustomerIdByContact, withTenant), and loadCustomerContextById re-scopes via withTenant(customers, organizationId, eq(customers.id, customerId)) (customer-context.ts:133). No cross-org leak.

Degrade-safety: load wrapped in .catch(() => null) (voice-turn.ts:925); buildCustomerContextHint returns "" for null (customer-context.ts:234), so any failure leaves PHONE_SYSTEM_PROMPT byte-identical. Raced delete -> null, not throw (customer-context.ts:138).

Placement/no-regression: hint load sits AFTER the budget-exhausted early return (voice-turn.ts:877-911), so deterministic 0-token and budget-degraded turns never pay for it.

Safety invariants verified intact: (1) hvac-knowledge.ts absent from the Stage 3 diff. (2) Hint-influenced LLM reply still screened by screenAssistantReply before TTS/persist (voice-turn.ts:939). (3) metadata.verify untouched — the hint only appends to the `system` string and writes no metadata; the ACCOUNT_LOOKUP financial branch (voice-turn.ts:290) returns via persistAccountTurn before ever reaching the hint path, so the recognition hint cannot bypass the verify gate or clobber verify state across turns. (4) do-not-service gate (voice-turn.ts:246-277) is upstream and returns at 272 before the hint path — a flagged caller never reaches recognition.

PII: hint emits only firstName + counts/enums (customer-context.ts:236-263); fullName/email/phone/hcpCustomerId explicitly excluded per the documented contract.

Minor evidence imprecision carried from the prior review (NOT a code bug): voice-turn.test.ts:423 asserts the literal '[RETURNING_CUSTOMER]' (underscore), but that string is a MOCK (voice-turn.test.ts:101 replaces buildCustomerContextHint with `(ctx) => ctx ? ' [RETURNING_CUSTOMER]' : ''`). The REAL hint emits '[RETURNING CUSTOMER]' with a SPACE (customer-context.ts:259), covered separately by customer-context.test.ts:246. The voice test proves plumbing reaches call.system but does not validate real hint text. Acceptable layering; worth a note so no future reader assumes the underscore is the production marker.

HCP enrichWithServiceHistory note remains intentionally sub-deferred (external fetch on the latency-bound spoken turn), documented inline (voice-turn.ts:913-919) — consistent with the plan, not a gap.

**Key risks:**
- Two DB round-trips per LLM voice turn for the same customerId: the do-not-service gate (voice-turn.ts:248-252) and the recognition hint load (voice-turn.ts:922) each query customers by id. Acknowledged latency tradeoff, not a bug; a once-per-call cached hint on the session would collapse both.
- HCP prior-service note sub-deferred: voice returning-customers get name/count/membership but not the 'last service' one-liner chat gets (chat enriches via enrichWithServiceHistory). Intentional, tracked follow-up.
- Test only asserts a mock marker string ('[RETURNING_CUSTOMER]' underscore) for the voice plumbing; real hint text ('[RETURNING CUSTOMER]' space) validated only in customer-context.test.ts. No end-to-end voice test of the real hint text.
- eval 30/30 not run headless (no keys); low risk since hvac-knowledge.ts frozen blocks untouched and the appended text is the already-vetted chat hint.

**Verifier (sound):** 
- Evidence imprecision (not a bug): voice-turn.ts:290 evidence says the ACCOUNT_LOOKUP financial branch 'returns via persistAccountTurn before the hint+LLM path.' In fact the branch CAN fall through to the LLM/hint path (voice-turn.ts:410-419): when accountReply===null and the caller did NOT just pass the ZIP this turn, control continues past line 419 to the FALLBACK_LLM coercion and reaches the hint+LLM path. I independently verified this fall-through is safe: it only occurs after advanceVerify returned decision.kind==='serve' (i.e. verify already passed or a non-financial intent), so no pending financial intent can reach the LLM path unverified — no Stage 5 financial-verify bypass. The conclusion holds; only the word 'returns' overstates the control flow.
- metadata.verify non-clobber claim independently confirmed at the LLM-path persist (voice-turn.ts:971-974): the .set() writes only status/turnCount/tokensUsed/updatedAt and never touches the metadata column, so metadata.verify survives an LLM/hint turn. Assessment claim #3 is correct but the proof is this write, not (as worded) merely that the ACCOUNT_LOOKUP branch returns first.

_Notes:_ Independently re-derived against current code. All cited line numbers verified exact (no ~30-line drift as the assessment hedged — customer-context.ts:113-158, 103, 234, 236-263; voice-turn.ts:246-277/272, 290, 920-927, 931, 939; resolve-voice-identity.ts:24 all match). Tenant scope clean: session.customerId resolved org-scoped (resolve-voice-identity.ts:24 -> lookupCustomerContext -> findCustomerIdByContact), re-scoped via withTenant(customers, organizationId, eq(customers.id, customerId)) at customer-context.ts:133; null on raced delete (line 138). Degrade-safe: load wrapped .catch(()=>null) at voice-turn.ts:925; buildCustomerContextHint returns '' for null (line 234). Placement: hint load (920-927) sits AFTER the budget early-return (910-911) and the do-not-service early-return (272), so deterministic/budget-degraded/flagged turns never pay for it or reach it. Reply still screened by screenAssistantReply (939). PII: hint emits only firstName + counts/enums (236-263); fullName/email/phone/hcpCustomerId excluded. Safety text frozen: git diff 7d2783b..25e721c shows exactly 5 files, hvac-knowledge.ts absent. Tests: ran `vitest run customer-context.test.ts voice-turn.test.ts` -> 46 passed. Mock-marker imprecision the assessment self-flagged is accurate: voice-turn.test.ts:101 mocks '[RETURNING_CUSTOMER]' (underscore), real hint at customer-context.ts:259 is '[RETURNING CUSTOMER]' (space) covered by customer-context.test.ts:246 — acceptable test layering. HCP enrichWithServiceHistory sub-deferral is real and documented inline (voice-turn.ts:913-919). keyRisks are all genuine non-blocking tradeoffs. No financial-bypass, no cross-org leak, no safety-invariant violation found.

---

## Stage 4 — Chat customer-context persistence on linked sessions  _(review)_

**Verified status:** shipped-correct  **·  Verify:** sound  **·  Effort:** S

**Evidence:**
- src/app/api/chat/route.ts:750-766 linked branch loads context by id every turn, degrade-safe
- src/app/api/chat/route.ts:767-816 unlinked else-if branch unchanged: lookup, FK link, mid-turn do-not-service
- src/app/api/chat/route.ts:502-535 load gate selects customers.doNotService via withTenant; refuses before context load
- src/lib/ai/customer-context.ts:113-158 loadCustomerContextById tenant-scoped (133), null on raced delete (138)
- src/app/api/chat/route.ts:638 only customerSessions write between 502 and 750 sets turnCount then returns at 647
- src/app/api/chat/route.ts:784 only customerId write SETS it, never nulls
- src/app/api/chat/route.ts:821-824,1299,1399 seededName gated on !knownSlots.name, lowest-priority fallback
- vitest 19/19 passed; tsc exit 0

**Assessment:**

No issues after a genuine adversarial hunt. Stage 4 (commit 225be10) intact and correct. Prior review line numbers (425/673/680) are STALE: Stage 5 (e1bce98) landed after Stage 4 and shifted ~75 lines (gate now 502, linked branch now 750); I re-derived all claims against shifted code and all hold. (1) Correctness: linked branch (750-766) hydrates context by id every turn, fixing turn-1-only vanish; unlinked path (767-816) preserved; if/else-if mutually exclusive. (2) Do-not-service safety: linked branch relies on the 502 gate; re-grepped every customerSessions write between 502 and 750 - only 638 fires (turnCount then return at 647), the 784 customerId write is in the unlinked else-if so cannot precede the linked branch; session.customerId identical at both gates. (3) Tenant scope: loadCustomerContextById uses withTenant (133); raced delete->null. (4) Degrade-safety: linked load is .catch(()=>null)+logged. (5) No name-clobber: seededName gated on !knownSlots.name and last in priority chain (1299/1399), fresh name always wins. (6) No metadata clobber: only customerId write SETS it; customerId is a column not metadata JSON, so Stage 5 metadata.verify rebuilds cannot unlink mid-turn. (7) Invariants untouched: no change to hvac-knowledge frozen safety text, money paths, or metadata.verify. Verified green: vitest 19/19, tsc exit 0.</assessment>
</invoke>


**Key risks:**
- Do-not-service safety on linked sessions depends on session.customerId being unmutated between the 502 gate and the 750 branch; true today but a future relink-before-750 edit would open a bypass, and the 502 gate degrades open on DB error (529-534).
- Stage 5 shifted all Stage 4 line numbers ~75; the review-results citations (425/673/680) are stale and must be re-grepped.

**Verifier (sound):** confirmed; no corrections.

_Notes:_ Independently verified against the real code; the assessment holds up under adversarial re-checking. All eight evidence citations are exact and say what they claim:

1. chat/route.ts:750-766 — linked branch loads context via loadCustomerContextById by session.customerId every turn, wrapped in .catch(()=>null)+logged. CONFIRMED degrade-safe, fixes the turn-1-only vanish.
2. chat/route.ts:767-816 — unlinked else-if (resolvedEmail||resolvedPhone): lookupCustomerContext, FK link at 782-791, mid-turn do-not-service at 794-814. CONFIRMED mutually exclusive with the linked branch (if/else-if on session.customerId).
3. chat/route.ts:502-535 — load gate selects customers.doNotService via withTenant; refuses before context load; catch degrades open (continues). CONFIRMED exactly as described.
4. customer-context.ts:113-158 — loadCustomerContextById is tenant-scoped via withTenant at line 133; returns null on raced delete at 138. CONFIRMED.
5. The only customerSessions write between the 502 gate and the 750 branch is the SOFT-guardrail path at 637-640, which returns at 647 before reaching 750. CONFIRMED — cannot precede the linked branch on a normal turn.
6. Only customerId writes are 784 (unlinked sync branch) and 1974 (async path), both gated and both SET customerId, never null it. The async write at 1965-1977 is guarded by !session.customerId and runs after the streamed reply. CONFIRMED — no mid-turn unlink.
7. seededName (821-824) is gated on !knownSlots.name and is last in the priority chain at 1299 (correctedName ?? residualName ?? seededName ?? null) and 1399. CONFIRMED — a customer-provided name always wins. The no-clobber protection is the upstream !knownSlots.name gate (mergeSlots' pick() prefers the incoming value, so the gate is load-bearing — which it is).

Key-risk premise verified: session.customerId is NEVER reassigned in-memory (grep for `session.customerId =` is empty; session is the immutable destructured query result). Both the 502 gate and the 750 branch read the identical snapshot, so do-not-service enforcement on linked sessions is sound today. The risk note ("a future relink-before-750 edit would open a bypass") is a fair forward-looking caveat, not a current bug.

Stage-5 invariant check: the metadata-rebuild write at 956-959 spreads existingMeta and sets metadata.verify on the `metadata` column only — it never touches the separate `customerId` column, so it cannot unlink a session mid-turn. Stage 5 (e1bce98) verify-ZIP gate is orthogonal to Stage 4's context persistence; no financial-bypass introduced by Stage 5 against the Stage 4 surface.

Stale-citation claim VERIFIED: at the Stage-4 commit (225be10), the gate/linked-check/load were at ~420/673/680; Stage 5 (e1bce98, +196/-39 lines) shifted them to 502/750/757 (~75 lines). The assessment correctly flagged the prior review's 425/673/680 citations as stale and re-derived all claims against the shifted code.

Build verification reproduced: `tsc --noEmit` exits 0; `vitest run src/lib/ai/customer-context` = 19/19 passed. Both green-claims confirmed.

No missed bug, no over-rated non-issue. Closure decision (status=shipped-correct) is correct.

---

## Stage 5 — Account-data verify gate (chat) + shared advanceVerify + voice refactor  _(review)_

**Verified status:** shipped-with-issues  **·  Verify:** sound  **·  Effort:** M

**Evidence:**
- src/lib/ai/account-verify.ts:77-106 advanceVerify pure engine: non-financial serves with state UNCHANGED (never fabricates passed, l.86-88); empty onFileZips can't match (l.96 via checkZipMatch); financial+failed defers no-reask (l.92-93); pending+wrong at MAX defers failed (l.100-101)
- src/lib/ai/account-verify.ts:33-37 checkZipMatch requires digits.length===5 (rejects 6/10-digit prefix-match bypass); regression-tested account-verify.test.ts:44-51
- src/app/api/chat/route.ts:913-1027 chat ACCOUNT_LOOKUP block wires advanceVerify; ask->CHAT_VERIFY_ASK (991), defer->CHAT_VERIFY_DEFER (994), serve->buildAccountLookupReply (998); metadata persisted only when verifyToPersist!==null (l.954) so non-financial never fabricates a verify key
- src/app/api/chat/route.ts:144-185 loadChatOnFileZips is withTenant(customers/customerLocations, organizationId,...)-scoped + decrypt in try/catch (degrade-safe); accountCustomerId is org-resolved (route.ts:905-906 via loadCustomerContextById/lookupCustomerContext, both org-scoped) -> cross-org ZIP leak impossible
- preserveVerifyKey wired at all 3 metadata-rebuild sites: route.ts:1429-1431 (sync intake), 1658-1677 (deterministic-reply persist, unconditional before the 1701 write), 1947-1954 (async extraction, re-reads fresh metadata); helper account-verify.ts:120-133
- src/lib/ai/voice-turn.ts:389-418 voice refactored to call the SAME advanceVerify; inline ~100-line state machine deleted (git 5b96554); voice-turn.test.ts 27 pass, account-verify.test.ts 21 pass, tsc clean
- BUG (Major, both channels): src/lib/ai/intent-router.ts:371-451 routeMessage is text-only/stateless; account-data-balance triggers are phrases (knowledge-base.ts:2522-2530) so routeMessage('37601') returns FALLBACK not ACCOUNT_LOOKUP. chat route.ts:913 + voice-turn.ts:290 both gate on verdict.action==='ACCOUNT_LOOKUP', so the pending ZIP-answer turn never enters the verify block -> the user's bare ZIP is dropped and pending->passed is unreachable
- voice DTMF-pass is also dead in prod: gather/route.ts:47-98 a digits-only turn has empty SpeechResult -> userMessage='' -> voice-turn.ts:283 routeMessage('') returns FALLBACK (intent-router.ts:378) -> verify block skipped, dtmfDigits never consumed. voice-turn.test.ts:933 only passes because routeMessage is mocked (test l.105)
- Non-exploitable clobber: route.ts:1216-1219 escMetadata (buildExtraction, NO preserveVerifyKey) wipes verify, but escalateSession (route.ts:1174) already set status=escalated (TERMINAL, state-machine.ts:2,43) so route.ts:480 blocks the next turn -> lockout reset gains nothing (verify is per-session)

**Assessment:**

SECURITY GOAL ACHIEVED — no financial-data bypass found. The pure advanceVerify engine is correct and exhaustively tested (21 cases): no fabricated pass on the non-financial path (serve carries existing state unchanged, account-verify.ts:86-88; tested test.ts:114-125), empty on-file ZIPs never auto-pass (inherited from checkZipMatch, test.ts:168-174), the >5-digit prefix-match bypass is explicitly rejected (length===5, test.ts:44-51). Cross-org ZIP is impossible: loadChatOnFileZips re-applies withTenant(...organizationId...) on both customers and customerLocations, and accountCustomerId is always org-resolved upstream. The lockout-wipe class is closed at all THREE reachable metadata-rebuild sites via preserveVerifyKey (1429/1658/1947); I verified each carries verify forward (1658 reassigns metadataStr unconditionally before the 1701 persist; 1947 re-reads fresh metadata). I found a FOURTH clobber site the plan missed — route.ts:1219 escMetadata rebuilds via buildExtraction with no preserveVerifyKey — but it is NOT exploitable: escalateSession transitions status to 'escalated' (terminal) before that write, so the session is locked next turn (route.ts:480) and the per-session lockout reset yields no advantage. Worth a 1-line preserveVerifyKey for defense-in-depth/consistency, but not a blocker.\n\nMAJOR FUNCTIONAL BUG (not security; gate fails CLOSED so it is safe): the verify gate's pending->passed transition is effectively unreachable in production. routeMessage is stateless/text-driven; a bare ZIP reply ('37601') to CHAT_VERIFY_ASK does not classify as account-data-balance, so chat route.ts:913 (verdict.action==='ACCOUNT_LOOKUP') is never entered on the answer turn — the ZIP is handed to FALLBACK_LLM and the pending state never advances. The same defect exists on voice: a DTMF-only gather turn yields empty SpeechResult -> userMessage='' -> routeMessage('') returns FALLBACK -> the dtmfDigits payload is never consumed by advanceVerify. The voice 'ZIP-pass' test passes only because it MOCKS routeMessage to keep returning ACCOUNT_LOOKUP (voice-turn.test.ts:105), so neither the original voice gate nor the new chat gate is exercised end-to-end on the real router. Net effect: a legitimate identified customer can only ever get balance/membership served by re-stating the intent keyword alongside the ZIP in one message (e.g. 'my balance 37601'); a natural bare-ZIP reply leaves them permanently stuck at the challenge. This is a pre-existing voice limitation that Stage 5 faithfully PORTED into chat rather than introduced — so 'parity' was reached at the broken-but-secure level on both channels. No route-level test covers the chat gate (consistent with the documented 'chat POST has no unit harness' caveat), which is exactly why the routing dead-end shipped unnoticed.\n\nRefactor quality is otherwise high: voice and chat now share one tested engine and cannot drift; tsc/lint/voice+verify suites green; frozen safety text and money-safety (buildAccountLookupReply) untouched.

**Key risks:**
- pending->passed is unreachable via a natural bare-ZIP reply on BOTH channels: routeMessage(zipAnswer) returns FALLBACK, not ACCOUNT_LOOKUP, so the verify block is never re-entered and the typed/keyed ZIP is dropped to the LLM. Gate fails closed (secure) but a verified customer can't actually get their financial data unless they re-state the intent keyword + ZIP together. Fix: detect a pending-verify session (read metadata.verify before routing) and route the next message's ZIP into advanceVerify regardless of routeMessage's verdict; add a route-level test that drives the REAL router (no routeMessage mock).
- No end-to-end test exercises either gate against the real router — the only ZIP-pass test mocks routeMessage (voice-turn.test.ts:105), masking the routing dead-end. The chat gate has zero route-level coverage.
- Minor/defense-in-depth: route.ts:1219 escMetadata rebuilds metadata without preserveVerifyKey (4th rebuild site, missed by the plan). Not exploitable today (escalation is terminal first), but it is a latent clobber that would bite if escalation ever became non-terminal — add preserveVerifyKey for consistency with the other three sites.

**Verifier (sound):** confirmed; no corrections.

_Notes:_ Independently verified every load-bearing claim against the real code; the assessment holds up. No corrections.

SECURITY (confirmed sound, no financial-bypass): advanceVerify (account-verify.ts:77-106) is correct line-by-line — non-financial serves with state UNCHANGED (l.86-88, no fabricated pass), passed/failed handled (89-93), pending+match→passed (96-97), pending+mismatch→ask/defer at MAX (99-102). checkZipMatch requires digits.length===5 (l.35); regression tests reject 10-digit (test.ts:44-47) and 6-digit (49-51) prefix-matches. loadChatOnFileZips (route.ts:144-185) applies withTenant on BOTH customers and customerLocations; accountCustomerId org-resolved (905-906) — cross-org leak impossible. preserveVerifyKey wired at all 3 reachable rebuild sites (1429 reads session.metadata, 1658 unconditional before the 1701 persist, 1947 reads fresh?.metadata ?? session.metadata). 48 tests pass (21 account-verify + 27 voice-turn), tsc --noEmit exit 0. Commit 5b96554 confirms the ~100-line inline voice gate was deleted (-98 net).

MAJOR FUNCTIONAL BUG (confirmed real, NOT security — gate fails CLOSED): routeMessage (intent-router.ts:371-451) is stateless/text-only. A bare ZIP '37601' → no triggerKeywords match → scored.length===0 → returns ambiguityProbe ?? FALLBACK (l.450), NOT ACCOUNT_LOOKUP. Both channels gate on action==='ACCOUNT_LOOKUP' (chat route.ts:913, voice voice-turn.ts:290), so the pending-answer turn never re-enters the verify block and the typed/keyed ZIP is dropped to the LLM — pending→passed unreachable via a natural bare-ZIP reply. VOICE DTMF-pass also dead in prod: gather/route.ts:47,98 → empty SpeechResult → sanitized='' → routeMessage('') → l.378 FALLBACK → dtmfDigits never consumed. The ZIP-pass test (voice-turn.test.ts:933) only passes because routeMock defaults to ACCOUNT_LOOKUP (l.873-875; routeMessage mocked at l.105), masking the dead-end. A customer can only pass by re-stating the keyword+ZIP together ('my balance 37601'), which the assessment correctly acknowledges — so 'unreachable' is precisely scoped to the bare-ZIP reply, not literal impossibility.

4TH CLOBBER (confirmed non-exploitable): escMetadata at route.ts:1219 rebuilds via buildExtraction with no preserveVerifyKey, but it sits on the deterministic-escalation path; escalateSession sets status='escalated' (escalate-service.ts:51), terminal (state-machine.ts:2,43), so route.ts:480 blocks the next turn. Latent only. Closure decision and proposed fix (hoist the metadata.verify read above routing + add a real-router route-level test) are feasible against the real code — existingMeta.verify is already read at route.ts:918-920, so the hoist compiles cleanly. Effort 'M' is reasonable.

---

## Stage 6 — HCP technician roster sync  _(review)_

**Verified status:** shipped-correct  **·  Verify:** sound  **·  Effort:** none

**Evidence:**
- technician-sync.ts:101-113 mass-deactivate guarded by currentHcpIds.length>0
- technician-sync.ts:76-88 upsert target [org,email] setWhere eq(role,technician)
- schema.ts:282,331-333 housecallProUserId column + per-org partial unique index
- drizzle/0022 sql + journal:163 + snapshot has housecall_pro_user_id
- client.ts:280 email captured; client.test.ts:430-445 verifies
- technician-sync.test.ts 4 tests pass
- no route wires sync, parity with FP

**Assessment:**

No correctness issues after a genuine adversarial hunt. Faithful mirror of fieldpulse/technician-sync.ts with all safety invariants intact. Mass-deactivate guarded behind currentHcpIds.length>0 (technician-sync.ts:101), test-covered. Tenant scoping complete: every query org-filtered, upsert keyed (organizationId,email), per-org partial unique identity index (schema:331-333). setWhere eq(users.role,technician) at line 86 blocks clobbering human admins sharing an email. Degrade-safe: errors swallowed to {synced:0}. Email captured via toTechnician (client.ts:280) and verified in client.test.ts:430-445. No transactions (neon-http-safe). No frozen-safety/money/metadata.verify surfaces touched. HCP divergence (no role field) documented and correct. tsc clean, 4 tests green. Global-email-unique edge pre-existing and identical in FP. LATENT: migration 0022 NOT applied to shared DB but module unwired so no live 500; db:migrate MUST run before Stage 7+ wires a caller.</parameter>
<parameter name="title">HCP technician roster sync

**Key risks:**
- Migration 0022 not applied; run db:migrate before wiring a caller
- Same-email cross-org row triggers users_email_global_unique 23505 degrading sync; pre-existing same as FP
- Every HCP employee with email+name becomes role=technician (no role filter)

**Verifier (sound):** 
- Minor citation imprecision: the email-capture test the assessment cites at client.test.ts:430-445 actually begins at line 430 ("captures the employee email...") and asserts techs[0].email==="dana@hcp.test" / techs[1].email undefined — the test exists and proves the claim, but the exact 430-445 range is approximate, not the literal block bounds. Non-substantive.
- Citation note: the assessment says 'no route wires sync, parity with FP' — independently confirmed via grep: the only non-test reference to syncTechniciansFromHousecall is its own definition (technician-sync.ts:37). Module is genuinely unwired, so the latent migration-0022 risk cannot 500 live. Correct.

_Notes:_ Independently re-derived every cited line. CONFIRMED: technician-sync.ts:101 mass-deactivate guarded by currentHcpIds.length>0; line 77 upsert target [organizationId,email]; line 86 setWhere eq(users.role,'technician') blocks clobbering human admins sharing an email; degrade-safe try/catch at 117 returns {synced:0}. Schema.ts:282 housecallProUserId column and 331-333 per-org partial unique index (WHERE housecall_pro_user_id IS NOT NULL) both present. Migration 0022_aberrant_carmella_unuscione.sql adds the column + index exactly; journal entry at line 163 (idx 22, the latest); 0022_snapshot.json contains housecall_pro_user_id (4 hits). client.ts:280 returns email via str(obj.email); listTechnicians defined at client.ts:109/515. Ran the test file: 4/4 pass. Ran full tsc --noEmit: 0 errors (clean), no errors in technician-sync.ts or client.ts.

Adversarial checks that did NOT find a bug: (1) cross-org same-email insert hits users_email_global_unique (schema:318) -> 23505 -> caught and swallowed -> degrade-safe; identical to FP, correctly flagged as pre-existing keyRisk. (2) A 23505 mid-loop aborts to catch so deactivation is skipped that run — same as FP, degrade-safe, not a new bug. (3) HCP's no-role-filter divergence (every employee -> role=technician) is real and documented in the file header AND keyRisk #3; NOT a security bypass because synced techs get passwordHash:null (cannot password-login) and authenticate via HCP, so over-broad import grants no admin access. (4) neon-http no-transactions invariant respected (no db.transaction used). No frozen-safety/money/metadata.verify surfaces touched.

Note on the git-status snapshot mentioning drizzle/0034 and 0035: those are not present in the checked-out drizzle/ dir (tops out at 0022, 23 sql files total); they belong to a different/uncommitted FieldPulse-availability branch state and are irrelevant to Stage 6.

The keyRisks list is accurate and complete. The closure/status decision (shipped-correct, faithful FP mirror with all safety invariants intact, migration-apply as the only latent action before a Stage 7+ caller wires it) holds up under skeptical review. Verdict: sound.

---

## Stage 7 — HCP durable availability sync  _(plan)_

**Verified status:** real-gap  **·  Verify:** sound  **·  Effort:** M

**Evidence:**
- src/lib/integrations/housecall-pro/scheduling-source.ts:49 — DEFAULT_HCP_AVAILABILITY_TTL_MS = 30_000; HCP availability is in-memory cache-only, no DB persistence (gap is OPEN)
- src/lib/integrations/housecall-pro/scheduling-source.ts:165 — code comment: 'HCP itself has no per-tech availability surface here'
- find src: NO housecall-pro/availability-sync.ts and NO app/api/cron/sync-housecall-availability (confirmed empty)
- src/lib/integrations/housecall-pro/types.ts:167-170 — HousecallAvailabilitySlot {startIso; endIso} only; carries NO technician/employee id
- src/lib/integrations/housecall-pro/client.ts:480-510 — listAvailability hits GET /company/schedule_availability, returns {startIso,endIso}; no per-tech attribution
- src/lib/integrations/housecall-pro/availability-mapping.ts:99 — windows map to synthetic `hcp-slot-<index>` ids (window index, NOT a staff id); comment 37 'never contains an HCP staff name/id'
- src/lib/db/schema.ts:1069-1071 — technicianAvailability.technicianId uuid NOT NULL .references(users.id); every row REQUIRES a real users.id
- src/lib/db/schema.ts:1153-1185 — housecallProConnections block has NO availabilitySyncStatus/lastAvailabilitySyncAt/lastSyncError (those columns at 1218/1223/1228 are inside the fieldpulseConnections block 1197-1245)
- CHANGED SINCE ORIGINAL REVIEW: src/lib/db/schema.ts:282 users.housecallProUserId now exists + partial-unique index (332-333); src/lib/integrations/housecall-pro/technician-sync.ts now exists (Stage 6 shipped) — original blocker #2 partially resolved, but does NOT unblock the mirror
- src/lib/integrations/fieldpulse/availability-sync.ts:117-149 — FP works ONLY because fp_<userId> resolves via users.fieldpulseUserId→users.id; HCP synthetic ids are window indices with nothing to resolve to
- src/app/api/cron/sync-fieldpulse-availability/route.ts:28-87 — the exact mirror pattern to copy (verifyCronAuth Bearer fail-closed, after() not detached, {initiated})
- src/lib/integrations/housecall-pro/scheduling-source.ts:44 — AVAILABILITY_HORIZON_DAYS = 14 is module-PRIVATE (not exported); a new availability-sync.ts must export or redefine it
- src/lib/integrations/housecall-pro/client.ts:583 — factory is getHousecallClient (NOT getHousecallProClient)

**Assessment:**

PLAN MODE. Gap is genuinely OPEN and a literal technician_availability mirror remains STRUCTURALLY BLOCKED — re-confirmed against current code. HCP availability is cache-only (scheduling-source.ts:49, 30s TTL), no DB persistence, no sync module, no cron.

KEY UPDATE vs prior review: Stage 6 SHIPPED since the first assessment — users.housecallProUserId (schema:282) + technician-sync.ts now exist, so the original 'no roster' blocker (#2) is partially resolved. This does NOT unblock the mirror. The fundamental blocker (#1) is unchanged: HCP availability windows are {startIso,endIso} account-level, pre-netted, with NO technician attribution (types.ts:167-170, client.ts:480-510). availability-mapping.ts:99 produces synthetic hcp-slot-<index> ids that are WINDOW INDICES, not staff ids — nothing resolves to users.id. FP's mirror works only via fp_<userId>→users.fieldpulseUserId (availability-sync.ts:117-149); HCP has no analog because the data has no staff identity. The code states this itself (scheduling-source.ts:165). technicianAvailability.technicianId is uuid NOT NULL references users.id (schema:1069-1071), so writing synthetic ids would FK-violate. There is no HCP API returning per-tech windows. Therefore Option B (faithful mirror) is NOT implementable today, independent of Stage 6.

CLOSURE-CHECK on the original 'reframe as durable snapshot' recommendation: still the honest call. Recommend RESOLVING Stage 7 as 'mirror is HCP-blocked; ship the buildable durability win OR explicitly skip.' My recommendation: SKIP / mark blocked rather than build the snapshot table, because the cache-only path already degrades safely (loadMapped throws → factory falls back to DB source) and a jsonb snapshot table is speculative scope (no consumer demands warm cold-start fallback). Building it risks dead schema. If the user wants the durability win, here is the concrete buildable plan (Option A):

FILES TO CREATE:
1. drizzle/00XX_hcp_availability_snapshot.sql + hand-authored journal/meta snapshot copy (per hand-authored-trigger-migration memory). New table hcp_availability_snapshot(id uuid pk, organization_id uuid NOT NULL refs organizations onDelete cascade, slots jsonb NOT NULL, fetched_at timestamptz NOT NULL default now, UNIQUE(organization_id)). Operator runs npm run db:migrate (Vercel does NOT run migrations — migrations-not-run-on-deploy memory; un-run migration = schema-drift 500s).
2. src/lib/integrations/housecall-pro/availability-sync.ts: syncAvailabilityFromHousecall(orgId, fetchImpl=fetch). getHousecallClient (NOT getHousecallProClient) → if null return {success:false}. Build the 14-day range, client.listAvailability(range), mapHcpAvailability(windows), then a SINGLE db.insert(hcpAvailabilitySnapshot).values({...}).onConflictDoUpdate(target: organization_id, set: {slots, fetchedAt}) — one statement, neon-http safe, NO db.transaction(). Wrap in try/catch, logger.warn, never throw (degrade-safe). Do NOT add a claimSync/status-column dance unless you also add the three tracking columns to housecallProConnections — and do NOT add those columns without this writer (avoid dead schema).
3. src/app/api/cron/sync-housecall-availability/route.ts: mirror sync-fieldpulse-availability/route.ts EXACTLY — verifyCronAuth Bearer (fail-closed 401), select connected housecallProConnections, after(()=>syncAvailabilityFromHousecall(orgId)) per org (after(), never detached — Vercel freeze), return successResponse({initiated}).

FILES TO MODIFY:
4. src/lib/integrations/housecall-pro/scheduling-source.ts: export AVAILABILITY_HORIZON_DAYS (currently private at :44) so availability-sync reuses it; OPTIONALLY have loadMapped() read the snapshot as a cold-cache fallback before hitting HCP; add a header ADR comment explaining HCP availability is non-durable per-tech (account-level, no staff id, FK requires users.id).
5. vercel.json: add {"path":"/api/cron/sync-housecall-availability","schedule":"0 * * * *"} mirroring the line-32 FP entry.

TESTS (TDD vitest):
- availability-sync.test.ts: (a) connected → upsert called with mapped slots; (b) not connected → {success:false}; (c) HCP throw → degrade-safe {success:false}, no throw; (d) re-run converges to one row per org (mock client.listAvailability + db).
- cron route test: unauthorized → 401; authorized → after() scheduled per connected org.

VERIFY GATES: npx tsc --noEmit; npm run lint; npm run test:unit (new files); npm run build. NO prompt/money/frozen-safety-text/metadata.verify surfaces touched → no eval needed.

**Key risks:**
- FALSE-PARITY FK TRAP: blindly mirroring FP into technician_availability writes synthetic hcp-slot-<n> window-index ids into a NOT NULL FK→users.id (schema:1069-1071) → runtime FK violation. Do NOT do Option B. HCP windows have no staff attribution (types.ts:167-170); confirmed unchanged even after Stage 6 roster shipped.
- SCOPE-CREEP / DEAD SCHEMA: do NOT copy fieldpulseConnections' three sync-tracking columns onto housecallProConnections (it currently has none, 1153-1185) unless a real writer exists. A jsonb snapshot table is itself speculative — recommend SKIP unless user explicitly wants warm cold-start; cache-only already degrades safely.
- MIGRATION DISCIPLINE: any new table must be hand-authored (journal + meta snapshot copy) per repo convention; Vercel build skips migrations (migrations-not-run-on-deploy memory) → operator must run npm run db:migrate or .returning() writes 500.
- neon-http: snapshot write must be a SINGLE upsert (no db.transaction() — throws at runtime; neon-http-no-transactions memory). Cron must use after() not a detached promise (Vercel freeze).
- PSEUDOCODE NITS to honor when building: factory is getHousecallClient not getHousecallProClient (client.ts:583); AVAILABILITY_HORIZON_DAYS is module-private (scheduling-source.ts:44) — export or redefine before reuse.
- No prompt/money/metadata.verify surfaces involved; Stage-5 financial-bypass concerns are N/A to this stage (availability is PII-free counts only, availability-mapping.ts:22-23).

**Verifier (sound):** confirmed; no corrections.

_Notes:_ Independently verified every cited line; all hold. Status real-gap (plan mode) is correct: HCP availability is cache-only (scheduling-source.ts:49, 30s TTL), no DB persistence, no availability-sync.ts, no sync-housecall-availability cron (both confirmed absent via directory listings). The structural blocker is genuine and unchanged by Stage 6: HousecallAvailabilitySlot is {startIso,endIso} with no tech id (types.ts:167-170), client.listAvailability hits GET /company/schedule_availability returning only {startIso,endIso} (client.ts:480-513), and availability-mapping.ts:99 produces synthetic hcp-slot-<index> WINDOW-INDEX ids (line 37/21-23 comments confirm no staff identity). technicianAvailability.technicianId is uuid NOT NULL references users.id (schema:1069-1071), so a literal FP-style mirror would FK-violate at runtime — the FALSE-PARITY FK TRAP risk is real. FP works only because fp_<userId> resolves via users.fieldpulseUserId (availability-sync.ts:117-149, resolveTechnicianIds); HCP has no analog. Stage-6 facts confirmed: users.housecallProUserId at schema:282 + per-org partial-unique index 331-333; technician-sync.ts exists. CLOSURE decision (mark blocked / skip speculative snapshot) is correct and honest: cache-only degrades safely — loadMapped throws (scheduling-source.ts:146,156) and getSchedulingSource catches + falls back to DB source (scheduling-source.ts:132-133), independently confirmed. PLAN feasibility sound: availabilitySyncStatusEnum exists (schema:197); hcp_availability_snapshot table does not yet exist (no collision); proposed single onConflictDoUpdate upsert is neon-http safe (FP precedent uses db.batch, never db.transaction); factory is getHousecallClient (client.ts:583); AVAILABILITY_HORIZON_DAYS is module-private at scheduling-source.ts:44 (correctly flagged to export). Stage-5 financial-bypass N/A is correct — availability is PII-free counts only (availability-mapping.ts:21-23); no money/prompt/metadata.verify surfaces touched; no missed security or financial-bypass bug, no over-rated non-issue. vercel.json FP cron line confirmed at line 32. Minor non-blocking nit (does NOT affect verdict): FP code field is misspelled technicanIds (availability-sync.ts:212 + its mapping module); a porter should not copy that typo, but the assessment's HCP plan correctly references mapHcpAvailability which uses the correctly-spelled technicianIds, so no correction is required to the assessment itself. Effort M is reasonable.

---

## Stage 8 — HCP address validation on customer sync  _(closure)_

**Verified status:** closure-correct  **·  Verify:** sound  **·  Effort:** none

**Evidence:**
- src/lib/db/schema.ts:648,658 — customers table has a single addressEncrypted text column; NO structured city/state/zip columns exist (the load-bearing premise)
- src/lib/integrations/fieldpulse/customer-sync.ts:224 — FP reads address: safeDecrypt(row.addressEncrypted) (single free-text field)
- src/lib/integrations/fieldpulse/customer-sync.ts:92 — guard: if (contact.address && hasMinimumAddressQuality({ street: contact.address })) — passes ONLY street
- src/lib/integrations/fieldpulse/address-validation.ts:299 — return Boolean(hasStreet && (hasCity || hasState || hasZip)); city/state/zip undefined => ALWAYS false
- src/lib/integrations/fieldpulse/customer-sync.ts:104-106 — else if (contact.address) { address = { street: contact.address } } — the branch ALWAYS taken; validateAddressForSync/Photon/geocode (lines 93-99) unreachable for free-text
- src/lib/integrations/housecall-pro/customer-sync.ts:85-86 — const address = contact.address ? { street: contact.address } : undefined — identical output to FP
- grep validateAddressForSync|hasMinimumAddressQuality|address-validation|validation-core over housecall-pro/ + src/lib/address/ => no matches; no shared validation-core.ts exists
- Closure commit 1d26906 cited lines (FP customer-sync.ts:92, address-validation.ts:299) still match current code exactly — not stale

**Assessment:**

CLOSURE IS CORRECT. Independently re-derived the full chain: customers.addressEncrypted (schema.ts:658) is a single free-text column — no structured city/state/zip exists. Both FP and HCP customer-sync read only that field and build { street: <free-text> }. FP's guard hasMinimumAddressQuality({ street }) (customer-sync.ts:92) calls address-validation.ts:299 which returns Boolean(hasStreet && (hasCity || hasState || hasZip)); with city/state/zip undefined the second clause is falsy, so it ALWAYS returns false on this path. FP therefore takes the else-if at lines 104-106 and writes { street } unchanged — validateAddressForSync, Photon (line 141), and the FP-geocode fallback (lines 97,160) are NEVER reached for free-text input. HCP (customer-sync.ts:85-86) writes the same { street } unchanged. The two paths produce byte-identical address payloads at runtime, so HCP is already at parity. Implementing the Photon enrichment plan from the review doc (validation-core.ts + validateHcpAddress) would make HCP EXCEED FP's actual runtime behavior — an asymmetry, the opposite of parity, and over-building. No code change is the right call. No frozen-safety-text, money-safety, metadata.verify, or tenant-scope surfaces are touched (DB read is withTenant'd at customer-sync.ts:184; no writes). The closure also correctly surfaces (without autonomously building) the real latent finding: FP's own validation is dead code for single-field free-text — fixing it changes live FP behavior beyond the parity bar, so it is rightly left as a user decision, not a Stage-8 parity gap.

**Key risks:**
- If customers.addressEncrypted ever splits into structured city/state/zip columns (or a multi-field address is introduced), hasMinimumAddressQuality would start returning true on the FP path, FP's Photon/geocode validation would fire, and HCP would silently fall BEHIND parity — this closure would then need re-opening. It is contingent on the single-free-text-field schema, not permanent.
- The deferred 'separate finding' (FP validation unreachable for free-text) means address normalization is effectively absent on BOTH integrations — fine for parity, but a product-quality gap the user explicitly owns; not a regression.

**Verifier (sound):** confirmed; no corrections.

_Notes:_ Independently verified every cited line; all exist and say what the assessment claims. Re-derived the full chain:\n\n1. schema.ts:658 — customers.addressEncrypted is a single `text(\"address_encrypted\")` column; no structured city/state/zip columns exist (confirmed reading 648-669). Load-bearing premise holds.\n\n2. FP customer-sync.ts:224 reads `address: safeDecrypt(row.addressEncrypted)` — single free-text field. Line 92 guard: `if (contact.address && hasMinimumAddressQuality({ street: contact.address }))` passes ONLY street.\n\n3. address-validation.ts:299 returns `Boolean(hasStreet && (hasCity || hasState || hasZip))`. With only street supplied, hasCity/hasState/hasZip are all undefined/falsy, so the expression is `Boolean(hasStreet && false)` = false on EVERY free-text input (true whether street is long or short). Therefore the `if` branch (lines 92-103: validateAddressForSync → Photon line 141 → FP geocode line 160) is unreachable for free-text; the `else if` at 104-106 is always taken, yielding `{ street: contact.address }` unchanged. Confirmed.\n\n4. HCP customer-sync.ts:85-86 (`const address = contact.address ? { street: contact.address } : undefined`) produces the byte-identical payload. The two integrations emit the same address object at runtime — HCP is already at parity.\n\n5. grep for validateAddressForSync|hasMinimumAddressQuality|address-validation|validation-core|validateHcpAddress over housecall-pro/ and src/lib/address/ returned EXIT 1 / no matches — confirmed no shared validation-core.ts and no validateHcpAddress; the Photon-enrichment plan is unbuilt. Building it would make HCP exceed FP's real runtime behavior (asymmetry, anti-parity), so no-op is the correct closure.\n\n6. Closure commit 1d26906 (docs-only, +9/-6 in the plan md, zero code change) cites FP customer-sync.ts:92 and address-validation.ts:299 — both still match current code exactly; not stale.\n\nNo security/financial-bypass concern for this stage: the DB read is tenant-scoped (withTenant at customer-sync.ts:184/210), the only write is the FP/HCP mapping id guarded by IS NULL + withTenant — no address write, no frozen-safety-text, money-safety, or metadata.verify surface touched. The deferred latent finding (FP's own validation is dead code for single-field free-text — fixing it would change live FP behavior beyond the parity bar) is correctly surfaced as a user decision rather than autonomously built. The keyRisks (schema-split contingency; normalization absent on both) are accurate and appropriately scoped as non-regressions. Verdict: closure is correct, no corrections, effort: none.

---

## Stage 9 — HCP rate limiter (shared token-bucket extract)  _(review)_

**Verified status:** shipped-correct  **·  Verify:** sound  **·  Effort:** none

**Evidence:**
- src/lib/integrations/shared/rate-limiter.ts:72-229 RateLimiter class extracted here; :235 fieldpulseRateLimiter, :241 housecallRateLimiter separate singletons; :247-249 waitForRateLimit defaults limiter=fieldpulseRateLimiter (FP callers unchanged)
- src/lib/integrations/fieldpulse/rate-limiter.ts:10-17 thin re-export shim (RateLimiter, fieldpulseRateLimiter, waitForRateLimit, chunk, RateLimiterOptions, RateLimitInfo) from ../shared/rate-limiter
- git diff 408beb9^ shared/rate-limiter.ts vs old fieldpulse/rate-limiter.ts: core class body identical except ADDED resetAll() (additive, test-only) and local RateLimitInfo interface (was `import type from ./bulk-types`); no logic change
- src/lib/integrations/housecall-pro/rate-limiter.ts:31-46 withHcpRateLimit(orgId, fn): waitForRateLimit(org, housecallRateLimiter) -> fn -> reportSuccess; catch isThrottleError -> reportThrottle -> rethrow
- No import cycle: shared/rate-limiter.ts imports nothing from integrations (grep: only fieldpulse/rate-limiter.ts & housecall-pro/rate-limiter.ts import from ../shared/rate-limiter)
- vitest: fieldpulse/rate-limiter.test.ts + fieldpulse/bulk-operations.test.ts + housecall-pro/rate-limiter.test.ts = 59 passed; FP suites import impl via shim, proving extract behavior-preserving
- npx tsc --noEmit: no errors in any rate-limiter file
- grep withHcpRateLimit|housecallRateLimiter across src (excl tests/rate-limiter.ts): zero live consumers — limiter ready for Stage 10, mirrors FP (bulk-ops-only), matches plan line 88 + review-results:465

**Assessment:**

No blocker/major issues. The extract is genuinely behavior-preserving: the RateLimiter class moved verbatim to shared/rate-limiter.ts (git diff of the class body 408beb9^ shows only an additive resetAll() and the inlined RateLimitInfo interface, which is byte-identical in shape to the old `./bulk-types` one). The FP shim re-exports everything FP previously imported, and waitForRateLimit still defaults to fieldpulseRateLimiter so existing FP call sites (bulk-operations.ts:26) are unchanged — proven by the FP suites passing while importing through the shim. housecallRateLimiter is a separate bucket-map instance (line 241), so HCP throttle state can't leak into FP's budget; withHcpRateLimit keys buckets by organizationId, so no cross-tenant starvation. The helper correctly does NOT wrap client.request() (which already retries 429/5xx) — sitting at the batch layer avoids double-handling. No DB / no prompt / no money / no metadata.verify surface touched; frozen safety text and Stage-5 financial-verify paths untouched (N/A). MINOR-only observations, not defects: (1) RateLimitInfo is now defined twice — shared/rate-limiter.ts:24 and the still-present fieldpulse/bulk-types.ts:121 — harmless redundancy (TS structural typing; bulk-operations.ts:24 still imports the bulk-types copy and getRateLimitInfo returns it without error); a future cleanup could delete the bulk-types copy. (2) isThrottleError regex (rate-limiter.ts:22 `\b429\b|too many requests|rate limit`) won't match a hyphenated "rate-limited" string, but real HCP 429s carry the status code which `\b429\b` matches, and "429" is also matched in "429 Too Many" — non-issue. (3) The helper has zero live consumers, but this is the deliberate, plan-sanctioned Stage-9-ships-limiter / Stage-10-wires-it split (mirrors FP), explicitly accepted in review-results:465.

**Key risks:**
- Duplicate RateLimitInfo (bulk-types.ts:121 vs shared:24) is dead-ish redundancy — if someone edits one shape and not the other, FP getRateLimitInfo could silently diverge from the limiter's actual return; low risk, structurally identical today
- Stage 10 must actually call withHcpRateLimit around each HCP bulk item, else Stage 9's limiter remains permanently unused (verify in Stage 10 review)

**Verifier (sound):** confirmed; no corrections.

_Notes:_ Independently verified every load-bearing claim against the real code at commit 408beb9; the assessment holds up.

CONFIRMED:
- shared/rate-limiter.ts: RateLimiter class at lines 72-229; fieldpulseRateLimiter:235, housecallRateLimiter:241 are SEPARATE `new RateLimiter()` singletons (no shared bucket map -> HCP throttle cannot leak into FP budget); waitForRateLimit:247-249 defaults limiter=fieldpulseRateLimiter, so FP call sites unchanged.
- fieldpulse/rate-limiter.ts:10-17 is a pure re-export shim (RateLimiter, fieldpulseRateLimiter, waitForRateLimit, chunk, type RateLimiterOptions, type RateLimitInfo) from ../shared/rate-limiter. No logic.
- Behavior-preserving extract VERIFIED via `diff 408beb9^:fieldpulse/rate-limiter.ts shared/rate-limiter.ts`: 56-line diff is ONLY (a) header/jsdoc comment rewrites, (b) inlined RateLimitInfo interface replacing `import type from ./bulk-types`, (c) added housecallRateLimiter singleton, (d) added resetAll() {this.buckets.clear()}. A keyword grep over added/removed lines for bucket./tokens/rateModifier/Math./return/if found ZERO method-body logic changes. resetAll() is additive + test-only.
- Duplicate RateLimitInfo: bulk-types.ts:121 and shared:24 -> diffed the two interface bodies byte-for-byte = IDENTICAL SHAPE. bulk-operations.ts:24 imports the bulk-types copy; getRateLimitInfo:323 returns it. Harmless redundancy, structurally typed, compiles. Correctly flagged MINOR.
- housecall-pro/rate-limiter.ts:31-46 withHcpRateLimit(orgId, fn): waitForRateLimit(org, housecallRateLimiter) -> fn -> reportSuccess; catch isThrottleError -> reportThrottle -> rethrow. Org-keyed (no cross-tenant starvation). Does NOT wrap client.request() (sits at batch layer; client already retries 429/5xx).
- isThrottleError regex behavior empirically confirmed: matches "429 Too Many" and "rate limited"; does NOT match hyphenated "rate-limited". Correctly downgraded to non-issue (real 429s carry the status code).
- No import cycle: grep shows shared/rate-limiter.ts imports nothing from integrations; only fieldpulse/ and housecall-pro/ rate-limiter.ts import from ../shared.
- Tests: vitest run of the 3 suites = 3 files / 59 passed (exact match). tsc --noEmit shows NO errors in any rate-limiter file.
- Zero live consumers of withHcpRateLimit/housecallRateLimiter outside test+rate-limiter.ts (grep confirmed empty). This is the deliberate Stage-9-ships / Stage-10-wires split mirroring FP (limiter is bulk-ops-only). Commit message + plan doc corroborate.
- Stage-5 / safety surface: commit 408beb9 touched ONLY the plan doc + 4 rate-limiter files. No DB/drizzle/prompt/invoice/payment/financial-verify/frozen-safety-text imports in the new files (sole "verify" hit is a test comment). N/A is accurate.

The two keyRisks they list are both legitimate and correctly scoped low: (1) duplicate RateLimitInfo divergence risk is real but structurally identical today; (2) Stage 10 must actually call withHcpRateLimit or the limiter stays unused — a true forward dependency to verify in Stage 10, not a Stage-9 defect.

No missed bug, no over-rated non-issue, no financial-bypass. Closure decision is correct.

---

## Stage 10 — HCP bulk operations + admin endpoint  _(plan)_

**Verified status:** real-gap  **·  Verify:** minor-corrections  **·  Effort:** M

**Evidence:**
- housecall-pro dir has NO bulk-operations.ts and NO bulk-types.ts (only rate-limiter.ts)
- app/api/admin/integrations/housecall has only connect/disconnect/status, NO bulk-update route
- housecall-pro/types.ts:148 UpdateJobInput has no work_status, so Option A blocked
- client.ts:393-415 updateJob body is description/schedule/line_items only
- client.ts:417 cancelJob returns void; client.ts:426 addJobNote returns void (ASSUMED HCP SHAPE)
- housecall-pro/rate-limiter.ts:31-46 withHcpRateLimit exists from Stage 9
- grep withHcpRateLimit finds zero live consumers; Stage 10 is the intended first consumer
- FP precedent present: fieldpulse/bulk-operations.ts(378 lines), bulk-types.ts(145), fieldpulse/bulk-update/route.ts(191)
- shared/rate-limiter.ts:241 housecallRateLimiter, :247 waitForRateLimit, :130 checkLimit, :198 resetClient
- rate-limit.ts:86 adminMutation 30/60000; session.ts:28 getAdminSession returns payload or null; getHousecallClient returns client or null at client.ts:583

**Assessment:**

GAP FULLY OPEN. No HCP bulk-ops, bulk-types, or admin route exist; Stage-9 withHcpRateLimit has zero consumers. Closure hint (Option A blocked, do Option B) re-verified correct: UpdateJobInput (types.ts:148) and updateJob (client.ts:393-415) carry no work_status; a verbatim FP port would silently no-op. Only cancelJob/addJobNote mutate status. Proceed Option B.

PORTING DELTA the prior plan under-specified: HCP cancelJob/addJobNote both return void (client.ts:417,426), unlike FP updateJob which returns a job. BulkJobUpdateResult must DROP the job field; processSingleUpdate must race the void mutation and return success without a job. cancel and note are mutually-exclusive primary actions (note is NOT a secondary append like FP:86-95).

PLAN (Option B):
1. CREATE housecall-pro/bulk-types.ts (port fieldpulse/bulk-types.ts). BulkJobOperation = {hcpJobId, serviceRequestId, action note or cancel, note optional}. BulkJobUpdateResult drops the job field. Keep Summary/Error/Options/Request{operations,options?}/Response{summary,aggregatedErrors?,completeSuccess}. Do NOT import RateLimitInfo from FP (shared/rate-limiter.ts:24 owns it).
2. CREATE housecall-pro/bulk-operations.ts. Port the bounded-worker-pool verbatim (fieldpulse:145-207: shared nextIndex, per-worker await, aborted-stops-new-starts, hole-filter preserves order). processSingleUpdate wraps the single mutation in withHcpRateLimit(clientId, fn) where fn does Promise.race([mutation, timeout]) and mutation is cancelJob(id) or addJobNote(id, note). This REPLACES FP manual waitForRateLimit/reportSuccess/reportThrottle (lines 59,83,114) and gives Stage 9 its live consumer. Keep retry classification (429/timeout/5xx/ECONN star/maxRetries) and statusCode mapping. aggregateErrors keyed on hcpJobId. Export bulkJobOperations(client, operations, options, clientId), validateBulkOperations (cap 1000, non-empty, ids required strings, action enum, note required when action note), getRateLimitInfo and resetRateLimiter via housecallRateLimiter. Header documents the no-arbitrary-status limitation.
3. CREATE app/api/admin/integrations/housecall/bulk-update/route.ts (mirror FP route). POST: getAdminSession 401; slidingWindow(admin:housecall-bulk:userId, adminMutation) 429; shape-guard (object, not null, Array.isArray operations) 400 before destructure; validateBulkOperations 400; getHousecallClient(session.organizationId) NOT_CONFIGURED 400 on null; clientId equals org:organizationId from SESSION not body; bulkJobOperations; successResponse with summary, aggregatedErrors, completeSuccess equals failed is zero; catch SyntaxError 400 else 500. GET: adminRead-gated getRateLimitInfo plus supportsStatusBulk false note. No dynamic params so Next-16 Promise-params N/A. Bulk runs inline and awaited so no after() or detached-promise concern.
4. TESTS (TDD vitest): bulk-operations.test.ts with stub client cancelJob/addJobNote: per-item partial failure, order preserved, continueOnError false aborts, transient-then-success retry, cancel-failure recorded, note requires note, reportThrottle on injected 429. bulk-types.test.ts shape smoke. tests/api/housecall-bulk-update.test.ts NET-NEW since no FP route test exists to port: 401, 400 bad body, 400 NOT_CONFIGURED, 400 bad action or missing note, happy path, tenant-scope clientId from session.

DEGRADE-SAFETY: continueOnError default true; inline await bounded-worker-pool with no orphaned promises; limiter in-memory keyed by orgId. NEON-HTTP/db.batch/withTenant N/A since no DB. FROZEN safety text, money-safety, metadata.verify all N/A.

VERIFY GATES: npx tsc --noEmit; npm run lint to 0; npm run test:unit (new HCP green, FP unchanged); npm run build. No eval, no migration.

**Key risks:**
- addJobNote is ASSUMED HCP SHAPE at client.ts line 427; a real 4xx on the notes endpoint marks every note operation failed; document it; cancelJob is the firmer path
- HCP cancelJob and addJobNote return void while FP updateJob returns a job, so drop BulkJobUpdateResult.job and race the void mutation or tsc fails
- withHcpRateLimit already reports success and throttle internally, so do not also call reportSuccess or reportThrottle manually inside processSingleUpdate
- clientId must derive from session.organizationId per FP route.ts line 82, never request body, else cross-org rate-bucket leak

**Verifier (minor-corrections):** 
- FP line counts are off by one each (immaterial): bulk-operations.ts is 377 lines not 378, bulk-types.ts is 144 not 145, bulk-update/route.ts is 190 not 191 (verified via wc -l).
- RATIONALE IMPRECISION (non-blocking): the note 'Do NOT import RateLimitInfo from FP (shared/rate-limiter.ts:24 owns it)' is muddled. FP's bulk-types.ts:121 defines its OWN local RateLimitInfo; it does NOT import from shared. The two are structurally IDENTICAL (allowed/state/remaining/resetMs/suggestedDelayMs), which is why FP's getRateLimitInfo (bulk-operations.ts:323) compiles despite checkLimit returning the shared shape. The plan's instruction to reuse shared's RateLimitInfo for HCP is still correct and avoids duplication; only the stated reason is off.
- API-SHAPE SHORTHAND (non-blocking): the plan writes slidingWindow(key, adminMutation) but the real signature (rate-limit.ts:45) is positional slidingWindow(key, maxRequests, windowMs) -> the FP route mirrors it correctly at route.ts:36-40 (RATE_LIMITS.adminMutation.maxRequests, .windowMs), so 'mirror FP route' yields correct code; the abbreviation could mislead a literal implementer.

_Notes:_ Independently re-derived; assessment is sound with only cosmetic corrections. CONFIRMED via direct file reads: (1) Gap fully open - no HCP bulk-operations.ts/bulk-types.ts/bulk-update route; withHcpRateLimit has ZERO live consumers (grep excluding def+test = empty). (2) Closure decision Option-A-blocked->Option-B is CORRECT: types.ts:148 UpdateJobInput has no work_status; client.ts:393-415 updateJob body = description/schedule/line_items only, returns HousecallJob; client.ts:417 cancelJob returns void; client.ts:426 addJobNote returns void + ASSUMED HCP SHAPE comment. A verbatim FP port would silently no-op status. (3) All 4 key risks verified exact: addJobNote ASSUMED SHAPE (client.ts:427 comment), cancelJob/addJobNote void vs FP updateJob returning job (so drop BulkJobUpdateResult.job at bulk-types.ts:42), withHcpRateLimit already does waitForRateLimit+reportSuccess+reportThrottle internally (rate-limiter.ts:35-43) so don't double-report, clientId from session.organizationId (FP route.ts:82 = `org:${session.organizationId}`). (4) Porting delta accurate: FP note is non-critical secondary append (bulk-operations.ts:85-96) vs HCP primary mutually-exclusive action; worker pool at bulk-operations.ts:145-207 matches description (shared nextIndex, per-worker await, aborted-stops-new-starts, hole-filter preserves order); manual rate-limit calls at lines 59/83/114 exact. (5) All supporting refs exist: getHousecallClient(organizationId) client.ts:583 returns null when unconfigured, getAdminSession session.ts:28 returns AdminSessionPayload|null, adminMutation 30/60000 rate-limit.ts:86, adminRead 60/60000 :90, successResponse/errorResponse present, HousecallJob types.ts:64, shared checkLimit:130/resetClient:198/housecallRateLimiter:241/waitForRateLimit:247. (6) Plan's claim 'no FP route test to port' verified - tests/api has no fieldpulse bulk-update test. Every referenced file/function/column exists; plan would compile. Effort M is reasonable.

---

## Stage 11 — FieldPulse job line-items on push  _(closure)_

**Verified status:** closure-correct  **·  Verify:** sound  **·  Effort:** none

**Evidence:**
- src/lib/integrations/fieldpulse/client.ts:519-533 createJob body = {customer_id, description, schedule_start, schedule_end, assigned_user_id, tags} — NO line_items key
- src/lib/integrations/fieldpulse/client.ts:536-552 updateJob body = {description, schedule_start, schedule_end, assigned_user_id, work_status} — NO line_items key
- src/lib/integrations/fieldpulse/job-sync.ts:154-159 (update) and :196-203 (create) pass only description+schedule+requestId from serviceRequestToJobFields
- src/lib/integrations/fieldpulse/types.ts:73-89 CreateJobInput/UpdateJobInput have no lineItems field; no line-items.ts exists in fieldpulse/ (ls confirms) while HCP has the full 3-file pattern
- src/lib/integrations/fieldpulse/job-mapping.ts:65-87 buildDescription emits Issue/Work Type/System/Access lines from issueType,jobType,systemType,accessNotes — the SAME four source fields the HCP builder (housecall-pro/line-items.ts:27-33,70-73) consumes → information parity
- Every FP line_items reference is the INVOICE read path: client.ts:367,376,383 flatten line_items[].line_components[] off /invoices; invoice-sync.ts maps into native invoice_line_items; client-real-shapes.test.ts:42-70 confirms line_items is the invoice shape carrying money
- docs/superpowers/specs/2026-06-19-fieldpulse-live-api-remediation-design.md:16,27,29 — LIVE probing of the real FP API: /jobs returns 200, the captured ~150-field shape documents line_items only as an INVOICE field (line_components[] with unit_price/unit_cost); no jobs-resource line_items anywhere
- src/lib/integrations/fieldpulse/job-sync.ts:221-227 catch swallows all FP push errors as a degraded WARN — a guessed line_items key rejected 4xx would silently no-op (or break the whole push), validating the don't-guess rationale
- a275910 (closure commit) added only an 8-line documenting comment to job-mapping.ts:50-57 + the doc — zero behavior change

**Assessment:**

Closure is CORRECT. Both load-bearing claims independently reproduce against current code. (1) Information parity is real: FP's buildDescription (job-mapping.ts:65-87) reads exactly issueType, jobType, systemType, accessNotes — the identical four-field source the HCP line-items builder (line-items.ts:70-73) consumes — and emits them as labelled lines. Only the wire format differs (labelled \\n-lines vs a line_items array); no classification information is lost. (2) FP /jobs structured line_items is genuinely unconfirmable: every line_items reference in the FP codebase is the invoice read path (client.ts:367/376/383, invoice-sync.ts, real-shapes test), and — the decisive evidence the prior review did not cite — the live-API remediation design captured the real /jobs and /invoices shapes from actual probing and documents line_items ONLY on invoices (FP models line items on invoices/estimates, not jobs). Building it would mirror an admittedly-ASSUMED HCP shape (HCP client.ts:169) and, if FP rejects the unknown key, the job-sync.ts:221 catch would silently swallow the 4xx — feature looks done, no-ops, or breaks the whole push. The honest parity move (description-level + documented FP-only limitation) is exactly the plan's stated option B and the Stage-10 'document the limitation' convention. No correctness bugs, no regressions, no tenant/money/safety surfaces touched (closure is doc-only; description path was already shipping and is byte-unchanged). Verdict: closure-correct — the skipped structured-line_items capability does NOT demonstrably exist in the FP /jobs API per the codebase's own live-probe evidence, so the closure does not undersell a real gap.

**Key risks:**
- Residual (not a defect): if FieldPulse vendor docs or a sandbox later confirm POST /jobs DOES accept line_items, the gap reopens — the closure correctly gates reopening on that operator confirmation (job-mapping.ts:57 comment instructs exactly this). Low likelihood given live-probe evidence.
- The information-parity argument assumes downstream FP tooling/techs parse the labelled description lines; FP cannot filter/sort/total by these the way it could a structured line_items array. This is a UX-richness gap, not an information gap — acceptable given line items here are price-free and descriptive only.
- If FP ever rejects the EXISTING job body on validation, job-sync.ts:221 swallows it silently (pre-existing degrade-by-design, unchanged by this stage).

**Verifier (sound):** 
- Minor imprecision (not a defect): the assessment states FP buildDescription reads 'exactly issueType, jobType, systemType, accessNotes — the identical four-field source' as the HCP builder. job-mapping.ts:65-87 actually reads a SUPERSET — it also emits Reference, Urgency, Details(description) and Address lines (lines 67-69,77-84), on top of the four classification fields. HCP LineItemSource (line-items.ts:25-33) reads exactly the four. The load-bearing claim that holds is 'no classification information is lost / information parity', which is true because FP conveys >= the HCP fields; 'exactly/identical' overstates the symmetry but does not affect the closure verdict.

_Notes:_ Independently reproduced every cited line. Both load-bearing claims hold. (1) Information parity: HCP LineItemSource (housecall-pro/line-items.ts:25-33) consumes issueType/jobType/systemType/accessNotes; FP buildDescription (fieldpulse/job-mapping.ts:65-87) emits those same four as labelled lines plus more (reference/urgency/details/address) — so no classification info is lost; only wire-format differs. (2) FP /jobs structured line_items is genuinely unconfirmable: grep confirms every FP line_items reference is the INVOICE read path (client.ts:367/376/383 flatten line_items[].line_components[] off /invoices; invoice-sync.ts:303-320; live-smoke.ts:61; types.ts:112/137) — no jobs-resource line_items anywhere. createJob (client.ts:519-533) and updateJob (536-552) bodies contain no line_items key; CreateJobInput/UpdateJobInput (types.ts:73-89) have no lineItems field; job-sync.ts:154-159 and 195-201 pass only description+schedule(+requestId). The live-API remediation design (docs/.../2026-06-19-fieldpulse-live-api-remediation-design.md:16,27,29) documents /jobs returning 200 and probed ~150-field shapes with line_items ONLY on the invoice shape (line_components[] with unit_price/unit_cost); jobs carry status/invoice_status ints, no line_items. Closure commit a275910 added exactly an 8-line intentional-parity comment (job-mapping.ts:50-57) + a doc edit, with the description path byte-unchanged (verified via git show) — zero behavior change, no tenant/money/safety surfaces touched. job-sync.ts:221-227 catch degrades FP push errors to WARN, validating the don't-guess rationale (a rejected unknown key would silently no-op or break the push). No skipped real gap; closure does not undersell. Only correction is the cosmetic 'exactly/identical four-field' overstatement noted above.

---

## Stage 12 — technician_skills table + CRUD UI  _(plan)_

**Verified status:** real-gap  **·  Verify:** sound  **·  Effort:** M

**Evidence:**
- grep -rniE 'technician_skill|technicianSkill|technician-skill' src/ drizzle/ → ZERO matches (no table, model, query, route, or UI)
- src/lib/ai/dispatch/score.ts:45 `const skillMatched = tech.skillJobsCompleted > 0;` — hard boolean gate, completion-history only
- src/lib/ai/dispatch/score.ts:72 `.filter((r) => r.skillMatched)` — drops 0-history techs in rankTechnicians
- src/lib/ai/dispatch/signals.ts:66-98 — skillPredicate counts serviceRequests.status='completed' matching jobType/systemType; no explicit-skill source
- src/lib/ai/dispatch/signals.ts:23 TechSignalRow interface (touch-point 1) / score.ts:13 DispatchSignals.tech (touch-point 2) / scheduling-queries.ts:800-811 candidate mapping (touch-point 3)
- src/lib/admin/scheduling-queries.ts:794-812 rankedTechnicianOrder feeds skillJobsCompleted from loadDispatchSignals — the single dispatch integration point
- drizzle/meta/_journal.json last tag = 0022_aberrant_carmella_unuscione (idx 22) → NEXT migration is 0023, not 0022 as prior plan stated
- src/lib/db/schema.ts:77 jobTypeEnum, :117 systemTypeEnum, :258-300 users table (organizationId :262, users_org_id_idx :300) — reuse targets
- src/app/admin/(dashboard)/technicians/page.tsx now ONLY redirects to /admin/staff (no CRUD surface) — prior plan's UI home is GONE
- src/app/admin/(dashboard)/staff/page.tsx is the live surface (StaffTable + StaffFormDialog); skills UI must live here
- src/app/api/admin/membership-plans/route.ts + [id]/route.ts — exact route template (getAdminSession, slidingWindow RATE_LIMITS, success/errorResponse, logAudit .catch); DELETE uses `const { id } = await context.params` ([id]/route.ts:97)
- src/lib/ai/dispatch/score.test.ts:6-20 signals() helper spreads ...over → adding hasExplicitSkill:false default keeps all existing tests green
- src/lib/ai/dispatch/signals.test.ts:3-21 uses shift-based selectQueue mock; each test pushes one array per db.select() — a 4th parallel skill query needs +1 push per test

**Assessment:**

GAP IS OPEN — re-confirmed against current code. Nothing named technician_skills exists. The failure in the plan is real and exactly traced: a certified tech with 0 completed jobs gets skillMatched=false (score.ts:45) and is dropped by rankTechnicians (score.ts:72), so it is never auto-assigned. The prior review's plan remains substantively correct; signals.ts/score.ts/scheduling-queries.ts are byte-identical to the prior assessment. TWO facts have DRIFTED since the prior review and must be corrected:\n\n1. MIGRATION NUMBER: journal now ends at idx 22 (0022_aberrant_carmella_unuscione). The prior plan's `drizzle/0022_technician_skills.sql` is WRONG — the next migration is 0023. Append journal idx 23, copy 0022_snapshot.json → 0023_snapshot.json (hand-authored-trigger-migration memory pattern), add the new pgTable to the snapshot.\n\n2. UI HOME MOVED: src/app/admin/(dashboard)/technicians/page.tsx is now a bare redirect to /admin/staff. The prior plan's 'add a Skills section to the technicians admin surface' no longer applies. The CRUD UI must live in /admin/staff (StaffTable / StaffFormDialog at staff/page.tsx) — e.g. a per-technician-row 'Skills' expand/dialog that calls the new endpoints, gated to role=technician rows.\n\nCONCRETE PLAN (file-level):\n\n1. Migration drizzle/0023_technician_skills.sql (hand-authored): CREATE TABLE technician_skills (id uuid PK default gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_type job_type NULL, system_type system_type NULL, proficiency integer NOT NULL DEFAULT 1, created_at/updated_at timestamptz NOT NULL DEFAULT now()). CHECK (job_type IS NOT NULL OR system_type IS NOT NULL). For dedupe across NULLs use TWO partial unique indexes (WHERE system_type IS NULL keyed (org,user,job_type); WHERE job_type IS NULL keyed (org,user,system_type)) PLUS one full unique (org,user,job_type,system_type) for the both-present case — NULLs-distinct means a plain composite unique alone won't dedupe. index (organization_id, user_id). REUSE jobTypeEnum/systemTypeEnum — DO NOT create enums. Append journal idx 23; copy 0022_snapshot.json→0023_snapshot.json with the table added. Run `npm run db:migrate` (migrations-not-run-on-deploy memory) or .returning() inserts 500 in prod.\n\n2. src/lib/db/schema.ts: add technicianSkills pgTable mirroring users tenant conventions (organizationId FK cascade, org_id index, withTenant-compatible), referencing jobTypeEnum/systemTypeEnum.\n\n3. src/lib/admin/technician-skills-queries.ts (new): listTechnicianSkills(orgId, userId?) withTenant; createTechnicianSkill(orgId,{userId,jobType?,systemType?,proficiency}) — validate userId in-org via withTenant(users,...) select BEFORE insert, catch 23505 → friendly duplicate; deleteTechnicianSkill(orgId,id) withTenant in WHERE; loadExplicitSkills(orgId, technicianIds, job) → Map<techId,boolean> matching job.jobType OR job.systemType, default false for missing techs.\n\n4. DISPATCH WIRING (3 touch-points, load-bearing): (a) signals.ts:23 add `hasExplicitSkill: boolean` to TechSignalRow, default false in the seed loop (line 58); add a 4th query to the Promise.all (line 81) selecting technician_skills rows matching job.jobType OR job.systemType for the tech ids, set hasExplicitSkill=true for matches. (b) score.ts:13 add `hasExplicitSkill: boolean` to DispatchSignals.tech; change score.ts:45 to `const skillMatched = tech.skillJobsCompleted > 0 || tech.hasExplicitSkill;`. Grant ONLY the gate, NOT skillDepth (keep skillDepth completion-based so a 0-history certified tech doesn't outrank a veteran). (c) scheduling-queries.ts:805 add `hasExplicitSkill: s.hasExplicitSkill` to the candidate tech mapping.\n\n5. Routes (copy membership-plans exactly): src/app/api/admin/technicians/skills/route.ts → GET (?userId= optional) + POST (zod: userId uuid, jobType enum optional, systemType enum optional, .refine at-least-one, proficiency int 1-5 default 1; RATE_LIMITS.adminRead/adminMutation; logAudit create_technician_skill, details=enums only no PII). src/app/api/admin/technicians/skills/[id]/route.ts → DELETE (`const { id } = await context.params`; audit delete_technician_skill).\n\n6. CRUD UI in /admin/staff: per-technician-row Skills control (dialog or expander) — jobType/systemType select + proficiency, add/remove chips — calling the new endpoints; match StaffFormDialog/Card styling; client component. No new nav.\n\n7. TESTS (TDD vitest): score.test.ts — add hasExplicitSkill:false default to signals() helper (keeps :22-32 green); new case skillJobsCompleted=0 + hasExplicitSkill=true → skillMatched true + survives rankTechnicians; skillJobsCompleted=0 + hasExplicitSkill=false → still dropped. signals.test.ts — push one more selectQueue array per test for the 4th query; assert hasExplicitSkill maps and defaults false. technician-skills-queries test — dedupe 23505 path, withTenant in WHERE, cross-org userId rejected (mock db like signals.test.ts; vitest-env memory: real-client import fails headless).\n\nVERIFY GATES: npm run tsc, npm run lint (stay 0), npm run test:unit (score/signals/queries green), npm run build. No prompt/hvac-knowledge.ts edits → eval not required. No money-safety / metadata.verify surfaces touched. DEGRADE-SAFE: default hasExplicitSkill=false → orgs with no skills rows behave identically; explicit skill only ADDS candidates, never removes a matched tech. NEON-HTTP: selects + single .returning() inserts only; db.batch if a multi-write ever needed; no db.transaction.

**Key risks:**
- MIGRATION NUMBER DRIFT (corrected): prior plan said 0022 but journal now ends at idx 22 — the file MUST be 0023; journal+snapshot hand-edit must be exact or drizzle-kit drifts; forgetting npm run db:migrate 500s any .returning() insert in prod
- UI HOME MOVED (corrected): technicians/page.tsx is now a redirect-only stub; skills CRUD must be built into /admin/staff (StaffTable/StaffFormDialog), not the dead technicians page
- NULL-in-unique-constraint: SQL treats NULL as distinct, so a single composite UNIQUE(org,user,job_type,system_type) won't dedupe rows where one column is NULL — need partial unique indexes (the trickiest part)
- Precedence semantics: grant explicit-skill techs only the skillMatched GATE, not skillDepth — else an unproven certified tech (0 history) could outrank a 9-job veteran; confirm this conservative product choice is intended
- Enum-aligned only: free-text certs (e.g. 'EPA 608') can't match the jobType/systemType-keyed dispatch signal — non-enum certs are out of scope for auto-assign matching
- signals.test.ts shift-based selectQueue mock: the conditional skill query already complicates ordering; the new 4th parallel query must be pushed in the correct position per test or assertions silently read the wrong mocked result

**Verifier (sound):** 
- EVIDENCE LINE-NUMBER NITPICKS (non-load-bearing, plan still correct): The plan says 'add hasExplicitSkill to TechSignalRow at signals.ts:23' — the interface is at lines 23-27 and the field would be added inside it (line 23 is just the `export interface` declaration). The plan says 'default false in the seed loop (line 58)' — confirmed, line 58 is `result.set(id, {...})`. The plan says '4th query to the Promise.all (line 81)' — line 81 is the `const [skillRows, ratingRows, loadRows] = await Promise.all([` destructure; correct. The evidence item citing 'signals.ts:66-98 skillPredicate' is loose: skillPredicate is built at 67-79 and the skill query is at 82-98. None of these affect correctness.
- TEST-MOCK STEP UNDERSTATES ONE SUBTLETY (feasible but needs care): The existing skill query in signals.ts:82-98 is CONDITIONAL — when skillPredicate is null (job has no jobType/systemType) it short-circuits to `Promise.resolve([])` and does NOT call db.select(). signals.test.ts:60-70 ('no classification') therefore pushes only 2 arrays (rating+load), not 3. The plan's '4th parallel skill query needs +1 push per test' is correct ONLY for the classified-job tests (lines 34, 46). The new technician_skills query must ALSO short-circuit when both jobType and systemType are null, or the no-classification test's shift-based queue ordering breaks. keyRisk #6 flags the ordering hazard but the plan body says '+1 push per test' which is too absolute — the no-classification case must stay at 2 (or +1 only if the new query is unconditional). The plan author should decide and state whether the explicit-skill query is conditional on classification (recommended: yes, to mirror existing behavior).
- PARTIAL-UNIQUE-INDEX CLAIM IS CORRECT AND IS THE RISKIEST PART: Postgres treats NULL as distinct in UNIQUE constraints, so a single composite UNIQUE(org,user,job_type,system_type) will NOT dedupe rows where one column is NULL. The plan's three-index solution (two partial uniques + one full) is sound. This is hand-authored SQL not generated by drizzle-kit, so the journal-idx-23 + 0022_snapshot.json→0023_snapshot.json copy (hand-authored-trigger-migration memory pattern) must be exact or drizzle-kit will detect drift on the next generate.

_Notes:_ Independently re-derived the status as real-gap and confirm the assessment holds up. Verified against actual code:\n\nSTATUS (real-gap) — CONFIRMED. `grep -rniE 'technician_skill|technicianSkill|technician-skill' src/ drizzle/` returns ZERO matches. No table/model/query/route/UI exists.\n\nFUNCTIONAL GAP — CONFIRMED exact: score.ts:45 `const skillMatched = tech.skillJobsCompleted > 0;` and score.ts:72 `.filter((r) => r.skillMatched)` mean a certified tech with 0 completed matching jobs is dropped from rankTechnicians and never auto-assigned. signals.ts only sources skill from completed serviceRequests (lines 82-98), no explicit-skill source. scheduling-queries.ts:800-811 is the single integration point (tech mapping at 804-809).\n\nDRIFT CORRECTIONS — BOTH CONFIRMED CORRECT:\n1. Journal ends at idx 22 (0022_aberrant_carmella_unuscione); 0022_snapshot.json is the latest snapshot. Next migration IS 0023, not 0022. The prior plan's 0022_technician_skills.sql would collide.\n2. technicians/page.tsx is now an 11-line bare `redirect('/admin/staff')` — the prior 'add Skills to technicians page' is dead. Live surface is staff/page.tsx (StaffTable + StaffFormDialog confirmed).\n\nPLAN FEASIBILITY — all referenced anchors exist: jobTypeEnum (schema.ts:77), systemTypeEnum (:117), users table (:258), organizationId (:262), users_org_id_idx (:300), withTenant (tenant.ts:19), RATE_LIMITS.adminRead/adminMutation (rate-limit.ts:86/90), gen_random_uuid (established pattern), loadJobClassification (scheduling-queries.ts:735). Route template membership-plans/[id]/route.ts confirmed byte-for-byte: getAdminSession, slidingWindow, success/errorResponse, logAudit().catch, DELETE `const { id } = await context.params` at line 97. score.test.ts signals() helper spreads ...over at line 17 (adding hasExplicitSkill:false default keeps tests green). signals.test.ts shift-based selectQueue mock confirmed at lines 3-23.\n\nThe degrade-safe design (default hasExplicitSkill=false → empty-skills orgs unchanged; explicit skill only ADDS candidates) and the conservative gate-not-skillDepth choice are sound product calls. No money-safety/metadata.verify surfaces touched. neon-http constraints (no transaction, single .returning()) respected. The assessment is accurate, well-evidenced, and the two drift corrections are real and material. Verdict: sound with three minor precision notes (see corrections) — none block the plan.

---

## Stage 13 — Technician base location + proximity scoring  _(plan)_

**Verified status:** real-gap  **·  Verify:** minor-corrections  **·  Effort:** M

**Evidence:**
- src/lib/db/schema.ts:258-298 users table has NO base_lat/base_lng/latitude/longitude column
- src/lib/ai/dispatch/score.ts:30-32 only W_SKILL=0.5,W_QUALITY=0.3,W_LOAD=0.2 (sum 1.0); no W_PROX
- src/lib/ai/dispatch/score.ts:51 score = skillDepth*W_SKILL + quality*W_QUALITY + load*W_LOAD; no distance term
- src/lib/ai/dispatch/score.ts:13-19 DispatchSignals.tech has no distanceKm
- src/lib/ai/dispatch/signals.ts:22-27 TechSignalRow has no distance; loadDispatchSignals(50-165) never reads coordinates
- src/lib/admin/scheduling-queries.ts:739-748 loadJobClassification selects jobType/systemType/urgency only; never resolves locationId or site coords
- src/lib/admin/scheduling-queries.ts:800-812 candidate map has no distanceKm; calls rankTechnicians(candidates)
- src/lib/db/schema.ts:1854-1855 customer_locations.latitude/longitude (doublePrecision) EXIST; serviceRequests.locationId links to it
- src/lib/address/photon.ts:211 export function haversineKm(...) pure + reusable (reused at photon.ts:242)
- score.test.ts:35 hardcodes 0.5+0.3+0.2=1.0; :52 asserts (3.5/5)*0.3+0.2; :55-60 load baseline; all break on weight rebalance
- drizzle journal idx 22 = 0022_aberrant_carmella_unuscione (HCP user id); next migration is 0023, NOT 0022
- src/app/api/admin/staff/[id]/route.ts:17-34 updateStaffSchema has name/role/isActive/laborRateCents only; staff-queries.ts:245+:310 is the save seam

**Assessment:**

GAP STILL OPEN; prior plan architecture re-verified sound. Re-confirmed every closure-relevant file: users (schema.ts:258-298) has no base_lat/base_lng; scoreTechnician (score.ts:43-62) has no distance term; DispatchSignals.tech (13-19) and TechSignalRow (signals.ts:23-27) carry no distanceKm; loadJobClassification (sched-queries.ts:739-748) never resolves site coords; candidate map (800-811) never passes distance. customer_locations.lat/lng (schema.ts:1854-1855) and haversineKm (photon.ts:211) both already exist and are reusable.\n\nDRIFT vs prior plan: migration slot. Prior plan said 'next is 0022' but 0022_aberrant_carmella_unuscione (HCP user id) now occupies it (journal idx 22). New migration MUST be 0023_*: ALTER TABLE users ADD COLUMN base_lat double precision; ADD COLUMN base_lng double precision; copy drizzle/meta/0022_snapshot.json -> 0023, add cols under users, bump id/prevId, append journal idx 23. Run npm run db:migrate after (Vercel skips migrations).\n\nVerifier test-breakage correction CONFIRMED: rebalancing W_QUALITY/W_LOAD breaks THREE score.test.ts assertions: max-signals (:35), rating-default (:52 asserts exactly (3.5/5)*0.3+0.2), load-penalty (:55-60). All must be updated with the weight change.\n\nPLAN: (1) schema.ts:298 add baseLat/baseLng doublePrecision (nullable; already imported) + hand-authored 0023 migration + snapshot/journal copy. (2) score.ts: extend DispatchSignals.tech with distanceKm: number|null; rebalance W_SKILL=0.45,W_QUALITY=0.25,W_LOAD=0.15,W_PROX=0.15 (sum 1.0); proximity = distanceKm==null ? 0.5 : 1 - Math.min(distanceKm,DIST_CAP)/DIST_CAP, DIST_CAP=80km; null => neutral, NEVER gates (skillMatched stays the only filter, 69-77); update the 3 broken tests. (3) signals.ts: add distanceKm to TechSignalRow; loadDispatchSignals reads tech baseLat/baseLng (one withTenant select) + site coords passed in as params; compute via imported haversineKm; null when either side null. (4) scheduling-queries.ts: loadJobClassification LEFT JOIN customer_locations ON serviceRequests.locationId org-scoped via withTenant (join predicate MUST carry organizationId), select latitude/longitude; thread siteLat/siteLng through rankedTechnicianOrder(784) into loadDispatchSignals + candidate map; null site coords => neutral => zero behavior change (preserves 'opt-in never strands a job' at 778-793,849-861). (5) updateStaffSchema (route.ts:17-34) add optional baseLat/baseLng (z.number min/max, nullable), relax the at-least-one refine; persist in updateStaff (staff-queries.ts:310). PREFERRED: explicit coords from admin address-autocomplete (reuse src/components/chat/address-autocomplete.tsx). If server geocode added, use after() not detached promise. Audit-log field NAMES only.\nTESTS (vitest): score.test.ts weight sum 1.0; closer outranks equal-skill farther; null => neutral never excluded; DIST_CAP clamp; max incl distance=0 => 1.0; fix 3 hardcoded tests. signals.test.ts distance from tech+site coords, null when missing, tenant-scoped query.\nVERIFY: tsc --noEmit; lint; test:unit (score/signals pure); build. No prompt change => no eval.</assessment>
</invoke>


**Key risks:**
- Weight rebalance breaks THREE score.test.ts assertions (:35 max-signals, :52 rating-default (3.5/5)*0.3+0.2, :55-60 load-penalty), not one; all hardcode current constants and must be updated with the weight change
- Proximity MUST be a soft signal (neutral 0.5 on null distance), never a filter; if it gates, a coordless tech (the common case) gets excluded and an opted-in org regresses below opted-out, violating scheduling-queries.ts:778-793,849-861
- Cross-org leak: the new customer_locations LEFT JOIN and users coord select must BOTH be org-scoped on the join predicate; a missing org filter leaks another tenant's site coordinates
- Migration index drift: 0022 slot is taken (HCP user id); new migration MUST be 0023_* with snapshot copied from 0022_snapshot.json + journal idx 23; run npm run db:migrate (Vercel skips it)
- Feature dormant until coords exist: both tech base_lat/lng AND customer_locations.lat/lng must be populated; frequently null => neutral => no-op (degrade-safe) but the win materializes only once locations are geocoded
- Server-side geocode-on-save (if chosen) must use after() not a detached promise (Vercel freeze) and degrade to no-coords on Photon failure

**Verifier (minor-corrections):** 
- PLAN OMISSION (staff save seam): updateStaff has a SECOND hasChange guard at staff-queries.ts:256-260 (independent of the route schema refine at route.ts:26-35). A PATCH carrying only baseLat/baseLng would pass the relaxed route schema but be rejected as {ok:false, reason:'no_changes'} by updateStaff. The plan cites :310 (persist) and the route refine but never mentions relaxing staff-queries.ts:256-260 — both guards must be updated, or the feature silently no-ops.
- PLAN OMISSION (type def): UpdateStaffInput is NOT defined in staff-queries.ts; it is imported from ./types at staff-queries.ts:42. Adding baseLat/baseLng requires editing the UpdateStaffInput type in src/lib/admin/types.ts. The plan never names this file. Also note STAFF_COLUMNS (staff-queries.ts:119-127, used in .returning) does not include the new cols — if the admin UI must read coords back, STAFF_COLUMNS needs them too.
- PLAN OMISSION (third test file): The plan's TESTS section updates score.test.ts and signals.test.ts but the existing mock at scheduling-queries.test.ts:146-153 returns TechSignalRow objects WITHOUT distanceKm. If distanceKm is added as a required field on TechSignalRow, `tsc --noEmit` (the plan's VERIFY step) may flag the mocked module's return type. Either make distanceKm optional/nullable in the row default or add it to that mock. (Vitest itself does not typecheck — no `typecheck` in vitest config — so runtime tests pass regardless; the risk is only the tsc gate.)
- STALE GIT-STATUS NOTE (not an assessment error, but worth recording): the session-start git status listed untracked drizzle/0034_*.sql and 0035_*.sql, which do NOT exist on the actual current main tree (verified: highest .sql is 0022, journal idx 22, `ls drizzle/003*` → no matches). Those were a snapshot from a different FieldPulse working state. The assessment's '0023 is next' is correct for the real tree.

_Notes:_ Independently re-derived the status as real-gap; closure decision (GAP STILL OPEN) is CORRECT. All 13 evidence citations verified against the live code: users table (schema.ts:258-298) has no lat/lng; score.ts:30-32 weights (0.5/0.3/0.2, no W_PROX); score.ts:51 score formula has no distance term; DispatchSignals.tech (13-19) and TechSignalRow (signals.ts:23-27) carry no distanceKm; loadDispatchSignals (50-165) never reads coords; loadJobClassification (sched-queries.ts:735-752) selects only jobType/systemType/urgency and never resolves locationId (serviceRequests.locationId exists at schema.ts:487); candidate map (800-811) has no distanceKm; customer_locations.latitude/longitude (schema.ts:1854-1855, doublePrecision) EXIST; haversineKm (photon.ts:211) is pure+exported+reused (242); doublePrecision is imported (schema.ts:13). The THREE broken test assertions are confirmed EXACTLY: score.test.ts:35 (0.5+0.3+0.2=1.0), :52 ((3.5/5)*0.3+0.2), :55-60 (load baseline). Migration journal idx 22 = 0022_aberrant_carmella_unuscione confirmed; next is 0023. Only one production consumer of the scoring API (scheduling-queries.ts); adding nullable distanceKm is non-breaking. The architectural invariants are sound: proximity-as-soft-signal (neutral 0.5 on null, W_PROX=0.15) never gates (skillMatched stays the sole filter at score.ts:72) and does not regress opt-in ordering or strand jobs (778-793/849-861 govern job stranding via null classification, orthogonal to score); cross-org leak risk is correctly flagged and the org-scoped-join pattern already exists in signals.ts:106-109 (reviewRequests join carries organizationId). Effort 'M' is fair. Corrections are plan-completeness gaps (3 unmentioned edit sites), not flaws in the gap-open conclusion.

---

## Stage 14 — Tunable confidence threshold (org-level)  _(plan)_

**Verified status:** real-gap  **·  Verify:** minor-corrections  **·  Effort:** M

**Evidence:**
- src/lib/ai/dispatch/score.ts:45 - const skillMatched = tech.skillJobsCompleted > 0; (hard boolean gate, unchanged)
- src/lib/ai/dispatch/score.ts:69 - rankTechnicians(candidates: readonly DispatchSignals[]) takes no threshold/options arg
- src/lib/ai/dispatch/score.ts:72 - .filter((r) => r.skillMatched) drops non-matches; nothing reads a score threshold
- src/lib/admin/scheduling-queries.ts:812 - return rankTechnicians(candidates); caller passes no threshold
- src/lib/admin/scheduling-queries.ts:727 - isAutoDispatchEnabled selects only { enabled: organizationSettings.autoDispatchEnabled }, keyed by organizationId PK (729)
- src/lib/db/schema.ts:1008 - autoDispatchEnabled: boolean(auto_dispatch_enabled).notNull().default(false) is the only dispatch tuning column; no min-score column
- src/lib/admin/org-config-types.ts:125,148,164 - only autoDispatchEnabled in OrgConfigUpdate schema / OrgConfig / DEFAULT_ORG_CONFIG; no dispatchMinScore
- src/lib/admin/org-config-queries.ts:52,90-91,112,114 - map / patch / insert-default / onConflictDoUpdate wired only for autoDispatchEnabled
- grep minScore|dispatchMinScore|dispatch_threshold across src/ + drizzle/ returns only FieldPulse address-quality hits (address-validation.ts:61,144); no dispatch threshold exists
- drizzle/meta/_journal.json - committed journal tops at idx 22 (0022 = HCP user-id column, unrelated); next hand-authored migration is 0023 (untracked 0034/0035 are FieldPulse working-tree files, not journaled)

**Assessment:**

GAP STILL OPEN - independently re-confirmed against current code; the prior plan's reasoning reproduces exactly. Auto-dispatch gates solely on the boolean skillMatched = skillJobsCompleted > 0 (score.ts:45) and drops non-matches (score.ts:72); rankTechnicians takes no threshold (score.ts:69); no org-tunable min-score column, config field, or UI control exists. Line numbers drifted slightly from the prior review (schema 999->1008) but every cited structure is present and matches.

PLAN (file-level, TDD-first):
(1) MIGRATION - hand-author drizzle/0023_dispatch_min_score.sql: ALTER TABLE organization_settings ADD COLUMN dispatch_min_score real; (nullable; NULL = today's behavior). Copy drizzle/meta/0022_snapshot.json -> 0023_snapshot.json adding the column under organization_settings.columns, bump id/prevId, append journal idx 23 (hand-authored-trigger-migration memory). Operator runs npm run db:migrate post-merge. NOTE: bump to 0023 not 0022 - committed journal already has 0022.
(2) SCHEMA - src/lib/db/schema.ts:1008 area: add dispatchMinScore: real(dispatch_min_score) to organizationSettings (verify real imported from drizzle-orm/pg-core).
(3) SCORING - src/lib/ai/dispatch/score.ts: rankTechnicians(candidates, minScore?: number). KEEP the .filter((r) => r.skillMatched) gate (line 72) and ADD a second .filter((r) => r.score >= (minScore ?? 0)). Default 0/undefined = byte-identical. CRITICAL: threshold is ADDITIVE, never a replacement - a zero-skill tech scores 0*0.5 + (3.5/5)*0.3 + 1*0.2 = 0.41, so dropping skillMatched would auto-assign unqualified techs (regression).
(4) CALLER - src/lib/admin/scheduling-queries.ts: extend isAutoDispatchEnabled (725) to also select dispatchMinScore (return {enabled, minScore}); thread minScore through rankedTechnicianOrder (784) into rankTechnicians (812). Tenant scope correct via eq(organizationId) PK (729).
(5) CONFIG TYPES - src/lib/admin/org-config-types.ts: add dispatchMinScore: z.number().min(0).max(1).nullable().optional() to update schema (125, keep .strict()); readonly dispatchMinScore: number | null to OrgConfig (148); dispatchMinScore: null to DEFAULT_ORG_CONFIG (164).
(6) CONFIG QUERIES - src/lib/admin/org-config-queries.ts: map dispatchMinScore: row.dispatchMinScore ?? null (52); patch wiring (90); insert default (112). Single onConflictDoUpdate upsert (114) - neon-http no-transaction rule respected.
(7) UI - src/components/admin/settings/dispatch-panel.tsx:60-66: add number/slider input (0.0-1.0, step 0.05) shown/enabled only when autoDispatchEnabled; copy: higher = stricter.
(8) TESTS (vitest, RED-first) - score.test.ts: (a) threshold filters as configured; (b) undefined/0 minScore preserves existing assertions; (c) a non-skill-matched tech is STILL dropped even when its quality+load score (0.41) exceeds a low threshold (guards the trap). org-config round-trip + partial-update-no-clobber. scheduling-queries.test.ts: ranked order respects org minScore.

VERIFY GATES: npm run typecheck, npm run lint, npm run test:unit, npm run build. No prompt/eval surface, no frozen-safety-text, no money-safety, no metadata.verify touched. Tenant scope preserved (organizationId PK).

**Key risks:**
- Correctness trap: replacing the skillMatched filter with a score threshold auto-assigns UNQUALIFIED techs (zero-skill tech scores 0.41 from quality+load). Threshold MUST be additive to the skill gate, never a replacement.
- Degrade-safety: must default to NULL/0 so opted-in orgs and existing score.test.ts/signals.test.ts see byte-identical behavior; a non-default could strand jobs first-fit would have placed.
- Migration numbering: committed journal tops at idx 22 - new migration must be 0023 (not 0022 as original plan text said). Hand-author snapshot+journal copy per 0021/0022 pattern and run npm run db:migrate post-merge (Vercel skips migrations; insert against missing column 500s).
- Score units: weights sum to 1.0 so score in [0,1]; UI/zod must constrain threshold to 0-1, not an integer, or the slider drops every tech.

**Verifier (minor-corrections):** 
- Plan step 2: `real` is NOT currently imported in src/lib/db/schema.ts. The pg-core import block (lines 1-14) imports doublePrecision (used 2x) but not real. The implementer must ADD `real` to the import OR reuse the already-imported doublePrecision. The plan flagged this as a verify-item, but the import is confirmed absent — the migration's `ADD COLUMN dispatch_min_score real` would also need the column type to match whatever drizzle type is chosen (real vs double precision differ in SQL).
- Plan step 4 is under-specified at the consuming call site. It cites threading minScore into rankTechnicians (812) and extending isAutoDispatchEnabled (725), but does NOT mention: (a) scheduling-queries.ts:854 `const enabled = await isAutoDispatchEnabled(...)` must change to destructure `{enabled, minScore}` (it currently returns a bare boolean); and (b) `rankedTechnicianOrder` (signature at 784) must gain a minScore param to pass it to rankTechnicians at 812. Implied by intent but not enumerated; both are required for the change to compile.

_Notes:_ Independently re-verified all 10 evidence items against current code — every cited line is accurate (score.ts:45/69/72, scheduling-queries.ts:725-732, schema.ts:1008, org-config-types.ts:125/148/164, org-config-queries.ts:52/90-91/112/114). Journal confirmed tops at idx 22 (no 0023; latest snapshot 0022), so the plan's 0023 numbering correction over the prior plan's 0022 is right. grep confirmed only FieldPulse address-quality minScore hits (address-validation.ts:61/144); no dispatch threshold anywhere.\n\nThe central correctness trap is REAL and independently recomputed: a zero-skill tech scores 0*0.5 + (3.5/5)*0.3 + 1*0.2 = 0.41, and score.ts:72's .filter((r)=>r.skillMatched) is the ONLY thing dropping them today. The plan's 'threshold must be ADDITIVE to the skill gate, never a replacement' is the correct and load-bearing guardrail; replacing the filter would auto-assign unqualified techs (a financial/ops regression). keyRisks all hold up: weights sum to 1.0 so score is in [0,1] (UI/zod 0-1 bound is correct), and the NULL-default degrade-safety is sound for byte-identical existing behavior.\n\nClosure decision 'real-gap' is CORRECT: no org-tunable min-score column, config field, query wiring, or UI control exists anywhere. dispatch-panel.tsx (lines 60-66 cited) is confirmed toggle-only. Plan steps 1,3,5,6,7,8 are all feasible against the real code. This is NOT a Stage 5 (no money/security-bypass surface touched); the plan correctly notes no frozen-safety-text, no money-safety, no metadata.verify, tenant scope preserved via organizationId PK. Effort 'M' is reasonable. Two minor plan imprecisions (the absent `real` import and the un-enumerated call-site destructure at line 854) keep this from a clean 'sound' but neither invalidates the gap or the approach.

---

## Stage 15 — Failed-auto-assign reconcile sweep (cron)  _(plan)_

**Verified status:** real-gap  **·  Verify:** sound  **·  Effort:** M

**Evidence:**
- src/app/api/cron/ listing: no reconcile/auto-assign route (only booking-recovery, cleanup, dunning, generate-membership-visits, process-communications, reconcile-payments, sync-fieldpulse-availability, sync-fieldpulse-invoices, sync-housecall-invoices, webhook-cleanup)
- vercel.json:1-49 crons array has NO auto-assign reconcile path
- grep 'reconcile.*auto.assign|reconcileUnassigned' across src/ returns ZERO hits
- src/lib/requests/submit-session-request.ts:313-341 — autoAssignBookedRequest invoked once in after(); on failure only logs 'Auto-assign failed (non-fatal) — soft-held window stands' (line 341), no retry scheduled
- src/lib/admin/scheduling-queries.ts:823-824 docstring: 'Best-effort: returns {assigned:false} when nobody fits, leaving the soft-held window for a dispatcher'
- src/lib/admin/scheduling-queries.ts:725 — 'async function isAutoDispatchEnabled' is module-PRIVATE (no export) — still unexported as of current HEAD
- src/lib/admin/capacity-hold.ts:111-119 arrivalWindowForSlot uses businessWallClockToUtc(day, startHour, 0) — window stored in BUSINESS-TZ (Eastern, DST-aware), NOT UTC-anchored
- src/lib/admin/arrival-window.ts:53-63 arrivalWindowForDate uses setUTCHours (UTC table) — this is NOT the path the live booking uses; WINDOW_HOURS table at lines 20-25
- src/lib/admin/scheduling-queries.ts:827-836 — autoAssignBookedRequest signature requires {start:Date, end:Date, isoDay:string, window:ArrivalWindow}
- src/lib/db/schema.ts:493 autoAssigned boolean default false; :517-518 arrivalWindowStart/End timestamptz; :488 assignedTo nullable
- src/lib/admin/scheduling-queries.ts:760-775 markAutoAssigned UPDATE guards on eq(assignedTo, technicianId) — won't stamp over a human assignment
- src/lib/admin/calendar-time.ts:80-95 toBusinessWallClock returns business-TZ .hour; :156 businessIsoDate returns business-TZ YYYY-MM-DD — correct inversion primitives
- src/app/api/cron/booking-recovery/route.ts:1-59 — verbatim cron template (dynamic/runtime, verifyCronAuth 401, per-org try/catch, successResponse)
- src/lib/cron-auth.ts:28-29 verifyCronAuth fails CLOSED when CRON_SECRET unset

**Assessment:**

GAP CONFIRMED OPEN against current HEAD. No reconcile/auto-assign cron exists; at-booking attempt (submit-session-request.ts:313-341) is a one-shot after() with only a log on failure. The prior plan (results doc 833-850) is structurally sound and the two independent-verifier corrections (859-860) BOTH still apply verbatim to current code — neither has been fixed. I independently reproduced both and add one more.\n\nCONCRETE FILE-LEVEL PLAN:\n\n1) src/lib/admin/arrival-window.ts — add pure helper `windowFromHours(startHour:number, endHour:number): ArrivalWindow | null` that matches BOTH bounds against WINDOW_HOURS (return null on no match so a custom dispatcher window is skipped, not coerced). Unit-testable, single source of truth alongside arrivalWindowHours.\n\n2) src/lib/admin/scheduling-queries.ts — EXPORT isAutoDispatchEnabled (line 725: change `async function` → `export async function`). Required because the new reconcile module gates on it and cannot import an unexported fn (verifier finding #2 — would not compile as written).\n\n3) src/lib/admin/reconcile-auto-assign.ts (NEW) — export `reconcileUnassignedRequests(organizationId): Promise<{considered:number; assigned:number}>`. Tenant-scoped SELECT mirroring listUnscheduledRequests:310-338 but with: inArray(status, ACTIVE_BOOKING_STATUSES), isNull(assignedTo), eq(autoAssigned,false), isNotNull(arrivalWindowStart), isNotNull(arrivalWindowEnd), gt(arrivalWindowEnd, now) [future-only], gte(createdAt, now-48h) [recency bound]. Gate whole sweep on isAutoDispatchEnabled(orgId) per plan's 'respects the opt-in flag' (CONFIRM with user — diverges from live at-booking path which is NOT flag-gated; scheduling-queries.ts:854 only gates SCORING, first-fit runs regardless). For each row: derive window+isoDay the CORRECT way — start=new Date(arrivalWindowStart); window = windowFromHours(toBusinessWallClock(start).hour, toBusinessWallClock(end).hour); isoDay = businessIsoDate(start). DO NOT use getUTCHours() (verifier finding #1 — windows are stored Eastern-wall-clock via businessWallClockToUtc, so a summer 'morning' is 12:00Z and getUTCHours()→12 would mislabel it 'afternoon'; DST makes the offset vary 4h/5h so no fixed UTC mapping exists). DO NOT use toISOString().slice(0,10) for isoDay (a late-evening Eastern window crosses into the next UTC day). If window===null, skip+log (don't guess). Call existing autoAssignBookedRequest(orgId, id, {start, end, isoDay, window}); wrap each row in try/catch so one bad row never aborts the org. Tally considered/assigned.\n\n4) src/app/api/cron/reconcile-auto-assign/route.ts (NEW) — copy booking-recovery/route.ts:1-59 structure verbatim: dynamic='force-dynamic', runtime='nodejs', GET gated by verifyCronAuth→401, loop db.select({id}).from(organizations) with per-org try/catch failure isolation, successResponse({orgs, considered, assigned}). Use dynamic import('@/lib/admin/reconcile-auto-assign') to keep the enum/status chain off module-load (mirrors submit-session-request.ts:319).\n\n5) vercel.json — add {path:'/api/cron/reconcile-auto-assign', schedule:'0 13 * * *'} (low-frequency; at-booking after() handles the common case). CONFIRM cadence.\n\n6) src/lib/admin/reconcile-auto-assign.test.ts (NEW) — reuse hoisted db-mock harness from scheduling-queries.test.ts:1-55 (selectQueue/whereCalls proxy). Required test (plan): previously-unassignable soft-held row now placed when a free qualified tech exists. Plus: window reconstruction of a SUMMER 'morning' (start=2026-07-01T12:00:00Z,end=16:00:00Z) → 'morning' NOT 'afternoon' (regression-guards verifier finding #1); custom/unmatched window → skipped not crashed; WHERE includes isNull(assignedTo) + tenant scope; opt-in gate honored. Optionally add windowFromHours unit tests in arrival-window.test.ts.\n\nINVARIANTS: dispatch-only — no frozen-safety-text (hvac-knowledge.ts), money-safety, or metadata.verify surfaces touched. neon-http: no db.transaction (reuses autoAssignBookedRequest's existing sequential single-statement writes; db.batch not needed). withTenant on every query; org loop bounds each call. Next.js 16: cron GET takes Request, no Promise params. No migration needed (reuses existing columns).\n\nVERIFY GATES: npm run tsc; npm run lint; npm run test:unit (new test + existing scheduling-queries suite green); npm run build. No prompt edits → no eval.

**Key risks:**
- Window reconstruction (CENTRAL FLAW in original plan, still unfixed): windows are stored Eastern wall-clock via businessWallClockToUtc (capacity-hold.ts:111-119), so the plan's getUTCHours()-vs-WINDOW_HOURS match mislabels every window and DST varies the offset 4h/5h. MUST invert via toBusinessWallClock().hour + businessIsoDate, never getUTCHours/toISOString.slice.
- isAutoDispatchEnabled is module-private (scheduling-queries.ts:725) — must add export or the reconcile module won't compile.
- Opt-in semantics mismatch: live at-booking path is NOT gated on auto_dispatch_enabled (first-fit runs regardless; line 854 only gates scoring). Gating the sweep on the flag makes it a no-op for orgs that never opted in; not gating diverges from plan wording. NEEDS USER CONFIRMATION.
- Idempotency/race: dispatcher may manually assign between the sweep SELECT and placeAndAssignRequest. Safe because markAutoAssigned (760-775) guards on assignedTo and placeAndAssignRequest re-checks conflicts on the live row — rely on that, never on the stale sweep snapshot.
- Unbounded scope: without future-window (gt(arrivalWindowEnd, now)) + createdAt lookback, the sweep would reprocess every historical unassigned soft-held row each run and could place a tech on a past window.

**Verifier (sound):** 
- Minor citation drift, not substantive: assessment cites submit-session-request.ts:313-341 for the at-booking after() block. Verified: the `if (heldSlot)` is at line 313, the after() at 314, and the failure-log 'Auto-assign failed (non-fatal) - soft-held window stands' at 341. Accurate. The success-path 'left soft-held for dispatcher' info log is at 332-337. No correction needed beyond noting line precision is exact.
- Assessment evidence line for arrival-window.ts says 'arrivalWindowForDate uses setUTCHours (UTC table)' at :53-63 with WINDOW_HOURS at :20-25. Verified exact: setUTCHours at lines 59 and 61, WINDOW_HOURS at 20-25. The crucial nuance (correctly captured in the plan) is that arrivalWindowForDate is DEAD for the live booking path - the live path is arrivalWindowForSlot (capacity-hold.ts:111-119) -> businessWallClockToUtc. Confirmed via submit-session-request.ts:92 calling arrivalWindowForSlot. The window-reconstruction concern is therefore real and central.

_Notes:_ Independently verified every load-bearing claim against current HEAD; the assessment holds up.

STATUS (real-gap): CONFIRMED. No reconcile/auto-assign cron exists (cron dir listing and vercel.json:1-44 both confirm - the 10 crons are exactly as cited, no auto-assign path). grep for reconcile.*auto.assign/reconcileUnassigned/windowFromHours returns zero. The only auto-assign trigger is the one-shot after() in submit-session-request.ts:314-344, which on failure only logs (341) with no retry/reconcile. Gap is genuinely open.

KEY TECHNICAL FINDINGS - both verifier corrections independently reproduced:
1) WINDOW RECONSTRUCTION (central flaw): CONFIRMED. Live booking stores windows via arrivalWindowForSlot (submit-session-request.ts:92) -> capacity-hold.ts:117-118 businessWallClockToUtc(day, startHour, 0), i.e. Eastern wall-clock anchored, NOT UTC. capacity-hold.ts:100-106 docstring explicitly says 'band hours read as BUSINESS-timezone (Eastern)... DST-correct'. The worked example checks out: summer morning 8-12 ET (EDT=UTC-4) -> 12:00Z-16:00Z; getUTCHours(12:00Z)=12 maps to WINDOW_HOURS afternoon[12,16] -> mislabel. Must invert via toBusinessWallClock().hour (calendar-time.ts:80-95) + businessIsoDate (156-161). Both primitives exist and are correct inversions. DST varies offset 4h/5h so no fixed UTC mapping - accurate.
2) isAutoDispatchEnabled module-private: CONFIRMED. scheduling-queries.ts:725 is `async function isAutoDispatchEnabled` with no export keyword. Plan step 2 (add export) is necessary and would otherwise not compile - correct.

OPT-IN SEMANTICS keyRisk: CONFIRMED ACCURATE. autoAssignBookedRequest builds firstFit unconditionally (853), calls isAutoDispatchEnabled only to decide whether to use rankedTechnicianOrder (854-857); first-fit (DB order) runs regardless of the flag (858-860). So gating the sweep on the flag genuinely diverges from the live at-booking path. The plan correctly marks this CONFIRM-with-user rather than silently choosing.

IDEMPOTENCY/RACE keyRisk: CONFIRMED. markAutoAssigned (763-775) guards UPDATE on eq(assignedTo, technicianId) via withTenant; autoAssignBookedRequest loops placeAndAssignRequest (864-869) which re-checks conflicts on the live row. Safe to rely on, as stated.

PLAN FEASIBILITY: All referenced files/functions/columns exist. Schema columns confirmed: autoAssigned bool default false (schema.ts:493), arrivalWindowStart/End timestamptz (517-518), assignedTo nullable (488). ACTIVE_BOOKING_STATUSES exists (52-58). listUnscheduledRequests (310-338) is a valid mirror template - note it uses UNSCHEDULED_STATUSES + an OR(isNull assignedTo, isNull arrivalWindowStart), whereas the plan correctly specifies a tighter predicate (isNotNull window + isNull assignedTo + autoAssigned=false + future + recency); the plan's WHERE is the right one for a 'soft-held but untech'd' reconcile and does not blindly copy the looser list. autoAssignBookedRequest signature {start,end,isoDay,window:ArrivalWindow} matches (827-836). Cron template booking-recovery/route.ts:1-59 is verbatim usable (dynamic/runtime, verifyCronAuth->401, per-org try/catch, successResponse). cron-auth.ts:28-37 fails closed when CRON_SECRET unset (30-32). Test harness scheduling-queries.test.ts uses vi.hoisted selectQueue/whereCalls mock (lines 9-54) - reusable as claimed.

INVARIANTS check out: dispatch-only (no frozen-safety/money/metadata.verify surfaces); reuses autoAssignBookedRequest's existing sequential single-statement writes so no db.transaction (respects neon-http constraint); withTenant present on the queries it mirrors; no migration needed (reuses existing columns). Dynamic import pattern (submit-session-request.ts:319) is a real, mirror-able precedent.

Effort M is reasonable: 1 new module + 1 route + vercel.json line + 1 export change + tests.

The only items needing user input are correctly surfaced as CONFIRM (opt-in gating semantics, cron cadence) - not defects in the plan. No compile-blockers, no invariant violations, no missed financial/security bypass (this is dispatch-only, no money/auth surface). Recommend proceeding as planned.

---

## Stage 16 — Real-time availability (PTO / sick / live load)  _(plan)_

**Verified status:** real-gap  **·  Verify:** minor-corrections  **·  Effort:** M

**Evidence:**
- src/lib/db/schema.ts:1052,1062 — technician_availability is 'recurring weekly working hours per technician' only; no technician_time_off table/column exists (grep confirms)
- grep -rniE 'time.?off|pto|sick|vacation|on.?leave|timeOff' across src/lib+src/app (non-test) returns ZERO real hits — only string literals (conversation-style.ts:143 'sick of this', seed-demo.ts:784 comment)
- drizzle/meta/_journal.json now tops out at idx 22 'aberrant_carmella_unuscione'; drizzle/0022_aberrant_carmella_unuscione.sql is HCP user mapping (ALTER users ADD housecall_pro_user_id) — unrelated to PTO. Next free migration is 0023
- src/lib/admin/scheduling-queries.ts:621-638 — gate inside if(!options.override && targetTech) checks only checkScheduleConflict (621) + isWindowWithinAvailability (629); reject is detail:{conflicts, outsideAvailability:!within} (638). An off tech with no overlap + matching weekly hours STILL passes
- src/lib/admin/scheduling-queries.ts:844 — autoAssignBookedRequest pulls candidates by and(eq(role,'technician'),eq(isActive,true)) only; nothing excludes a tech off that day
- src/lib/admin/scheduling-queries.ts:891 — try-next loop continues when reason==='conflict'||'technician_not_found', breaks otherwise (confirms plan's 'keep reason:conflict' makes off-tech skip work)
- src/lib/ai/dispatch/signals.ts:160 sameDayJobCount counts assigned jobs only; score.ts:35,49 LOAD_CAP=6 is the entire live-load signal — no PTO/sick input
- src/lib/admin/queries.ts:807 getTechnicians (board source) has no isoDay/offToday param; consumed at 1121,1211 with no time-off filter — off tech still renders bookable
- src/app/api/admin/requests/[id]/reschedule/route.ts:134-136,166-168 — sole ScheduleConflictDetail consumer reads only outsideAvailability/conflicts → adding onTimeOff is additive-safe
- src/lib/integrations/fieldpulse/availability-mapping.ts + availability-sync.ts — zero pto/sick/time-off hits; the recent FieldPulse availability work is an orthogonal weekly-hours mirror, does NOT close this gap
- Plan anchors all exist at HEAD: options.isoDay (scheduling-queries.ts:558), heldSlot.isoDay (856,868), ScheduleConflictDetail (485-487), withTenant (tenant.ts:19), businessWeekday/businessWallClockToUtc (availability-coverage.ts:31-32), TechnicianRecord (types.ts:79)

**Assessment:**

GAP CONFIRMED OPEN against HEAD. No PTO/sick/time-off model exists anywhere; the conflict gate, auto-assign candidate set, load signal, and board are all PTO-blind. The session-start git-status snapshot in my prompt (showing 0034/0035 + many ?? files) is STALE — actual tree tops out at migration 0022 (HCP user mapping), and the FieldPulse availability-sync files are already git-tracked and orthogonal (weekly-hours only). The Stage-16 acceptance test ('a tech on PTO is excluded from auto-assign and the board') does not exist.

The prior plan (results doc 884-924) is SOUND and still accurate. Minor corrections only:

1) LINE DRIFT (substance intact): plan cites gate 'line 618 block' / override 'line ~688' / autoAssign 'line 837' — current HEAD: gate 621-638, override recompute 687-703, autoAssignBookedRequest 827 (candidate query 844). Plan's 'drizzle/0022_technician_time_off.sql / append idx 22' is now WRONG — 0022 is taken by HCP mapping; the new migration must be 0023 (append journal idx 23, copy 0022_snapshot.json→0023_snapshot.json). This is the one materially stale instruction.

2) INTERFACE EDIT (already flagged by verifier 927): onTimeOff is not a free 'sibling' — ScheduleConflictDetail is an exported interface (485-487); add onTimeOff there (make it optional/defaulted so the override audit path and reschedule route stay compatible).

3) The exclusion-only interpretation of 'live load' (candidate pre-filter, not mutating sameDayJobCount) is correct and sufficient for the verify gate; score.ts:18,49 type would otherwise need a new field. Confirm exclusion-only is acceptable (noted in plan keyRisks).

INVARIANTS: no frozen-safety-text (hvac-knowledge.ts) touched; no money-safety path; no metadata.verify path; dispatch-only reads + one additive interface field + reuse of existing sequential write path. Tenant scope via withTenant(technicianTimeOff, orgId) throughout. neon-http: all single/batched-IN reads; any multi-write CRUD uses db.batch (no db.transaction). Degrade-safety: wrap the auto-assign pre-filter so a probe error logs and falls back to NOT-filtering (never strand a placeable job); the per-tech gate reject still protects the manual path. Next.js 16: time-off CRUD route params is a Promise (await params).

PROCEED with the prior plan as written, with the migration number corrected to 0023 and the ScheduleConflictDetail interface edit made explicit.

**Key risks:**
- isoDay/TZ: time-off dates and scheduling isoDay are both business-TZ calendar dates → compare as date strings; store endsOn INCLUSIVE; reuse businessWeekday/businessWallClockToUtc (availability-coverage.ts:31) to avoid a DST/off-by-one on the last PTO day
- Migration must be 0023 (0022 is now HCP user mapping); journal idx 23 + 0022_snapshot.json→0023_snapshot.json hand-authored dance; Vercel skips migrations → run npm run db:migrate post-merge or new reads 500 on schema drift
- Override path (scheduling-queries.ts:687-703) must recompute time-off for audit symmetry, else an overridden assignment onto an off tech is silently un-audited
- getTechnicians (queries.ts:807) is consumed at 1121,1211 — the new isoDay param must be OPTIONAL with offToday defaulting false, or those callers break
- ScheduleConflictDetail (485-487) is an exported interface — add onTimeOff as optional/defaulted, not an untyped sibling; sole consumer (reschedule route 134-136) only reads outsideAvailability/conflicts so it stays safe
- Auto-assign pre-filter degrade-safety: a time-off probe error must fall back to NOT-filtering (never strand a job the old path would place); gate reject remains the manual-path backstop

**Verifier (minor-corrections):** 
- ANCHOR PATH WRONG: assessment says 'withTenant (tenant.ts:19)' — the function is actually defined at src/lib/db/tenant.ts:19 (imported in scheduling-queries.ts:31 as '@/lib/db/tenant'). There is no src/lib/admin/tenant.ts. Line number 19 is correct; only the implied path is mislabeled. Harmless — function exists and is the right tenant primitive.
- ANCHOR CONFLATION: assessment lists 'businessWeekday/businessWallClockToUtc (availability-coverage.ts:31-32)'. businessWeekday IS defined at availability-coverage.ts:31, but businessWallClockToUtc is NOT defined there — it lives in src/lib/admin/calendar-time.ts:129 and is re-imported into availability-coverage.ts:22. Both helpers exist and are exported/reusable as the plan intends; only the location label for businessWallClockToUtc is off.
- MIGRATION NUMBER (already self-corrected in the assessment, restating for the record): the prior plan's 'drizzle/0022_technician_time_off.sql / append journal idx 22' is STALE — 0022 is now 0022_aberrant_carmella_unuscione (ALTER users ADD housecall_pro_user_id, HCP user mapping). The new migration MUST be 0023 (journal idx 23, copy 0022_snapshot.json→0023_snapshot.json). Verified: drizzle tops out at 0022; no 0023+ exists.

_Notes:_ GAP CONFIRMED OPEN against HEAD (e01a284). I independently re-derived the status and verified every cited anchor. No PTO/sick/time-off model exists anywhere: grep for time.?off|pto|sick|vacation|leave across src/lib+src/app non-test returns only false positives ('crypto' via the pto alternation, 'symptom'/'sick of this' string literals — conversation-style.ts:143 confirmed). technician_availability (schema.ts:1062) is recurring weekly working hours only; no technician_time_off table/column.

VERIFIED PARITY-BLIND PATHS: (1) per-tech gate scheduling-queries.ts:620-641 — checks only checkScheduleConflict(621)+isWindowWithinAvailability(629); reject detail {conflicts, outsideAvailability:!within} at 638; an off tech with no overlap + matching weekly hours passes. (2) override recompute 686-705 (ScheduleConflictDetail at 687/703). (3) autoAssignBookedRequest candidate query 837-846, exactly and(eq(role,'technician'),eq(isActive,true)) at 844 — nothing excludes an off tech; try-next loop continues on reason==='conflict'||'technician_not_found' (891), so a reason:'conflict' off-tech skip would work as the plan assumes. (4) live-load signal: signals.ts:160 sameDayJobCount counts assigned jobs only; score.ts:35,49 LOAD_CAP=6 is the whole live-load input — no PTO. (5) board source getTechnicians (queries.ts:807) takes no isoDay/offToday param, returns all technicians, consumed at 1121 (dispatch board) + 1211 (calendar) with no time-off filter.

ADDITIVE-SAFETY VERIFIED: ScheduleConflictDetail is an EXPORTED interface (485-488: conflicts + outsideAvailability) — adding onTimeOff must be optional/defaulted, as the assessment flags. Sole consumer reschedule route reads only outsideAvailability/conflicts/overriddenConflicts (134-136, 166-168), so the addition is safe. reschedule route uses params: Promise (Next.js 16 await params at 67) — consistent with the plan's note.

ORTHOGONALITY VERIFIED: FieldPulse availability-sync.ts + availability-mapping.ts are git-tracked (git ls-files) with ZERO pto/sick/time-off hits; availability-mapping.ts maps FP bookable windows into the recurring weekly AvailabilitySlot shape — a positive-availability mirror that does NOT model absence. Gap stays open.

STALE-SNAPSHOT VERIFIED: the session-start git-status (0034/0035 + many ?? fieldpulse files) does NOT match the actual tree — drizzle tops at 0022, those ?? files do not exist. The assessment correctly flags this.

CLOSURE DECISION CORRECT: real-gap, PROCEED with prior plan as written + migration→0023 + explicit ScheduleConflictDetail optional onTimeOff. Exclusion-only 'live load' (candidate pre-filter, not mutating sameDayJobCount/score.ts type) is sufficient for the verify gate and avoids touching the score.ts tech type (18-19). Degrade-safety (probe error → fall back to NOT-filtering so a placeable job is never stranded; per-tech gate reject remains manual-path backstop) is the right safety posture. Effort M is reasonable. No security/financial-bypass concern: dispatch-only reads + one additive interface field + reuse of the existing sequential write path; no frozen-safety-text, money-safety, or metadata.verify path touched. neon-http note holds (single/batched-IN reads; any multi-write CRUD must use db.batch, not db.transaction). The two anchor mislabels above are cosmetic and do not affect feasibility.

---

## Stage 17 — Technician push notification (tech_assigned)  _(plan)_

**Verified status:** real-gap  **·  Verify:** minor-corrections  **·  Effort:** M

**Evidence:**
- src/lib/db/schema.ts:1556-1577 — communicationTriggerTypeEnum last member is 'warranty_expiring'; NO 'tech_assigned'
- src/lib/db/schema.ts:258-291 — users table has fieldpulseUserId/housecallProUserId/laborRateCents but NO phone column
- src/lib/db/schema.ts:1652-1719 — communication_jobs has no idempotency_key column; indexes are org_id / status_scheduled(partial) / service_request / customer / external_id only
- src/lib/communication/consent.ts:130-132 — checkSendAllowed returns {allowed:true} early when customerId is null (tech send bypasses customer consent)
- src/lib/communication/consent.ts:46-68,161-162 — TRIGGER_RULES is Record<CommTrigger,TriggerRule>; line 161 reads TRIGGER_RULES[triggerType] then rule.toggle, so a new enum value WITHOUT a rule entry is both a tsc exhaustiveness error and a runtime crash; escalation:57 = {toggle:null,quietHours:false} is the mirror
- src/lib/admin/scheduling-queries.ts:870-886 — success path (result.ok -> markAutoAssigned -> optional decision log -> return) has NO notification enqueue
- src/lib/admin/scheduling-queries.ts:763-775 — markAutoAssigned IS tenant+assignee guarded (withTenant + eq(assignedTo,technicianId)); NOT an idempotency guard against re-notification, so an idempotency key is still needed (corrects the original 'no guard' wording)
- src/lib/requests/submit-session-request.ts:314-322 — autoAssignBookedRequest invoked inside after() via dynamic import; confirms the background entry point
- src/lib/communication/job-queue.ts:26-58 — queueCommunicationJob accepts plaintext recipientPhone (encrypts at :49 to recipientPhoneEncrypted), customerId optional, triggerType as string; NO idempotencyKey param and NO onConflict/23505 handling
- src/lib/communication/triggers.ts:351-393 — triggerTechnicianEnroute is the exact mirror (findFirst active sms template, `if (smsTemplate && phone)` degrade-safe guard, queueCommunicationJob); no triggerTechAssigned exists
- src/lib/communication/seeds.ts:15-23 — defaultTemplates array shape {key, triggerType, templateType:'sms' as const, bodyTemplate}; step-5 seed is feasible (full path confirmed)
- grep tech_assigned/techAssigned/notifyTech/triggerTechAssigned across src/ + drizzle/ returns ZERO hits — feature absent
- drizzle/meta/_journal.json — last tag is 0022_aberrant_carmella_unuscione (added users.housecall_pro_user_id); STALENESS: plan says 'next is 0022' but 0022 now exists, so the new hand-authored migration must be 0023

**Assessment:**

CLOSURE/STATUS RE-CONFIRMED: gap is genuinely OPEN. Re-verified every cited line against current code (code has advanced — 0022 migration now exists). No tech-facing notification exists anywhere: no 'tech_assigned' enum member (schema.ts:1556-1577), no users.phone (258-291), no idempotency column on communication_jobs (1652-1719), no enqueue on the auto-assign success path (scheduling-queries.ts:870-886), and zero grep hits for the feature.

The plan (results doc lines 972-1009) is feasible and respects all codebase invariants (tenant scoping via withTenant, neon-http no-interactive-txn, after() already isolating the caller, degrade-safe try/catch, no frozen-safety-text/money/metadata.verify surfaces touched). Reuse seam is real: triggerTechnicianEnroute (triggers.ts:351-393) is a clean mirror with the idiomatic `if (smsTemplate && phone)` degrade guard; queueCommunicationJob already encrypts plaintext phone and accepts null customerId; consent.ts:130-132 already lets a customerId=null tech job bypass customer consent at the send gate.

ONE CORRECTION TO THE PLAN (both Stage 17 and 18 share it): migration numbering is stale. The plan targets drizzle/0022_*; 0022_aberrant_carmella_unuscione already exists, so the new hand-authored migration must be 0023 (snapshot copied from 0022_snapshot.json, journal idx 23). The verifier's earlier minor-corrections (markAutoAssigned 'no guard' wording inaccurate; recipientPhone vs recipientPhoneEncrypted; seeds.ts full path) are all valid and already absorbed above.

CONCRETE FILE-LEVEL PLAN (updated numbering):
1. drizzle/0023_tech_assigned_notification.sql (hand-authored): ALTER TABLE users ADD COLUMN phone text; ALTER TYPE communication_trigger_type ADD VALUE 'tech_assigned'; ALTER TABLE communication_jobs ADD COLUMN idempotency_key text; CREATE UNIQUE INDEX communication_jobs_org_idempotency_unique ON communication_jobs(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL. Copy meta/0022_snapshot.json -> 0023_snapshot.json with the three changes; append journal idx 23. Operator runs npm run db:migrate (Vercel skips migrations — enum value MUST land in prod before code references it or inserts 500 on the cast).
2. schema.ts: add phone:text('phone') to users (~287); add 'tech_assigned' to enum (~1577); add idempotencyKey:text('idempotency_key') + partial uniqueIndex to communicationJobs (~1719).
3. job-queue.ts: add optional idempotencyKey?:string param + .values(); wrap insert and swallow 23505 as already-enqueued (no-op). Keep customerId optional.
4. consent.ts: add tech_assigned:{toggle:null,quietHours:false} to TRIGGER_RULES (mirrors escalation:57; satisfies tsc exhaustiveness and stays un-suppressed).
5. seeds.ts: add defaultTemplates entry key:'tech_assigned_sms', triggerType:'tech_assigned', templateType:'sms' as const, bodyTemplate with serviceType/date/time/address/referenceNumber vars.
6. NEW triggers.ts: triggerTechAssigned({organizationId, technicianId, technicianName, serviceRequestId, ...vars}) — findFirst active tech_assigned sms template; tenant-scoped read of users.phone; if no template OR no phone -> return (degrade-safe, no throw); else queueCommunicationJob({recipientPhone:tech.phone, customerId:undefined, triggerType:'tech_assigned', idempotencyKey:`tech_assigned:${serviceRequestId}:${technicianId}`}).
7. scheduling-queries.ts:871 — after markAutoAssigned, try/catch+log-only enqueue (caller already in after()); fetch referenceNumber/window vars from the request row in scope.

TESTS (vitest TDD): consent.test.ts — tech_assigned + null customerId -> allowed:true. job-queue — second insert same idempotencyKey -> single row / 23505 swallowed. scheduling-queries.test.ts (existing autoAssign suite) — successful assign -> exactly one tech_assigned job; null-phone tech -> zero jobs; double auto-assign -> still one (mock the triggers module to avoid live DB). triggers test — missing template -> no enqueue, no throw.
VERIFY GATES: npx tsc --noEmit; npm run lint; npm run test:unit; npm run build. No prompt/eval surfaces touched.

**Key risks:**
- Postgres ALTER TYPE ... ADD VALUE cannot run in a txn block and the value isn't usable in the same txn it's added — keep it a standalone statement; CRITICAL: Vercel skips migrations, so the enum value MUST exist in prod (operator runs npm run db:migrate) before any code that casts/inserts 'tech_assigned' deploys, or every insert 500s on the enum cast
- Migration number staleness: plan says 0022 but 0022 already exists (added users.housecall_pro_user_id); use 0023 + copy 0022_snapshot.json. Same off-by-one affects the Stage 18 plan
- Idempotency key (serviceRequestId, technicianId) silently suppresses a legitimate manual reassign-back-to-same-tech later — acceptable for auto-assign-once; add a nonce/timestamp component if future manual reassign should re-notify
- users.phone as plaintext PII breaks the encrypt+blind-index convention used for customer.phone — a deliberate consistency call (plaintext = simpler staff-internal; encrypted = matches at-rest convention, needs decrypt at send)
- Enqueue must stay strictly degrade-safe inside autoAssignBookedRequest's success path — wrap in try/catch, log-only; a comms failure must never block or roll back the assignment (caller's after() isolates the request turn)
- consent bypass relies on customerId=null at consent.ts:130 — a future caller passing a customerId for a tech job would route through customer consent; document that tech jobs MUST omit customerId

**Verifier (minor-corrections):** 
- PLAN step 5 (seeds.ts) under-specifies the defaultTemplates entry. The insert loop at seeds.ts:278-290 reads template.name/description/variables/priority, and communicationTemplates.name is .notNull() (schema.ts:1613). A literal entry of only {key, triggerType, templateType:'sms', bodyTemplate} would insert name=undefined and 500 on the NOT NULL constraint. The new entry MUST also include name, description, variables, and priority (mirror the existing entries, e.g. seeds.ts:16-35).
- PLAN step 6 omits templateId in the queueCommunicationJob argument list. queueCommunicationJob requires templateId (job-queue.ts:28, non-optional) and communicationJobs.templateId is .notNull(). The mirror triggerTechnicianEnroute passes templateId: smsTemplate.id (triggers.ts:375). The prose 'findFirst active template' implies it, so this is a wording/completeness nit, not a feasibility blocker.

_Notes:_ Independently re-derived: status real-gap is CORRECT and the gap is genuinely OPEN. Verified every cited line against current code. Enum (schema.ts:1556-1577) ends at 'warranty_expiring' with NO 'tech_assigned'. users table (258-291) has fieldpulseUserId/housecallProUserId/laborRateCents but NO phone column. communicationJobs (1652-1721) has org/status_scheduled(partial)/service_request/customer/external_id indexes and NO idempotency_key. consent.ts:130-132 returns {allowed:true} when customerId is null (tech-send bypass is real and intentional per the doc-comment at 114-118). CommTrigger is derived from the enum (consent.ts:23), so adding a member forces TRIGGER_RULES exhaustiveness at tsc AND a runtime crash if the rule entry is missing (rule.toggle read at 161-162); escalation:57={toggle:null,quietHours:false} is the exact mirror. scheduling-queries.ts:870-886 success path (markAutoAssigned -> optional decision log -> return) has NO enqueue; markAutoAssigned (763-776) is tenant+assignee guarded (NOT a re-notification idempotency guard) — the 'corrects the no-guard wording' note is accurate. triggers.ts:351-393 triggerTechnicianEnroute is a clean mirror with the `if (smsTemplate && params.customerPhone)` degrade guard. submit-session-request.ts:313-322 confirms autoAssignBookedRequest runs inside after() via dynamic import. job-queue.ts:26-58 takes plaintext recipientPhone (encrypts at :49), customerId optional, triggerType as string, NO idempotencyKey/onConflict. grep for tech_assigned/techAssigned/notifyTech/triggerTechAssigned across src/ + drizzle/ returns ZERO hits.\n\nMigration staleness correction VERIFIED CORRECT: _journal.json last tag is 0022_aberrant_carmella_unuscione (idx 22); new hand-authored migration must be 0023. ALTER TYPE ... ADD VALUE approach has direct precedent in drizzle/0001_money_loop_triggers.sql (adds estimate_sent/payment_receipt/invoice_overdue to communication_trigger_type via standalone statements with --> statement-breakpoint). The Vercel-skips-migrations risk is consistent with project memory.\n\nKey risks are all sound. consent bypass-via-null-customerId, plaintext-PII-vs-encrypt-convention tradeoff, degrade-safe enqueue requirement, and idempotency-key-suppresses-reassign caveat are all legitimate. Effort M is reasonable. The two corrections above are minor plan-completeness nits (both already demonstrated correctly by the existing triggerTechnicianEnroute mirror) and do not change the gap status or overall feasibility.

---

## Stage 18 — Customer "your technician is X" messaging  _(plan)_

**Verified status:** real-gap  **·  Verify:** sound  **·  Effort:** M

**Evidence:**
- src/lib/db/schema.ts:1556-1577 — communicationTriggerTypeEnum lists 15 values ending in 'warranty_expiring'; NO 'technician_assigned'/'technician_*assigned' value exists (technician_enroute:1562, technician_arrived:1563, job_completed:1564 are the only tech-lifecycle values)
- grep -rn 'technician_assigned|tech_assigned|your technician|triggerTechnicianAssigned' src/ drizzle/ returns ONLY src/lib/ai/knowledge-base-coverage.test.ts:55 ('are your technicians background checked?') — no enum value, template, trigger fn, consent rule, or enqueue anywhere in production code
- src/lib/communication/consent.ts:46-68 — TRIGGER_RULES: Record<CommTrigger, TriggerRule> has no assignment entry; consent.ts reads TRIGGER_RULES[triggerType].toggle, so a new enum value with no entry would be a build error (exhaustive Record) and, if forced, a runtime crash — the entry is mandatory
- src/lib/communication/triggers.ts:351-393 triggerTechnicianEnroute is the correct mirror (findFirst active sms template -> guard on template+customerPhone -> queueCommunicationJob priority 70, customerId+serviceRequestId); only triggerAppointmentScheduled/Rescheduled/Cancelled/TechnicianEnroute/JobCompleted exist — no triggerTechnicianAssigned (grep of 'export async function' confirms)
- src/lib/admin/queries.ts:378-476 assignTechnician — CONFIRMED manual assignment: guarded UPDATE pending/scheduled->assigned, withTenant-scoped, returns assignedToName=tech.name + customerName but NOT phone/serviceType/scheduledDate (those columns ARE on the returned `updated` row: customerPhoneEncrypted/issueType/scheduledDate, so step-6's extra read can be a return-shape extension rather than a second query); reassignTechnician at :497
- src/app/api/admin/requests/[id]/assign/route.ts:62 POST -> assignTechnician (confirmed path to wire); :145 PATCH -> reassignTechnician — POST-only wiring recommendation holds
- src/lib/admin/scheduling-queries.ts:825-827 autoAssignBookedRequest runs in after() as PROVISIONAL auto-assign — correctly flagged do-NOT-message
- drizzle/ latest on disk is 0022_aberrant_carmella_unuscione.sql (journal idx 22, meta/_journal.json) but it only adds users.housecall_pro_user_id — UNRELATED to the enum; next free migration is now 0023 (NOT 0022 as the prior plan stated — numbering has advanced since the first review)

**Assessment:**

CLOSURE/STATUS RE-CONFIRMED: gap is genuinely still OPEN. No enum value, template, trigger fn, consent rule, or enqueue for a customer "your technician is X" message exists in production code (only a knowledge-base test string matches the grep). The prior real-gap verdict holds against current code.

The prior plan (results doc lines 1058-1082) is correct and remains feasible, with ONE numbering correction: a 0022 migration has landed since the first review (HCP user-id, unrelated), so the new migration is 0023, journal idx 23 — NOT 0022. Otherwise every cited file:line still resolves exactly.

Concrete file-level plan (TDD, neon-http no-tx, withTenant, Next 16 Promise params, after() for background):

1. MIGRATION (hand-authored) drizzle/0023_tech_assigned_customer_msg.sql: `ALTER TYPE "public"."communication_trigger_type" ADD VALUE 'technician_assigned';` — standalone, no table DDL (ADD VALUE can't run in a tx; neon-http auto-commits each stmt). Append journal idx 23 to drizzle/meta/_journal.json and create drizzle/meta/0023_snapshot.json by copying 0022's and adding 'technician_assigned' to the communication_trigger_type values array. Operator runs `npm run db:migrate` (MEMORY: Vercel build skips migrations; absent value -> inserts referencing it 500).

2. SCHEMA src/lib/db/schema.ts:1564 — add `"technician_assigned",` to communicationTriggerTypeEnum grouped with the technician_* values. Propagates to CommTrigger type.

3. CONSENT RULE (mandatory, tsc-enforced) src/lib/communication/consent.ts:53 — add `technician_assigned: { toggle: "automatedConfirmations", quietHours: false },` next to technician_enroute. Transactional (customer waiting to know who's coming), quiet-hours-exempt, gated by automatedConfirmations.

4. TEMPLATE SEED src/lib/communication/seeds.ts — add defaultTemplates entry key `technician_assigned_sms`, triggerType `technician_assigned`, templateType `sms`, an SMS body naming {{technicianName}}/{{serviceType}}/{{appointmentDate}}, priority ~50. Backfill existing tenants by calling seedCommunicationTemplates(orgId) per org (per-key idempotent) — NOT seedAllOrganizationTemplates (skips any org with ANY existing template). Provisioning of new orgs already calls seedCommunicationTemplates (src/lib/admin/provisioning.ts:290).

5. TRIGGER FN src/lib/communication/triggers.ts — add triggerTechnicianAssigned mirroring triggerTechnicianEnroute (lines 351-393): findFirst active sms template for trigger 'technician_assigned', guard on template+customerPhone, queueCommunicationJob(triggerType:'technician_assigned', channel:'sms', priority ~60, customerId, serviceRequestId). Do NOT re-implement consent — enforced at send time via TRIGGER_RULES.

6. WIRE THE CONFIRMED PATH ONLY — in src/app/api/admin/requests/[id]/assign/route.ts after a successful POST assignTechnician (line 62-97), enqueue via Next after() (NOT a detached promise; Vercel freeze). Source the decrypted phone + serviceType + scheduledDate either by extending assignTechnician's return (the columns are already on the `updated` row at queries.ts:469-473) or a small follow-up org-scoped select. Do NOT wire PATCH/reassignTechnician (double-notify on every reassign) and do NOT wire autoAssignBookedRequest (provisional).

7. TESTS (vitest) — triggers.test.ts: confirmed assignment + active template + consenting customer -> exactly ONE pending technician_assigned sms job (assert customerId/serviceRequestId/triggerType); degrade-safe: no template -> zero jobs, no throw. consent.test.ts: technician_assigned with automatedConfirmations=false -> not allowed; do_not_contact -> not allowed; quiet hours ignored (exempt).

VERIFY GATES: npm run lint; tsc --noEmit (catches the missing TRIGGER_RULES entry via exhaustive Record<CommTrigger>); npm run test:unit (consent+triggers; isolate from live DB per MEMORY vitest-env-known-failures); npm run build. No hvac-knowledge.ts/prompt change -> frozen-safety-text invariant untouched, no eval needed. metadata.verify path untouched. neon-http: single inserts (no db.transaction); use db.batch only if batching.

**Key risks:**
- tsc gate is load-bearing: a missing TRIGGER_RULES[technician_assigned] entry compiles-fails (exhaustive Record<CommTrigger>) but if bypassed would crash at send time on .toggle — must run tsc
- Backfill blind spot: seedAllOrganizationTemplates (seeds.ts) skips orgs that already have any template, so the new SMS template won't reach existing tenants through it; must loop seedCommunicationTemplates(orgId) per org (per-key idempotent)
- Double-notification: wiring into reassignTechnician/PATCH or the provisional autoAssignBookedRequest (scheduling-queries.ts:827) violates 'confirmed assignment only' — wire POST/assignTechnician exclusively
- Background send must use after() not a detached promise (Vercel freeze); customer phone is encrypted at rest, so the enqueue must pass the decrypted phone (safeDecrypt) — queueCommunicationJob re-encrypts
- Migration won't auto-run on Vercel deploy (MEMORY migrations-not-run-on-deploy); operator must npm run db:migrate or 'technician_assigned' inserts 500
- Migration numbering advanced since the prior plan: next is 0023, not 0022 (0022 = HCP user-id, already on disk) — do not collide
- assignTechnician currently doesn't return phone/serviceType/scheduledDate; either extend its return (columns already on the returned `updated` row, queries.ts:469-473) or add a withTenant-scoped follow-up select — don't introduce an unscoped read

**Verifier (sound):** 
- Evidence #5 nuance (not an error): assignTechnician's returned `updated` IS the full serviceRequests row from .returning(), so customerPhoneEncrypted (schema.ts:533), issueType (494), scheduledDate (558) are genuinely available to extend the return shape with zero extra DB read — confirmed, the plan's claim holds.
- Minor clarification (not an error): queueCommunicationJob (job-queue.ts:26-38) types triggerType as plain `string`, so it does NOT itself add a tsc gate for the new value. The sole compile gate for the missing entry is the exhaustive Record<CommTrigger> in consent.ts TRIGGER_RULES — the plan correctly relies on this. Consent is enforced at send time via checkSendAllowed in processPendingJobs (job-queue.ts:120), so the new trigger fn correctly must NOT re-implement consent.

_Notes:_ Independently re-derived the status and re-checked every cited file:line; all resolve exactly. STATUS real-gap CONFIRMED: grep for technician_assigned/your-technician returns ONLY knowledge-base-coverage.test.ts:55 (a test string); enum (schema.ts:1556-1577) ends at warranty_expiring with 15 values, no technician_assigned; trigger fns are exactly triggerAppointmentScheduled/Rescheduled/Cancelled/TechnicianEnroute/JobCompleted (no Assigned); TRIGGER_RULES (consent.ts:46-68) is exhaustive Record<CommTrigger> with no assignment entry. PLAN feasibility verified end-to-end: (1) migration precedent is exact — drizzle/0001_money_loop_triggers.sql does `ALTER TYPE \"public\".\"communication_trigger_type\" ADD VALUE 'estimate_sent'` on the SAME enum; journal has 23 entries last idx 22 (0022 = HCP users.housecall_pro_user_id, unrelated), disk last is 0022, so next is 0023 — numbering correction is RIGHT; 0022_snapshot.json contains public.communication_trigger_type with the 15-value array to copy+append. (2-3) schema add + consent rule both tsc-clean, technician_enroute:52 is the right sibling rule. (4) seeds.ts defaultTemplates key/triggerType shape confirmed; seedCommunicationTemplates (261) is per-key idempotent; seedAllOrganizationTemplates (297-320) skips ANY org with existing templates — backfill blind spot is REAL; provisioning.ts:290 already calls seedCommunicationTemplates. (5) triggerTechnicianEnroute mirror (351-393) accurate; queueCommunicationJob takes plaintext recipientPhone and encrypts at rest (job-queue.ts:49) so caller must pass decrypted phone (keyRisk #4 correct). (6) `after` from next/server already used in sibling routes ([id]/route.ts, reschedule/route.ts); ASSIGNABLE_STATUSES=[pending,scheduled,assigned] (347) gates POST, REASSIGNABLE (366) gates PATCH — POST-only wiring correctly scoped; autoAssignBookedRequest (scheduling-queries.ts) is provisional after()-run auto-assign, correctly flagged do-not-message; safeDecrypt already imported in queries.ts (used :469). All 7 keyRisks are accurate and grounded. No security/financial bypass, no compile-breaking step, no invariant violation (no hvac-knowledge/prompt/metadata.verify touched). Effort M is reasonable.

---

## Stage 19 — Membership plans edit flow  _(closure)_

**Verified status:** closure-correct  **·  Verify:** sound  **·  Effort:** none

**Evidence:**
- src/app/api/admin/membership-plans/[id]/route.ts:22-76 PATCH exists alongside DELETE:78
- src/lib/admin/membership-queries.ts:102-124 updateMembershipPlan withTenant single-statement update
- src/lib/admin/membership-queries.ts:88-98 getMembershipPlanById 404 guard
- src/components/admin/memberships/membership-plans-table.tsx:97-98 Edit button onEdit(plan)
- src/app/admin/(dashboard)/membership-plans/page.tsx:21-24 handleEditClick opens dialog with editing
- src/components/admin/memberships/membership-plan-form-dialog.tsx:110-114 PATCH to /api/admin/membership-plans/id in edit mode
- grep: no test exercises updateMembershipPlan or the PATCH route

**Assessment:**

CLOSURE-CORRECT. Edit flow exists end-to-end. PATCH at route.ts:22 alongside DELETE; the original gap premise (route has POST only) is false. updateMembershipPlan (queries.ts:102) is a partial withTenant-scoped single-statement update honoring the neon-http no-transaction rule. UI fully wired: table Edit button to handleEditClick (page.tsx:21) to MembershipPlanFormDialog edit mode to PATCH fetch with createFormState(editing) prepopulation. Conventions verified: Next-16 await context.params, withTenant on both existence read and write (no tenant leak), adminMutation rate-limit, audit .catch degrade-safety. No frozen-safety/metadata.verify/money-safety surface is touched. Two deviations from the gap wording, neither a real gap: (a) edit is an in-list modal not a dedicated /[id] page (equivalent CRUD; the program treats detail-URL pages as a UX nicety); (b) no active-subscription guard on price edits is SAFE in v1 because customerMemberships has no price snapshot column and there is no auto-renew/charge cron, so price edits have zero retroactive money effect (relevant only when recurring billing ships). No correctness bugs found. Only open item: the stage's own unit/integration-test-for-update criterion is unmet (grep confirms updateMembershipPlan and the PATCH route are untested); additive test debt, not a parity blocker, does not invalidate the closure.

**Key risks:**
- Future auto-renew billing makes PATCH price edits affect active members at renewal; add active-subscription guard or price snapshot then
- No test covers updateMembershipPlan or the PATCH route; the update path is unguarded against regression

**Verifier (sound):** 
- Minor evidence incompleteness (not a correctness error): the assessment's grep line 'no test exercises updateMembershipPlan' is true, but it omits that a test file src/lib/admin/membership-queries.test.ts DOES exist — it covers enrollCustomer/cancelMembership/getActiveMembership only, never the plan create/update/deactivate/getById path. The substantive claim (update path untested) is correct; the framing just understates that membership tests exist.

_Notes:_ Independently re-derived every cited line. Route [id]/route.ts: PATCH at L22 (auth L27, adminMutation rate-limit L32, await context.params L41, withTenant existence check getMembershipPlanById L42, zod validate L47, empty-update guard L51, updateMembershipPlan L55, audit .catch degrade L57-69), DELETE at L78 — both real and as described. queries.ts: getMembershipPlanById L88-98 (withTenant + null/404), updateMembershipPlan L102-124 (partial set-build, withTenant+eq(id)-scoped single UPDATE, sets updatedAt). UI fully wired: table Edit onEdit(plan) L97 -> page handleEditClick L21-24 sets editing + opens dialog -> dialog createFormState(editing) prepopulation L53-62/L77 -> PATCH to /api/admin/membership-plans/${editing.id} L110-114. The 'POST-only gap' premise is FALSE; PATCH exists. No dedicated /[id] page file exists (modal-only edit) — correctly noted as UX-equivalent deviation. Price-snapshot/auto-renew SAFE claim VERIFIED against schema L2452-2493: customerMemberships has NO price column and schema comments L2469-2475 confirm renewals are not auto-charged in v1, so PATCH price edits have zero retroactive money effect today; the active-subscription-guard risk is correctly future-only. No frozen-safety/metadata.verify/money-bypass surface touched. No security or financial bypass missed. Effort=none is correct; the only open item is additive test debt, not a parity blocker. Closure decision holds.

---

## Stage 20 — Tech portal mutations (photos / notes / timeline)  _(plan)_

**Verified status:** partially-done  **·  Verify:** minor-corrections  **·  Effort:** M

**Evidence:**
- src/app/api/tech/jobs/[id]/note/route.ts:43 — addFieldNote tech-scoped POST ships (NOTES DONE)
- src/lib/tech/field-queries.ts:280-291 addFieldNote calls findOwnedJob (assignee+tenant guard at 28-48: withTenant + eq(serviceRequests.assignedTo, techUserId) line 42)
- find src/app/api/tech: routes are note/materials/signature/status/timesheet only — NO photo route, NO timeline route
- grep photo|timeline|attachment in src/app/tech + src/components/tech: zero hits — no photo UI, no timeline UI
- src/app/api/tech/jobs/[id]/signature/route.ts:59-94 — reusable R2 upload template: getStorageClient/validateFile(file,MAX_FILE_SIZE)/generateStorageKey/uploadFile, then ownership-check, then deleteFile orphan-cleanup on not_owned (84-88)
- src/lib/db/schema.ts:1401-1403 attachments.serviceRequestId nullable FK (no-op-on-delete) + filename/mimeType/size/storageKey columns + partial index attachments_service_request_idx at 1418-1420 — photo storage needs NO migration
- src/lib/db/schema.ts:1807-1828 request_status_events (fromStatus/toStatus/actorType/actorId/at + request_idx) — authoritative status-timeline source
- src/lib/db/schema.ts:601-616 request_notes (authorId/content/createdAt) — note timeline source
- src/lib/storage/r2-client.ts:117-123 ADMIN_DOCUMENT_MIME_TYPES (jpeg/png/webp/heic/pdf) + validateFile 3rd arg defaults to PUBLIC_UPLOAD_MIME_TYPES (300) — pass ADMIN_DOCUMENT_MIME_TYPES for iOS HEIC, no allowlist edit needed
- src/app/api/tech/jobs/[id]/status/route.ts:17 updateRequestStatus -> src/lib/admin/queries.ts:677 recordStatusEvent — tech status changes DO populate request_status_events, so a timeline has real transition data
- src/lib/tech/field-queries.test.ts:36 mockSelectSeq harness exists (currently exercises addJobMaterial only — photo/timeline tests are net-new patterns in this file)

**Assessment:**

Gap is PARTIALLY OPEN and the prior assessment re-confirms cleanly against current code. The original plan's claim 'no /api/tech/* mutation endpoints' is STALE: note/materials/signature/status/timesheet all ship and are assignee+tenant guarded via findOwnedJob (field-queries.ts:28-48). NOTES = DONE. Genuinely still missing: (1) tech photo upload, (2) timeline/activity view. No regressions or invariant violations found in the existing tech routes (signature route fails closed + cleans up R2 orphans; note route 404s on not_owned).

FILE-LEVEL PLAN (TDD):

1) PHOTO UPLOAD — reuse attachments table, NO migration (serviceRequestId/storageKey/filename/mimeType/size all exist at schema.ts:1401-1409).
   - src/lib/tech/field-queries.ts: add addJobPhoto(orgId, techUserId, serviceRequestId, {filename, mimeType, size, storageKey}) -> {ok:true,id}|{ok:false,reason:'not_owned'}. MUST call findOwnedJob FIRST (mirror addFieldNote:291), then db.insert(attachments).values({organizationId, serviceRequestId, filename, mimeType, size, storageKey}).returning({id}). Add listJobPhotos(orgId, techUserId, serviceRequestId): owned-check then select from attachments where withTenant(org) AND serviceRequestId, asc(createdAt).
   - NEW src/app/api/tech/jobs/[id]/photo/route.ts: copy signature/route.ts structure (runtime='nodejs', force-dynamic, getAdminSession 401, slidingWindow `tech:photo:${userId}` w/ RATE_LIMITS.adminMutation, formData file). CRITICAL: call validateFile(file, MAX_FILE_SIZE, ADMIN_DOCUMENT_MIME_TYPES) — pass the 3rd arg (the signature route omits it and falls back to jpeg/png; field photos from iOS are HEIC). Upload, then addJobPhoto; on not_owned, deleteFile(storageKey).catch(()=>{}) then 404 — replicate signature/route.ts:84-94 orphan cleanup verbatim (the route's doc-comment claims pre-upload ownership check but the code uploads-then-deletes; copy the real behavior, not the comment). Add GET to list photos (mirror materials GET shape, owned-check inside query).
   - src/components/tech/tech-job-detail-client.tsx: add a Photos section + file input + POST(FormData) handler mirroring handleSign (no canvas), render listed photos from GET.

2) TIMELINE — read-only aggregation, NO new table.
   - src/lib/tech/field-queries.ts: add getJobTimeline(orgId, techUserId, serviceRequestId): owned-check then merge three SELECTs into TimelineEntry[] = {kind:'status'|'note'|'photo', at:Date, label, detail?} sorted desc — (a) requestStatusEvents (fromStatus->toStatus, at, actorType) as the authoritative status source [PREFER this over scalar serviceRequests timestamps], (b) requestNotes (content, createdAt), (c) attachments-for-request (filename, createdAt). neon-http: these are independent reads — await sequentially or db.batch for parallelism; NO db.transaction().
   - NEW src/app/api/tech/jobs/[id]/timeline/route.ts: GET only, mirror materials GET (getAdminSession, owned-check inside query returning 404 on not_owned, successResponse(entries)).
   - Client: render a Timeline section consuming the GET.

TESTS (vitest, extend src/lib/tech/field-queries.test.ts mockSelectSeq harness): addJobPhoto not_owned -> {ok:false} and NO insert; owned -> insert called with org+serviceRequestId, returns id. listJobPhotos/getJobTimeline: not_owned short-circuits; owned returns merged sorted entries. Route integration (mirror existing route-test style): photo route 401 no session, 404 not_owned WITH assertion deleteFile called for orphan cleanup, 201 happy; timeline 404 not_owned, 200 entries.

VERIFY GATES: npx tsc --noEmit; npm run lint; npm run test:unit (new field-queries + route tests green); npm run build. No migration (attachments.serviceRequestId pre-exists; attachments_service_request_idx covers list) -> skip db:migrate. No prompts touched -> no eval.

**Key risks:**
- Stage premise stale: NOTES already ship end-to-end (note/route.ts -> addFieldNote) — do NOT rebuild; only photos + timeline remain
- Orphan-R2 risk: must replicate signature/route.ts:84-88 upload-then-deleteFile-on-not_owned, or a non-assignee leaves files in R2 storage
- iOS HEIC: signature route's validateFile omits the 3rd arg and falls back to jpeg/png-only (r2-client.ts:300); the new photo route MUST pass ADMIN_DOCUMENT_MIME_TYPES (r2-client.ts:117-123) — no r2-client allowlist edit needed
- Timeline source: use request_status_events (schema.ts:1807, populated by tech status route via updateRequestStatus->recordStatusEvent at queries.ts:677) for multi-transition history, NOT scalar serviceRequests timestamps (single snapshot)
- attachments.serviceRequestId is no-op-on-delete (schema.ts:1401-1403): deleting a job will NOT cascade-delete photo rows — acceptable for read-only tech view but note for any future cleanup job
- Keep timeline read-only; do not add a status-write path (status route already exists)

**Verifier (minor-corrections):** 
- recordStatusEvent provenance imprecise: it is DEFINED in src/lib/admin/status-events.ts and IMPORTED into queries.ts:40; queries.ts:677 is a CALL SITE, not the definition. Conclusion (tech status route populates request_status_events) is still correct — status/route.ts:69-75 calls updateRequestStatus with {actorType:'human',actorId} and queries.ts:677 fires recordStatusEvent.
- Read-scope divergence the plan glosses over: the EXISTING materials GET calls listJobMaterials(organizationId, id) (field-queries.ts:197-200) — ORG-scoped only, NO assignee guard on reads. The plan proposes listJobPhotos/getJobTimeline as assignee-scoped (owned-check / not_owned short-circuit), which is STRICTER than the established read pattern. Defensible, but it does NOT 'mirror materials GET shape' as the plan claims; the plan should state this is an intentional tightening, not a mirror.
- Column-name trap not called out: attachments + request_notes FK to a request via differently-named columns. request_notes.requestId (schema.ts:605), request_status_events.serviceRequestId (schema.ts:1814), attachments.serviceRequestId (schema.ts:1401). A timeline that merges all three must use each table's actual column; the assessment does not flag this and a careless join could cross them.
- Implementation prerequisite not mentioned: field-queries.ts currently imports only {jobMaterials, requestNotes, serviceRequests} (line 17) and only {and, asc, eq} from drizzle-orm (line 15). addJobPhoto/getJobTimeline must ADD imports for attachments + requestStatusEvents and desc (for desc timeline sort). Trivial, but a literal 'add function X' step would not compile without these.

_Notes:_ Independently re-derived the status and audited every cited line. Status partially-done is CORRECT: notes ship end-to-end (note/route.ts:43 -> addFieldNote field-queries.ts:280 -> findOwnedJob:28-48, which applies withTenant + eq(assignedTo, techUserId) — a real assignee+tenant guard). No photo route, no timeline route (find shows only note/materials/signature/status/timesheet); grep for photo|timeline|attachment in src/app/tech + src/components/tech returns zero — confirmed no UI. The original plan's 'no /api/tech/* mutation endpoints' premise is genuinely STALE.\n\nAll line citations verified accurate: findOwnedJob 28-48; addFieldNote 280-309; signature route upload-then-deleteFile-on-not_owned 78-94 (and the assessment is RIGHT that the route's doc-comment at lines 7-9 claims a pre-upload ownership check while the code actually uploads first then deletes on failure — 'copy the real behavior not the comment' is sound advice); attachments schema 1401-1409 with nullable no-op-on-delete serviceRequestId FK and partial index attachments_service_request_idx 1418-1420 (NO migration needed — confirmed); request_status_events 1807-1828; request_notes 601-616; ADMIN_DOCUMENT_MIME_TYPES 117-123; validateFile 3rd-arg defaulting to PUBLIC_UPLOAD_MIME_TYPES jpeg/png 297-300.\n\nKey risks are REAL: (a) HEIC — signature route line 60 omits the 3rd arg so it falls back to jpeg/png; the photo route MUST pass ADMIN_DOCUMENT_MIME_TYPES. (b) R2 orphan cleanup pattern is genuine and correctly described. (c) Timeline should use request_status_events (multi-transition) over scalar serviceRequests timestamps — valid; status events ARE populated by the tech status route. No security or financial-bypass gap was missed, and no non-issue was over-rated. The plan is feasible against the real schema/helpers (successResponse, generateStorageKey, uploadFile, deleteFile, mockSelectSeq harness all exist; tech-job-detail-client.tsx with handleSign FormData pattern exists). Corrections are minor (provenance wording, an unstated read-scope tightening, a column-naming trap, and required new imports) — none block the closure decision or invalidate the plan.

---

