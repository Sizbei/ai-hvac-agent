---
phase: 02-customer-chat-ui
plan: 03
subsystem: ui-integration
tags: [react, ai-sdk, useChat, streaming, extraction, session, confirmation, escalation, next.js]

requires:
  - phase: 02-02
    provides: chat shell components (ChatContainer, ChatHeader, MessageList, ChatInput, MessageBubble, TypingIndicator), ChatMessage type
  - phase: 01
    provides: API routes (/api/chat, /api/session, /api/session/confirm, /api/session/escalate), ExtractionResult type, SessionState type

provides:
  - useChatSession hook for full session lifecycle management
  - ExtractionPills component for extraction progress display
  - ExtractionCard component for inline extraction summary
  - EscalationDialog for human handoff flow
  - ConfirmationDialog for reviewing and submitting extraction data
  - Success page with reference number display

affects:
  - src/app/chat/page.tsx (fully rewritten from mock data to live API)

tech_stack:
  added: []
  patterns:
    - TextStreamChatTransport with prepareSendMessagesRequest for custom body format
    - Session state polling after streaming completes
    - UIMessage parts-to-content string conversion via useMemo
    - Suspense boundary wrapping useSearchParams on success page
    - base-ui render prop pattern for Button+Link composition

key_files:
  created:
    - src/hooks/use-chat-session.ts
    - src/components/chat/extraction-pills.tsx
    - src/components/chat/extraction-card.tsx
    - src/components/chat/escalation-dialog.tsx
    - src/components/chat/confirmation-dialog.tsx
    - src/app/chat/success/page.tsx
  modified:
    - src/app/chat/page.tsx

decisions:
  - Composed chat components directly in page.tsx rather than through ChatContainer, since the page is now the orchestration layer with dialogs and extraction cards
  - Used base-ui render prop pattern (render={<Link />}) instead of asChild for Button+Link composition
  - Wrapped useSearchParams in Suspense on success page per Next.js 16 prerendering requirements
  - Session polling uses useEffect triggered by chatStatus transitions rather than interval-based polling

metrics:
  duration: 4min
  completed: "2026-05-27T07:21:00Z"
  tasks: 2
  files_created: 6
  files_modified: 1
---

# Phase 2 Plan 3: Chat API Integration Summary

useChatSession hook wired to all 4 API endpoints with TextStreamChatTransport, extraction progress pills, inline extraction card, confirmation/escalation dialogs, and success page with reference number

## What Was Built

### useChatSession Hook (src/hooks/use-chat-session.ts)
Custom hook orchestrating three concerns:
1. **Session creation** -- POST /api/session on mount, sets httpOnly cookie for subsequent requests
2. **Chat streaming** -- AI SDK useChat with TextStreamChatTransport, prepareSendMessagesRequest transforms to `{ message: string }` body format matching backend expectations
3. **Session state polling** -- After each streaming response completes (status transitions from streaming/submitted to ready), fetches GET /api/session to get updated session status and extraction metadata

Returns: messages (ChatMessage[]), status (SessionState), isStreaming, extraction (ExtractionResult | null), extractionFields (ExtractionField[]), error, isLoading, sendMessage, escalate, confirm.

### Extraction Components
- **ExtractionPills** -- Row of Badge pills above chat input showing issueType, urgency, address collection progress with check icons
- **ExtractionCard** -- Inline card in message area showing all extracted fields with Confirm & Submit button

### Dialog Components
- **EscalationDialog** -- "Talk to a Human" dialog with phone number display, Cancel and Confirm Escalation buttons, loading state
- **ConfirmationDialog** -- "Confirm Your Service Request" dialog showing all extraction data with Go Back and Confirm & Submit buttons

### Success Page (src/app/chat/success/page.tsx)
Post-submission page reading reference number from URL search params (?ref=HVAC-XXXXXXXX). Shows CheckCircle icon, reference number in a Card, "within 2 hours" estimate, Start New Chat button, and Back to Home link. Wrapped in Suspense for Next.js 16 prerendering compatibility.

### Chat Page Rewrite (src/app/chat/page.tsx)
Completely replaced mock data with live API integration via useChatSession. Composes ChatHeader, MessageList, ExtractionCard, ExtractionPills, ChatInput, EscalationDialog, and ConfirmationDialog. Manages dialog state, loading skeleton, error banner, and input disabling for streaming/terminal states. On confirmation success, navigates to /chat/success with reference number.

## Deviations from Plan

None - plan executed exactly as written.

## Decisions Made

1. **Direct composition over ChatContainer wrapper** -- The chat page composes ChatHeader, MessageList, ExtractionPills, ExtractionCard, ChatInput directly rather than routing through ChatContainer. This gives the page full control over rendering extraction cards inline and managing dialog state.

2. **render prop for Button+Link** -- Used base-ui's `render={<Link href="/chat" />}` pattern instead of the `asChild` prop which doesn't exist on this project's shadcn Button implementation.

3. **Suspense boundary on success page** -- Wrapped useSearchParams usage in a Suspense boundary with skeleton fallback per Next.js 16 documentation requirements for prerendered routes.

4. **Status-transition-based polling** -- Session state is polled only when chatStatus transitions from streaming/submitted to ready (using useEffect + previousStatusRef), avoiding unnecessary interval-based polling.

## Verification

- TypeScript: `npx tsc --noEmit` passes with no errors
- Build: `npm run build` succeeds with all routes generating correctly
- Chat page imports useChatSession (no mock data remains)
- TextStreamChatTransport with prepareSendMessagesRequest sends `{ message: string }` body
- Confirmation flow: extraction card -> confirmation dialog -> POST /api/session/confirm -> success page
- Escalation flow: header button -> escalation dialog -> POST /api/session/escalate
- Success page reads ref from URL search params and displays reference number with "within 2 hours"

## Self-Check: PASSED

All 6 created files verified on disk. 1 modified file verified. Both task commits (2649354, 29d19cb) confirmed in git log.
