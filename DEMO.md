# AI HVAC Agent — 5-Minute Demo Script

A guided walkthrough for showing this project live. Follow the scenes in order; each
one lists exactly what to type, what the audience will see, and a one-line engineering
talking point.

> **Live demo:** https://ai-hvac-agent-lovat.vercel.app
> &nbsp;·&nbsp; chat → `/chat` &nbsp;·&nbsp; admin → `/admin` (`admin@demo-hvac.com` / `admin123`)
> &nbsp;·&nbsp; docs → `/docs.html`
> The admin dashboard is pre-seeded with realistic conversations, so it looks alive.

---

## TL;DR

This is an AI customer-service intake agent for HVAC companies. A customer describes a
heating/cooling problem in a web chat or over the phone — the same AI agent handles both,
with phone replies spoken in a natural Amazon Polly neural voice. The agent collects the
details that matter (issue, urgency, address, contact), turns the conversation into a
structured service request, and staff triage and dispatch it from an admin dashboard. **The headline is cost
engineering:** a deterministic 65-intent router answers common questions, greetings,
emergencies, and slot collection with **zero LLM tokens** (~55% of assistant turns) —
the LLM (Qwen via Alibaba DashScope) is only the fallback for genuinely novel input.
It's a full-stack **Next.js 16 + Drizzle + Neon PostgreSQL** app with AES-256-GCM PII
encryption, JWT admin auth, multi-tenant scoping, and audit logging.

---

## Setup (60 seconds)

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL, AI_API_KEY, ENCRYPTION_KEY, AUTH_SECRET
npm run db:migrate           # create tables
npm run db:seed              # seed demo org, admin, 3 technicians
npm run dev                  # http://localhost:3000
```

Secrets: generate `ENCRYPTION_KEY` / `AUTH_SECRET` with `openssl rand -hex 32`.

| What | Where |
|---|---|
| Customer chat | `http://localhost:3000/chat` (or `https://ai-hvac-agent-lovat.vercel.app/chat`) |
| Admin dashboard | `http://localhost:3000/admin` (or `https://ai-hvac-agent-lovat.vercel.app/admin`) |
| Interactive docs | `http://localhost:3000/docs.html` |
| Admin login | `admin@demo-hvac.com` / `admin123` |

> Tip: open two browser tabs before you start — one on `/chat`, one ready for `/admin`.
> For Scene 5 you'll want a **fresh** chat session (new incognito window or clear the
> session cookie), because the emergency in Scene 5 locks its session.

---

## The 5-Minute Live Walkthrough

### Scene 1 — Greeting (0 tokens)

**Type as the customer:**

```
hi
```

**What the audience sees:** an instant reply introducing the AI, disclosing it can make
mistakes, and offering "Talk to a Human." No typing indicator appears — the branded
"HVAC Assistant is typing…" indicator only shows on the LLM path, so canned replies
never fake latency.

> **Engineering:** This turn never touched the LLM. The `meta-greeting` intent matched
> deterministically and returned a canned response with `tokensUsed: 0`.

### Scene 2 — A common FAQ (0 tokens)

**Type as the customer:**

```
do you charge for estimates?
```

(Or try `what are your hours?`)

**What the audience sees:** an immediate, on-brand answer explaining a technician
provides the quote after assessing in person — still zero latency, zero tokens.

> **Engineering:** The `faq-pricing` intent. The router normalizes the message, scores it
> against 65 intents, applies a confidence gate, and serves canned FAQ text. FAQ/greeting
> answers are treated as "low-harm" and allowed at a lower confidence threshold (0.45)
> than slot-collecting actions (0.7).

### Scene 3 — A real problem (LLM engages)

**Type as the customer:**

```
my AC isn't cooling and the house is 85 degrees
```

**What the audience sees:** the typing indicator appears (this one hit the LLM), the
assistant streams an empathetic reply and asks for the service address, and the **"Step
X of 3" intake stepper** at the top lights up its first check chip (Issue Type detected).

> **Engineering:** This is open-ended, so it falls back to Qwen via `streamText()`. The
> reply streams token-by-token; in parallel, a background extraction call distills the
> conversation into structured slots. Output is capped at 350 tokens and only the last
> 10 messages are sent to the model, so cost-per-turn stays flat in long chats.

### Scene 4 — Provide details (extraction completes)

**Type as the customer (one message or two):**

```
the address is 742 Evergreen Terrace, Springfield
```

```
my name is Jane Doe, phone 555-123-4567
```

**What the audience sees:** the stepper fills in (Address, Urgency), then an **extraction
card** appears summarizing the full request. The customer clicks **Confirm & Submit**,
reviews the confirmation dialog, and lands on a success page with a reference number like
**`HVAC-3F9A2B7C`** and a "technician follows up within 2 hours" promise.

> **Engineering:** Once the issue is known, supplying a bare address/phone/email is a
> "slot-provision" turn — the router fills it **deterministically via regex** (no LLM
> call) even though there's no intent for a raw address. When all required slots
> (issue, urgency, address) are present, the state machine promotes the session to
> `confirmed`; confirming generates the `HVAC-XXXXXXXX` reference and creates the
> service request.

### Scene 5 — Emergency (use a FRESH chat session)

> Open a new incognito window at `/chat` first — this scene locks the session.

**Type as the customer:**

```
I smell gas
```

**What the audience sees:** an immediate safety escalation — leave the home, avoid
switches/flames, call the gas utility or 911 — and the session **locks** (no further
messages accepted).

> **Engineering:** Emergencies short-circuit everything **before** any LLM call, at a
> deliberately low confidence threshold (0.25). But to avoid false alarms, emergency
> intents are **qualifier-gated**: `emergency-gas-smell` only fires when a danger word
> (smell/leak/odor) co-occurs, and negation guards whitelist safe phrases like "gas
> furnace" or "emergency heat" (an HVAC mode). The session is escalated and an audit-log
> entry is written even on this 0-token path.

### Scene 6 — Admin dashboard

Open `https://ai-hvac-agent-lovat.vercel.app/admin` and log in with `admin@demo-hvac.com` / `admin123`.

1. **Service Requests queue** — the request from Scene 4 appears with its reference #,
   issue, color-coded urgency, and status. Open the detail sheet on the right and
   **assign a technician** from the dropdown (Mike Johnson / Sarah Chen / David Martinez,
   seeded). Stats cards auto-refresh every 30s.
2. **Conversations** — a searchable log of **every** saved chat, including ones that
   never became a request (e.g. the Scene 5 emergency). Open one to see the full
   transcript alongside extracted data. Nothing a customer typed is ever lost.
3. **AI Insights** — the payoff slide. Show the **headline deflection rate** (share of
   replies answered with 0 LLM tokens), the **funnel** (conversations → requests →
   escalated → abandoned), deterministic-vs-LLM reply counts, total tokens used, and the
   👍/👎 feedback tallies.

> **Engineering:** All admin queries are tenant-scoped via a `withTenant()` helper.
> AI Insights is computed entirely from existing tables — no extra schema. Conversations
> reads straight from `customer_sessions` + `messages`.

---

## What to Emphasize to Employers

- **Deterministic router design.** A pure, testable function: normalize → score 65
  intents → priority/confidence gate → verdict. Emergency short-circuit, compound-message
  detection, gibberish detection, and a per-action confidence band — all before any model
  call.
- **Cost engineering.** ~55% of assistant turns cost 0 tokens. On the LLM path, output is
  capped (350 tokens) and history is windowed (last 10 messages) to keep cost-per-turn
  flat. The whole router is behind a single `ROUTER_ENABLED` kill-switch.
- **Safety-first escalation.** Gas/CO/fire/flooding escalate immediately, qualifier-gated
  to avoid false alarms, with negation guards for safe phrases — and the audit trail is
  written even when escalation costs zero tokens.
- **Tolerant extraction against a non-compliant endpoint.** DashScope's OpenAI-compatible
  API doesn't honor structured-output mode, so instead of `generateObject` the code
  instructs a JSON shape and parses it tolerantly (handles fenced/chatty output,
  nullish-value normalization) to stay reliable.
- **Security posture.** AES-256-GCM PII encryption at rest, JWT admin auth, multi-tenant
  query scoping, per-IP rate limiting, per-session token budget, prompt-injection input
  sanitization, and audit logging.
- **Modern full stack.** Next.js 16 (App Router, streaming), Drizzle ORM, Neon
  PostgreSQL, Vercel AI SDK, daily session-cleanup cron.

---

## Q&A Prep

**Q: How do you keep LLM costs down?**
A deterministic 65-intent router resolves common questions, greetings, emergencies, and
slot-provision turns with zero tokens (~55% of turns). On the LLM path I cap output at
350 tokens and send only the last 10 messages, so cost-per-turn doesn't grow with
conversation length. The whole layer is toggleable via `ROUTER_ENABLED`.

**Q: How do you handle a gas-leak message?**
It short-circuits before any LLM call. Emergency intents match at a low confidence
threshold (0.25) but are qualifier-gated — `emergency-gas-smell` requires a danger word
like "smell" or "leak" to co-occur, and negation guards exempt safe phrases ("gas
furnace", "emergency heat"). The session is escalated, locked, and an audit entry is
written.

**Q: Why not use `generateObject` for extraction?**
The Qwen/DashScope OpenAI-compatible endpoint doesn't honor strict `json_schema`
structured-output mode — it returns prose or fenced text the SDK can't parse, throwing
`AI_JSONParseError` on every turn. So I instruct the exact JSON shape via `generateText`
and parse it tolerantly: strip markdown fences, locate the JSON object in chatty output,
and normalize nullish values ("none", "n/a", "") to `null`.

**Q: How is PII protected?**
Customer names, phones, emails, and addresses are encrypted at rest with AES-256-GCM
(the `ENCRYPTION_KEY` is required to decrypt). Admin access is JWT-gated, all queries are
scoped by `organization_id`, input is sanitized for prompt injection, and there's per-IP
rate limiting plus a per-session token budget.

**Q: Why a deterministic router instead of just prompting the LLM well?**
Determinism buys correctness, latency, and cost. Canned safety responses can't drift or
hallucinate, common FAQs answer instantly with no token spend, and behavior is unit-
testable as a pure function. The LLM is reserved for what it's actually good at — novel,
ambiguous, free-form input — and is always reachable as a fallback.

**Q: How would you scale this?**
The schema is already multi-tenant (`organization_id` scoping via `withTenant()`), so
multiple HVAC companies share one deployment. Per-org knowledge bases and FAQ text could
be data-driven. Rate limiting and token budgets bound abuse and cost. The CRM groundwork
(customer profiles, equipment registry, service history) is on the roadmap to turn
one-off sessions into persistent customer relationships.

**Q: What happens to conversations that never become a request?**
Nothing is lost. The Conversations log reads directly from `customer_sessions` and
`messages`, so abandoned, escalated, and incomplete chats are all searchable in the
admin dashboard with full transcripts.

**Q: Can customers call instead of chat?**
Yes — a Twilio voice number routes calls to the same agent. It reuses the exact
router/extraction/state-machine core as the web chat (a voice persona, not a second bot),
speaks with an Amazon Polly neural voice, captures speech via Twilio's built-in
recognition, validates every webhook's signature, and escalates emergencies the same way.
Phone conversations show up in the admin Conversations view with a Phone channel badge.

**Q: How do you keep long conversations coherent without runaway cost?**
A background compaction step folds older turns into a rolling summary that's prepended to
the model context, so only a summary plus the recent window is ever sent. This keeps cost
flat and lets the per-org turn ceiling default to 40.
