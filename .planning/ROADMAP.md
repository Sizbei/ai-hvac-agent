# Roadmap — v1.0 AI HVAC Customer Service Agent

## Milestone: v1.0 — MVP Launch

### Phase 1: Schema + AI Core
- **Goal**: Stand up the database, encryption layer, AI extraction pipeline, and core API routes
- **Plans:** 5 plans
- **Success Criteria**:
  - Next.js 15 project initialized with all dependencies
  - Drizzle ORM schema with 6 tables (organizations, users, customer_sessions, messages, service_requests, audit_log)
  - PII column-level encryption via AES-256-GCM (app-level, Node crypto)
  - Multi-tenancy enforced via organization_id + withTenant helper
  - Single-pass GPT-4o structured extraction with Zod schemas
  - Prompt injection guardrails (input sanitization, system prompt hardening, output validation)
  - Per-session AI token budget enforcement
  - 4+2 conversation state machine (chatting/extracting/confirmed/submitted + escalated/abandoned)
  - Chat API with SSE streaming via Vercel AI SDK
  - Session management with cryptographic UUID tokens
  - Structured logging with PII redaction via Pino
  - Rate limiting on chat and session creation endpoints
  - 50+ integration tests with 80%+ coverage on core modules
  - Database seed with demo organization, admin user, and technicians
- **Status**: Complete

Plans:
- [x] 01-01-PLAN.md — Project setup, Drizzle schema, DB connection, encryption, logging
- [x] 01-02-PLAN.md — AI extraction engine, state machine, token budget, guardrails
- [x] 01-03-PLAN.md — Session management, chat API with SSE, rate limiting, response envelope
- [x] 01-04-PLAN.md — Database migrations and seed data
- [x] 01-05-PLAN.md — Unit tests for all core modules (50+ tests, 80%+ coverage)

### Phase 2: Customer Chat UI
- **Goal**: Build a premium, streaming chat interface for HVAC customers
- **Depends on**: Phase 1
- **Plans:** 4 plans
- **Success Criteria**:
  - shadcn/ui + Framer Motion design system configured
  - Chat container with streaming responses via useChat hook
  - Message bubbles with slide-in animations (user right-aligned, assistant left-aligned)
  - Typing indicator with animated dots during AI streaming
  - Chat header with status dot and "Talk to a Human" escalation button
  - Extraction summary card showing extracted fields in real-time
  - Confirmation flow (customer reviews and confirms extracted data)
  - Escalation dialog for human handoff
  - Message renderer with XSS prevention (no dangerouslySetInnerHTML)
  - Minimal landing page with "Get Help Now" CTA
  - Post-submission success page with reference number
  - Error boundaries and loading skeletons on all pages
  - Mobile-responsive design (most customers on phones)
- **Status**: Complete

Plans:
- [x] 02-01-PLAN.md — shadcn/ui + motion + Inter font + design tokens + core components
- [x] 02-02-PLAN.md — Chat UI shell components (message bubbles, header, input, typing indicator) + landing page
- [x] 02-03-PLAN.md — API integration (useChat hook, extraction card/pills, confirmation flow, escalation dialog, success page)
- [x] 02-04-PLAN.md — Error boundaries and loading skeletons for all routes

### Phase 3: Admin Dashboard + Manual Dispatch
- **Goal**: Authenticated admin dashboard for viewing requests and assigning technicians
- **Depends on**: Phase 1
- **Plans:** 6 plans
- **Success Criteria**:
  - JWT auth with jose library and 24-hour expiry (Edge-compatible with Next.js 16 proxy.ts)
  - Admin proxy.ts protecting /admin/* routes (Next.js 16 pattern, replacing deprecated middleware)
  - Admin API routes scoped by organization_id
  - Request queue table with status filters and polling live updates (10s interval)
  - Request detail panel with conversation transcript and extracted data
  - Manual technician assignment dialog
  - Technician CRUD (list, create, edit, deactivate)
  - Stats cards (Pending, Assigned Today, In Progress, Completed Today)
  - Audit logging on all state changes
  - Responsive sidebar layout (collapsible on mobile)
  - 20+ additional integration tests
- **Status**: Complete

Plans:
- [x] 03-01-PLAN.md — Admin auth: JWT via jose, login/logout API, proxy.ts route protection
- [x] 03-02-PLAN.md — Admin API routes: requests, technicians, stats, assignment, audit logging
- [x] 03-03-PLAN.md — Admin login page, sidebar layout, navigation shell
- [x] 03-04-PLAN.md — Request queue table, detail sheet, filters, polling, technician assignment
- [x] 03-05-PLAN.md — Technician CRUD page, stats cards
- [x] 03-06-PLAN.md — Integration tests (20+ tests for admin auth and API routes)

### Phase 4: Polish + Deploy
- **Goal**: Harden error handling, add observability, deploy to production, verify end-to-end
- **Depends on**: Phase 2, Phase 3
- **Plans:** 3 plans
- **Success Criteria**:
  - OpenAI data handling policy documented (DPA, training opt-out)
  - AI metrics tracking (latency, tokens, error rate per call)
  - Request ID middleware for distributed tracing
  - Standardized API response envelope (no stack trace leaks)
  - Session cleanup cron (expire sessions, 90-day data retention)
  - Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
  - Vercel deployment configuration
  - Neon PostgreSQL production database provisioned
  - Database migrations run against production
  - Seed data for production org + admin
  - Full end-to-end smoke test (chat -> confirm -> admin sees request -> assign tech)
  - All 195+ tests passing
- **Status**: Complete

Plans:
- [x] 04-01-PLAN.md — AI metrics tracking, session cleanup cron endpoint, tests
- [x] 04-02-PLAN.md — PRIVACY.md, vercel.json, DEPLOY.md deployment runbook
- [x] 04-03-PLAN.md — End-to-end smoke test, final test suite and build verification
