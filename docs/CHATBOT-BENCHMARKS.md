# Chatbot Benchmarks & Simple Wins

How leading help/support chatbots build trust, deflect routine questions, and hand off gracefully — distilled into simple, high-leverage improvements for our AI HVAC intake bot. Our bot already has a strong base (deterministic intent router, quick-reply chips, extraction pills + confirmation card, "Talk to a Human" escalation, emergency handling, rate limiting, token budget). The goal here is to find the *cheap* UX patterns the market leaders use that we haven't adopted yet — and to be honest about what's not worth building for a single-purpose intake bot.

---

## Leading chatbots & their signature UX patterns

| Product | Signature UX pattern(s) | Notes |
|---|---|---|
| **Intercom (Fin)** | Answers strictly from approved knowledge and **links the source article** behind each answer; clean "I can't answer this → hand over to a human" fallback. "Fin Guidance" lets admins set tone/escalation in natural language. | Source-citing builds trust and reduces hallucination; explicit handover is a first-class state, not an afterthought. |
| **Zendesk (AI agent / Answer Bot)** | After every answer, a **standard "Was this helpful? yes/no"** step; on "no," it offers related answers or **Transfer to agent**. | Feedback is built into the answer flow, and a negative answer is the trigger for escalation. |
| **Drift** | **Quick-reply buttons** as the primary interaction; conversation is steered toward a human handoff or a lead form with minimal typing. | Button-first design lowers friction and keeps users on rails. |
| **Tidio (Lyro)** | Highly **customizable welcome message** + proactive prompts; deflects a large share of queries before a human is involved. | Branding and a strong first message set expectations. |
| **Ada / Forethought** | **Proactive welcome / contextual prompts** ("Can I help you find…?") to reduce decision fatigue, balanced against not overwhelming with multiple messages at once. | Proactivity must be balanced with restraint. |
| **NN/G guidance (research)** | **Disclose it's an AI** up front + "ask for a person anytime"; **clarify capabilities** in the first message; **contextual suggested prompts** as buttons; **typing indicators / progress**; **don't autoscroll** past the top of a new message; allow save/share of the conversation. | Vendor-neutral, evidence-based; several map directly to our bot. |
| **Accessibility consensus (Orange/CANAXESS/BOIA)** | `aria-live="polite"` + `aria-atomic="false"` on the streaming response region; keyboard-focusable, scrollable history; per-message labels with author + timestamp; respect reduced-motion. | Cheap to add, broadens reach, reduces legal risk. |

Sources: [Intercom Fin – Help](https://www.intercom.com/help/en/articles/7120684-fin-ai-agent-explained) · [eesel: Fin guide](https://www.eesel.ai/blog/intercom-fin-chatbot) · [Zendesk: standard responses](https://support.zendesk.com/hc/en-us/articles/7510607688730-Setting-the-standard-responses-for-a-conversation-bot) · [Zendesk: deploying a conversation bot](https://support.zendesk.com/hc/en-us/articles/4965031536794-Best-practices-for-deploying-a-conversation-bot) · [Tidio: chatbot UI](https://www.tidio.com/blog/chatbot-ui/) · [NN/G: 10 AI chatbot guidelines](https://www.nngroup.com/articles/ai-chatbots-design-guidelines/) · [NN/G: explainable AI in chat](https://www.nngroup.com/articles/explainable-ai/) · [Practical AI UX playbook](https://spiralscout.com/blog/ai-ux-playbook-for-websites) · [Orange a11y: chatbot](https://a11y-guidelines.orange.com/en/articles/chatbot/) · [BOIA: chatbot accessibility](https://www.boia.org/blog/five-key-accessibility-considerations-for-chatbots)

---

## Simple wins we should adopt (prioritized)

Each item is tagged **Value** (High/Med/Low) × **Effort** (S/M/L). Items marked ✅ ALREADY HAVE are listed only so we don't redo them.

### 1. AI disclosure + "ask for a person anytime" in the first message — **High value / S effort**
- **Pattern (Intercom, NN/G, FTC/EU/CA compliance):** State plainly that it's an AI, that it can make mistakes, and that a human is one tap away — in the very first bubble.
- **Why it helps:** Sets honest expectations, builds trust, and is increasingly a legal/compliance expectation. Costs nothing at runtime.
- **HVAC mapping:** Reassures a stressed customer (no heat, gas smell) that escalation is always available, reinforcing our existing emergency/handoff design.
- **Sketch:** Edit the first-greeting line in `src/lib/ai/system-prompt.ts` to: "Hi! I'm an AI HVAC assistant — I can help describe your issue and get a technician dispatched. I might not get everything right, so you can tap **Talk to a Human** anytime. What's going on?" Zero tokens — it's already the deterministic greeting.

### 2. "Did this answer your question? 👍 / 👎" after FAQ answers — **High value / S–M effort**
- **Pattern (Zendesk):** Every answered FAQ ends with a yes/no helpfulness check; "no" surfaces alternatives or escalation.
- **Why it helps:** Cheap signal for measuring deflection quality; a 👎 becomes a natural, low-pressure escalation trigger.
- **HVAC mapping:** Applies only to the deterministic `ANSWER`/FAQ branch (not slot-collection or emergency). On 👎, offer "Describe your issue" or "Talk to a Human."
- **Sketch:** When the chat route returns an `ANSWER` verdict, append a small feedback control (reuse the chip styling from `quick-replies.tsx`). Render it in `message-bubble.tsx`/`message-list.tsx`; persist the vote against the message + `intentId` already logged by the router metrics, so we can report FAQ helpfulness without new infra.

### 3. Suggested follow-up replies after each answer — **High value / S effort**
- **Pattern (Drift, NN/G "contextual suggested prompts"):** After a bot turn, show 2–3 clickable next steps instead of leaving the user to type.
- **Why it helps:** Keeps users on rails, reduces typing on mobile, and steers toward completing the intake.
- **HVAC mapping:** After a FAQ answer → "Book a technician" / "Talk to a Human." After the bot asks for the address → no suggestions (free text). We already have the chip component; this is mostly about *when* we show it.
- **Sketch:** Drive contextual chips from the router verdict (`ANSWER` → next-step chips; `COLLECT_INFO` → keep free text). Reuse `quick-replies.tsx`'s button rendering with a smaller, context-specific list rather than the full category tree.

### 4. Progress indicator for the multi-step intake — **High value / S effort**
- **Pattern (NN/G progressive disclosure; common in multi-step intake bots):** Show how far along a multi-step flow the user is.
- **Why it helps:** Reduces abandonment by signaling "almost done"; our intake is a known 3-field flow (issue, urgency, address).
- **HVAC mapping:** We already render extraction *pills* — upgrade them into a clear "2 of 3 collected" stepper so progress reads as a finish line, not just chips.
- **Sketch:** Add a compact "Step X of 3" / progress bar to `extraction-pills.tsx` derived from how many of the 3 required slots are filled (data already in `use-chat-session.ts`). No backend change.

### 5. Streaming/answer accessibility: `aria-live` + reduced-motion — **High value / S–M effort**
- **Pattern (Orange, CANAXESS, BOIA):** `aria-live="polite"` + `aria-atomic="false"` on the streaming region; keyboard-focusable scrollable history; per-message labels with author; honor `prefers-reduced-motion`.
- **Why it helps:** Screen-reader and keyboard users can actually use the bot; cheap insurance against accessibility complaints. The typing-dot and pill animations should pause under reduced-motion.
- **HVAC mapping:** Customers in distress may be on phones, using voice control, or have impairments — broad reach matters.
- **Sketch:** Add `aria-live="polite" aria-atomic="false"` to the streaming message container in `message-list.tsx`; ensure each `message-bubble.tsx` has an author label; gate the `motion` animations in `typing-indicator.tsx`/`extraction-pills.tsx` behind `prefers-reduced-motion`.

### 6. Don't autoscroll past the top of a new bot message — **Med value / S effort**
- **Pattern (NN/G guideline #7):** Keep the user's scroll at the *top* of a new long message so they read from the beginning.
- **Why it helps:** With streaming, naive auto-scroll-to-bottom hides the start of longer answers.
- **HVAC mapping:** Our FAQ/safety answers can be multi-line; users should see the first line of safety guidance.
- **Sketch:** In `message-list.tsx`, on a new assistant message scroll its *top* into view rather than always jumping to the container bottom.

### 7. Conversation persistence / resume across refresh — **Med value / S–M effort**
- **Pattern (GetStream, industry consensus):** Auto-save messages so a refresh, crash, or returning tab resumes the same conversation.
- **Why it helps:** A customer who accidentally refreshes mid-intake shouldn't lose progress and start over (a top abandonment cause).
- **HVAC mapping:** We already create a session server-side; the gap is *reattaching* the browser to it. Likely low effort since history + metadata already persist.
- **Sketch:** Persist the session id in `localStorage`; on load, `use-chat-session.ts` rehydrates messages from the existing `GET /api/session` (which now returns `metadata` per the router plan). No new tables.

### 8. Bot identity + handoff expectations in the header — **Med value / S effort**
- **Pattern (NN/G "clarify capabilities"; Intercom handover):** The header should say what it is and set response-time expectations.
- **Why it helps:** Reinforces transparency at a glance and frames the "Talk to a Human" button.
- **HVAC mapping:** `chat-header.tsx` already shows "HVAC Assistant" + a status dot and the escalate button — just add a one-line subtitle like "AI assistant · a tech follows up within 2 hrs."
- **Sketch:** Add a muted subtitle under the `<h1>` in `chat-header.tsx`. Static text, no logic.

### 9. Set a realistic handoff expectation on escalation — **Med value / S effort**
- **Pattern (Intercom explicit handover; NN/G honesty):** Don't just dump a phone number — tell the user what happens next and when.
- **Why it helps:** Avoids the "did anything happen?" anxiety after they click escalate; matches the trust-without-fake-promises principle.
- **HVAC mapping:** Our `escalation-dialog.tsx` shows a number; add expectation copy consistent with our 2-hour promise on the success page.
- **Sketch:** Add one line of copy to `escalation-dialog.tsx`: "We've flagged this for a human. Call now for emergencies, or a technician will reach out within 2 hours."

### 10. Branded typing indicator with name — **Low value / S effort**
- **Pattern (NN/G typing indicators; Tidio branding):** Label the "thinking" state with the assistant's identity.
- **Why it helps:** Minor warmth/trust nudge; reinforces it's the AI, not a person typing.
- **HVAC mapping:** Note: deterministic answers are *instant* (0 tokens) — only show this on the LLM-fallback path so we don't fake latency on canned replies.
- **Sketch:** Add an "HVAC Assistant is typing…" label to `typing-indicator.tsx`; only mount it during the streaming LLM path in `use-chat-session.ts`.

### ✅ Already have (do not redo)
- **Quick-reply chips** — `quick-replies.tsx` (category-grouped). (Items 2/3 *extend* these contextually.)
- **Typing indicator** — `typing-indicator.tsx` exists (items 5 & 10 refine it).
- **Conversation summary before submit** — extraction card + confirmation dialog (`extraction-card.tsx`, `confirmation-dialog.tsx`).
- **Field-collection progress feedback** — extraction pills (item 4 upgrades to an explicit stepper).
- **Human escalation as a first-class state** — "Talk to a Human" + `escalated` session state.
- **Emergency/safety escalation** — deterministic emergency intent with conservative thresholds.
- **Deflection of routine questions with 0 LLM tokens** — deterministic intent router (this *is* the Intercom/Zendesk deflection pattern).
- **Reference number + next-step confirmation** — success page (`/chat/success`).
- **No fake promises / no DIY repair / non-HVAC redirect** — enforced in `system-prompt.ts`.

---

## Deliberately skip / not worth it for an intake bot

- **Source-article citations under each answer (Intercom Fin).** Great for a knowledge-base bot; our answers come from a small hand-curated deterministic catalog, not a doc corpus — citations add UI weight with little payoff.
- **Voice input / voice agent (Fin Voice).** High effort, niche for a short text intake; revisit only if mobile data shows demand.
- **Image/screenshot diagnosis (Fin Vision).** HVAC photos could *eventually* help triage, but it's a large, separate feature — out of scope for "simple wins."
- **Multilingual / tone-of-voice tuning UI.** Our router is English-only by design (non-Latin input already falls back to the LLM); a full localization layer is a project, not a tweak.
- **Proactive/pop-up "Can I help?" nudges.** Users arrive at `/chat` having *already* clicked "Get Help Now" — they've opted in; a proactive nudge would be noise.
- **Resizable / maximize chat window, save/share transcript (NN/G #8–9).** Aimed at long research conversations; our flow is a short, single-purpose intake that ends on a success page. Low return.
- **Confidence-score display on answers.** Useful for open-domain LLM chat; our deterministic answers are either matched (act) or fall back (LLM) — exposing a number would confuse more than clarify.
- **Persisting/resuming across *devices* (vs. simple refresh-resume in item 7).** Cross-device continuity needs identity we deliberately don't collect up front; refresh-resume captures ~all the value.
