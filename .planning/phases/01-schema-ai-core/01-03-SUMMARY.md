---
phase: 01-schema-ai-core
plan: 03
subsystem: api
tags: [next.js, vercel-ai-sdk, sse, streaming, rate-limiting, cookies, session-management, drizzle-orm]

# Dependency graph
requires:
  - "01-01: Drizzle schema, crypto, logger, DB connection, withTenant"
  - "01-02: AI engine (extraction, state machine, guardrails, token budget, system prompt)"
provides:
  - "Response envelope helpers (successResponse, errorResponse) with { success, data?, error? } format"
  - "In-memory sliding window rate limiter with configurable limits per endpoint"
  - "Session token management with httpOnly+Secure+SameSite=Strict cookies"
  - "POST /api/session (create session with cookie)"
  - "GET /api/session (session status and message history)"
  - "POST /api/session/confirm (validate, encrypt PII, create service request)"
  - "POST /api/session/escalate (transition to escalated state)"
  - "POST /api/chat (SSE streaming GPT-4o with extraction and state machine)"
  - "Security middleware with X-Request-Id, X-Content-Type-Options, X-Frame-Options, Referrer-Policy"
affects: [01-04-seed-data, 01-05-tests, 02-customer-chat-ui]

# Tech tracking
tech-stack:
  added: []
  patterns: [response-envelope, sliding-window-rate-limiter, session-cookie-auth, sse-streaming-via-vercel-ai-sdk, post-stream-extraction]

key-files:
  created:
    - src/lib/api-response.ts
    - src/lib/rate-limit.ts
    - src/lib/session.ts
    - src/app/api/session/route.ts
    - src/app/api/session/confirm/route.ts
    - src/app/api/session/escalate/route.ts
    - src/app/api/chat/route.ts
    - src/middleware.ts
  modified: []

key-decisions:
  - "Used toTextStreamResponse() instead of toDataStreamResponse() since AI SDK v6 renamed the API"
  - "Used usage.inputTokens/outputTokens instead of promptTokens/completionTokens per AI SDK v6 LanguageModelUsage type"
  - "Removed request.ip usage since Next.js 15+ removed ip/geo properties from NextRequest"
  - "Used encrypt() directly per field instead of encryptFields() for clearer null handling on optional PII fields"
  - "Used crypto.randomUUID() Web API in middleware for Edge runtime compatibility instead of node:crypto"

patterns-established:
  - "Response envelope: All API responses use { success: true, data } | { success: false, error: { message, code } }"
  - "Rate limiting: slidingWindow(key, maxRequests, windowMs) with RATE_LIMITS config object"
  - "Session auth: Cookie-based with generateSessionToken() + getSessionToken() + setSessionCookie()"
  - "API route structure: Validate session -> check state -> parse input -> business logic -> response"
  - "Post-stream extraction: onFinish callback runs extraction and state transition after stream completes"

requirements-completed: [SC-09, SC-10, SC-12]

# Metrics
duration: 5min
completed: 2026-05-27
---

# Phase 1 Plan 03: API Routes + Session Management + Chat Streaming Summary

**Seven API routes with SSE streaming via Vercel AI SDK, session management with httpOnly cookies, in-memory rate limiting, PII encryption at confirm, and security middleware with request tracing**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-27T06:14:35Z
- **Completed:** 2026-05-27T06:20:08Z
- **Tasks:** 3
- **Files created:** 8

## Accomplishments
- Complete HTTP API layer for customer interaction: session create/get/confirm/escalate and chat with SSE streaming
- POST /api/chat streams GPT-4o responses via Vercel AI SDK, runs extraction in onFinish callback, updates state machine and token budget
- POST /api/session/confirm validates via Zod, encrypts PII with AES-256-GCM, creates service request with reference number, and creates audit log entry
- All routes enforce multi-tenancy via withTenant, rate limiting via sliding window, and response envelope format

## Task Commits

Each task was committed atomically:

1. **Task 1: Create response envelope, rate limiter, and session token helpers** - `ce1e89e` (feat)
2. **Task 2: Build session management API routes (create, get, confirm, escalate)** - `c2b2161` (feat)
3. **Task 3: Build chat API route with SSE streaming and security middleware** - `00bfc9d` (feat)

## Files Created/Modified
- `src/lib/api-response.ts` - Response envelope: successResponse<T>() and errorResponse() helpers
- `src/lib/rate-limit.ts` - In-memory sliding window rate limiter with configurable limits and auto-cleanup
- `src/lib/session.ts` - Session cookie management using crypto.randomUUID and httpOnly cookies
- `src/app/api/session/route.ts` - POST (create session with cookie) and GET (session status + messages)
- `src/app/api/session/confirm/route.ts` - POST: Zod validation, PII encryption, service request creation, audit log
- `src/app/api/session/escalate/route.ts` - POST: state machine transition to escalated with audit log
- `src/app/api/chat/route.ts` - POST: SSE streaming GPT-4o, guardrails, extraction, state transition, token budget
- `src/middleware.ts` - X-Request-Id generation, security headers on all API routes

## Decisions Made
- Used `toTextStreamResponse()` instead of `toDataStreamResponse()` -- AI SDK v6 renamed this API. The plan referenced the v3/v4 name which no longer exists.
- Used `usage.inputTokens` / `usage.outputTokens` instead of `promptTokens` / `completionTokens` -- AI SDK v6 `LanguageModelUsage` type uses these property names.
- Removed `request.ip` usage -- Next.js 15+ removed `ip` and `geo` from NextRequest (confirmed in Next.js 16 docs). IP address is extracted from `x-forwarded-for` header only.
- Used `encrypt()` directly per field in confirm route instead of `encryptFields()` helper -- this provides clearer null-handling for optional PII fields (customerName, customerPhone, customerEmail can be null).
- Used `crypto.randomUUID()` Web Crypto API in middleware instead of `node:crypto` for Edge runtime compatibility.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed toDataStreamResponse to toTextStreamResponse**
- **Found during:** Task 3 (chat route)
- **Issue:** Plan specified `result.toDataStreamResponse()` but AI SDK v6.0.191 renamed this to `toTextStreamResponse()`
- **Fix:** Used `result.toTextStreamResponse()` which is the correct v6 API
- **Files modified:** src/app/api/chat/route.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** 00bfc9d

**2. [Rule 1 - Bug] Fixed usage property names for AI SDK v6**
- **Found during:** Task 3 (chat route onFinish callback)
- **Issue:** Plan used `usage?.promptTokens` and `usage?.completionTokens` but AI SDK v6 `LanguageModelUsage` uses `inputTokens` and `outputTokens`
- **Fix:** Changed to `usage?.inputTokens ?? 0` and `usage?.outputTokens ?? 0`
- **Files modified:** src/app/api/chat/route.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** 00bfc9d

**3. [Rule 1 - Bug] Removed request.ip usage (removed in Next.js 15+)**
- **Found during:** Task 2 and Task 3 (all API routes)
- **Issue:** Plan used `request.ip` as fallback for IP address but Next.js 15+ removed `ip` and `geo` properties from NextRequest
- **Fix:** Use `request.headers.get("x-forwarded-for") ?? "unknown"` as sole IP source
- **Files modified:** All route files
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** c2b2161, 00bfc9d

**4. [Rule 1 - Bug] Used Web Crypto API in middleware for Edge compatibility**
- **Found during:** Task 3 (middleware)
- **Issue:** Plan used `randomUUID` from `node:crypto` in middleware, but middleware runs in Edge runtime by default where Node.js APIs may not be available
- **Fix:** Used `crypto.randomUUID()` (Web Crypto API) which is available in both Node.js and Edge runtimes
- **Files modified:** src/middleware.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** 00bfc9d

---

**Total deviations:** 4 auto-fixed (4 bugs from plan referencing outdated API names/properties)
**Impact on plan:** All auto-fixes necessary for correctness with current library versions. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations.

## User Setup Required
None - no external service configuration required. OpenAI API key (OPENAI_API_KEY) is needed at runtime but was already configured in .env.example from Plan 01-01.

## Next Phase Readiness
- All API routes ready for Plan 01-04 (seed data can exercise session creation)
- All routes ready for Plan 01-05 (comprehensive testing)
- Chat endpoint ready for Phase 2 (Customer Chat UI) -- useChat can connect to POST /api/chat
- Session endpoints ready for Phase 2 -- frontend can create/get/confirm/escalate sessions

## Self-Check: PASSED

All 8 files verified present on disk. All 3 task commits (ce1e89e, c2b2161, 00bfc9d) verified in git log.

---
*Phase: 01-schema-ai-core*
*Completed: 2026-05-27*
