# AI HVAC Agent — User Guide & Product Overview

## What This Is

An AI-powered customer service agent for HVAC companies. Customers describe their heating/cooling problem in a chat, the AI extracts a structured service request (issue type, urgency, address, contact info), and admins manage the queue from a dashboard. Built with Next.js 16, Qwen (via DashScope), and Neon PostgreSQL.

---

## Quick Start

### Prerequisites

- Node.js 20+
- A Neon PostgreSQL database (free tier works)
- A DashScope API key from Alibaba Cloud (for Qwen AI)

### Run Locally

```bash
cd ai-hvac-agent
npm install
npm run db:migrate    # create tables
npm run db:seed       # seed demo data
npm run dev           # start at http://localhost:3000
```

### Environment Variables (`.env.local`)

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL pooled connection string |
| `AI_BASE_URL` | DashScope OpenAI-compatible endpoint |
| `AI_API_KEY` | Your DashScope API key |
| `AI_MODEL` | Model name (default: `qwen-plus`) |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM PII encryption |
| `AUTH_SECRET` | JWT signing secret for admin auth (min 32 chars) |
| `CRON_SECRET` | Secret for the session cleanup cron job |

Generate secrets with: `openssl rand -hex 32`

---

## Using the App

### Customer Flow (Public)

**1. Landing Page** — `http://localhost:3000`

The entry point. A single "Get Help Now" button sends customers into the AI chat. Designed mobile-first — centered layout, large tap target, 24/7 availability messaging.

**2. AI Chat** — `http://localhost:3000/chat`

This is where the AI conversation happens:

- A session is created automatically when the page loads
- The customer describes their HVAC issue in natural language
- The AI asks follow-up questions to collect: issue type, urgency, address, name, phone, email
- **Extraction pills** appear at the top as each field is collected (Issue Type, Urgency, Address) — giving the customer visual progress feedback
- Once all fields are collected, an **extraction card** appears showing the full summary
- The customer reviews and clicks "Confirm & Submit"
- A **confirmation dialog** gives one final review before submitting

**Guardrails built in:**
- 2000-character message limit
- Input sanitization (prompt injection prevention)
- Token budget per session (prevents runaway AI costs)
- 15-turn escalation hint (suggests human handoff if conversation is long)
- Rate limiting per IP

**3. Escalation** — "Talk to a Human" button in the chat header

If the customer prefers human help, they can escalate at any time. This shows a phone number and marks the session as `escalated`.

**4. Success Page** — `http://localhost:3000/chat/success?ref=REF-XXXXX`

After confirmation, the customer sees their reference number and a promise that a technician will reach out within 2 hours.

### Admin Flow (Protected)

**1. Login** — `http://localhost:3000/admin/login`

Default credentials (change after first login):
- Email: `admin@demo-hvac.com`
- Password: `admin123`

**2. Service Requests Dashboard** — `http://localhost:3000/admin/requests`

The main admin screen. Shows:

- **Stats cards** (auto-refresh every 30s):
  - Pending Requests (yellow)
  - Assigned Today (blue)
  - In Progress (purple)
  - Completed Today (green)

- **Filter bar**: All | Pending | Assigned | In Progress | Completed | Cancelled

- **Request table**: Reference #, Customer, Issue, Urgency (color-coded), Status, Date, Assigned To

- **Request detail sheet** (click any row): Slides in from the right showing:
  - Customer information (name, phone, email, address)
  - Issue details (type, description)
  - Technician assignment dropdown
  - Full conversation transcript (user messages in blue, AI in gray)

**3. Technician Management** — `http://localhost:3000/admin/technicians`

- View all technicians in a table (name, email, status, join date)
- **Add Technician**: Click "+ Add Technician", fill in name/email/password
- **Edit Technician**: Click "Edit" to change name, email, or toggle active/inactive
- Only active technicians appear in the assignment dropdown on service requests

### Session States

Each customer chat session moves through these states:

```
chatting → extracting → confirmed → submitted
                ↘ escalated
                ↘ abandoned (timeout)
```

- **chatting**: Active conversation
- **extracting**: AI is collecting structured fields
- **confirmed**: Customer reviewed and confirmed the extraction
- **submitted**: Service request created and visible to admins
- **escalated**: Customer requested human help
- **abandoned**: Session expired (cleaned up by daily cron)

---

## Architecture

```
src/
├── app/                          # Next.js App Router pages
│   ├── page.tsx                  # Landing page
│   ├── chat/
│   │   ├── page.tsx              # AI chat interface
│   │   └── success/page.tsx      # Post-submission confirmation
│   ├── admin/
│   │   ├── login/page.tsx        # Admin authentication
│   │   └── (dashboard)/
│   │       ├── requests/page.tsx # Service request queue
│   │       └── technicians/page.tsx # Technician management
│   └── api/
│       ├── chat/route.ts         # Streaming AI chat endpoint
│       ├── session/              # Session create, confirm, escalate
│       ├── auth/                 # Login, logout
│       ├── admin/                # Stats, requests, technicians CRUD
│       └── cron/cleanup/route.ts # Daily session cleanup
├── components/
│   ├── chat/                     # 11 chat UI components
│   ├── admin/                    # 9 dashboard components
│   └── ui/                       # Shared primitives (Button, Card, etc.)
├── hooks/
│   ├── use-chat-session.ts       # Chat state, streaming, extraction tracking
│   ├── use-admin-requests.ts     # Request list with 10s polling
│   └── use-admin-technicians.ts  # Technician list
└── lib/
    ├── ai/                       # AI provider, extraction, guardrails, metrics
    ├── db/                       # Drizzle schema, migrations, seed
    └── ...                       # Auth, encryption, logging, rate limiting
```

### Key Design Decisions

- **PII encryption**: Customer names, phones, emails, and addresses are encrypted at rest with AES-256-GCM. The `ENCRYPTION_KEY` is required to decrypt.
- **Multi-tenant**: All queries are scoped by `organization_id` via a `withTenant()` helper. The demo uses a single org, but the schema supports multiple.
- **Streaming**: Chat responses stream token-by-token via the Vercel AI SDK's `streamText()`. Extraction runs in the `onFinish` callback after the stream completes.
- **Token budget**: Each session has a configurable token budget to prevent cost overruns.

---

## Deployment (Vercel)

See [DEPLOY.md](./DEPLOY.md) for the full runbook. The short version:

1. Connect this repo to Vercel
2. Set all env vars in the Vercel dashboard
3. Push to `main` — Vercel auto-deploys
4. The `vercel.json` configures a daily cron job at 3 AM UTC for session cleanup

---

## Roadmap

### Desktop App (Tauri)

Wrap the web app in a native desktop window using Tauri:
- ~5 MB binary (uses OS-native WebKit on macOS)
- Points at `localhost:3000` during dev, bundles production build for release
- Native window chrome, dock icon, auto-updater
- No Rust knowledge needed for the wrapper — just configuration

### CRM (Customer Relationship Management)

The current app treats each chat session independently. A CRM adds persistent customer profiles:

**New features:**
- **Customer profiles** — deduplicated from service request data (name, address, phone, email)
- **Equipment registry** — track installed HVAC units per customer (make, model, serial, warranty date)
- **Service history timeline** — all past requests linked to the customer with outcomes and tech notes
- **Follow-up reminders** — maintenance schedules, warranty expirations, post-service check-ins
- **Returning customer detection** — when a chat session matches an existing customer, pre-populate context so the AI gives better help

**New screens:**
- Customer list (searchable, filterable)
- Customer detail page (contact info, equipment tab, service history tab, notes tab)
- Follow-up queue (upcoming reminders across all customers)

**Reference designs:** ServiceTitan (industry leader — unified customer profile with equipment and job history on one screen), Housecall Pro (address-centric model, handles tenant turnover), Jobber (drag-and-drop scheduling from service history).

### UX Improvements

**Chat:**
- Quick-reply suggestion buttons (e.g., "AC not cooling", "Furnace won't start")
- Progress stepper showing where the customer is in the flow
- Branded typing indicator with company name

**Dashboard:**
- Kanban board view as an alternative to the table (drag requests between status columns)
- Technician workload visualization
- Customer satisfaction tracking post-service

**Design system:**
- Trust-oriented palette: deep navy/slate primary, warm orange accents, clean white backgrounds
- Consistent spacing scale and component library
- Motion design: subtle transitions for sheet slides, card entries, status changes
