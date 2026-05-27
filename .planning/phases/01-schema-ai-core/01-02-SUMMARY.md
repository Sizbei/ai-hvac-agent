---
phase: 01-schema-ai-core
plan: 02
subsystem: ai
tags: [zod, openai, gpt-4o, vercel-ai-sdk, state-machine, guardrails, token-budget]

# Dependency graph
requires: []
provides:
  - "Zod extraction schema with HVAC service fields and 3-field completion check"
  - "GPT-4o system prompt with warm greeting, extraction instructions, and non-HVAC redirect"
  - "Prompt injection guardrails with 18 pattern detectors, input sanitization, output validation"
  - "4+2 conversation state machine (chatting/extracting/confirmed/submitted + escalated/abandoned)"
  - "Per-session 10,000 token budget enforcement"
  - "Single-pass GPT-4o structured extraction pipeline via Vercel AI SDK generateObject"
affects: [01-03-api-routes, 01-05-tests, 02-customer-chat-ui]

# Tech tracking
tech-stack:
  added: [zod, ai, "@ai-sdk/openai"]
  patterns: [pure-function-modules, zod-schema-validation, structured-extraction, state-machine-pure-function]

key-files:
  created:
    - src/lib/ai/extraction-schema.ts
    - src/lib/ai/system-prompt.ts
    - src/lib/ai/guardrails.ts
    - src/lib/ai/state-machine.ts
    - src/lib/ai/token-budget.ts
    - src/lib/ai/extract.ts
  modified: []

key-decisions:
  - "Used Vercel AI SDK LanguageModelUsage properties (inputTokens/outputTokens) instead of OpenAI-native naming (promptTokens/completionTokens)"
  - "Installed zod, ai, and @ai-sdk/openai as project dependencies (needed for type-checking)"

patterns-established:
  - "Pure function AI modules: all modules except extract.ts are pure functions with zero external dependencies"
  - "Zod schema shared between extraction and API validation (extractionSchema, serviceRequestSchema)"
  - "State machine as pure transition function with explicit valid-transition map"
  - "Guardrail pipeline: sanitize input -> AI call -> validate output"

requirements-completed: [SC-05, SC-06, SC-07, SC-08]

# Metrics
duration: 2min
completed: 2026-05-27
---

# Phase 1 Plan 2: AI Conversation Engine Summary

**Six pure-function AI modules: Zod extraction schemas, GPT-4o system prompt with warm greeting and 3-field extraction, 18-pattern prompt injection guardrails, 4+2 conversation state machine, 10K token budget enforcer, and single-pass structured extraction pipeline via Vercel AI SDK**

## Performance

- **Duration:** 2 min
- **Started:** 2026-05-27T06:06:21Z
- **Completed:** 2026-05-27T06:08:43Z
- **Tasks:** 2
- **Files created:** 6

## Accomplishments
- Zod extraction schema defines all HVAC service fields with `isExtractionComplete` function that triggers on issueType + urgency + address
- System prompt implements warm greeting ("Hi! I'm your HVAC assistant"), 3-field extraction, non-HVAC redirect ("I specialize in heating, cooling, and air quality"), and 15-turn escalation suggestion
- Prompt injection guardrails detect 18 regex patterns (ignore previous instructions, system prompt reveal, etc.), strip control characters, truncate at 2000 chars, and validate extraction output field lengths
- Conversation state machine covers 4 session states (chatting, extracting, confirmed, submitted) and 2 terminal states (escalated, abandoned) with explicit transition validation
- Token budget enforces 10,000 token limit per session with exhaustion tracking and pre-call affordability check
- Extraction pipeline wires sanitization -> GPT-4o generateObject with Zod schema -> output validation in a single pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Zod extraction schemas, system prompt, and prompt injection guardrails** - `cd5c8f7` (feat)
2. **Task 2: Build state machine, token budget enforcer, and extraction pipeline** - `ae2203e` (feat)

## Files Created/Modified
- `src/lib/ai/extraction-schema.ts` - Zod schemas for HVAC extraction with issueType/urgency/address completion check
- `src/lib/ai/system-prompt.ts` - GPT-4o system prompt with warm greeting, extraction instructions, non-HVAC redirect
- `src/lib/ai/guardrails.ts` - 18 injection patterns, input sanitization, output validation
- `src/lib/ai/state-machine.ts` - 4+2 state machine with pure transition function
- `src/lib/ai/token-budget.ts` - 10,000 token budget with exhaustion and affordability checks
- `src/lib/ai/extract.ts` - Single-pass GPT-4o structured extraction via Vercel AI SDK

## Decisions Made
- Used Vercel AI SDK's `inputTokens`/`outputTokens` property names (not OpenAI-native `promptTokens`/`completionTokens`) to match the `LanguageModelUsage` type
- Installed zod, ai, and @ai-sdk/openai dependencies since Plan 01-01 was still running and these were needed for type-checking

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Vercel AI SDK usage property names**
- **Found during:** Task 2 (extraction pipeline)
- **Issue:** Plan specified `usage?.promptTokens` and `usage?.completionTokens` but Vercel AI SDK's `LanguageModelUsage` type uses `inputTokens` and `outputTokens`
- **Fix:** Changed to `usage?.inputTokens ?? 0` and `usage?.outputTokens ?? 0`
- **Files modified:** src/lib/ai/extract.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** ae2203e (Task 2 commit)

**2. [Rule 3 - Blocking] Installed missing AI dependencies**
- **Found during:** Pre-Task 1 (dependency check)
- **Issue:** zod, ai, and @ai-sdk/openai not yet in package.json (Plan 01-01 still running)
- **Fix:** Ran `npm install zod ai @ai-sdk/openai`
- **Files modified:** package.json, package-lock.json (will be committed by Plan 01-01)
- **Verification:** All imports resolve, `npx tsc --noEmit` passes
- **Committed in:** Dependencies tracked in Plan 01-01's package.json commit

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both auto-fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations.

## User Setup Required
None - no external service configuration required. OpenAI API key will be needed at runtime but is configured via environment variables in Plan 01-01.

## Next Phase Readiness
- All 6 AI modules ready for consumption by Plan 01-03 (API routes)
- All modules are pure functions (except extract.ts) and ready for Plan 01-05 (tests)
- Extraction schema shared between AI extraction and API validation as designed

## Self-Check: PASSED

All 7 files verified present on disk. Both task commits (cd5c8f7, ae2203e) verified in git log.

---
*Phase: 01-schema-ai-core*
*Completed: 2026-05-27*
