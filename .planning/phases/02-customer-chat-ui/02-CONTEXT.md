# Phase 2: Customer Chat UI - Context

**Gathered:** 2026-05-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Build a premium, mobile-first chat interface for HVAC customers. Customers interact with the AI agent via streaming chat, see extraction progress in real-time, confirm extracted service request data, and receive a reference number on success. Includes landing page, chat page, success page, and escalation flow.

</domain>

<decisions>
## Implementation Decisions

### Visual Design Language
- Color palette: cool blue primary (#2563EB) + warm orange accent (#F97316) + neutral slate backgrounds
- Chat bubbles: rounded rectangles with subtle shadow, user messages blue (right-aligned), AI messages white/slate (left-aligned)
- Animations: subtle — message slide-up 200ms, typing indicator pulse, extraction card fade-in. Respect prefers-reduced-motion.
- Typography: Inter font, 16px base on mobile, clean hierarchy with semibold headers

### Chat UX Flow
- Extraction display: inline card in the chat flow when extraction completes (not sidebar)
- Extraction progress: subtle status pills above chat input showing collected fields ("Issue Type ✓, Urgency ✓, Address ...")
- Escalation: "Talk to a Human" button in header, opens confirmation dialog with phone number + follow-up message
- Post-submission: success page with reference number, estimated response time "within 2 hours", "Start New Chat" button

### Technical Implementation
- shadcn/ui with New York style + slate base color
- Chat state: Vercel AI SDK useChat hook for streaming + React state for UI (no Zustand)
- Mobile-first: chat is full-screen on mobile, max-w-lg centered on desktop
- Icons: Lucide (bundled with shadcn), no images for MVP
- XSS prevention: all message content rendered via React's default escaping, never dangerouslySetInnerHTML

### Claude's Discretion
- Exact component decomposition within the chat feature
- Loading skeleton designs
- Error boundary messaging
- Specific Framer Motion spring/tween configurations

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- src/app/api/chat/route.ts — SSE streaming chat endpoint (POST)
- src/app/api/session/route.ts — Session creation (POST) and retrieval (GET)
- src/app/api/session/confirm/route.ts — Extraction confirmation (POST)
- src/app/api/session/escalate/route.ts — Escalation (POST)
- src/lib/ai/extraction-schema.ts — ExtractionResult type, isExtractionComplete function
- src/lib/ai/state-machine.ts — SessionState type, all state constants

### Established Patterns
- Next.js 15 App Router with src/ directory
- TypeScript strict mode
- API routes return { success, data?, error? } envelope

### Integration Points
- Chat page calls POST /api/session to create session, POST /api/chat for messages
- useChat hook connects to /api/chat for SSE streaming
- Extraction card triggers POST /api/session/confirm
- Escalation dialog triggers POST /api/session/escalate

</code_context>

<specifics>
## Specific Ideas

- Use Vercel AI SDK's useChat hook for zero-config streaming integration
- Status pills should animate in as each field gets extracted
- Mobile chat should feel like a native messaging app (full viewport height, keyboard-aware)
- Landing page is minimal — hero + CTA, no parallax

</specifics>

<deferred>
## Deferred Ideas

- Parallax landing page with trust signals — v2 marketing
- Dark mode toggle — v2
- File/image upload in chat — v2
- Customer account system — v2

</deferred>
