# AI HVAC Agent

An AI-powered intake, triage, and dispatch platform for HVAC companies. Customers
describe a heating, cooling, or refrigeration problem — **in a web chat or over the
phone** — and the agent answers common questions instantly, runs a ServiceTitan-style
intake (safety screen first, then the details that matter), turns the conversation into
a structured service request, and hands staff an admin console to triage, dispatch, and
report on the work.

Built with **Next.js 16**, **Qwen** (via Alibaba DashScope, OpenAI-compatible),
**Drizzle ORM**, and **Neon PostgreSQL**.

> **🔵 Live demo — [ai-hvac-agent-lovat.vercel.app](https://ai-hvac-agent-lovat.vercel.app)**
> · [Customer chat](https://ai-hvac-agent-lovat.vercel.app/chat)
> · [Admin console](https://ai-hvac-agent-lovat.vercel.app/admin) — sign in with `admin@demo-hvac.com` / `admin123` (demo only)
> · Or call the voice agent at **(231) 559-9669**

![Landing page](public/screenshots/landing.png)

---

## Two ways in

The product has two audiences, and the fastest way to understand it is to try both:

| | Entry point | What you'll see |
|---|---|---|
| **Customers** | `/chat` (web) or the phone number | The AI intake assistant — asks about the problem, screens for safety, collects the details, and books the job. |
| **Staff** | `/admin` (the Service Console) | Request queue, conversation log, dispatch board, AI insights, and a customer CRM. |

**New here?** Read **[DEMO.md](DEMO.md)** for a 5-minute guided walkthrough, then
**[ARCHITECTURE.md](ARCHITECTURE.md)** for the system design.

---

## Screenshots

| Customer chat | Service requests |
|---|---|
| ![Customer chat](public/screenshots/chat.png) | ![Service requests](public/screenshots/admin-requests.png) |

| AI Insights | Conversations |
|---|---|
| ![AI Insights](public/screenshots/admin-insights.png) | ![Conversations](public/screenshots/admin-conversations.png) |

---

## Quick start

Prerequisites: **Node.js 20+**, a **PostgreSQL** database (Neon or any), and a
**DashScope** API key (or any OpenAI-compatible endpoint, e.g. Ollama for local dev).

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run db:migrate           # create tables
npm run db:seed              # seed demo org, admin, technicians
npm run dev                  # → http://localhost:3000
```

Then open **http://localhost:3000/chat** (customer) and **/admin** (staff, sign in with
the seeded `admin@demo-hvac.com` / `admin123` — dev/demo only).

See [`.env.example`](.env.example) and the [User Guide](GUIDE.md#environment-variables-envlocal)
for the full environment-variable list. The phone agent is optional — set the `TWILIO_*`
variables and point a Twilio number at `/api/voice/incoming` (see
[GUIDE.md](GUIDE.md#telephone-agent-voice)).

---

## What it does

- **Deterministic answers (0-token routing).** A knowledge base + intent router resolves
  common questions, greetings, emergencies, and slot collection **without any LLM call** —
  the LLM (Qwen) is the fallback for novel input only. ~70% of assistant turns cost zero
  tokens (see the live [AI Insights](public/screenshots/admin-insights.png)).
- **Smart ServiceTitan-style intake.** A deterministic triage engine runs a **safety
  screen first** (gas/CO/burning/flooding escalate), then qualifying questions, a small
  required gate (issue, urgency, address, contact phone), and skippable enrichment
  (system type, equipment age/brand, warranty, access notes, arrival window, …). See
  **[docs/INTAKE-FIELDS.md](docs/INTAKE-FIELDS.md)**.
- **Telephone agent (voice).** The same intake agent answers phone calls via Twilio with
  a natural neural voice — reusing the exact router / extraction / state-machine core as
  the web chat, with signed webhooks and deterministic emergency escalation.
- **Long conversations.** Background summary-compaction folds older turns into a rolling
  recap so long calls and chats stay coherent and cheap; per-org turn/token ceilings are
  admin-tunable.
- **Admin Service Console.** Request queue with technician assignment, a searchable
  **Conversations** log of every saved chat **and phone call**, a **dispatch** board,
  **AI Insights** (deflection rate, funnel, feedback), and a customer CRM.
- **Confidence-gated autodispatch.** Skills → travel → load scoring auto-assigns a clear
  winner and routes ambiguous jobs to an exception queue.
- **Invoices & collections.** A collections workspace — aging summary (Outstanding /
  Overdue >30d / Collected this month), an overdue-first list with one-click SMS
  **reminders** (atomic 6h cooldown + re-chase), **copy pay link**, and a guarded
  **void** — plus a real service-invoice **document** with **take payment** / refund.
  Void/refunded invoices are never dunned; synced invoices stay read-only. See
  **[docs/INVOICES.md](docs/INVOICES.md)**.
- **Integrations.** Read-only invoice mirroring from **FieldPulse** and **Housecall Pro**,
  plus Google Calendar — see **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**.
- **Production-minded.** AES-256-GCM PII encryption, JWT admin auth, multi-tenant query
  scoping, per-IP rate limiting, per-session token budget, audit logging, secure-cookie
  enforcement, and a public `/api/health` readiness probe.

---

## Documentation

**Product & usage**
- **[GUIDE.md](GUIDE.md)** — product overview, customer + admin flows, env vars.
- **[DEMO.md](DEMO.md)** — 5-minute guided walkthrough.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design.
- **[docs/INTAKE-FIELDS.md](docs/INTAKE-FIELDS.md)** — intake field model + triage playbook.

**Reference**
- **[docs/API.md](docs/API.md)** — REST API reference (chat, admin, file upload, widget).
- **[docs/DISPATCH.md](docs/DISPATCH.md)** — dispatch/scheduling pipeline (scoring, confidence gate, duration, tech location) + roadmap.
- **[docs/INVOICES.md](docs/INVOICES.md)** — invoices & collections workspace (business rules, reminders, void, query + HTTP API, screens).
- **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)** — FieldPulse / Housecall Pro / Google Calendar.
- **[docs/KNOWLEDGE-BASE-CATALOG.md](docs/KNOWLEDGE-BASE-CATALOG.md)** — the deterministic FAQ intents.
- **[EVAL.md](EVAL.md)** — the conversation-quality eval harness.
- **`/docs.html`** — interactive docs (run the app, open http://localhost:3000/docs.html).

**Operations**
- **[DEPLOY.md](DEPLOY.md)** / **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — Vercel + self-hosted deployment.
- **[MIGRATIONS.md](MIGRATIONS.md)** — running and authoring database migrations.
- **[OBSERVABILITY.md](OBSERVABILITY.md)** — logging and monitoring.
- **[TESTING.md](TESTING.md)** — test strategy and how to run the suites.
- **[docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md)** — security audit findings and mitigations.
- **[PRIVACY.md](PRIVACY.md)** — PII handling and data policy.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run test:unit` | Unit tests (Vitest) — includes the offline eval gate |
| `npm run test:e2e` | E2E tests (Playwright) |
| `npm run eval` / `eval:ab` / `eval:prompts` / `eval:behavior` | Chatbot-quality eval ([EVAL.md](EVAL.md)) |
| `npm run smoke:fieldpulse` | Live FieldPulse API smoke test (key-gated, manual) |
| `npm run db:migrate` / `db:seed` / `db:studio` | Database migrate / seed / studio |

---

## Project structure

```
src/app/            App Router pages + API routes (chat, voice, session, admin, tech)
src/components/     Chat UI + admin console components
src/lib/ai/         Intent router, knowledge base, extraction, guardrails, compaction,
                    phone-agent + voice-turn orchestration, dispatch scoring
src/lib/voice/      Twilio signature validation, TwiML builders, voice config
src/lib/admin/      Tenant-scoped admin + scheduling queries
src/lib/tech/       Technician field app (location tracking, job summary)
src/lib/integrations/  FieldPulse / Housecall Pro invoice mirrors
src/lib/db/         Drizzle schema, migrations, seed
drizzle/            SQL migrations
e2e/                Playwright E2E suites (chat, admin, security, embed)
.github/            CI/CD pipeline (type-check, lint, test, security audit)
public/docs.html    Interactive documentation
```

---

## License

MIT
