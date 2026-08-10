# Implementation plan

Derived from the 30 page specs in `specs/`, with round-1 adversarial review
findings applied. Work items are grouped into waves; items inside a wave touch
disjoint files and can run in parallel.

## Reviser decisions (round 1)

What the critics found, and what I did about it. Findings I rejected are
listed with reasons — performative compliance would bloat the plan.

| Finding | Decision |
|---|---|
| `pricebook` M-S-1 / `estimates` M-S-3 — a self-rated P2 smuggled into Requirements | **Accepted the process error, kept the work.** Both are server-side money-input validation (`memberPriceCents <= priceCents`; INT32 caps). Relabelled the gaps **P1** with a stated reason — a server that error-messages an invariant it does not enforce is a workflow hole, not polish — rather than deleting work the specs were right to want. |
| `pricebook` M-S-2 — category-tree UI is manufactured work | **Accepted. Rpricebook-3 dropped** to P2 backlog. "The plumbing exists" is not operator evidence. |
| `estimates` M-S-4 — `winRatePct` can only trend to 100%, rated P1 | **Accepted. Relabelled P0.** A KPI structurally incapable of reflecting reality is the same defect class as this repo's earlier AR-$0 bug. |
| `accounting` M-S-5 — HCP-never-writes-`payments` rated P2 | **Accepted the relabel to P1; still deferred.** Cross-integration change, out of this program's page scope. Recorded in backlog. |
| `home` P-S-1 — Rhome-1 (SEO/OG metadata) rated P1 | **Accepted. Dropped to P2.** Nothing in the product workflow is obstructed by a meta tag. `home` therefore ships **no** work this run — the honest outcome. |
| `auth` P-S — Rauth-2 needs an undisclosed schema column + migration | **Accepted.** Rauth-2 moved to its own item with the migration process spelled out, and sequenced alone (migration collision risk). |
| `tech` P-S — five requirements have criteria unverifiable under the repo's no-jsdom/RTL rule | **Partially accepted.** Tap-target and confirm-gate logic is extracted into pure helpers that vitest *can* test; the remaining visual claims are explicitly marked "screenshot-verified, not unit-testable". Also adds the missing technician-session mint script (see W0). |
| `communications` C-S-1 — Rcommunications-3 silently needs an FK migration | **Accepted the finding, rejected the fix.** Changing the FK to `restrict` needs a migration and leaves the operator stuck. Re-scoped: the DELETE route refuses when `communication_jobs` rows exist and directs the operator to deactivate instead. No migration, smaller blast radius, same data preserved. |
| `communications` C-S-2 — R1 (P0) and R4 (P1) are one root cause split across layers | **Accepted. Merged** into a single item covering schema + dropdown. |
| `communications` C-S — Rcommunications-7 (rewrite booking-recovery through the queue) | **Accepted. Dropped to P2.** The critic read the file: it already claims the ledger and checks consent. Nothing is broken; the benefit is editable copy. |
| `customers` C-S — hard-delete missing any role check, rated P1 | **Accepted. Relabelled P0.** It is strictly more destructive than the `super_admin`-gated erase path it should mirror. |
| `insights-ai` C-S — `Promise.all`→`db.batch` is polish rated P1 | **Rejected.** `AGENTS.md` makes `db.batch()` a stated repo invariant on neon-http, and `dashboard.md` independently found the same violation. Treated as one cross-page invariant-compliance item, not per-page polish. |
| `chat` P-E-1 — the spec's claim that `X-Frame-Options` does not apply to `/embed` is empirically wrong | **Accepted as a spec correction only.** Not load-bearing for any requirement; no work item. |
| `staff` Rstaff-1 and `technicians` Rtechnicians-1 propose the **same** migration | **Deduped** into one item (W0-2). Two specs authoring `drizzle/0044` independently would have collided. |

## Wave 0 — prerequisites (sequential, run first)

| id | Work | Files | Why first |
|---|---|---|---|
| W0-1 | Technician-session mint script (`scripts/agent/mint-tech-session.mjs`) mirroring the admin one, so `/tech/*` can be screenshot-verified at 390px | `scripts/agent/` | Wave D's tech items cannot be visually verified without it |
| W0-2 | Re-author the last-admin guard trigger as `drizzle/0044_last_admin_guard.sql` — `--> statement-breakpoint` separators, `_journal.json` entry, snapshot copy, then `drizzle-kit generate` must report "No schema changes" | `drizzle/` | Only migration in the run; must land alone to avoid numbering collisions. Serves `Rstaff-1` + `Rtechnicians-1` |

**W0-2 corrections from plan review (do not skip — either one breaks prod):**

1. **Recover `0027`, not `0008`.** The 2026-06-16 squash (`0cea181`) deleted
   *two* migrations. `0027_last_admin_guard_super_admin.sql` superseded
   `0008_last_admin_guard.sql` with different semantics — `OLD.role IN
   ('admin','super_admin')` vs `OLD.role = 'admin'` only — and its commit
   message records that it fixed a real super_admin-lockout bug. Recover with
   `git show a117843:drizzle/0027_last_admin_guard_super_admin.sql`. The
   `technicians.md` spec cites `git show 392cbc4:drizzle/0008_…`, which would
   reintroduce the exact bug `0027` fixed.
2. **The migration MUST be idempotent.** The trigger and function already
   exist on both dev and prod (they predate the squash). Migrations auto-run
   in the Vercel build, so a bare `CREATE TRIGGER` fails the next production
   deploy. Use `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` before
   `CREATE TRIGGER`.
3. Verifying "a fresh DB now gets the trigger" cannot be done on the dev Neon
   branch — dev already has it. Prove idempotency there instead (migration
   re-runs clean), and prove creation-from-nothing by reading the SQL.

## Wave A — security and safety

| id | Requirement | Change | Files |
|---|---|---|---|
| A1 | `Rportal-1` | Stop transmitting raw bearer tokens to Vercel Analytics. The root layout renders `<Analytics/>` for every route; `path` is the raw `usePathname()`. Scope analytics away from the three token routes (or mask the path before it is sent) | `src/app/layout.tsx` (+ portal/estimates/review route group) |
| A2 | `Rauth-1` | Apply the repo's existing `isSameOriginRequest` + JSON content-type guard to `/api/auth/login`, `/api/auth/tech/login`, `/api/auth/invite/accept` | `src/app/api/auth/**`, reuse `src/lib/session-csrf.ts` |
| A3 | `Rcommunications-2` + `Rreviews-3` | Enforce the demo-account outbound block at the shared chokepoint so BOTH the admin `/api/communications/send` route and the technician-triggered `createReviewRequest` path are covered. One guard, not two | `src/lib/communication/` chokepoint + call sites |
| A4 | `Rcustomers-1` (P0) + `Rcustomers-2` | Hard-delete requires `super_admin`, mirroring erase; erase gains the `isDemoAccount` defence-in-depth guard | `src/app/api/admin/customers/[id]/route.ts`, `.../erase/route.ts` |
| A5 | `Rplatform-1` | `DELETE /api/platform/organizations/[id]` refuses to purge the org bound to `PLATFORM_ORG_ID` | `src/app/api/platform/organizations/[id]/route.ts` |
| A6 | `Rauth-2` | Password reset invalidates prior session tokens. Needs a `users` column — sequence AFTER W0-2 and follow the same hand-authored migration process | `src/lib/auth/`, `drizzle/0045_*` |
| A7 | **new — P0** | **Public chat account-lookup has no possession proof.** A self-reported phone/email links the session to a real customer (`api/chat/route.ts:703-727`), and `requiresVerify` gates only the two `financial` intents — `next-visit`, `appointment-status` and `reschedule` are `"none"` (`src/lib/ai/account-verify.ts:4-13`). Anyone who knows a customer's phone number can pull their upcoming appointment from the public widget. Extend the ZIP-verify gate to every `account-data-*` intent | `src/lib/ai/account-verify.ts`, `src/app/api/chat/route.ts` |
| A8 | `Raudit-log-1` (P0) | Free-text, unconstrained `name` values are interpolated straight into `audit_log.details`, which the viewer renders verbatim — violates the field-names-only invariant | `src/app/api/admin/membership-plans/route.ts:86`, `.../pricebook/route.ts:125` |
| A9 | `Raudit-log-3` | `DELETE /api/admin/conversations/[id]` is reachable by any authenticated role and permanently deletes that session's prior `audit_log` rows — the page's whole promise is immutability. Add the role gate and stop the audit wipe | `src/app/api/admin/conversations/[id]/route.ts` |
| A10 | `Rsettings-2` | Google Calendar / Housecall Pro / FieldPulse credential connect+disconnect require only `getAdminSession()`, not `isSuperAdmin` — any admin can overwrite the org's external CRM credential. Matches the page's own precedent (AI model and billing are both `super_admin`-gated) | `src/app/api/admin/settings/**/connect` routes |

| A11 | **new — P0** (ops missed-risk O-R-1) | **A deactivated technician's emergency goes invisible.** Deactivation flips `users.isActive` only (`staff-queries.ts:312-325`); it never clears `assignedTo`. The dashboard's "needs attention" triage list requires `assignedTo IS NULL` (`queries.ts:1217-1241`), so a no-heat emergency assigned to a since-deactivated technician disappears from the one screen meant to catch it — while "today's schedule" still shows that technician's name against the job, implying coverage that does not exist. Dispatch and calendar already treat such jobs as unassigned; make the dashboard consistent (treat assigned-to-inactive as unassigned, and filter the schedule join) rather than mutating rows on deactivation | `src/lib/admin/queries.ts` |

## Wave B — money correctness

| id | Requirement | Change | Files |
|---|---|---|---|
| B1 | `Rinvoices-1` | `sendInvoiceReminder` gains the synced read-only guard its sibling `sendOverdueInvoiceReminders` already has (`fieldpulseInvoiceId`/`hcpInvoiceId` null-checks) | `src/lib/communication/money-triggers.ts` |
| B2 | `Raccounting-1`, `Raccounting-2` | Accounting export filters/dates synced invoices by `coalesce(issuedAt, createdAt)` — the definition invoices/operations already use; synced subtotal label reflects the actual source | `src/lib/admin/accounting-export.ts` |
| B3 | `Rreports-1`, `Rreports-2` | `dismissed` estimates stop vanishing from every bucket; billed-vs-collected revenue bases are disclosed | `src/lib/admin/reporting-queries.ts`, `src/app/admin/(dashboard)/reports/page.tsx` |
| B4 | `Restimates-1` (P0), `Restimates-2`, `Restimates-3` | Native estimates can reach a terminal state (so `winRatePct` can fall); approval link is regenerable; quantity/unit-price bounded before the DB write | `src/lib/admin/estimate-queries.ts`, `src/app/api/admin/estimates/**` |
| B5 | `Rmembership-plans-1`, `-2` | Deactivated plans are visible and reactivatable (the confirm dialog already promises this); PATCH honours `MAX_PRICE_CENTS` like POST | `src/lib/admin/membership-queries.ts`, `src/app/api/admin/membership-plans/**`, page + hook |
| B7 | **new — P1** (money missed-risk M-R-3) | `takePayment` derives its display-state write from the pre-claim stale read instead of re-deriving post-claim, unlike its sibling `reconcilePayment` which does re-read. Two concurrent partial payments summing exactly to the balance can strand `state='open'` on a fully-paid invoice, leaving it in the collections queue forever. Cents stay exact (CAS holds) — this is a state-display defect, not money loss | `src/lib/admin/invoice-queries.ts:246-247` |
| B6 | `Rpricebook-1`, `-2`, `-4` | FieldPulse `quantityAvailable`/`vendorType` surfaced; estimate item picker stops fetching the whole 17.5k catalogue; PATCH enforces `memberPriceCents <= priceCents` against the resulting row | `src/lib/admin/pricebook-queries.ts`, `src/app/api/admin/pricebook/**`, `estimate-create-dialog.tsx` |

## Wave C — data honesty

| id | Requirement | Change | Files |
|---|---|---|---|
| C1 | `Rmap-1`, `Rmap-2` | Operator can tell "no jobs" from "jobs exist but did not plot"; `map-pins.ts` pure functions (incl. `esc()`) get unit tests | `src/app/api/admin/map/route.ts`, map components, `src/lib/admin/map-pins.ts` |
| C2 | `Rops-1` | Response-time and dispatcher-first-response KPIs exclude synced jobs, matching every other KPI on the page | `src/lib/admin/operations-metrics-queries.ts` |
| C3 | `Rdashboard-1`, `-2`, `Rinsights-ai-1`, `-2` | `db.batch()` replaces `Promise.all` in `getDashboardOverview` and `getBotAnalytics` (repo invariant); dashboard surfaces overdue-invoice signal; insights sections disclose their period | `src/lib/admin/queries.ts`, `bot-analytics-queries.ts`, both pages |
| C4 | `Rfieldpulse-import-1`, `-2` | All 11 pipeline phases shown, not 4; a run stuck in `running` is detectable and recoverable | `src/lib/admin/import-status-model.ts`, page |
| C5 | `Rintegrations-1`, `-2` | "Connected" stops being a write-once lie — surface the `lastSyncError`/`availabilitySyncStatus` columns that are already written and read by nothing | `src/lib/admin/integration-queries.ts`, integrations page |
| C8 | **new — P1** (ops missed-risk O-R-2) | The calendar's "Unscheduled" queue is capped at 50, sorted oldest-first with no urgency ordering (`queries.ts:1419-1436`) — once the backlog passes 50, a fresh emergency is excluded from the very panel dispatchers place jobs from | `src/lib/admin/queries.ts` |
| C9 | **new — P2→built** (ops missed-risk O-R-3) | The dispatch map's technician-location query has no `isActive` filter (`map/route.ts:130-146`), so a deactivated technician's last-known pin renders indistinguishably from an active one. Cheap one-predicate fix; folded into C1 since it is the same file family | `src/app/api/admin/map/route.ts` |
| C7 | **new — P1** (ops-scope O-S, verified by me) | Dispatch board job cards format a real ISO instant with `timeZone: 'UTC'` (`dispatch-column.tsx:29-33`), so every arrival time on an Eastern-anchored board displays 4–5 hours off. `map-pins.ts:85-86` already takes a proper `tz`, so the codebase knows better elsewhere. NOTE: `dispatch/page.tsx:48-56` is **correct** and must not be "fixed" — it renders a date-only value pinned at UTC midnight, which is the right way to display a plain date. This partially overturns `dispatch.md`'s 0 P0/P1 all-clear | `src/components/admin/dispatch/dispatch-column.tsx` |
| C6 | `Rportal-2`, `-3`, `-4` | Portal history sourced from `service_requests` (`service_history` is empty org-wide); draft invoices excluded; a working token-revoke path | portal route + queries |

| A12 | **new — P1** (workspace missed-risk W-R-2) | Cross-tenant identity leak: `getAuditLog`'s actor-name join (`audit-queries.ts:58-67`) is a `leftJoin(users, …)` with NO `organizationId` predicate. Where `userId` and `organizationId` diverge — the `org_provisioned` row — every provisioned org's own `/admin/audit-log` page discloses the platform admin's real name. The audit-log spec's PII sweep examined `details` payloads, not the join | `src/lib/admin/audit-queries.ts` |

Also recorded from W-R-1 (feeds D12, not built in A): `org_provisioned` is
written only to the new org's own `audit_log`, never to `platformAuditLog` —
so the platform audit viewer D12 builds would ship blind to tenant
provisioning. `platform.md` cites that write site as a `platformAuditLog` path;
it is not one. Fix when D12 is built, not before.

| A13 | **new — P0** (plan review O-3) | A7 closes the account-lookup intents, but `GET /api/chat/history` is an INDEPENDENT leak on the same false premise: it returns past-conversation snippets keyed off `session.customerId`, which the unverified contact-field match sets. A7 alone does not close it. Gate the history read on the same verification state, and keep `Rchat-1` (D11) blocked until both land | `src/app/api/chat/history/route.ts` |

## Wave D-committed — P0 work promoted out of best-effort (plan review O-1)

The omissions critic was right that filing P0s under "best-effort" is a hedge.
These four are P0 in their own specs and are committed scope, not best-effort:

| id | Requirement | Why it is P0 |
|---|---|---|
| DC-1 | `Rconv-1` | The human-takeover reply API is fully built server-side — consent-gated, rate-limited, audited — with ZERO UI entry point. An operator cannot take over a conversation at all. |
| DC-2 | `Rcommunications-1` (+`-4`, merged) | 4 of 15 live trigger types are unmanageable from the templates page; those rows exist only because a seed bypassed the CRUD validation. |
| DC-3 | `Rcommunications-3` (re-scoped) | Deleting a template CASCADE-deletes its entire send history, while the confirm dialog promises a "fallback to defaults" that does not exist. Re-scoped to refuse deletion when history rows exist — no FK migration. |
| DC-4 | `Rtech-1` | A ~16×16px destructive control on a one-handed mobile app used at a customer's furnace. |

## Wave D — workflow holes (best-effort; ordered by value)

D1 `Rconv-1..4` conversations: reply UI for the built-but-unreachable takeover
API, render AI outcome/nextSteps, search by reference number, sort by last
activity · D2 `Rrequests-1..3` emergency surfacing and open-count · D3
`Rcalendar-1,2` non-drag reschedule + dnd accessibility · D4 `Rtech-1..5`
mobile tap targets, destructive-action confirms, retry affordances · D5
`Rreviews-1,2` private feedback readable, rows identify the customer · D6
`Rcommunications-1+4` (merged), `-3` (re-scoped), `-5`, `-6` · D7 `Rstaff-2,3`
· D8 `Rsettings-1` (saved-but-ignored `businessInfo.website`) · D9 `Raudit-log-1..4` · D10 `Rinventory-1` restock on
material removal · D11 `Rchat-1` history sidebar — **blocked behind A7**: the spec's fix trusts "a
contact-field match" as the signal to surface a customer's past conversations,
which inherits exactly the authorization gap A7 closes. Do not wire the sidebar
until A7 lands · D12 `Rplatform-2` audit read surface · D13 `Raudit-log-2` (21
writers build non-JSON `details`, so the viewer silently shows "(details
unavailable)") and `Raudit-log-4` (entity filter missing 10 live values).

## Not being built (with reasons)

- `Rhome-1` — SEO/OG metadata. Real, but P2; `home` ships nothing this run.
- `Rpricebook-3` — category tree UI. Manufactured work.
- `Rcommunications-7` — booking-recovery rewrite. Nothing is broken.
- `dispatch` — the spec found 0 P0/P1 and its evidence held on every claim the
  evidence critic re-checked (server-side confidence gate, shadow-mode
  isolation, no-double-assign CAS). It is **not** a clean sweep though: C7
  above fixes a real UTC-vs-Eastern display bug the spec rated P2. So: no
  dispatch *logic* work, one dispatch *display* fix.
- All 74 P2 items — recorded in their specs, backlog per the severity gate.
- Anything requiring Housecall Pro or FieldPulse API keys the repo lacks.
- **Money missed-risk M-R-2** — `enrollCustomer`'s `chargeFirstPeriod` charge is
  never written to `payments`/`invoices`, so it is invisible to "Collected this
  month", the accounting export and any refund path. Deferred with reason: the
  Stripe adapter is hardcoded to mock today, so no real money moves through it.
  This becomes a **release blocker the day a real payment adapter lands** —
  recorded here so it is not rediscovered as a surprise.
- **Money missed-risk M-R-1** — `buildCsv` sums already-converted float dollars
  rather than integer cents (`accounting-export.ts:334-335`). Inert at current
  scale; folded into B2 only if it is a one-line change while that file is open.

## Plan-review outcomes (round 1)

Three lenses ran against this plan: feasibility, sequencing/collision, omissions.

| Finding | Decision |
|---|---|
| **Feasibility F — A1 is infeasible as written.** A nested route group cannot remove `<Analytics/>` rendered by the root layout; the only "multiple root layouts" mechanism would restructure the entire app tree. | **Accepted.** A1 re-specced to `beforeSend` masking, which the installed `@vercel/analytics` types confirm (`BeforeSend = (event) => event \| null`). Needs a small client wrapper, since a function prop cannot cross the server→client boundary. |
| Feasibility — A10 and C1/C4 cite paths that do not exist (`integrations/` not `settings/`; `components/admin/dispatch/` not `lib/admin/`). | **Accepted**, paths corrected during execution; the build agents found the real files. |
| Feasibility — C3's `db.batch()` swap is not purely mechanical: one of `getDashboardOverview`'s four branches is a wrapped async helper drizzle's `batch<U extends BatchItem<'pg'>>` signature rejects. | **Accepted** — flagged to the implementing agent. |
| **Sequencing S-5 (blocker) — A7 will break 3 named existing tests** because `requiresVerify` is shared with `voice-turn.ts`, which was not in A7's Files column. | **Accepted, and it happened exactly as predicted.** The implementing agent updated `voice-turn.test.ts`'s two cases, which had encoded the pre-fix vulnerable behaviour. |
| Sequencing S-4 — A3's chokepoint has 6 callers, 3 of them cron-driven with no session, so an email-keyed `isDemoAccount(session)` cannot cover them. | **Accepted** — the guard must be org-id-keyed, not session-keyed. |
| Sequencing S-1 — "A2 is already shipped; the guard exists in commit `9991c2e`". | **Rejected.** I checked `git show e7450a7:src/app/api/auth/login/route.ts` directly: no `isSameOriginRequest`, no `hasJsonContentType`. The guard was absent when the plan was written. |
| **Omissions O-1 (blocker)** — four P0 requirements filed under "best-effort". | **Accepted.** Promoted to Wave D-committed above. |
| **Omissions O-2 (blocker)** — the plan contradicted itself about `dispatch`. | **Accepted.** "Not being built" reworded. |
| Omissions O-3 — A7 closes only part of the chat-leak finding; `GET /api/chat/history` is independently exploitable. | **Accepted.** Added as A13. |
| Omissions O-4 — chat's per-instance rate limiter on its highest-cost LLM surface is never mentioned. | **Acknowledged, not built.** It is the same in-memory-`Map` limitation `auth.md` already tracks; fixing it properly needs shared state (Redis/KV) this deployment does not have. Recorded as a real, unaddressed exposure rather than silently dropped. |
| Omissions O-5 — `settings.md` smuggled a P2 into `Rsettings-1`, the same pattern fixed for pricebook/estimates. | **Accepted.** The P2 sub-item (dead `businessInfo.email` schema field) stays backlog; only the saved-but-ignored `website` field is in scope. |

## Gates (every wave)

`npx tsc --noEmit` → 0 · `npx eslint <changed>` → 0 errors · `npx vitest run`
→ must not drop below **297 files / 4022 passed / 1 skipped** · page skill
updated in the same commit when files/flows/invariants change, then
`node scripts/agent/verify-skills.mjs` → 0 missing.

Never touched: FROZEN safety text in `src/lib/ai` prompts, the
`output-guardrail.ts` regex shapes, the guarded-flush streaming theorem, the
deliberate demo-account posture, tenancy scoping, `db.batch()` over
`db.transaction()`, `after()` over detached promises.
