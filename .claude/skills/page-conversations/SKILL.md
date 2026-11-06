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
status + channel + search + `needsAction=1` + `includeEmpty=1` filters;
server-paginated at 50/page, sorted by last message time (falls back to
`created_at`), and returns an org-wide `needsActionCount`. The list polls every
10s. Selecting a row loads `/api/admin/conversations/[id]`. Filters and the
open conversation live in the URL (`status`, `channel`, `action`, `empty`, `q`,
`c=<session id>`); the dashboard card and ⌘K results deep-link with `?c=`.
Pure display/triage helpers: `src/lib/admin/conversation-display.ts`
(`needsAction`, `conversationTitle`, `extractedFields`, `messageAuthors`,
`phoneDigitsQuery`).

**One detail view per breakpoint:** `useIsDesktop()` (matchMedia `lg`) mounts
EITHER the inline pane OR the sheet — never both. The sheet portals to `<body>`,
so a `lg:hidden` wrapper can't hide it; don't go back to opening it on every
click.

**Needs action:** `customer_sessions.handled_at` (migration 0055). Needs action
= `status = 'escalated'` AND (`handled_at IS NULL` OR a customer message after
it) — SQL `needsActionSql` in the queries mirrors the pure `needsAction`.
`PATCH /api/admin/conversations/[id]` `{ handled: boolean }` (any admin, only
escalated rows, 404 otherwise) sets/clears it and audits
`conversation_marked_handled` / `conversation_reopened` with ids only.

**Empty sessions:** a session with no `user` message AND no linked request is a
widget open; it is hidden unless `includeEmpty=1` ("Show empty chats"). Nothing
is deleted.

**Search:** session id, the captured contact keys only (name/phone/email/
address via `sessionContactMatches`, `src/lib/admin/session-contact-search.ts`
— never the raw metadata JSON text, which matched key names and internal
slots), linked request number, message text, and — for a phone-shaped query
(`phoneDigitsQuery`) — the digits of the `customerPhone` key or of the number
in an `sms:` token (`sessionPhoneDigitsMatch`; web tokens and CallSids are
never digit-matched). Erased customers' sessions have no metadata and an
`erased:<id>` token, so they cannot be found by the person's details.

**Invariants:**
- `page.tsx` intentionally omits PageShell (no `<h1>` wrapper, full-bleed
  layout); the `<h1>` is SR-only inside the page div. It reads the session to
  pass `canDelete` (super_admin) — Delete is hidden for everyone else and sits
  at the end of the scroll body, not pinned.
- The header is titled by the intake customer name (else request number, else
  short id) and links the request (`/admin/requests?request=<id>` + an "Open
  request" button). Extracted data shows only the office fields in
  `EXTRACTED_FIELDS` with human labels; bot state keys (reAskCount,
  empathyShown…) are hidden. Phone/email rows are `tel:`/`mailto:`.
- Staff replies are stored as role `assistant` (send route unchanged); the
  detail returns `staffReplyTimes` (the `conversation_reply_sent` audit rows)
  and `messageAuthors` labels the matching message "Office", not "AI
  assistant".
- List/detail failures render `ErrorState` with "Try again" and human copy —
  never `body.error.message`.
- `ConversationDetailContent` has a reply composer pinned at the bottom, ONLY
  for `canReplyByChannel` channels (SMS) — phone/web threads get no panel: a `Textarea` bound to `REPLY_MAX_LENGTH` (1600, mirrors the
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
  the status badge (text threads only; "AI replying" / "Office replying"), and
  a "you've taken over" hint under the composer while `mode === 'human'`.
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
- Status filter offers chatting · submitted · escalated · abandoned (the
  brief `extracting` / `confirmed` pipeline states are left out); values match
  the schema enum.
- A row shows "Needs action" OR its status badge, never both.
- Deleting a conversation uses `db.batch` (not `db.transaction`) — neon-http
  has no interactive transactions.

**Verify changes:** `npx vitest run src/lib/admin/conversation-queries.test.ts
src/lib/admin/conversation-display.test.ts
src/app/api/admin/conversations
src/components/admin/conversations/conversation-reply-logic.test.ts`.
Visual via the admin-pages recipe (`/admin/conversations`).
