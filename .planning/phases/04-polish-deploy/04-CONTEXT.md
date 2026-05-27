# Phase 4: Polish + Deploy - Context

**Gathered:** 2026-05-27
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Harden error handling, add observability (AI metrics tracking, request ID tracing), configure security headers, set up session cleanup cron, prepare Vercel deployment configuration, and verify the complete end-to-end flow. This is the final phase before MVP launch.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

Key deliverables from ROADMAP:
- OpenAI data handling policy documented (PRIVACY.md)
- AI metrics tracking (latency, tokens, error rate per call)
- Request ID middleware for distributed tracing
- Standardized API response envelope (no stack trace leaks in production)
- Session cleanup cron (expire sessions, 90-day data retention)
- Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- Vercel deployment configuration (vercel.json)
- Database migrations run against production
- Full end-to-end smoke test
- All 195+ tests passing

</decisions>

<code_context>
## Existing Code Insights

### What Already Exists
- src/proxy.ts — already has security headers and request ID generation
- src/lib/logger.ts — Pino logger with PII redaction
- src/lib/api-response.ts — standardized response envelope
- All API routes already use the response envelope
- 195 tests passing across 14 files

### What's Missing
- AI call metrics (latency, token usage tracking) — need to wrap extract.ts
- PRIVACY.md document
- vercel.json deployment config
- Session cleanup logic (cron or scheduled function)
- End-to-end verification that all flows work together

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to ROADMAP phase description and success criteria.

</specifics>

<deferred>
## Deferred Ideas

None — discuss phase skipped.

</deferred>
