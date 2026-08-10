# conversations — target-state spec

`/admin/conversations` — master-detail inbox for every customer session
(chat, SMS, phone).

## 1. Purpose

Let an operator (dispatcher/CSR) browse every customer conversation across
channels, judge at a glance whether the AI handled it well, read the full
transcript, and — when the bot needs a human — take over the thread with a
one-off reply. One job: turn the raw chat/SMS/phone log into something an
operator can triage without reading every transcript end to end.

## 2. Brainstorm

Considered, and what shipped or got cut:

- **Server-paginated master-detail inbox** — shipped. Necessary: sessions
  grow unbounded, an admin table has to stay fast at 10k+ rows. verified
  (`conversation-queries.ts:110-115` LIMIT/OFFSET; `Pager` in
  `conversation-inbox.tsx:302-311`).
- **Background polling for new conversations** — shipped, 10s interval,
  latest-wins + SWR cache so a filter change mid-poll doesn't render stale
  data. verified (`use-admin-conversations.ts:59,144-150`).
- **AI post-hoc summary/outcome/next-steps surfaced to the operator** —
  partially shipped (see Gaps Gconv-2). Decision: finish wiring it (P1)
  rather than cut it — the backend already computes and returns `outcome`
  and `nextSteps` every time; not rendering them wastes work already done
  and directly fails this program's core lens ("does the operator learn
  whether the AI handled it well").
- **Human takeover / one-off reply from the inbox** — backend fully shipped,
  UI entirely missing (see Gaps Gconv-1). Decision: wire it (P0) — this is
  literally the second half of the page's stated purpose and the page
  skill's documented behavior; right now it's a promise the code doesn't
  keep.
- **Search by the visible reference number** — currently missing (Gconv-3).
  Decision: fix (P1) — the row's primary label is the reference number, so
  it must be searchable.
- **Read/unread tracking per conversation** — rejected. No evidence of a
  shift-handoff need; `needsAction` (escalated flag) already does that
  job. YAGNI.
- **Rich-text / attachment replies** — rejected. The only outbound channel
  is SMS (`message/route.ts:76-89`), plain text with a 1600-char cap
  (`:24`); rich formatting for a channel that can't render it is
  speculative.
- **Real-time (WebSocket) transcript updates** — rejected. 10s polling plus
  manual refetch is adequate for a back office; real infra for a latency
  win nobody has asked for.
- **Bulk actions (delete/mark-handled) and transcript export (CSV/PDF)** —
  rejected. No evidenced workflow needs multi-select or export; export
  would also be another surface to keep the audit-log PII rule honest for
  no proven benefit.

## 3. Current state

**Pages / components** (verified — read in full):
- `src/app/admin/(dashboard)/conversations/page.tsx:6-14` — deliberately no
  `PageShell`; SR-only `<h1>`, full-bleed layout for the master-detail.
- `src/components/admin/conversations/conversation-inbox.tsx` — owns filter
  state (status/channel/search/page), keyboard nav (arrow keys + Enter,
  `:174-190`), list pane + desktop detail pane (`:314-339`) + mobile sheet
  (`:342-353`). Search is debounced 300ms (`:29,130-135`); any filter
  change resets to page 1 (`:138-141`).
- `src/components/admin/conversations/conversation-detail-content.tsx` — the
  single detail-rendering component shared by desktop pane and mobile sheet
  (`conversation-detail-sheet.tsx:34-38`), so load/delete behavior lives in
  one place (module doc, `:14-19`). Renders: AI summary callout (`:275-284`,
  only if `detail.summary` set), Overview rows (channel, turns, messages,
  tokens used/budget, linked request, created — `:287-309`), extracted
  metadata (`:312`, filters the `__skipped__` sentinel, `:104-116`),
  running summary (`:315-324`), transcript bubbles (`:329-347`), and a
  destructive delete button with confirm dialog (`:351-373`).
- `src/hooks/use-admin-conversations.ts` — fetches
  `GET /api/admin/conversations` with status/channel/search/page/limit;
  10s poll (`:46`); SWR cache keyed on the filter tuple (`:33,48`);
  equality guard skips re-render on identical poll responses (`:60-63,112-119`).
- `channel-chip.tsx` — monochrome channel icon (phone/SMS/web); no
  per-channel color so cyan stays reserved for actions (`:8-10`).

**Server** (verified):
- `GET /api/admin/conversations/route.ts:8-52` — session-gated, rate-limited
  (`adminRead`: 60/min), delegates to `getConversations`, clamps `limit`
  to 100 (`:31-33`).
- `getConversations` (`conversation-queries.ts:103-288`) — tenant-scoped via
  `withTenant` on every table touched (`:147-151,197-202,215-221,231-237`);
  runs count + page query concurrently (`Promise.all`, `:155-175`), then a
  second `Promise.all` for per-session message aggregates, first-user-
  message preview, and service-request lookup, all keyed on the page's
  `sessionIds` (`:187-238`) — bounded to page size, not the whole table.
  List is always ordered `desc(customerSessions.createdAt)` (`:172`,
  session-creation time).
- Search (`:128-145`): matches session id text OR an `EXISTS` subquery
  against `messages.content` (both `ILIKE`), with `%`/`_`/`\` escaped so a
  literal wildcard can't become an unbounded scan (`:130-133`, module
  comment). Does **not** match `serviceRequests.referenceNumber`.
- `GET /api/admin/conversations/[id]/route.ts:14-38` — UUID-validated,
  tenant-scoped, calls `getConversationById`.
- `getConversationById` (`conversation-queries.ts:290-380`) — single session
  row + full `messages` list (no per-conversation cap) + optional
  `serviceRequests.referenceNumber` lookup; returns `outcome`, `nextSteps`,
  and `mode` as part of `ConversationDetail` (`conversation-types.ts:41-58`)
  but **`ConversationDetailContent` never reads** those three fields
  (grep-verified, no occurrence in `conversation-detail-content.tsx`).
- `DELETE /api/admin/conversations/[id]/route.ts:44-72` → `deleteConversation`
  (`conversation-queries.ts:401-495`) — atomic `db.batch` (neon-http has no
  interactive transactions, module doc `:390-391`) that deletes
  `service_history` → `service_requests` → `audit_log` rows for the session
  → `messages` → `customer_sessions`, then inserts one `conversation_deleted`
  audit row with `sessionId: null` (`:481-491`). Net effect: deleting a
  conversation also deletes every prior audit-log entry tied to it
  (including any earlier `conversation_reply_sent` rows).
- `POST /api/admin/conversations/[id]/message/route.ts` — Stage 4 staffed
  inbox reply. Session-gated, demo-blocked (`isDemoAccount`, `:37-43`),
  rate-limited (`adminMutation`: 30/min, `:44-48`), validates `message`
  1-1600 chars (`:24`). Derives the SMS recipient from the session token
  (`sms:<E.164>`, `:78-80`), rejects non-SMS channels and retired/closed
  tokens (`:83-89`). Checks consent via `checkSendAllowed` (do-not-contact
  / channel-off, `:94-106`) before sending. On success: sends the SMS
  (`:108`), inserts the message row (`role: "assistant"`, `:111-116`),
  flips `customer_sessions.mode` to `"human"` (`:117-122`, so the bot goes
  quiet — checked in the inbound SMS webhook per the page skill), and
  writes a `conversation_reply_sent` audit row with no PII in `details`
  (`:124-131`). **No caller anywhere in the client code** — grepped
  `src/components`, `src/app/admin`, `src/hooks` for the `.../message`
  endpoint or a reply textarea/button: none found.

**Tests**: `src/lib/admin/conversation-queries.test.ts` (132 lines) — mocks
`db`/`withTenant`/drizzle-orm, exercises query construction. No test
touches the message-send route or any UI component (repo convention: no
jsdom/RTL, pure-helper vitest only, per `AGENTS.md`).

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gconv-1: The human-reply / takeover feature has a complete, tested backend and zero UI entry point | P0 | `POST /api/admin/conversations/[id]/message/route.ts` implements consent-gated, rate-limited, audited SMS replies and flips the session to human mode — but no component renders a reply input, a "take over" control, or calls this route. `ConversationDetailContent` (`conversation-detail-content.tsx:245-376`) only has a "Delete conversation" button in its footer; there is no reply affordance anywhere in the desktop pane, mobile sheet, or inbox. The page skill (`.claude/skills/page-conversations/SKILL.md:8-10`) documents "send a one-off human reply that hands the session over from bot to human mode" as current page behavior; it is not. |
| Gconv-2: AI-classified outcome and suggested next steps are fetched but never shown | P1 | `ConversationDetail.outcome` (`session_outcome` enum: booked/escalated/info_provided/abandoned/unresolved, `schema.ts:30-36,432`) and `.nextSteps` (`schema.ts:433`) are populated by an `after()` LLM pass (`:428-430`) and returned in `GET /api/admin/conversations/[id]` (`conversation-types.ts:47-49`), but `conversation-detail-content.tsx` never reads either — only `detail.summary`/`.runningSummary` render (`:275-284,315-324`). An operator judging AI performance can't see the AI's own outcome classification or suggested next step without reading the full transcript. `detail.mode` (`"ai"`/`"human"`, `schema.ts:434-436`) is likewise fetched and never shown. |
| Gconv-3: Search doesn't match the reference number shown as each row's label | P1 | Row title is `conversation.referenceNumber ?? conversation.id.slice(0,8)` (`conversation-inbox.tsx:92-94`) — what an operator sees and would search for. But the search predicate only matches `customerSessions.id::text` or `messages.content` (`conversation-queries.ts:134-144`), never `serviceRequests.referenceNumber`. Typing a known reference number returns nothing unless it also appears verbatim in a message. |
| Gconv-4: Inbox list sorts by session creation time, not last activity | P1 | Rows display `formatRelativeTime(conversation.lastMessageAt ?? conversation.updatedAt)` (`conversation-inbox.tsx:102-104`), implying recency-of-activity order, but the query orders by `desc(customerSessions.createdAt)` (`conversation-queries.ts:172`) — a timestamp that never changes. An old conversation with a brand-new reply won't rise; operators scanning "top = needs attention" will miss it. |
| Gconv-5: Search's `messages.content` `EXISTS` subquery has no index support on an unbounded table | P2 | `conversation-queries.ts:137-144` runs a correlated `EXISTS (... content ILIKE %pattern%)` per candidate session. `messages.content` has no index and leading-wildcard `ILIKE` can't use a btree anyway — a growing table means a growing scan. Partially mitigated (wildcard-escaping) and only triggered on explicit search, not page load — kept P2. |
| Gconv-6: Deleting a conversation deletes its own prior audit trail first | P2 | `deleteConversation` (`conversation-queries.ts:459-464`) deletes every `audit_log` row for the session (e.g. prior `conversation_reply_sent` entries) in the same atomic batch that removes it, then inserts one `conversation_deleted` row. Once deleted, no record remains that a human ever replied. May be intentional (erasure-adjacent) — recorded as a finding, not assumed a bug. |

## 5. Requirements

Only Gconv-1 through Gconv-4 clear the P0/P1 bar.

- **Rconv-1** (Gconv-1): Add a reply UI to `ConversationDetailContent` that
  calls `POST /api/admin/conversations/[id]/message` for SMS conversations.
  **Acceptance criterion**: with an active SMS conversation open, the
  operator can type a message and send it; on success the new message
  appears in the transcript (refetch or optimistic append) and the mode
  indicator (Rconv-2) reflects `"human"`. For a non-SMS or closed/retired
  SMS thread, the control is disabled/hidden with copy explaining why
  (mirroring `UNSUPPORTED_CHANNEL`, `message/route.ts:83-89`) instead of
  submitting into a guaranteed 400. `CONSENT_BLOCKED` (409) surfaces
  `decision.reason` as human-readable copy, never the raw error. The demo
  account (`DEMO_RESTRICTED`, 403) sees the control disabled with an
  explanatory banner, consistent with other demo-blocked admin actions.
- **Rconv-2** (Gconv-2): Render `detail.outcome`, `detail.nextSteps`, and
  `detail.mode` in `ConversationDetailContent`.
  **Acceptance criterion**: non-null `outcome` shows as a labeled
  badge/row (sentence case); non-empty `nextSteps` renders as a list;
  `mode` renders as a small "AI"/"Human" indicator near the status badge.
  All three stay absent (no empty/"None" clutter) when null — matching the
  existing pattern for `detail.summary`/`detail.runningSummary`.
- **Rconv-3** (Gconv-3): Extend the search predicate in `getConversations`
  to also match `serviceRequests.referenceNumber` (case-insensitive).
  **Acceptance criterion**: searching the exact or partial reference
  number shown on a row returns that conversation. A `vitest` test
  (extending `conversation-queries.test.ts`'s pure-mock pattern) asserts
  the query includes the condition when `search` is set. Tenancy and the
  existing wildcard-escaping are preserved.
- **Rconv-4** (Gconv-4): Order the conversation list by last activity, not
  session creation time.
  **Acceptance criterion**: `getConversations` orders by the same
  `lastMessageAt` value the row already displays (falling back to
  `updatedAt`/`createdAt` for a session with zero messages), verified by a
  `vitest` test asserting `orderBy` targets recency-of-activity rather
  than `customerSessions.createdAt`. If a cheap fix needs a schema change
  (e.g. a maintained `lastMessageAt` column instead of a live join),
  document the tradeoff and prefer the query-side fix first.

## 6. Non-goals

- Not building read/unread tracking, rich-text replies, WebSocket
  updates, bulk actions, or transcript export (Brainstorm — YAGNI).
- Not changing what `deleteConversation` deletes (Gconv-6 is recorded as a
  finding, not a requirement — may be intentional erasure design; changing
  delete semantics needs a product decision, not a page-spec guess).
- Not addressing Gconv-5's index/perf gap in this pass (P2, already
  partially mitigated, only triggered on explicit search) — left in the
  backlog per METHOD.md's severity gate.
- Not touching the messages/sessions "not encrypted" architecture
  (`conversation-queries.ts:11`) — an explicit, already-documented
  invariant this page's spec doesn't revisit.

## 7. Invariants

- **Demo account send guard** — `isDemoAccount` blocks outbound SMS from
  the reply route (`message/route.ts:37-43`); Rconv-1's UI must disable
  the control for the demo account rather than let the 403 surface raw,
  and must never work around/remove the server-side guard.
- **Human-takeover mode flip + server-side consent** — sending a reply must
  keep setting `customer_sessions.mode = "human"` so the bot stops
  auto-replying (see `sms/incoming` handler per the page skill), and
  `checkSendAllowed` stays server-side; Rconv-1's UI only renders the
  resulting error/state, never duplicates or pre-checks this logic.
- **Audit-log PII rule** — `audit_log.details` holds field names/ids/enums
  only, never PII; any new audit call for Rconv-1's UI must not put
  message content or contact info into `details`. The existing
  `conversation_reply_sent` call already complies (`message/route.ts:124-131`)
  — do not add fields to it.
- **Tenancy** — every query in `conversation-queries.ts` goes through
  `withTenant`; Rconv-3's reference-number join and Rconv-4's reorder must
  preserve that scoping on every table touched.
- **Messages/sessions are not encrypted** — `conversation-queries.ts:11`
  documents this explicitly; don't add encryption/decryption as a side
  effect of these requirements.
- **neon-http: no interactive transactions** — any new multi-statement
  write must stay compatible with `db.batch()` / sequential awaits, never
  `db.transaction()`.
- **Copy canon** — "conversation"/"request"/"technician"/"sign in",
  Unicode …, sentence case, human error copy (no `err.message` in UI) for
  all new text in Rconv-1/Rconv-2.
- **No PageShell on this page** — `page.tsx:6` full-bleed layout is
  intentional; new UI is added inside the existing detail pane, not by
  introducing PageShell.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/components/admin/conversations/conversation-detail-content.tsx src/components/admin/conversations/conversation-inbox.tsx src/lib/admin/conversation-queries.ts src/app/api/admin/conversations/[id]/message/route.ts` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- `npx vitest run src/lib/admin/conversation-queries.test.ts` → extended
  with cases for Rconv-3 (reference-number search) and Rconv-4
  (activity-based ordering); must pass.
- New pure-function unit tests (no jsdom/RTL) for any client-side
  derivation added by Rconv-1/Rconv-2 (e.g. channel-eligibility-for-reply,
  outcome label formatting), per repo convention.
- Manual/visual, per the admin-pages recipe: `npm run dev` (background) →
  mint a session → `node scripts/agent/screenshot-page.mjs /admin/conversations`
  with a selected SMS conversation, confirming the reply control,
  outcome/next-steps/mode display, and unchanged delete flow. Look at the
  screenshot directly before claiming visual success.
- Manual functional check of Rconv-1: send a reply to a seeded dev SMS
  conversation, confirm a new `assistant` message row persists, `mode`
  flips to `human`, and a `conversation_reply_sent` audit row is written
  with no PII in `details`.
