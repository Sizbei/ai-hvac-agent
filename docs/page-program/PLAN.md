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
| C6 | `Rportal-2`, `-3`, `-4` | Portal history sourced from `service_requests` (`service_history` is empty org-wide); draft invoices excluded; a working token-revoke path | portal route + queries |

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
- `dispatch` — 0 P0/P1. The spec signed the page off and the evidence held.
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

## Gates (every wave)

`npx tsc --noEmit` → 0 · `npx eslint <changed>` → 0 errors · `npx vitest run`
→ must not drop below **297 files / 4022 passed / 1 skipped** · page skill
updated in the same commit when files/flows/invariants change, then
`node scripts/agent/verify-skills.mjs` → 0 missing.

Never touched: FROZEN safety text in `src/lib/ai` prompts, the
`output-guardrail.ts` regex shapes, the guarded-flush streaming theorem, the
deliberate demo-account posture, tenancy scoping, `db.batch()` over
`db.transaction()`, `after()` over detached promises.
