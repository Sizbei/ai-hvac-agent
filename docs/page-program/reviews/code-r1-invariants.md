# Code review round 1 — repo invariants, consistency, craft

Artifact: `git diff 7787352..HEAD -- src/ scripts/ drizzle/ tests/` (commits
`96a094a`, `e7450a7`, `3d4ca1e`, `fb27657`). Lens: repo invariants documented
in `AGENTS.md` / `.claude/skills/admin-pages/SKILL.md`, and whether the diff
reads like the surrounding code. Correctness and security are covered by
other reviewers; findings here are scoped to invariant compliance and
consistency/craft.

## Summary

- FROZEN surfaces touched: **no**. `git diff 7787352..HEAD -- src/lib/ai/`
  touches only `account-verify.ts` (+tests) and `voice-turn.test.ts`. That is
  the A7/A13 security fix (`account-data-*` intents now all gate on ZIP
  verify) — legitimate, in-scope logic, not the FROZEN artifacts.
  `src/lib/ai/output-guardrail.ts`, `src/lib/ai/guarded-stream.ts`, and the
  FROZEN prompt text are byte-untouched (confirmed by diff — zero hits).
- `npx drizzle-kit generate`: **"No schema changes, nothing to migrate 😴"** —
  clean.
- `node scripts/agent/verify-skills.mjs`: **"346 paths cited, 0 missing"** —
  clean (this only checks path existence, not staleness — see below).
- Findings: **0 blocker · 11 major · 9 minor** (20 total).
- Stale-skills list: **16 skill files** describe behavior this diff changed
  without being updated in the same commit (or any commit in range) — see
  the dedicated section below.
- **Verdict: ship-with-fixes.** Nothing here is a FROZEN-surface violation,
  a tenancy leak, or a `db.transaction()` misuse — the invariants this repo
  treats as hardest are respected. But IR-1 (money/INT32) is a real,
  trivially-reachable server error the diff's own commit message claims to
  have fixed, and IR-2 is a copy-canon violation in newly authored code, both
  fixable in minutes. The 16 stale skills are a real, expected gap per the
  task brief — not a blocker, but should be closed before the next session
  trusts these skills.

---

## Findings

### IR-1 — `major` · `verified` — estimate line totals can still overflow the `integer` (int4) money columns the diff claims to have bounded

`src/app/api/admin/estimates/route.ts` (createSchema, added in this diff):

```ts
const MAX_QUANTITY = 1_000_000;
...
quantity: z.number().int().min(1).max(MAX_QUANTITY),
unitPriceCents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
```

The comment directly above reads: *"Upper bounds keep every value inside a
signed int4 money column (an unbounded quantity/price overflowed INT32 on
insert and 500'd)."* That claim is false for the derived value. `MAX_PRICE_CENTS`
(`src/lib/admin/money-format.ts`) is `99_999_999`. `src/lib/admin/money.ts:17-19`:

```ts
export function lineTotalCents(line: LineItemInput): number {
  return Math.max(0, Math.round(line.quantity) * Math.max(0, line.unitPriceCents));
}
```

This product is never clamped, and it flows straight into `estimate_line_items
.line_total_cents` (`integer` — schema.ts:2736), and via
`computeOptionTotals`'s `subtotalCents`/`totalCents` reduce into
`estimate_options.subtotal_cents`/`.total_cents` (both `integer`,
schema.ts:2753-2755) — see `src/lib/admin/estimate-queries.ts:84-104`
(`createEstimate`), unchanged by this diff. Postgres `integer` overflows at
`2,147,483,647`. The new caps do not prevent reaching it: `quantity=22,
unitPriceCents=99_999_999` (both individually valid under the new caps)
already overflows (`2,199,999,978 > 2,147,483,647`); at `MAX_QUANTITY`'s
actual ceiling the product is ~14 orders of magnitude over. Postgres will
reject the insert with an integer-out-of-range error, which the route's
generic catch turns into a 500 — the exact symptom this diff's own commit
message says it fixed, still reachable with realistic-looking single-line
values, not just adversarial ones.

**Fix:** bound the *product*, not just the factors — e.g. clamp/reject when
`quantity * unitPriceCents > MAX_PRICE_CENTS` (or a dedicated line-total cap)
in the same zod schema, or in `lineTotalCents`/`computeOptionTotals` itself so
every caller (estimate create, and anything else that reuses `money.ts`)
gets the guard for free.

### IR-2 — `major` · `verified` — new user-facing copy violates the "request, not job" canon

`src/components/admin/dispatch/map-pins.ts:98-112` (new function, part of
this diff's C1 work):

```ts
export function notPlottedChipMessage(
  notPlottedCount: number,
  geocodeCapped: boolean,
): string | null {
  if (notPlottedCount <= 0) return null;
  const noun = notPlottedCount === 1 ? 'job' : 'jobs';
  if (geocodeCapped) {
    return `${notPlottedCount} ${noun} couldn't be placed on the map (25-job geocoding limit reached)`;
  }
  return `${notPlottedCount} ${noun} couldn't be placed on the map`;
}
```

Rendered directly in the map chip (`dispatch-map.tsx:206`,
`apple-dispatch-map.tsx:411`). `admin-pages/SKILL.md`'s copy canon: *"request
(not job/booking...)"*. This is new code in this diff (the `notPlottedCount`
feature is new), not a pre-existing violation being left alone — it should
have shipped copy-canon-clean the first time.

**Fix:** `const noun = notPlottedCount === 1 ? 'request' : 'requests'`, and
reword the geocode-capped branch ("25-request geocoding limit reached").

### IR-3 — `minor` · `verified` — `docs/page-program/LEDGER.md` (introduced by this diff) is already stale relative to this diff's own later commit

`docs/page-program/LEDGER.md` is a new file in `7787352..HEAD` (added by
`e7450a7`/`3d4ca1e`). Its only progress table is `## Wave A/B shipped (commit
3d4ca1e)`. Commit `fb27657` ("wave C + promoted P0s") shipped A13, A12, C2,
C6, B4, DC-2, DC-3 (per its own commit message) but the ledger was never
updated to record them — no `## Wave C shipped` section, no run-log entry
after 2026-08-11 01:55, and the per-page status table (lines 12-41) still
shows `—` for every page in every column, including pages this diff
demonstrably touched (estimates, communications, operations, portal). A
document whose stated purpose is "Status per page. Updated as the run
proceeds." should track its own diff's last commit, not just its first.

**Fix:** append a `## Wave C shipped (commit fb27657)` section mirroring the
existing table's format, and update the per-page status columns for the
~10 pages this diff actually touched.

---

### Stale skills (item 10 — `.claude/skills/page-*/SKILL.md`)

`verify-skills.mjs` only checks that every path *cited* in a skill still
*exists* — it cannot detect a skill describing behavior the diff changed.
None of `.claude/skills/**` was touched in `7787352..HEAD` (`git diff
7787352..HEAD --stat -- .claude/` is empty), despite this diff changing
behavior on essentially every page it touched. Per AGENTS.md's "invoke the
matching skill before editing a page" model, the skills below now actively
mislead the next session. All are `tag: verified` — each is grounded in a
specific line of the skill file quoted against a specific line of the diff.

#### IR-4 — `major` — `page-communications`
- Invariants list only 10 trigger types; `src/lib/communication/sms-templates.ts:204-220`
  (re-exported by `template-editor-dialog.tsx`, this diff) now defines 15 —
  missing `technician_arrived`, `estimate_sent`, `payment_receipt`,
  `invoice_overdue`, `warranty_expiring` (the DC-2 fix: "4 of 15 ... trigger
  types unmanageable").
- "Deleting a template warns that automations fall back to defaults — no
  cascaded outbound action on delete" is now **false**. The DC-3 fix
  (`templates/[id]/route.ts` DELETE, this diff) *refuses* deletion with
  `409 HAS_SEND_HISTORY` when `communication_jobs` rows reference the
  template; there is no "fallback to defaults" behavior in the code.

#### IR-5 — `major` — `page-estimates`
- Files section omits the new `src/app/api/admin/estimates/[id]/regenerate-link/route.ts`
  (B4).
- No mention that `GET /api/admin/estimates` now performs a write on every
  read: `expireOverdueEstimates(session.organizationId)` runs before the list
  query (`route.ts`, this diff) and can flip native `open` estimates to
  `expired`. That is a real architectural fact ("this GET has a side
  effect") the next editor needs, not just a KPI nuance.
- No mention that native (non-FieldPulse) estimates can now reach a terminal
  `expired` state at all — this is the fix for the previously-known
  "`winRatePct` can only trend to 100%" defect; the skill's only related
  note ("`winRatePct` can be null") doesn't capture it.
- No mention of the new `MAX_QUANTITY`/`unitPriceCents` upper bounds on
  estimate line items (see IR-1 — also worth a line once fixed).

#### IR-6 — `major` — `page-membership-plans`
- No mention of the "Show inactive" toggle + reactivate action
  (`page.tsx`, this diff: `showInactive` state, `handleReactivate`) — B5's
  fix for "the confirm dialog already promises this" (deactivated plans were
  previously invisible with no way back).
- No mention that `PATCH` now enforces `MAX_PRICE_CENTS` the same as `POST`
  (`membership-plans/[id]/route.ts`, this diff) — the skill's invariants
  section says nothing about a price ceiling at all.
- New audit action `reactivate_membership_plan` (route.ts) not mentioned,
  though this is lower-priority since the audit-log page reads actions live.

#### IR-7 — `major` — `page-conversations`
- Files section omits the new `src/components/admin/conversations/conversation-reply-logic.ts`
  (136 lines) — the pure-logic module extracted for DC-1's human-takeover
  reply UI, exactly the "extract pure functions" pattern AGENTS.md mandates
  for this no-jsdom repo.
- Doesn't mention `DELETE /api/admin/conversations/[id]` now requires
  `isSuperAdmin` (A9, this diff) — a real access-control fact for a
  "destructive action" the skill otherwise documents carefully.
- Doesn't mention that deleting a conversation now **preserves** `audit_log`
  rows (`UPDATE ... SET sessionId = NULL`, not `DELETE`) —
  `conversation-queries.ts`, this diff — a correction of the exact promise
  ("the page's whole promise is immutability") the skill's sibling
  `page-audit-log` skill makes.

#### IR-8 — `major` — `page-customers`
- The hard-delete route (`DELETE /api/admin/customers/[id]`) is not in the
  skill's Files or Invariants at all, even though this diff added a
  `super_admin` gate to it (A4, mirroring erase) — a reader has no way to
  learn this destructive route exists or who may call it.

#### IR-9 — `major` — `page-map`
- No mention of `notPlottedCount` (new field on the map API response,
  distinct from `geocodeCapped`) or the chip it drives
  (`notPlottedChipMessage`, see IR-2) — the C1 data-honesty fix.
- No mention of the deactivated-technician filter added to the
  technician-location query (C9).

#### IR-10 — `major` — `page-dashboard`
- The invariant "'Needs attention' filters on `assignedTo IS NULL` — an
  assigned-but-urgent request must NOT appear there even if it has no
  window" is now incomplete/misleading: `queries.ts` (this diff) changed the
  predicate to `or(isNull(serviceRequests.assignedTo), eq(users.isActive,
  false))` — a request assigned to a **deactivated** technician now also
  appears (A11, the intended fix). The skill's blanket "must NOT appear"
  statement is the opposite of current behavior for that case.
- Doesn't mention `assignedToName` is now nulled for inactive technicians
  across every dashboard list row (`dashboardRequestSelect`, this diff).

#### IR-11 — `minor` — `page-operations`
- C2 excluded synced (FieldPulse/HCP) jobs from response-time and
  dispatcher-first-response KPIs (`operations-metrics-queries.ts`, this
  diff). The skill documents synced-exclusion only for AR aging and
  `timeToPaidSeconds`, implying (incorrectly, post-diff) that those are the
  only two synced-exclusions on the page.

#### IR-12 — `major` — `page-reports`
- The invariant "`closeRatePct` denominator is `estimatesSold +
  estimatesOpen + estimatesExpired` (decided estimates only)" is now
  **factually wrong**. B3 (this diff, `reporting-queries.ts`) added
  `estimatesDismissed` to both the `SalesReport` shape and the denominator
  ("sold + expired + open + dismissed always sums to `created`"). This is
  the kind of stale invariant most likely to make a future edit reintroduce
  the exact "dismissed estimates vanish" bug this diff fixed.

#### IR-13 — `minor` — `page-staff`
- "Last-admin guard: a database trigger (migration 0008) prevents demoting
  the last `admin`/`super_admin`" cites the wrong migration. This diff's
  W0-2 re-authors the guard as `drizzle/0044_last_admin_guard.sql`
  (confirmed present, idempotent, `drizzle-kit generate` clean). The
  program's own `LEDGER.md` already flags the identical stale citation in
  `staff-queries.ts`'s code comments as a known follow-up — the skill file
  has the same problem and wasn't included in that note.

#### IR-14 — `minor` — `page-technicians`
- Same issue as IR-13: "a plpgsql BEFORE UPDATE trigger on `users`
  (migration `0008_last_admin_guard`)" should read `0044`.

#### IR-15 — `minor` — `page-portal`
- C6 (this diff) made portal service history explicitly source from
  `service_requests` (not `service_history`, empty org-wide) and excluded
  draft invoices from the customer view (`portal-queries.ts`). The skill's
  Purpose line ("Portal shows invoices, estimates, upcoming jobs, and
  service history") and Data flow section say nothing about either fact,
  both of which are exactly the kind of "which table is authoritative" trap
  `page-customers`' own skill warns about for the same `service_history`
  table.

#### IR-16 — `minor` — `page-audit-log`
- A12 (this diff, `audit-queries.ts`) scoped the actor-name join to the
  session's `organizationId` specifically to prevent a cross-tenant name
  leak on `org_provisioned` rows. The skill's "Tenancy: the API scopes all
  queries to `organizationId`" line is technically still true post-fix, but
  doesn't call out that the *join* needed a separate, non-obvious scoping
  predicate — worth a line so a future join added to this query doesn't
  reintroduce the same leak.

#### IR-17 — `major` — `page-settings` (ownership gap: A10 undocumented anywhere)
- A10 (this diff) added an `isSuperAdmin` gate to
  `src/app/api/admin/integrations/{fieldpulse,google,housecall}/{connect,disconnect}/route.ts`.
  `page-settings/SKILL.md` documents the panels that call these routes
  (`fieldpulse-panel.tsx`, `housecall-pro-panel.tsx`,
  `google-calendar-panel.tsx`) but its Files section lists only
  `api/admin/settings/route.ts` and `.../faqs/route.ts` — the actual connect/
  disconnect routes, and their new access-control requirement, appear in
  neither `page-settings` nor `page-integrations` (which is explicitly
  scoped to the read-only overview page and says setup flows "live in
  Settings"). A security-relevant gate change has no skill of record.

#### IR-18 — `major` — `page-chat`
- `src/app/api/chat/history/route.ts` is not in the skill's Files list at
  all, though it is part of the `/chat` surface. A13 (this diff) added a
  verify-state gate to it (`parseVerifyState(currentSession.metadata)?.status
  !== 'passed'` → empty response) closing the same class of leak A7 closed
  for account-data intents. The skill's Invariants section is explicitly
  headed "CRITICAL — violate = safety regression" and is otherwise thorough
  about guardrails/verify — this is precisely the kind of fact that section
  exists to hold, and it's missing.

#### IR-19 — `minor` — `page-platform`
- A5 (this diff) added a refusal (`409 PLATFORM_ORG_PURGE_FORBIDDEN`) when
  `id === process.env.PLATFORM_ORG_ID` in the purge route. The skill's
  Invariants section documents `platform_audit_log` logging and the env-var
  access model but says nothing about this self-purge guard — a real
  invariant ("the platform's own org can never be purged") a future editor
  of the purge flow should know about.

#### IR-20 — `minor` — `page-auth`
- A2 (this diff) added `isSameOriginRequest` + `hasJsonContentType` checks
  to `/api/auth/login`, `/api/auth/tech/login`, and
  `/api/auth/invite/accept` (all in this skill's Files list). The skill's
  Invariants section covers login-mode resolution, forgot-password honesty,
  and invite-error non-enumeration in detail but says nothing about this new
  CSRF layer — worth a line since `session-csrf.ts` is now a dependency of
  every route this skill owns.

---

## Checked and clean (no finding)

- **FROZEN surfaces**: no diff under `src/lib/ai/output-guardrail.ts`,
  `src/lib/ai/guarded-stream.ts`, or FROZEN prompt text.
- **`db.transaction()`**: zero introduced call sites (`grep -n
  "transaction("` over the full diff returns nothing).
- **`getDashboardOverview`'s `Promise.all`→`db.batch` conversion**
  (`src/lib/admin/queries.ts`): destructure order
  `[statsRows, scheduleRows, attentionRows, followUpRows]` matches the
  `db.batch([buildDashboardStatsQuery(...), <schedule>, <attention>,
  <followUp>])` array order exactly — same as the original `Promise.all`
  order. `stats: toDashboardStats(statsRows[0])` correctly unwraps the
  single-row aggregate. No positional swap.
- **Serverless background work**: no new `after()`-eligible pattern
  introduced (no bare `setTimeout`/detached `.then()`/fire-and-forget async
  work added outside request scope).
- **Tenancy**: every new/modified `where` clause checked
  (`audit-queries.ts`, `operations-metrics-queries.ts`,
  `estimate-queries.ts`'s `regenerateApprovalToken`/`expireOverdueEstimates`,
  `chat/history/route.ts`'s customer-scoped read, `conversations/[id]`'s
  delete) goes through `withTenant(...)` or an equivalent
  `organizationId`-scoped predicate.
- **`audit_log.details`**: the two A8-fixed writers
  (`membership-plans/route.ts`, `pricebook/route.ts`) now write
  `JSON.stringify({ enum/field-list })`, no free text. The one new writer in
  this diff (`estimates/[id]/regenerate-link/route.ts`) omits `details`
  entirely (entityId only) — safe. No new writer inspected violates the
  field-names-only rule.
- **Money — synced-invoice read-only guards**: not touched by this diff
  beyond what's already covered by IR-1; no synced-invoice mutation path was
  altered.
- **Design system**: no hand-rolled Tailwind color class (`grep` for
  `bg-{red,green,blue,...}-N` / `text-{...}-N` in the diff's `src/app` +
  `src/components` additions) — zero hits. Status colors continue to route
  through `src/lib/admin/status-colors.ts` wherever touched.
- **Migration hygiene**: `drizzle/0044_last_admin_guard.sql` has both
  `--> statement-breakpoint` separators, a `_journal.json` entry (idx 44,
  tag `0044_last_admin_guard`), a snapshot copy present, and `npx
  drizzle-kit generate` reports "No schema changes, nothing to migrate 😴".
  The migration is idempotent (`CREATE OR REPLACE FUNCTION` +
  `DROP TRIGGER IF EXISTS`) as W0-2 required.
- **Dead code / orphans**: the two audit-detail fixes replace inline
  free-text with `JSON.stringify(...)` cleanly, no orphaned imports left
  (`membership-plans/route.ts` correctly swapped its local `MAX_PRICE_CENTS`
  constant for the shared import rather than leaving both). No unused
  imports spotted in the files read for this review.

## Verdict

**Ship-with-fixes.** No FROZEN-surface, tenancy, or `db.transaction()`
violation. IR-1 (money/INT32) and IR-2 (copy canon) are small, mechanical
fixes that should land before this ships, since IR-1 is a regression risk
the diff's own commit message claims to have closed and IR-2 is brand-new
code failing an enforced canon. The 16 stale skills (IR-4..IR-20, minus
IR-1..IR-3) are real and match the task brief's expectation that this would
be "a real gap" — recommend a follow-up pass updating the listed
`.claude/skills/page-*/SKILL.md` files before the next session relies on
them, rather than blocking this diff on it.
