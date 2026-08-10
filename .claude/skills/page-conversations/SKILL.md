---
name: page-conversations
description: Use when working on the /admin/conversations page — master-detail inbox for chat, SMS, and phone conversations with human reply capability.
---

# Conversations (/admin/conversations)

**Purpose:** operators browse all customer sessions across channels, read the
message thread, and send a one-off human reply (SMS today) that hands the session
over from bot to human mode.

**Files:** page `src/app/admin/(dashboard)/conversations/page.tsx` (no PageShell
— full-bleed master-detail by design) → inbox
`src/components/admin/conversations/conversation-inbox.tsx` → detail panel
`src/components/admin/conversations/conversation-detail-content.tsx` + sheet
`src/components/admin/conversation-detail-sheet.tsx`. Channel label
`src/components/admin/conversations/channel-chip.tsx`. Reply composer pure
helpers `src/components/admin/conversations/conversation-reply-logic.ts`.
Hooks
`src/hooks/use-admin-conversations.ts`. Queries
`src/lib/admin/conversation-queries.ts`. Reply API
`src/app/api/admin/conversations/[id]/message/route.ts`. Delete API
`src/app/api/admin/conversations/[id]/route.ts`. Tables
`customer_sessions`, `messages`.

**Data flow:** `useAdminConversations` fetches `/api/admin/conversations` with
status + channel + search filters; server-paginated at 50/page. Selecting a row
loads `/api/admin/conversations/[id]` for the full message thread. No polling —
operator refreshes manually or selects another row.

**Invariants:**
- `page.tsx` intentionally omits PageShell (no `<h1>` wrapper, full-bleed
  layout); the `<h1>` is SR-only inside the page div.
- `ConversationDetailContent` has a reply composer at the bottom (above the
  delete footer): a `Textarea` bound to `REPLY_MAX_LENGTH` (1600, mirrors the
  server's zod bound) that POSTs to the message API and re-fetches the detail
  silently on success. `canReplyByChannel` only allows `sms` client-side — the
  server (`UNSUPPORTED_CHANNEL`) is still the authority, since a closed/retired
  SMS thread isn't detectable client-side. `replyErrorToCopy` /
  `extractConsentReason` in `conversation-reply-logic.ts` translate the
  server's `Cannot message this customer: <reason>` consent-block message into
  human copy — never show the raw server string.
- Sending a reply hits `POST /api/admin/conversations/[id]/message`; the demo
  account (`isDemoAccount` in `src/lib/auth/authz.ts`) receives a 403 — do not
  remove this guard.
- On send, the route sets `mode='human'` on the session so the bot stops
  auto-replying (checked in `sms/incoming` handler). Never bypass this. The
  detail panel shows a `ContextBadge` from `modeIndicator(detail.mode)` next to
  the status badge, and a "you've taken over" hint under the composer while
  `mode === 'human'`.
- `detail.outcome` (AI post-hoc classification) and `detail.nextSteps`
  (suggested next steps list) render in their own card above Overview when
  present — these fields existed on `ConversationDetail` before but were
  unused in the UI.
- `DELETE /api/admin/conversations/[id]` is `isSuperAdmin`-only and preserves
  `audit_log` rows: `deleteConversation` nulls their `sessionId` FK instead of
  deleting them, since the audit trail must outlive the conversation (see
  page-audit-log).
- `conversation-queries.ts` line 11 documents that messages/sessions are NOT
  encrypted unlike service-request PII — keep it that way.
- Search uses `ILIKE` on session ID text + a subquery into `messages.content`;
  the comment warns against % wildcards becoming full-scan — don't refactor
  without reading that note.
- Tenancy: every query goes through `withTenant(customerSessions, organizationId)`.

**Gotchas:**
- Status values in the filter dropdown: chatting · extracting · confirmed ·
  submitted · escalated · abandoned — match the enum in schema exactly.
- `needsAction(status)` marks only `escalated` rows; other statuses are
  informational.
- Deleting a conversation uses `db.batch` (not `db.transaction`) — neon-http
  has no interactive transactions.

**Verify changes:** `npx vitest run src/lib/admin/conversation-queries.test.ts
src/components/admin/conversations/conversation-reply-logic.test.ts`.
Visual via the admin-pages recipe (`/admin/conversations`).
