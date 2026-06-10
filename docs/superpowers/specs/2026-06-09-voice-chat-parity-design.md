# Voice ↔ chat parity + loop/duplication audit fixes

**Date:** 2026-06-09
**Branch:** `fix/voice-chat-parity`
**Status:** Approved — implementing.

Make the phone agent's conversation behave like the web chat, and fix the loop/capture bugs the audit found. The audit found **no duplication bug** (user + assistant message inserts are each exactly once per turn across the escalate/deterministic/LLM branches; metadata updates once per branch) — so this work is parity + loop fixes, not de-duplication.

All web-chat helpers already exist as clean, tested, importable modules: `extractAllContactFields` (extract-all-contact.ts), `detectCorrection` (detect-correction.ts), `isBusinessName` (detect-business-name.ts), `withLeadIn`/`leadInForIssue` (lead-ins.ts). Porting parity is mostly wiring.

---

## What stays divergent (INTENTIONAL — do NOT change)
- **No name question over the phone** — name is confirmed by the technician; voice marks NAME_STEP skipped. (But we DO capture a spoken name if offered — see Fix 1.)
- **No after-hours disclosure** — real-time call, human fallback handles it.
- **No repeat-customer context lookup** — voice starts from a raw CallSid, no session cookie.
- **No real-availability window lookup** — voice keeps the generic "we coordinate timing" line to avoid a blocking read.
- **TwiML `<Play>`-only** for ElevenLabs — do NOT add a `<Say>` fallback (re-introduces the fixed double-voicing bug).

---

## Fixes

### Fix 1 — Multi-field + residual-name capture (BUG: name re-ask)
**Now:** `voice-turn.ts` uses `extractSlots(userMessage)` → only address/phone/email, never name. A caller who says "Ray Chen, 865-555-1212" loses the name; triage later can't complete on name (name is required for submit) — though voice skips the name *question*, the captured name should still fill the slot so completion latches and the confirm doesn't stall.
**Change:** Replace `extractSlots` with `extractAllContactFields(userMessage, { allowResidualName: true })` in `voice-turn.ts`. Carry the captured `name` into the merge (same as web chat). Keep using `extractAddressAtAddressStep` at the address step (already in place) — feed its result as the address override, exactly as today.

### Fix 2 — Mid-call corrections ("actually my number is…") (GAP→BUG)
**Now:** Voice never calls `detectCorrection`, so a caller correcting an already-filled field is ignored; the old value ships.
**Change:** Import `detectCorrection`; at each turn, run it against the pending step (mirroring chat route's usage). When it returns a correction, apply it to the merged slots and prepend a brief spoken ack ("Got it, I've updated that.") to the reply. Generic logic — no reason to exclude voice.

### Fix 3 — Spoken-phone digit-sequence capture (BUG: phone re-ask)
**Now:** `extractPhone` regex matches grouped/spaced transcripts ("555 123 4567") but NOT a fully spelled-out sequence Twilio may render as "5 5 5 1 2 3 4 5 6 7".
**Change:** In voice-turn.ts, when the pending step is `phone` and `extractAllContactFields` found no phone, run a voice-only fallback that strips non-digits from the utterance and, if it yields exactly 10 (or 11 with a leading 1) digits, formats and uses that. Keep it gated to the phone step so stray digit runs elsewhere aren't misread. Add a small pure helper `extractSpokenPhone(message): string | null` (new, unit-tested) — do NOT loosen the shared `extractPhone`.

### Fix 4 — Enrichment skip latch (BUG: enrichment re-ask loop)
**Now:** For a voice-asked optional enum step (e.g. `system_type`), an unrecognized non-skip answer makes `captureEnrichmentAnswer` return `null` → step never marked skipped → re-asked next turn.
**Change (voice-only, minimal):** In voice-turn.ts, when the pending step is an optional enrichment step that voice asked, and the answer was neither captured as a value nor recognized as skip, mark that step skipped in the persisted extras so `voiceNextSlotPrompt` advances instead of re-asking. (Voice gets one shot per optional enrichment question — a call shouldn't loop on "what kind of system is it?".) Do not change the shared `captureEnrichmentAnswer`/triage semantics used by web chat.

### Fix 5 — Warmth + business-name ack to match chat (GAP)
**Now:** Voice replies are skeletal ("Great. <next question>"); chat prepends issue/urgency warmth via `withLeadIn` and a commercial-account ack via `isBusinessName`.
**Change:** In voice-turn.ts's deterministic/slot-fill reply assembly, when not extraction-complete and not escalating: prepend `withLeadIn(...)` warmth (issue/urgency, turn-aware) the way chat does, and when a captured name/address `isBusinessName`, prepend a short spoken commercial ack. Route everything through `toSpokenReply` last so markdown/screen affordances are still stripped. Keep `VOICE_CONFIRM_REPLY` on completion and the escalation reply unchanged.

---

## Persona prompt
Tighten `PHONE_SYSTEM_PROMPT` only if needed so the LLM-fallback persona matches the chat's warmth/acknowledgement style (it already says "re-read the conversation, never re-ask"). No structural change planned; deterministic paths carry the parity.

## Sequencing
- All changes are in `voice-turn.ts` plus one new pure helper (`extractSpokenPhone`) and its test; persona prompt untouched unless a test shows a gap. Disjoint from web chat code.
- New/updated tests: residual-name capture at phone step; mid-call correction updates the slot + acks; spelled-out phone captured; optional enrichment skip latches (no re-ask); warmth/business ack present on a slot-fill turn; existing 1405-test suite stays green.
- Verify: `tsc --noEmit`, full `vitest run`, `next build`. Then commit on `fix/voice-chat-parity`, merge to main, push, verify Vercel deploy.

## Risk notes
- Don't loosen shared extractors (`extractPhone`, `captureEnrichmentAnswer`) — voice-only fallbacks live in voice-turn.ts so web chat behavior is unchanged.
- Preserve the three once-per-turn DB writes and the escalation path exactly (audit confirmed no duplication; keep it that way).
