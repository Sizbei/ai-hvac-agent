# Address proximity, home-page footer, and voice-chatbot fixes

**Date:** 2026-06-09
**Branch:** `fix/address-footer-voice`
**Status:** Approved — implementing via Workflow.

Four independent fixes. Each is small, evidence-backed, and ships behind `npm test` + `tsc` + `next build`, then commit/push/deploy.

---

## 1. Address system — 50 km proximity bias + nearby suggestion for ambiguous input

### Current state
- `src/lib/address/photon.ts` queries Photon with no location bias and discards each feature's GeoJSON `geometry` (lat/lon).
- Suggestions are returned in Photon's default order, US-preferred but not distance-sorted.
- The Spears base address is hardcoded only in `src/app/page.tsx` (`SPEARS.address`).

### Changes
- **New file `src/lib/config/business-location.ts`** — single source of truth:
  - `name`, `address` = `3501 W Market St, Suite 1, Johnson City, TN 37604`
  - `latitude: 36.3340`, `longitude: -82.3819` (Johnson City, TN)
  - `serviceRadiusKm: 50`
  - `timezone: 'America/New_York'`
  - Exported `as const` with a `BusinessLocation` type.
- **`src/app/page.tsx`** imports `BUSINESS_BASE_LOCATION.address` instead of the inline string (keep the rest of `SPEARS`).
- **`src/lib/address/photon.ts`**:
  - Add optional `near?: { lat: number; lon: number }` to `FetchOptions`. When present, append `lat`, `lon`, and a `zoom` (~12) to the Photon query to bias results toward the base.
  - Parse each feature's `geometry.coordinates` (`[lon, lat]`) onto `AddressSuggestion` as optional `lat`/`lon` (nullable — Photon may omit geometry).
  - Add `haversineKm(aLat, aLon, bLat, bLon): number` helper.
  - When `near` is provided, **stable-sort** mapped suggestions by distance from `near` (suggestions without coordinates sort last, preserving original order among themselves). In-radius results therefore lead; out-of-radius still appear (we never hide them).
  - `preferUsResults` still runs first; distance sort applies to the chosen set.
- **`src/components/chat/address-autocomplete.tsx`**:
  - Import `BUSINESS_BASE_LOCATION`; pass `near: { lat, lon }` to `fetchAddressSuggestions`.
  - Render an optional distance hint per row (`~N mi`) computed from the suggestion's `lat`/`lon` vs. base (omit when coords are missing). Keeps an ambiguous pick obvious without changing the send behavior.
- Degradation is unchanged: any Photon failure → `[]` → customer free-types.

### Tests
- `photon.test.ts`: `haversineKm` sanity (known city pair within tolerance); `near` biasing sorts a closer candidate ahead of a farther one; suggestions missing coordinates sort last; empty/failed fetch still `[]`.

---

## 2. Home page — remove empty footer gap + add a real footer

### Current state
- `src/app/page.tsx:91` outer wrapper has `min-h-dvh`, forcing full-viewport height even when content is shorter → blank space under the CTA.
- `body` (in `layout.tsx`) is already `min-h-full flex flex-col`.
- No `<footer>` element exists.

### Changes
- Remove `min-h-dvh` from the outer wrapper `div` (line 91). The page still fills the viewport when content is short via the body's flex column; tall content is unaffected.
- Add a `<footer>` after `</main>`: Spears name, address (from `BUSINESS_BASE_LOCATION`), phone (`tel:`), email, the demo voice number, and a short "AI intake demo" line. On-brand, fills the bottom honestly.

### Tests
- No unit test (presentational). Verified via `next build` success and a visual check post-deploy.

---

## 3. Voice chatbot — stop the looping

### Root cause (confirmed)
`src/lib/ai/voice-turn.ts` extracts contact slots with `extractSlots(userMessage)`, whose address matcher is the **strict** `extractAddress` (suffix-anchored, expects `,`/ZIP). Twilio transcribes spoken addresses without that structure, so the address slot never fills and `voiceNextSlotPrompt` re-asks the same question every turn → loop. The web chat already solved this with `extractAddressAtAddressStep` (the permissive at-step matcher); the voice path never uses it.

### Changes
- In `voice-turn.ts`, compute the pending triage step (already done for enrichment capture). When that step is `address` or `address_parts`, capture the address with `extractAddressAtAddressStep(userMessage)` and use it in place of `extracted.address` for the merge. Outside the address step, strict extraction still applies (so a stray "123 Main" mid-issue isn't misread as the service address).
- Secondary loop guard: when the deterministic router returns a slot-fill (`verdict.action !== 'FALLBACK_LLM'`) and the slot it captured is now filled, prefer `voiceNextSlotPrompt(merged)` over re-speaking `verdict.reply`, so the call advances rather than repeating the same canned line.

### Tests
- `voice-turn.test.ts`: at the address step, a spoken-form address (`"123 Main Street Johnson City Tennessee"`, no comma/ZIP) fills the address slot and the next reply is NOT the address question again.

---

## 4. Voice chatbot — ElevenLabs "Brian" as the default voice

### Current state
- `resolveVoiceMode` (`src/lib/voice/request.ts`) only uses ElevenLabs when `VOICE_PROVIDER=elevenlabs` AND a key is set; otherwise Polly.
- Default ElevenLabs voice is "Davis" (`Z2fsAwk7IblvPhYzfslC`).

### Changes
- `src/lib/voice/elevenlabs.ts`: `DEFAULT_ELEVENLABS_VOICE_ID = 'nPczCjzI2devNBz1zQrb'` (ElevenLabs prebuilt **Brian**). Update the doc comment from "Davis" to "Brian". `ELEVENLABS_VOICE_ID` env override still wins.
- `src/lib/voice/request.ts`: `resolveVoiceMode` returns ElevenLabs **whenever `isElevenLabsEnabled()`** (a key is present). Drop the `VOICE_PROVIDER` requirement; keep an explicit `VOICE_PROVIDER=polly` escape hatch to force Polly. Polly remains the no-key fallback.
- TwiML stays `<Play>`-only (already correct — do NOT re-add a `<Say>` fallback; that re-introduces the fixed double-voicing bug).

### Tests
- `request.test.ts` (or existing voice test): with a key set and no `VOICE_PROVIDER`, mode is `elevenlabs`; with `VOICE_PROVIDER=polly`, mode is `polly`; with no key, mode is `polly`.
- `elevenlabs.test.ts`: default voice id is the Brian id; env override still applies.

---

## Sequencing & integration
- Areas 1, 2, 3+4 are independent files. Area 1's new `business-location.ts` is consumed by both Area 1 and Area 2 — create it first.
- After all edits: `npm test`, `npx tsc --noEmit`, `npm run build`. Fix any failures.
- Commit on `fix/address-footer-voice`, merge to `main`, push, verify Vercel deploy.
- **Env note:** ElevenLabs Brian only activates in prod if `ELEVENLABS_API_KEY` is set in Vercel. If absent, prod stays on Polly (graceful). Flag this in the final summary.
