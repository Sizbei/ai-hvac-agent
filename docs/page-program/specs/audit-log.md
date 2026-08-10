# audit-log — target-state spec

`/admin/audit-log` — the immutable, org-scoped history of admin and
safety-critical actions.

## 1. Purpose

Let an org operator answer "who changed what, and when" for every
state-changing admin action and safety-critical customer-facing event
(erasure, escalation, refund). One job: render a tenant-scoped, paginated,
filterable, tamper-evident trail — never leak the underlying PII the actions
touched.

## 2. Brainstorm

Ideas for a great version of this page, and what shipped vs. got cut:

- **Field-names-only `details` column, rendered verbatim** — shipped. The
  column is documented as holding only field names/ids/enums so the viewer
  can render it with zero redaction logic (`src/lib/admin/audit-types.ts:14`,
  `audit-queries.ts:9-10`). A redaction layer at read time would have to know
  what counts as PII per action — fragile; the write side is the enforcement
  point instead. verified.
- **Static entity enum + live action enum in the filter UI** — shipped, but
  the entity enum has drifted (Gaudit-4). Considered making both filters
  live-queried like `actions` already is; rejected for *this* fix — the
  simplest correct move is making `KNOWN_ENTITIES` match reality, not
  redesigning the filter data flow.
- **Row-level tamper protection (DB trigger blocking UPDATE/DELETE)** —
  considered, not built; the page's "immutable" claim isn't Postgres-enforced
  (Gaudit-3). Recommended: an admin-reachable route already deletes rows, and
  the repo has precedent for a small hand-authored trigger migration (the
  last-admin-guard trigger, per repo memory).
- **CSV/export** — rejected. No evidence of demand (no button, no route, no
  skill mention). YAGNI.
- **Raw-JSON detail view** — rejected. `formatDetails` already flattens
  `details` to one line (`page.tsx:65-80`); a raw view adds a surface to
  render un-vetted JSON without the parse-failure fallback. Not worth it.
- **Retention / auto-purge policy** — rejected. No compliance requirement is
  documented anywhere in the repo; a speculative purge job risks deleting
  evidence nobody asked to delete. YAGNI.
- **Role-gating reads to super_admin only** — considered, explicitly
  rejected as *not* a gap: every other admin list-read route (customers,
  invoices, staff, settings) is gated the same way — any authenticated
  session, any role (`audit-log/route.ts:10-13`, verified against
  `customers/route.ts`, `invoices/route.ts`, `staff/route.ts`). Singling
  this page out would be inconsistent with repo convention.
- **Free-text search over `details`** — rejected. `details` is intentionally
  low-cardinality field names/ids; free-text search wouldn't return anything
  a human would type — action/entity filters already cover the real case.

## 3. Current state

**Page / hook / API** (verified — read in full):
- `src/app/admin/(dashboard)/audit-log/page.tsx` (259 lines) — filters
  (action dropdown populated from the live API-returned `actions` list,
  `:198`; entity dropdown populated from the static `KNOWN_ENTITIES` array,
  `:28-50,218`), a `DataTableShell` with `minTableWidth="40rem"` (`:183`),
  pagination via `Pager` (`:246-254`), `humanize()` for sentence-case action/
  entity labels (`:54-61`), `formatDetails()` which `JSON.parse`s `details`
  and falls back to `'(details unavailable)'` on any parse failure rather
  than echoing raw text (`:65-80`).
- `src/hooks/use-admin-audit-log.ts` — fetches on mount and on any
  filter/page change; no polling, no client cache; re-entrancy guarded by
  `isFetchingRef` (`:39-44`).
- `src/app/api/admin/audit-log/route.ts` (53 lines) — `getAdminSession()`
  gate (any role, `:10-13`), rate-limited (`:15-22`), delegates to
  `getAuditLog(session.organizationId, {...})`.
- `src/lib/admin/audit-queries.ts` — `getAuditLog` builds a `withTenant`
  where-clause (`:40`), runs count/rows/distinct-actions in one
  `Promise.all` (`:45-75`), `limit`/`offset` capped at `MAX_LIMIT = 100`.
- `src/lib/db/schema.ts:997-1023` — `audit_log` table: `organizationId` (FK,
  cascade-on-org-delete), `userId`/`sessionId` (FK, nullable), `actorType`
  enum (`human`/`ai`/`system`), `action`/`entity` (text, required),
  `entityId` (uuid, nullable), `details` (text, nullable), `ipAddress`,
  `createdAt`. Indexes: `organizationId`, `action`, `createdAt`, and a
  composite `(organizationId, createdAt)` matching the list-page query shape.
- **Write path**: `logAudit()` (`src/lib/admin/audit.ts`, 33 lines) is the
  shared helper, called from 61 files across `src/app/api/admin/**`,
  `src/app/api/auth/**`, `src/app/api/platform/**`, and
  `src/lib/admin/crm-queries.ts`. 16 more call sites insert directly via
  `db.insert(auditLog).values({...})`, bypassing the helper (every site read
  in full — see Gaps).

**PII/secret audit of every writer** (verified — every `logAudit` call site
and every direct `insert(auditLog)` site was read in full):
- All sites pass only ids, enum/boolean values, or counts as `details`,
  **except** `create_membership_plan`
  (`src/app/api/admin/membership-plans/route.ts:86`) and
  `create_pricebook_item` (`src/app/api/admin/pricebook/route.ts:125`),
  which interpolate the admin-supplied, unconstrained `name` string
  (`z.string().trim().min(1).max(255)`) directly into `details` (Gaudit-1).
- 21 sites build `details` as a template-literal string instead of
  `JSON.stringify(...)` — e.g. `payments/[id]/refund/route.ts:92`
  (``refundId:${...} reason:${...}``),
  `inventory/purchase-orders/[id]/route.ts:120` (``provider=${vendor.name}``).
  `formatDetails`'s `JSON.parse` throws on all of these, so the viewer shows
  `'(details unavailable)'` for these actions today (Gaudit-2). This is also
  what currently *shields* the two membership-plan/pricebook name leaks from
  display (Gaudit-1's payload also fails `JSON.parse`) — the Gaudit-1 fix
  must change the value stored, not just make it parseable, or fixing
  Gaudit-2 for those two sites would newly expose the leaked name in the UI.
- Coverage of security-relevant actions (verified via grep + read): staff
  role change/deactivation → `update_staff`
  (`staff/[id]/route.ts:122-134`, one action, `isActive`/`role` logged as
  enum/boolean only); GDPR erase → `customer_erased`
  (`erasure-queries.ts:373-383`, counts only); customer delete (non-GDPR) →
  `customer_deleted` (`crm-queries.ts:918-925`, called live from
  `customers/[id]/route.ts:461`); refunds → `payment_refunded`
  (`payments/[id]/refund/route.ts:86-98`, `reason` is a closed
  `z.enum(...)`, `:14-17`); settings changes → `update_settings`
  (`settings/route.ts:62-72`, field names only); integration
  connect/disconnect → all four providers (fieldpulse/housecall/google ×
  connect+disconnect) log, no secret/token ever in `details`; widget-key,
  staff-invite, and password-reset actions all log. No coverage gap found.
- Entity filter drift: `KNOWN_ENTITIES` (`page.tsx:28-50`) lists 21 values,
  but live `entity:` strings across the codebase include at least 10 more
  never in the list — `attachment`, `communication_template`,
  `fieldpulse_connection`, `google_calendar_connection`,
  `housecall_pro_connection`, `inventory_item`, `purchase_order`,
  `pricebook_item`, `tax_rate`, `widget_keys` (verified by grepping every
  `entity: "..."` literal and diffing against the static array) — Gaudit-4.

**Immutability** (verified): no route or query does `db.update(auditLog)`
anywhere. Two places do `db.delete(auditLog)`:
- `conversation-queries.ts:461` inside `deleteConversation`, scoped to
  `WHERE sessionId = $1 AND organizationId = $2` (`withTenant`, `:463`), one
  statement in an FK-ordered `db.batch` that also deletes
  `service_history`/`service_requests`/`messages`/`customer_sessions` for
  that session, then inserts one `conversation_deleted` audit row (`:483-491`).
  Called from the **live** `DELETE /api/admin/conversations/[id]`
  (`conversations/[id]/route.ts:43-82`), gated only by `getAdminSession()` —
  any authenticated role, not `isSuperAdmin` (`:48-51`). Any admin/
  technician session can permanently erase that session's entire prior audit
  trail, leaving only the one `conversation_deleted` row — Gaudit-3.
- `src/lib/db/cleanup-conversations.ts:165` — a standalone, non-route
  maintenance script (`npx tsx ... [--apply]`) that bulk-deletes `audit_log`
  rows tied to junk sessions across all orgs. Not reachable from any admin
  route or UI; requires shell access — recorded for completeness, not
  scored as a page gap.

**Pagination cost**: `getAuditLog` uses `OFFSET` pagination
(`audit-queries.ts:27-28,68`) against the composite
`(organizationId, createdAt)` index — cheap for early pages, but deep-page
`OFFSET`s degrade linearly on an append-only, ever-growing table.
`MAX_LIMIT` caps page size, not depth. No evidence any org's table is large
enough for this to matter yet — a watch item, not a current gap.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gaudit-1: Two writers store a free-text, admin-supplied value (not a field name/id/enum) in `details`, violating the hard invariant | P0 | `src/app/api/admin/membership-plans/route.ts:86` — `` details: `billingPeriod=${parsed.data.billingPeriod};name=${parsed.data.name}` `` where `name` is `z.string().trim().min(1).max(255)` (unconstrained). `src/app/api/admin/pricebook/route.ts:125` — same pattern with the pricebook item name. Neither value is customer PII, but both violate the documented contract ("field NAMES, IDs, and enum values only", `audit-queries.ts:9-10`) and both are stored in cleartext in a column the viewer renders verbatim once parseable. |
| Gaudit-2: 21 writers build `details` as a non-JSON template-literal string, so `JSON.parse` in the viewer throws and every entry permanently renders `(details unavailable)` | P1 | e.g. `payments/[id]/refund/route.ts:92`, `invoices/[id]/payments/route.ts:85`, `pricebook/[id]/route.ts:93`, `membership-plans/[id]/route.ts:67`, `inventory/route.ts:104` (full list captured during this audit — see Current state). A refund's `refundId`/`reason` is exactly the detail an operator investigating money movement needs, and it's silently unreadable today. |
| Gaudit-3: `DELETE /api/admin/conversations/[id]` (any authenticated admin/technician role) permanently deletes that session's entire prior `audit_log` history, breaking the page's own "immutable record" claim, and no DB-level guard prevents it | P1 | `src/lib/admin/conversation-queries.ts:461-464` deletes `audit_log` rows scoped to the session; route gate is `getAdminSession()` only, no `isSuperAdmin` (`src/app/api/admin/conversations/[id]/route.ts:48-51`); no `UPDATE`/`DELETE` trigger guard exists on the `audit_log` table (verified: no such migration found, no trigger referenced in `schema.ts`). |
| Gaudit-4: Entity filter dropdown (`KNOWN_ENTITIES`) is missing at least 10 real entity values in active use, so an operator cannot filter to the exact events most worth auditing (integration connects/disconnects, widget-key changes) | P1 | `page.tsx:28-50` static list vs. live `entity:` literals grepped across `src/app/api` and `src/lib`: `attachment`, `communication_template`, `fieldpulse_connection`, `google_calendar_connection`, `housecall_pro_connection`, `inventory_item`, `purchase_order`, `pricebook_item`, `tax_rate`, `widget_keys` are all written but not selectable. (The list also carries a dead `message` singular that no writer uses — the real value is `messages`.) |
| Gaudit-5: Deep-page `OFFSET` pagination cost on an unbounded, append-only table | P2 | `audit-queries.ts:27-28,68` — `Math.min(MAX_LIMIT, ...)` caps page *size*, not page *depth*; no keyset/cursor pagination. No evidence of current pain (no row-count data found) — watch item only. |

## 5. Requirements

Only Gaudit-1 through Gaudit-4 clear the P0/P1 bar.

- **Raudit-log-1** (fixes Gaudit-1): `create_membership_plan` and
  `create_pricebook_item` must never store the entity's free-text `name`
  value in `details` — only field names/ids/enums.
  **Acceptance criterion**: both routes change `details` to
  `JSON.stringify({ fields: [...] })` (or equivalent field-name-only shape)
  with no interpolated `name` value; a `vitest` unit test asserts the
  produced `details` string, when `JSON.parse`d, contains no value equal to
  the input `name`.
- **Raudit-log-2** (fixes Gaudit-2): every writer's `details` must be valid
  JSON so the viewer renders it instead of `(details unavailable)`.
  **Acceptance criterion**: all 21 identified sites (plus the two from
  Raudit-log-1) build `details` via `JSON.stringify(...)`; a `vitest` test
  iterates a fixture of the previously-broken shapes and confirms each
  round-trips through `JSON.parse`. Manual: trigger a refund and a
  pricebook update in dev, confirm the page shows a formatted detail line.
- **Raudit-log-3** (fixes Gaudit-3): `audit_log` rows must not be deletable
  through any admin-reachable route.
  **Acceptance criterion**: either (a) a Postgres trigger blocking
  `UPDATE`/`DELETE` on `audit_log` (hand-authored migration per `AGENTS.md`
  — statement-breakpoint separators + `_journal.json` + snapshot copy,
  `drizzle-kit generate` reporting "No schema changes" after), or (b)
  `deleteConversation` nulls `sessionId` instead of deleting those rows
  (column is nullable) — whichever verifies safely against the existing
  `deleteConversation` test suite. Verify: delete a session with prior audit
  rows and confirm those rows still exist (trigger path) or survive with
  `sessionId = null` (null-out path).
- **Raudit-log-4** (fixes Gaudit-4): the entity filter must offer every
  entity value a current writer actually uses.
  **Acceptance criterion**: `KNOWN_ENTITIES` gains the 10 missing values and
  drops the dead `message` singular (add `messages` if distinct from it —
  verify against writers first); screenshot confirms the new dropdown
  options.

## 6. Non-goals

- Not building CSV/export, a raw-JSON detail view, retention/auto-purge, or
  free-text search over `details` (Brainstorm, all YAGNI/rejected).
- Not adding role-gating beyond `getAdminSession()` on reads — consistent
  with every other admin list route; singling this page out would be
  inconsistent, not a fix.
- Not touching `cleanup-conversations.ts`'s bulk delete — non-route
  maintenance script requiring shell access, out of scope for an admin-page
  spec; flagged for awareness only.
- Gaudit-5 (P2) stays in the backlog per METHOD.md's severity gate; not
  implementation work in this run.

## 7. Invariants

- **`details` = field names / ids / enum values only, never PII, secrets, or
  free text.** The hard invariant this spec exists to protect — the viewer
  renders `details` verbatim after `JSON.parse` (`page.tsx:65-80`); any
  writer that stuffs a raw value in breaks it silently (no runtime check
  catches it — Raudit-log-1). Every future writer must follow the same
  field-names-only convention the other 75 audited sites use correctly today.
- **Tenancy**: every audit-log query is scoped by `organizationId` via
  `withTenant` (`audit-queries.ts:40`); Raudit-log-3/4 must not introduce an
  unscoped query.
- **`minTableWidth="40rem"` on `DataTableShell`** must stay — prevents column
  collapse on narrow viewports.
- **Actor display**: `actorName` (never a raw user id) — null renders as
  `<span italic>System</span>` (`page.tsx:131-135`). Any new writer must set
  `userId` correctly (or leave it null for system/AI actors).
- **Action filter stays live-derived**; only the entity filter is static —
  Raudit-log-4 fixes the static list's content, not this asymmetry.
- **FROZEN safety text / guardrail regexes** in `src/lib/ai` are untouched by
  this spec (repo-wide invariant, `AGENTS.md`).
- **neon-http**: any batched write for Raudit-log-3 must use `db.batch()`, never `db.transaction()` (repo-wide invariant).

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint <every file touched for Raudit-log-1/2/3/4>` → 0 errors.
- `npx vitest run` → must not drop below the live baseline recorded in
  `docs/page-program/README.md`.
- New pure-function unit tests (no jsdom/RTL): Raudit-log-1's `details`
  payload contains no value matching the input `name`; Raudit-log-2's
  fixture of the 21 previously-broken shapes round-trips through
  `JSON.parse`; Raudit-log-3's chosen mechanism (trigger rejects
  `UPDATE`/`DELETE`, or `deleteConversation` preserves rows with
  `sessionId = null`).
- Regression: `npx vitest run src/lib/admin/audit.test.ts src/lib/admin/audit-queries.test.ts src/lib/admin/conversation-queries.test.ts` → stays green.
- Manual/visual: `npm run dev` (background) → mint a session → trigger a
  refund and a pricebook-item creation → screenshot `/admin/audit-log` via
  `node scripts/agent/screenshot-page.mjs /admin/audit-log` → confirm both
  entries show formatted `details` (not `(details unavailable)`) with no
  leaked free text, and the entity dropdown lists the 10 previously-missing
  values.
