# Phase 1: Schema + AI Core - Context

**Gathered:** 2026-05-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up the complete backend for an AI-powered HVAC customer service agent: database schema with multi-tenancy and PII encryption, AI conversation engine with single-pass GPT-4o structured extraction, chat API with SSE streaming, session management, rate limiting, and comprehensive tests. No UI in this phase — API-only.

</domain>

<decisions>
## Implementation Decisions

### AI Conversation Design
- Warm + direct greeting: "Hi! I'm your HVAC assistant. What issue are you experiencing today?"
- Extraction triggers after 3 required fields collected: issue type + urgency + address
- Non-HVAC requests get polite redirect with suggestion, then re-focus on HVAC
- Auto-suggest human escalation after 15 conversation turns

### Data & Security Boundaries
- Application-level PII encryption using AES-256-GCM via Node crypto (portable across Postgres hosts)
- Session tokens delivered via httpOnly + Secure + SameSite=Strict cookies
- AI token budget: 10,000 tokens per session (~15-20 exchanges)
- Data retention: 90 days, automated cleanup via cron

### API & Architecture Patterns
- Response envelope format: { success: boolean, data?: T, error?: { message, code } }
- In-memory Map with sliding window for rate limiting (single Vercel instance MVP)
- Neon serverless driver (@neondatabase/serverless) with connection pooling
- Vitest for test framework (fast, Vite-native, ESM support)

### Claude's Discretion
- Specific Drizzle schema column types and index choices
- Pino logger configuration details
- Exact system prompt wording (beyond the agreed greeting and redirect patterns)
- Internal code organization within src/ directories

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Greenfield project — no existing code to reuse

### Established Patterns
- None yet — this phase establishes all foundational patterns

### Integration Points
- Phase 2 (Customer Chat UI) will consume: /api/chat, /api/session endpoints, useChat hook integration
- Phase 3 (Admin Dashboard) will consume: /api/admin/* endpoints, SSE stream, NextAuth session

</code_context>

<specifics>
## Specific Ideas

- Use Vercel AI SDK's useChat and streamText for streaming (native SSE)
- Use Zod schemas shared between extraction and API validation
- Conversation state machine as pure function (easy to test independently)
- Every DB query must include organization_id via withTenant helper

</specifics>

<deferred>
## Deferred Ideas

- Multi-stage AI pipeline (GPT-4o-mini classifier + GPT-4o extractor) — v2 optimization
- Redis-backed rate limiting — v2 when traffic justifies it
- Weighted dispatch scoring algorithm — v2 after real dispatch patterns observed
- Voice/phone intake via Vapi/Twilio — future phase

</deferred>
