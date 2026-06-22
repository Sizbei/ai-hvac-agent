# Architecture

## 1. Overview

An AI customer-service intake agent for HVAC companies. A customer describes a heating/cooling problem — in a web chat or over the phone — and the system answers common questions, collects the fields that matter (issue, urgency, address, contact), turns the conversation into a structured service request, and hands it to an admin dashboard for triage and dispatch.

The core idea is **spend LLM tokens only when you have to**. A deterministic 65-intent router resolves the bulk of assistant turns — greetings, FAQs, safety escalations, and slot collection — with **zero LLM calls**. The language model (Qwen, via Alibaba DashScope's OpenAI-compatible endpoint) is the *fallback* for novel or ambiguous input, not the front door.

**Two channels, one brain.** The web chat (`/api/chat`) and the telephone agent (Twilio → `/api/voice/*`) run the *same* router → extraction → state-machine core; the phone path (`src/lib/ai/voice-turn.ts`) is a voice persona over it — spoken-friendly replies via an Amazon Polly neural voice, signed webhooks, and a non-streaming completion per turn — not a separate implementation. A session's `channel` column records which medium it arrived over.

## 2. System Diagram

```
  Customer (browser /chat)          Caller (phone)
        │  POST /api/chat            │  Twilio → POST /api/voice/{incoming,gather}
        │  { message }               │  (signed; speech → text; reply spoken via Polly neural voice)
        ▼                            ▼
┌───────────────────────────────────────────────────────────────┐
│  Chat route (api/chat/route.ts) · Voice route (api/voice/*)     │
│  both drive the SAME router → extraction → state-machine core   │
│                                                                 │
│  rate limit (per IP) → session + terminal-state check →         │
│  token-budget check → sanitizeInput (guardrails) → persist msg  │
│        │                                                        │
│        ▼                                                        │
│  ┌──────────────────────────┐                                  │
│  │ Deterministic router     │   normalize → score → confidence │
│  │ (intent-router.ts)       │   → verdict                      │
│  └──────────┬───────────────┘                                  │
│             │                                                   │
│   ┌─────────┼───────────────┬──────────────┐                   │
│   ▼         ▼               ▼              ▼                    │
│ ANSWER   ESCALATE        SLOT_FILL    FALLBACK_LLM              │
│ (canned) (lock session)  (regex slots) │                       │
│   │         │               │          ▼                       │
│   │         │               │   streamText(getModel) ──► token │
│   │         │               │   onFinish: extractServiceReq    │
│   │         │               │   (getExtractionModel, cheaper)  │
│   └────┬────┴───────────────┴──────────┘                       │
│        ▼  0 LLM tokens for the first three paths                │
└────────┼────────────────────────────────────────────────────┘
         ▼
  Neon serverless Postgres (Drizzle ORM)
  sessions · messages · service_requests · CRM · audit_log
         ▲
         │  tenant-scoped, PII decrypted on read
  Admin dashboard (queue, conversations, AI insights, CRM)
```

## 3. Request Lifecycle (one chat turn through `route.ts`)

1. **Rate limit** — per-IP sliding window keyed on `x-forwarded-for`; rejected with `429` if exceeded.
2. **Session resolve** — load the session by httpOnly cookie token, scoped with `withTenant()`. Reject if missing.
3. **Terminal-state guard** — refuse further messages on `submitted`/escalated/abandoned sessions.
4. **Token-budget guard** — when the session's `tokensUsed` has hit its `tokenBudget` (default 40,000), the turn **degrades gracefully** to a human handoff: it records a warm "let me connect you with someone" reply, escalates the session, and returns that as a normal assistant bubble — never a raw error. The same graceful handoff covers the turn-limit and any unhandled chat failure, so a long conversation never surfaces a red error box.
5. **Parse + sanitize** — validate the body, then `sanitizeInput()`: strip control chars, truncate to 2000 chars, and flag prompt-injection patterns (a flagged message is blocked with `400`).
6. **Persist** the sanitized user message; increment turn count (escalation hint fires near the per-session turn limit — `DEFAULT_MAX_TURNS = 40`, admin-tunable per org).
7. **Deterministic routing + triage** — call `routeMessage(message, knownSlots)` plus regex `extractSlots()`. A deterministic **triage engine** (`src/lib/ai/triage.ts`) sits in front of the LLM and drives the intake: it runs a **safety screen first** (gas/CO/burning/flooding short-circuit to escalation), then qualifying questions (system fully down vs partly working, how long), then the required dispatch gate (issue, urgency, address, **contact phone**), then skippable enrichment (system type, equipment age/brand, property type, owner/renter, warranty, access notes, vulnerable occupants, preferred window, contact preference, lead source). It emits ONE question at a time with quick-reply chips, so the common path stays **0-token**. If the verdict is *not* `FALLBACK_LLM` (or it's a mid-intake slot-provision turn), answer/escalate/slot-fill deterministically, write the assistant reply with `tokensUsed: 0`, update session state, and return a canned `text/plain` stream — **no model call**. A `jobType` work classification is derived from the symptom `issueType`.
8. **LLM fallback only if needed** — `streamText({ model: getModel(), maxOutputTokens: 350 })` over a rolling **summary + the last 10 messages**, streamed to the client.
9. **Background extraction** — in `onFinish`, record token usage, then run `extractServiceRequest()` to distill slots; it re-reads *current* metadata before merging so a fast follow-up turn can't be clobbered, and never overwrites a filled slot with null.
10. **Background compaction** — a separate `after()` task folds turns that have aged out of the 10-message window into the session's `running_summary` (`src/lib/ai/compaction.ts` for the pure model helpers, `compact-session.ts` for the idempotent DB write). This keeps long conversations coherent without re-sending the full transcript, so the raised turn ceiling stays affordable. Failure is logged and swallowed — the conversation simply continues uncompacted.

## 4. The Cost-Saving Router (the centerpiece)

`routeMessage()` is a pure function: no I/O, fully testable. Each turn flows through **normalize → score → threshold → verdict**.

- **Normalize** — lowercase, strip punctuation (keeping `#`/`+`/digits), collapse whitespace, then apply aliases (`a/c` → `air conditioner`, `tstat` → `thermostat`, `co` → `carbon monoxide`).
- **Score** — every entry in the 65-intent knowledge base is scored by keyword hits, with multi-word phrases weighted 3× single tokens. `negationGuards` zero out an entry (`"gas furnace"` must not trip the gas-leak intent); `requiredQualifiers` force a co-occurring danger word before an emergency can fire.
- **Threshold / verdict** — confidence is `score / (score + runnerUp + 0.75)`. Three bands gate the action: `EMERGENCY_THRESHOLD = 0.25`, `LOW_HARM_THRESHOLD = 0.45` (FAQ-style ANSWER/REDIRECT), `ACT_THRESHOLD = 0.7` (everything higher-stakes). Compound messages (two distinct non-meta categories scoring meaningfully) and low-Latin-ratio input defer to the LLM. `COLLECT_INFO` is promoted to `SUBMIT` once all required slots are present.
- **Emergency short-circuit** — gas/CO/fire/flood matches beat everything else (category priority 0), escalate at the low 0.25 band, and lock the session via `escalateSession()`. The qualifier gate keeps this conservative: a bare noun never escalates.

**Why it matters.** The chat endpoint historically made **2 LLM calls per turn** (reply + extraction). On a matched deterministic turn that drops to **0** — roughly **55% of assistant turns**. The win is threefold: **cost** (no tokens), **latency** (a canned reply returns immediately, with no fake typing indicator), and **determinism for safety** (an emergency response is a fixed, audited string, never a model's improvisation). A single `ROUTER_ENABLED=false` kill-switch routes everything through the LLM if the layer ever misbehaves.

## 5. Key Engineering Decisions

| Decision | Why | Tradeoff |
|---|---|---|
| **Deterministic router in front of the LLM** | ~55% of turns answered at 0 tokens; instant latency; auditable safety responses | Keyword catalog must be hand-maintained; no semantic matching for unseen phrasings (those fall back to the LLM) |
| **Deterministic triage engine (safety-first intake)** | The intake — safety screen, qualifying questions, required gate, enrichment — runs as a pure state machine (`src/lib/ai/triage.ts`), one question at a time with quick-reply chips, so a comprehensive ServiceTitan-style intake costs **0 tokens** on the common path and a hazard always escalates before anything is booked. Shared by web chat and the phone agent | The question order and field set are hand-modeled; genuinely novel phrasings still fall back to the LLM |
| **Tiered intake (small required gate + skippable enrichment)** | Only a small core blocks submission (issue, urgency, address, **contact phone**); the rich dispatch fields are asked smartly but are skippable ("skip" / "I don't know" advances and is never re-asked), so completion stays high while dispatch still gets everything offered | A skipped field is simply absent; the technician confirms it on arrival rather than the system forcing it |
| **Permissive address capture (lookup verbatim + lenient step parse)** | The address step is backed by a keyless autocomplete (Photon); a picked result is stored verbatim and a typed reply is captured leniently (comma / ZIP / multi-word), so non-US or house-number-less addresses don't get re-asked — all on the 0-token path (see [docs/INTAKE-FIELDS.md](docs/INTAKE-FIELDS.md)) | Trusting the whole reply can absorb trailing prose into the address string; the admin can edit it on the request |
| **`generateText` + tolerant JSON parser, not `generateObject`** | DashScope does **not** honor `generateObject`'s strict `json_schema` mode — it returned prose/fenced text and threw `AI_JSONParseError` on every turn. Instructing the shape and parsing tolerantly (strip fences, coerce nullish, drop out-of-enum values, Zod-validate) works reliably | Loses the SDK's compile-time schema guarantee; parser must defensively handle chatty/malformed output |
| **Separate extraction model (`AI_EXTRACTION_MODEL`)** | Extraction is mechanical JSON classification — it can run on a cheaper/faster tier than the conversational reply | Defaults to the chat model, so the saving is opt-in via env config |
| **Neon serverless Postgres + Drizzle** | HTTP-driver Postgres suits Vercel's serverless/edge model (no pooled connection to manage); Drizzle gives typed schema + migrations | HTTP round-trips per query rather than a long-lived pooled connection |
| **AES-256-GCM field encryption** | Customer name/phone/email/address are PII; GCM gives confidentiality **and** tamper detection (decrypt throws on a bad auth tag) | Encrypted columns aren't directly searchable; encryption key must be present to read |
| **`withTenant()` query scoping** | Every query is filtered by `organization_id` through one helper, so multi-tenant isolation is enforced by construction, not by remembering | Relies on discipline — a raw query that bypasses the helper would bypass isolation |
| **Phone agent reuses the web core (voice persona, not a fork)** | The telephone agent runs the same router/extraction/state-machine; only the prompt persona and output shaping (spoken text, neural voice, TwiML) differ. One brain to maintain and test | A phone turn uses non-streaming `generateText` (a call needs a complete utterance), so the streaming optimization the web path enjoys doesn't apply on the LLM-fallback path |
| **Summary compaction for long conversations** | Folding aged-out turns into a rolling summary keeps context coherent at flat per-turn cost, so the turn ceiling can rise (default 40) without unbounded token growth | Adds a background summarization call once a conversation crosses the window; the summary is model-generated and could lose nuance the raw transcript held |
| **Twilio signature validation (fails closed)** | Webhooks are public endpoints; verifying `X-Twilio-Signature` (HMAC-SHA1, keyed by `TWILIO_AUTH_TOKEN`) proves authenticity. No token / bad signature ⇒ rejected | The voice endpoints do nothing useful until `TWILIO_AUTH_TOKEN` is set — intentional, but a silent "all rejected" if an operator forgets it |

## 6. Data Model (Drizzle, ~55 tables)

- **Auth / org** — `organizations`, `users` (admin + technician staff, role-gated, password-hashed).
- **Chat** — `customer_sessions` (status state machine, token budget/usage, turn count, extracted-slot metadata, a `channel` of `web`/`phone`, and a `running_summary` for compacted long conversations) and `messages` (per-turn role/content, with `tokensUsed` recording 0 on deterministic turns).
- **Service requests** — `service_requests`: the structured intake output, with **encrypted** name/phone/email/address columns, a unique reference number, urgency enum, technician assignment, and the **comprehensive intake columns** captured by the triage engine (system-down status, problem duration, system type, equipment age band/brand, property type, owner-occupant, warranty, access notes, vulnerable occupants, preferred window, contact preference, lead source) plus a derived `jobType` work classification.
- **CRM** — `customers` (deduplicated profiles, encrypted PII, plus `customerType` / `membershipStatus` / `doNotService`), `customer_equipment` (installed units, warranty dates including `laborWarrantyExpiration` — ServiceTitan splits parts vs labor warranty), `customer_notes`, `follow_ups` (maintenance/warranty reminders), `service_history` (work performed, parts, cost).

> **ServiceTitan "soft split".** The service address lives on the `service_requests` row (the *location*), while billing identity lives on the `customers` row — a soft Customer↔Location split, with no separate locations table (deferred; see [docs/INTAKE-FIELDS.md](docs/INTAKE-FIELDS.md)). The preferred window we capture is appointment *intent*, not a real calendar booking.
- **Audit** — `audit_log`: append-only record of actions (escalations, request creation, feedback signals) with IP and entity references.
- **Money loop** — `estimates` / `estimate_line_items` / `estimate_options`, `invoices` / `invoice_line_items`, `payments`, `refunds` (all amounts in **integer cents**; over-collection + over-refund guards; provider-agnostic payment seam), plus `customer_memberships`.
- **Integrations** — per-org encrypted connections (`fieldpulse_connections`, `housecall_pro_connections`, `google_calendar_connections`) and inbound-webhook idempotency ledgers (`fieldpulse_webhook_events`, `hcp_webhook_events`). FSM invoices mirror into the native `invoices` table (read-only, keyed on `fieldpulse_invoice_id` / `hcp_invoice_id`). See **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**.

Every table carries `organization_id` with supporting indexes; hot lookups (session token, request status, audit time) are indexed explicitly.

## 7. Security & Reliability

- **PII encryption at rest** — AES-256-GCM via immutable `encryptFields`/`decryptFields`; auth tag verification detects tampering.
- **Prompt-injection guardrails** — input is matched against known injection patterns and blocked; control characters stripped; messages capped at 2000 chars.
- **Admin auth** — JWT-signed sessions (`AUTH_SECRET`, min 32 chars).
- **Multi-tenant isolation** — `withTenant()` scopes every query to one organization.
- **Cost controls** — per-IP rate limiting, per-session token budget (default 40,000; graceful human handoff on exhaustion rather than a hard error), `maxOutputTokens: 350`, and a 10-message sliding window + rolling summary to bound quadratic context growth even on long conversations.
- **After-hours fee honesty** — the after-hours surcharge is keyed to *when the technician goes out* (a booking-target signal derived from the customer's chosen window/urgency), not the conversation clock, so a business-hours booking is never quoted a charge even when the chat happens after hours. The dollar amount is never spoken; the confirm route computes it server-side.
- **Safety** — emergency intents escalate deterministically and lock the session; escalation failures are logged so the audit trail is never silently lost.
- **Integration hardening** — inbound FSM webhooks verify an HMAC signature (fail-closed in production), derive the org from a server-side lookup (never the payload), dedupe on a per-org idempotency ledger, and run background work via `after()`. FSM-synced invoices are read-only in native money flows (no double-billing). Every integration call is degrade-safe — a missing/expired credential or API error never breaks a customer turn. See **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**.
- **Auditability** — `audit_log` records escalations, submissions, and 👍/👎 deflection-quality feedback.
- **Operational hygiene** — a daily Vercel cron (`vercel.json`, 03:00 UTC) cleans up abandoned sessions; secrets are validated at startup (encryption key length, missing `DATABASE_URL`).

## 8. Scaling Notes / What I'd Do Next

- **Distributed rate limiting** — the current sliding window is in-process; move to Redis (or Upstash) so limits hold across multiple serverless instances.
- **Trusted-proxy IP handling** — `x-forwarded-for` is currently taken at face value; parse it against a trusted proxy chain to prevent spoofed rate-limit keys.
- **Router eval harness** — _shipped_ (`src/lib/ai/eval/`, `npm run eval`): a labeled golden-transcript corpus gates critical safety properties in CI; the optional LLM-judge + model/prompt A/B layers run when keys are present. See [EVAL.md](EVAL.md). Next: grow the corpus and wire the judge into a pre-release sweep.
- **Response caching** — canned answers are already free, but FAQ responses and admin stat aggregations could be cached/edge-served to cut DB round-trips.
- **Semantic fallback tier** — an embedding-based matcher between the keyword router and the full LLM could resolve paraphrased FAQs at lower cost than a chat completion.
- **Searchable encrypted PII** — deterministic/blind-index encryption for fields that need lookup (e.g. returning-customer detection by phone) without giving up at-rest protection.
