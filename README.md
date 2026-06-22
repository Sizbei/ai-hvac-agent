# AI HVAC Agent

An AI-powered customer-service intake agent for HVAC companies. Customers describe a
heating or cooling problem — in a web chat **or over the phone** — and the agent
answers common questions instantly, runs a comprehensive ServiceTitan-style intake
(safety screen first, then the details that matter), turns the conversation into a
structured service request, and lets staff triage and dispatch from an admin dashboard.

Built with **Next.js 16**, **Qwen** (via Alibaba DashScope, OpenAI-compatible),
**Drizzle ORM**, and **Neon PostgreSQL**.

> **🔵 Live demo:** **https://ai-hvac-agent-lovat.vercel.app**
> &nbsp;·&nbsp; [Customer chat](https://ai-hvac-agent-lovat.vercel.app/chat)
> &nbsp;·&nbsp; [Admin dashboard](https://ai-hvac-agent-lovat.vercel.app/admin) (`admin@demo-hvac.com` / `admin123`)
> &nbsp;·&nbsp; [Interactive docs](https://ai-hvac-agent-lovat.vercel.app/docs.html)
>
> New to the project? See **[DEMO.md](DEMO.md)** for a 5-minute guided walkthrough and
> **[ARCHITECTURE.md](ARCHITECTURE.md)** for the system design.

![Customer chat](public/screenshots/chat.png)

## Highlights

- **Deterministic answers (0-token routing).** A 65-intent knowledge base + intent
  router resolves common questions, greetings, emergencies, and slot collection
  **without any LLM call** — the LLM (Qwen) is the fallback for novel input only.
  ~55% of assistant turns cost zero tokens.
- **Smart ServiceTitan-style intake.** A deterministic triage engine runs a
  best-in-class HVAC intake: a **safety screen first** (gas/CO/burning/flooding
  escalate), then qualifying questions (system fully down vs partly working, how
  long), a small required gate (**issue, urgency, address, and contact phone**), and
  skippable enrichment (system type, equipment age/brand, owner/renter, warranty,
  access notes, preferred arrival window, lead source, …). Quick-reply chips keep the
  common path 0-token; a `jobType` work classification is derived from the symptom.
  See **[docs/INTAKE-FIELDS.md](docs/INTAKE-FIELDS.md)**.
- **Structured extraction.** The conversation is distilled into a validated service
  request via `generateText` + tolerant JSON parsing that works reliably against
  DashScope.
- **Telephone agent (voice).** The same intake agent answers phone calls via Twilio,
  speaking with a natural **Amazon Polly neural voice** — try the live demo by calling
  **(231) 559-9669**. It reuses the exact router /
  extraction / state-machine core as the web chat — a voice persona, not a second
  bot — with signed webhooks and deterministic emergency escalation.
- **Long conversations.** A background **summary-compaction** step folds older turns
  into a rolling recap, so long calls and chats stay coherent and cheap; per-org turn
  and token ceilings are admin-tunable.
- **Safety first.** Gas/CO/fire/flooding messages escalate immediately with a
  conservative, qualifier-gated matcher; input is sanitized for prompt injection.
- **Admin dashboard.** Service-request queue with technician assignment, a searchable
  **Conversations** log of every saved chat **and phone call** (filterable by channel,
  with rolling summaries for long ones), an **AI Insights** dashboard (deflection
  rate, funnel, feedback), and a customer CRM.
- **Customer UX.** AI disclosure, intake progress stepper, suggested replies, 👍/👎
  feedback, conversation resume across refresh, collapsible history sidebar,
  accessibility (aria-live, reduced-motion), and one-tap human handoff.
- **Production-minded.** AES-256-GCM PII encryption, JWT admin auth, multi-tenant
  query scoping, per-IP rate limiting, per-session token budget, audit logging,
  file upload with magic-byte validation, and secure cookie enforcement.

## Quick Start

Prerequisites: Node.js 20+, a Neon (or any) PostgreSQL database, and a DashScope
API key (or any OpenAI-compatible endpoint, e.g. Ollama for local dev).

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run db:migrate           # create tables
npm run db:seed              # seed demo org, admin, technicians
npm run dev                  # http://localhost:3000
```

Demo admin login: `admin@demo-hvac.com` / `admin123`.

See [`.env.example`](.env.example) / the [User Guide](GUIDE.md#environment-variables-envlocal)
for the full list of environment variables (DB, AI provider, encryption, auth, etc.).
The phone agent is optional — set the `TWILIO_*` variables and point a Twilio number
at `/api/voice/incoming` to enable it (see [GUIDE.md](GUIDE.md#telephone-agent-voice)).

## Documentation

- **[GUIDE.md](GUIDE.md)** — product overview, customer + admin flows, env vars.
- **[docs/INTAKE-FIELDS.md](docs/INTAKE-FIELDS.md)** — the full intake field model + triage playbook (ServiceTitan-based).
- **[docs/API.md](docs/API.md)** — complete REST API reference (chat, admin, file upload, widget).
- **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)** — FieldPulse / Housecall Pro / Google Calendar: the integration pattern, the verified FieldPulse live-API contract, the invoice money-mirror, webhooks, crons, and env vars.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — Vercel and self-hosted deployment guide.
- **[docs/MIGRATION_GUIDE.md](docs/MIGRATION_GUIDE.md)** — feature comparison with Vercel chatbot.
- **[docs/HVAC_IMPROVEMENTS.md](docs/HVAC_IMPROVEMENTS.md)** — HVAC-specific features and recommendations.
- **[docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md)** — security audit findings and mitigations.
- **[docs/NOTES.md](docs/NOTES.md)** — running engineering-notes / research log (decisions, tools to adopt).
- **`/docs.html`** — interactive docs (run the app, open http://localhost:3000/docs.html):
  searchable sidebar, light/dark mode, copy buttons, example workflow, architecture.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run test:unit` | Unit tests (Vitest) — includes the offline eval gate |
| `npm run test:e2e` | Run E2E tests (Playwright) |
| `npm run eval` / `eval:ab` / `eval:prompts` / `eval:behavior` | Chatbot quality eval — deterministic gate + optional LLM-judge model/prompt A/B ([EVAL.md](EVAL.md)) |
| `npm run smoke:fieldpulse` | Live FieldPulse API smoke test (key-gated, manual; [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)) |
| `npm run db:migrate` / `db:seed` / `db:studio` | Database migrate / seed / studio |

## Project Structure

```
src/app/            App Router pages + API routes (chat, voice, session, admin)
src/components/      Chat UI + admin dashboard components (history sidebar, file upload)
src/lib/ai/         Intent router, knowledge base, extraction, guardrails,
                     compaction, phone agent + voice-turn orchestration,
                     multi-model provider (OpenAI, Ollama, fallbacks)
src/lib/voice/      Twilio signature validation, TwiML builders, voice config
src/lib/admin/      Tenant-scoped admin queries
src/lib/db/         Drizzle schema, migrations, seed
src/lib/streaming/  Streaming utilities and patterns (SSE, transport, hooks)
src/lib/storage/    Cloudflare R2/S3 storage client for file uploads
src/lib/rate-limit/ In-memory rate limiting with memory ceiling protection
e2e/                Playwright E2E test suites (chat, admin, security, embed)
.github/            CI/CD pipeline (type-check, lint, test, security audit)
public/docs.html    Interactive documentation
```

## License

MIT
