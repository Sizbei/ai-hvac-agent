# R1 evidence audit — conversations, customers, reviews, communications, insights-ai

Lens: EVIDENCE AUDIT. Every `verified`-tagged, load-bearing claim backing a
P0/P1 gap was independently re-derived from the cited file/lines (or the
actual DB migration, for schema/FK claims), not taken on the spec's word.
Method used direct `Read`/`grep`/`sed` against the live repo at
`/Users/sizbei/Documents/GitHub/ai-hvac-agent` (branch `main`, clean tree).

## Summary

- **Findings: 0 blocker, 0 major, 1 minor.**
- Every claim checked — including all five explicitly flagged high-stakes
  claims — was **factually correct**, and the overwhelming majority of line
  citations were **exact** (verified with `sed -n` / `awk` against the
  precise line ranges quoted). This is an unusually well-evidenced batch of
  specs; I could not construct a blocker or major finding against any claim
  I checked.
- The one finding is a citation-precision nit (line drift, content correct),
  filed as `minor` per the rules.

## Findings

### CE-1 (minor) — `communications.md`: booking-recovery citation off by 1-2 lines

**Spec quote (verbatim):** `booking-recovery.ts:21-22,102`

Cited for: `booking-recovery.ts` sends bypass templates + the comms queue
entirely (hardcoded copy, no retry, invisible to observability) | P1 |
`booking-recovery.ts:21-22,102`

**What's actually true:** the claim's *content* is fully correct —
`RECOVERY_MESSAGE` is a hardcoded constant passed straight to `sendSms`,
bypassing `communication_templates`/`communication_jobs` entirely — but the
line numbers are off by 1-2 lines from the actual locations:
- `const RECOVERY_MESSAGE = ...` is at `booking-recovery.ts:23`, not 21-22.
- `await sendSms({ to: phone, body: RECOVERY_MESSAGE });` appears at
  `booking-recovery.ts:103` (and again at `:208` for the web-session
  variant, not cited at all), not `:102`.

Per the audit rules ("line-number drift with correct content = minor"),
this downgrades to `minor`. It does not affect the P1 severity assignment,
the requirement (Rcommunications-7), or the non-goals/invariants built on
top of it.

## High-stakes claim verification (explicitly requested)

### 1. `communications.md` — `/api/communications/send` has no `isDemoAccount` check

**VERDICT: TRUE, fully verified.**

- `src/app/api/communications/send/route.ts` imports `getAdminSession` only
  (no `isDemoAccount` import, no role check) — confirmed by reading the file
  in full (lines 1-138).
- Traced every layer it calls: `queueCommunicationJob`
  (`src/lib/communication/job-queue.ts:26-59`) — no demo/org check, just an
  `INSERT`. The job is later drained by the cron's `checkSendAllowed`
  (`src/lib/communication/consent.ts:120-171`) — read in full; it only
  queries `communicationPreferences` by `customerId` (do-not-contact,
  channel toggle, trigger toggle, quiet hours). No organization-level or
  demo check anywhere in that function.
- Codebase-wide grep: `grep -rn "isDemoAccount" src/` returns exactly two
  call sites — `src/app/api/admin/invoices/[id]/send-reminder/route.ts:31`
  and `src/app/api/admin/conversations/[id]/message/route.ts:37` — plus the
  definition in `src/lib/auth/authz.ts:22`. `/api/communications/send` is
  not among them.
- A demo session (`admin@demo-hvac.com`, seeded with `role: "admin"`,
  `src/lib/db/seed.ts:53`) passes `getAdminSession()` and can enqueue a real
  job against any `recipientPhone`, which the cron will hand to
  `sendSms`/Resend for real. Confirmed.

### 2. `communications.md` — deleting a template CASCADE-deletes `communication_jobs` history

**VERDICT: TRUE, fully verified, at both the Drizzle-schema and applied-SQL level.**

- `src/lib/db/schema.ts:1835-1837`:
  ```
  templateId: uuid("template_id")
    .notNull()
    .references(() => communicationTemplates.id, { onDelete: "cascade" }),
  ```
  — exact line match to the spec's citation.
- Cross-checked against the actual applied migration (not just the Drizzle
  model, which could in principle drift from what's live):
  `drizzle/0000_baseline.sql:663`:
  ```
  ALTER TABLE "communication_jobs" ADD CONSTRAINT
  "communication_jobs_template_id_communication_templates_id_fk"
  FOREIGN KEY ("template_id") REFERENCES "public"."communication_templates"("id")
  ON DELETE cascade ON UPDATE no action;
  ```
- `DELETE /api/admin/communications/templates/[id]/route.ts:196-198` does a
  plain `db.delete(communicationTemplates).where(eq(communicationTemplates.id, templateId))`
  — no soft-delete, no guard, no check for existing `communication_jobs`
  rows before deleting. Line numbers match the spec's citation exactly.
- The "fallback to defaults" claim in the confirm dialog
  (`page.tsx:197`) was not independently re-verified against the rendered
  copy text, but `defaultSmsTemplates` (`sms-templates.ts:273-325`) having
  zero importers elsewhere is consistent with the spec's framing (not
  separately re-greeped here since it's not the load-bearing half of this
  claim).

### 3. `communications.md` — CRUD zod schema covers only 11 of 15 trigger enum values

**VERDICT: TRUE, counted independently, exact match including which 4 are missing.**

- `communicationTriggerTypeEnum` (`schema.ts:1732-1752`) has exactly 15
  values: `appointment_scheduled`, `appointment_reminder_24h`,
  `appointment_reminder_2h`, `appointment_rescheduled`,
  `appointment_cancelled`, `technician_enroute`, `technician_arrived`,
  `job_completed`, `review_request`, `follow_up`, `escalation`,
  `estimate_sent`, `payment_receipt`, `invoice_overdue`,
  `warranty_expiring`.
- `templateSchema.triggerType` in `templates/route.ts:26-38` (exact line
  match) lists exactly 11 of those — missing `estimate_sent`,
  `payment_receipt`, `invoice_overdue`, `warranty_expiring`, precisely the
  four the spec names. `[id]/route.ts:26-38` (`updateTemplateSchema`) has
  the identical 11-value list.
- Bonus independent check (not explicitly requested but adjacent, and the
  spec makes the same claim): the editor's `TRIGGER_TYPES`
  (`template-editor-dialog.tsx:40-51`, exact line match) has only **10**
  values — the same 11 minus `technician_arrived`. Confirmed exactly as the
  spec states ("also missing `technician_arrived`").

### 4. `reviews.md` — automated review-request path bypasses `isDemoAccount`

**VERDICT: TRUE, full chain traced.**

- `src/app/api/tech/jobs/[id]/status/route.ts:31` calls
  `getTechSession()` (a **technician** session, not admin) — exact line
  match to the spec's citation. `grep -n "isDemoAccount"` on that file
  returns nothing.
- On `status === "completed"`, the route calls
  `createReviewRequest(orgId, id, customerId)` inside `after()`
  (`status/route.ts:94-105` region) with no demo/org check anywhere in
  between.
- `createReviewRequest` (`review-queries.ts:86-159`, read in full) claims
  the outbound ledger, looks up the template, resolves the customer's
  phone, inserts the `review_requests` row, then calls
  `queueCommunicationJob` directly — the same `queueCommunicationJob` shown
  in claim #1 above to have zero demo/org gating anywhere in its call
  chain (`job-queue.ts` → cron's `processPendingJobs` →
  `checkSendAllowed`, which only checks per-customer prefs).
- Codebase-wide `isDemoAccount` grep (same one run for claim #1) confirms
  there is no third call site — the two existing guards
  (`send-reminder/route.ts:31`, `conversations/[id]/message/route.ts:37`)
  are both **admin**-session-gated, manually-triggered routes; this
  technician-triggered, automatic path has neither pattern applied to it.
  Confirmed exactly as the spec states.

### 5. `conversations.md` — human-takeover reply API has ZERO UI entry point

**VERDICT: TRUE, exhaustively grepped.**

- `grep -rn "reply\|Reply\|takeover\|Takeover\|textarea\|Textarea"` against
  `conversation-detail-content.tsx` (the single detail-rendering component
  the spec names as shared by desktop pane + mobile sheet) returns **zero
  matches**.
- Also checked the standalone `src/components/admin/conversation-detail-sheet.tsx`
  (a differently-named but plausibly-related file the spec doesn't cite) —
  same zero-match result, so there's no reply UI hiding in a sibling file
  the spec's author might have missed.
- `grep -rln "conversations/\[id\]/message"` across all of `src/` (routes,
  components, hooks) returns **zero files** other than the route
  definition itself — no client code references the endpoint path at all,
  by any construction (template literal, string concat, or literal).
- Read the full `POST /api/admin/conversations/[id]/message/route.ts`
  (139 lines): every sub-citation in the spec's "Current state" section
  checks out exactly — `:24` (1-1600 char zod schema), `:37-43` (demo
  check), `:44-48` (rate limit), `:78-80` (recipient derivation from
  `sms:<phone>` token), `:83-89` (channel/retired-token rejection),
  `:94-106` (consent check via `checkSendAllowed` with `triggerType:
  "escalation"`), `:108` (`sendSms`), `:111-116` (message insert),
  `:117-122` (mode flip to `"human"`), `:124-131` (audit row with no PII
  fields — only `entity`/`entityId`/`action`, no `details` with message
  content). Confirmed: a complete, correctly-implemented, but entirely
  unreachable-from-the-UI backend feature.

## Additional spot-checks (beyond the 5 required claims)

To stress-test the "hunt for wrong-file citations / already-guarded-elsewhere
bugs" instruction, I independently verified a further ~20 load-bearing
`verified` claims across all five specs rather than stopping at the five
flagged ones. All checked out with exact or near-exact line matches:

- `conversations.md` Gconv-2 (outcome/nextSteps/mode fetched but never
  rendered): confirmed via `grep -n "outcome\|nextSteps\|\.mode\b"` on
  `conversation-detail-content.tsx` → zero matches.
- `conversations.md` Gconv-3 (search doesn't match `referenceNumber`):
  confirmed — the search predicate (`conversation-queries.ts:128-145`) is
  exactly `customerSessions.id::text ILIKE` OR an `EXISTS` on
  `messages.content ILIKE`; no `serviceRequests` join in that clause at all.
- `conversations.md` Gconv-4 (sort order mismatch): confirmed —
  `orderBy(desc(customerSessions.createdAt))` at exactly line 172; the row
  UI displays `formatRelativeTime(conversation.lastMessageAt ??
  conversation.updatedAt)` at exactly line 103 (cited range 102-104 covers
  it).
- `conversations.md` Gconv-6 (delete order: `audit_log` wiped before the
  `conversation_deleted` row is inserted): confirmed by reading
  `deleteConversation` in full — the `db.batch([...])` array deletes
  `service_history` → `service_requests` → `audit_log` → `messages` →
  `customer_sessions`, then inserts the `conversation_deleted` row last, in
  the same atomic batch. Matches the spec's ordering claim exactly.
- `customers.md`: hard-delete route (`DELETE
  /api/admin/customers/[id]/route.ts`) has no `isSuperAdmin`/`isDemoAccount`
  import anywhere (grep confirmed empty) while the erase route
  (`erase/route.ts:35`) has an explicit `if (!isSuperAdmin(session))` gate
  at exactly the cited line. Seed role for the demo account is `"admin"`
  at exactly `seed.ts:53`. `invoices.customerId`
  (`schema.ts:2750`, exact line) has no `.references()` call — bare `uuid`,
  no FK, confirmed by reading the surrounding block.
- `reviews.md`: `reviewRequests.feedback` (`schema.ts:3082`, PRIVATE
  comment) is written in `recordReviewResponse` but `listReviews`'s
  `SELECT` (`review-queries.ts:271-280`) has no `feedback` and no
  `customers` join at all — confirmed by reading the query in full. Status
  is hardcoded `"sent"` at exactly `review-queries.ts:125`. The
  `reviewRequestStatusEnum` comment/definition spans exactly
  `schema.ts:1755-1760` as cited.
- `communications.md`: `triggers.ts` has zero `claimOutboundOnce` calls
  (grep confirmed empty) while `money-triggers.ts` and `warranty-queries.ts`
  both call it near the cited lines (450, 217) — confirmed.
- `insights-ai.md`: `bot-analytics-queries.ts:93` is exactly
  `Promise.all([...])`; `ai-insights-queries.ts` and `ops-insights-queries.ts`
  both use `db.batch([...])` — confirmed exactly. `messages.tokensUsed`
  is nullable at exactly `schema.ts:477` (no `.notNull()`), and the admin
  CSR-reply insert (`conversations/[id]/message/route.ts:111-116`, the same
  route verified for claim #5) indeed omits `tokensUsed` from the insert —
  confirmed, it will be `NULL` at the DB level.

No case was found where: a claimed bug was actually already guarded by a
chokepoint the spec's author missed; a citation pointed at the wrong
sibling file; a `verified` tag covered something unverifiable by static
reading; or a cited line range didn't exist. All `isDemoAccount` /
`isSuperAdmin` gap claims were confirmed by grepping the *entire* call-site
set for those functions across `src/`, not just the files the specs
happened to cite — ruling out the "guarded somewhere else" failure mode
specifically called out in the task brief.

## Per-spec verdicts

- **`conversations.md`: sign-off.** Every checked claim (Gconv-1 through
  Gconv-6, plus all cited line ranges in "Current state") verified true.
- **`customers.md`: sign-off.** Hard-delete/erase privilege asymmetry and
  the demo-account incidental-protection claim both verified true with
  exact line citations.
- **`reviews.md`: sign-off.** Feedback write-only, anonymous rows, and the
  demo-guard gap in the technician-triggered send path all verified true.
- **`communications.md`: sign-off.** All three P0 claims (demo-account SMS
  gap, CASCADE data loss, 11-of-15 enum coverage) independently verified
  true at both the ORM-schema and applied-migration level. One `minor`
  citation-drift nit (CE-1) does not change the verdict.
- **`insights-ai.md`: sign-off.** `db.batch` vs. `Promise.all` claims and
  the `tokensUsed` NULL-exclusion path both verified true.
