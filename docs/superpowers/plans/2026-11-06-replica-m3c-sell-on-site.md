# Replica M3c: Sell on site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** main at `7567e03` or later (spec v4 FINAL committed; migrations through 0056 applied on dev). Plan v2 after adversarial review round 1 (three reports: code correctness, money/concurrency, spec coverage; scratchpad `m3c/plan-r1-*.md`).

**Goal:** The lead technician builds a one-to-three-option estimate from the pricebook, the customer picks and signs on the lead's phone, the estimate is sold, its lines land on the job's invoice exactly once (or wait in the office's new `Sold, not invoiced` filter), and any technician on the job can add or replace a unit of equipment, the old unit retired and linked.

**Architecture:** One hand-authored migration (0057: `invoice_line_items.estimate_line_item_id`, `estimates.sold_by` / `sold_via`). Shared pure SQL builders for billed(eid) (`src/lib/admin/estimate-billing-sql.ts`) used by the field bill, the office Generate guard, the office filter and the tech GET. New one-`db.batch` writers (lock-first `L_req`, xmin gates, in-batch re-checks, tail SELECTs, pure zero-row mappers): `createFieldEstimate` / `sellFieldEstimate` / `declineFieldEstimate` (`src/lib/tech/estimate-writes.ts`), `billSoldEstimate` next to the M3b writers (`src/lib/admin/invoice-field-writes.ts`, shares `LINE_GATE` and `createInvoiceFromJob`), `addFieldEquipment` (`src/lib/tech/equipment-writes.ts`). Routes under `src/app/api/tech/jobs/[id]/estimates/**` and `…/equipment` run through `withIdempotency` (M3b). Client: the M3b key reducer with its own storage key, a builder page, an estimate page with a full-screen customer layer driven by a pure `#customer` history state machine, an Estimates card and an Equipment card on the job page.

**Tech Stack:** Next.js 16 App Router (`params` is a Promise; native `window.history.pushState`/`replaceState` integrate with the router: `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` "Native History API"), Drizzle 0.45 on Neon neon-http (`db.batch()` = one transaction; `db.execute(sql…)` returns `.rows`; `db.transaction()` throws), zod 4, `uuid@14` (`v5` derived ids, `v7` ordered ids), drizzle-kit 0.31, vitest pure tests (mocked `db`; SQL rendered with `new PgDialect().sqlToQuery`), base shadcn primitives in the tech app (`src/components/ui/*`), admin primitives in the office.

**Spec:** `docs/superpowers/specs/2026-11-05-replica-m3c-sell-on-site.md` (v4 FINAL) and its review log `docs/superpowers/specs/2026-11-05-replica-m3c-review-log.md`. The spec is the authority; this plan argues from it.

**Rulings where the spec is silent or self-inconsistent (recorded again in Task 11's docs):**
1. The estimates GET adds two fields to the §6 contract: `requestStatus` (the §7.2 reload rule and the §7.3 billing branch need it) and `priorInvoicePaid` (§7.3 "This goes on a new invoice." needs to know an earlier invoice was paid). The bill success adds `hasMaterials` (§7.3 "Check the invoice for parts…" needs it).
2. The equipment preamble's assignment refusal is 403 `NOT_ASSIGNED` "Only a technician working this job can do that." (spec §5.6 names the check, not the code).
3. The bill route uses the estimate copies ("Arrive at the job first." / "This job is closed.") with the invoicing statuses (spec §6 gives only the statuses).
4. §6's preamble rule makes a cancelled request answer 409 `JOB_CLOSED` on the invoice routes too (copy unchanged, "Arrive at the job before invoicing."); it was `NOT_ON_SITE`. The one existing test that pins it is updated.
5. The FK on `invoice_line_items.estimate_line_item_id` is named `invoice_line_items_estimate_line_fk` with `foreignKey({ name })`: drizzle's default name is 66 characters, over Postgres' 63-character identifier limit.
6. `INVALID_OPTION` copy: "That option isn't on this estimate." (spec gives none). `EquipmentReason` "not found" copy: "That unit isn't at this address."
7. Integration case (q) is the `draftOutcome` unit test in Task 2 (the spec says "unit-tested with a mocked writer").
8. Case (f) says "both halves true" for an office-first invoice; the job half requires `i.estimate_id IS NULL`, so an office invoice alone never makes it true. Task 11 asserts office-only for (f) and adds a synthetic both-halves row to pin the office → job precedence.
9. The office customer LIST's equipment count also counts live units only (same number the profile shows).
10. The materials-overlap warning needs the sold estimates' pricebook ids on the job page; the Estimates card hands its loaded view to the page through `onLoaded`.
11. **Spec deviation — `INVOICE_CHANGED` (lead ruling 3).** Spec §5.3 step 2 maps `paid` / `refunded` / `invoice_voided` from `createInvoiceFromJob` to unstored `STALE`. But `createInvoiceFromJob` answers for THIS key's derived invoice id, and the same key always derives the same id, so an unstored answer re-arms the same key and every retry hits the same voided or paid invoice: the technician could never bill (review money M1). Those three results map to a NEW STORED code `INVOICE_CHANGED` (409, "The job's invoice changed. Try again."): the client spends the key, the next tap mints a new key and so a new derived invoice id. A plain `stale` (a deadlock included) stays unstored `STALE`.
12. **Spec deviation — `INVOICE_LOCKED` copy (lead ruling 6).** Spec copy "…The office will bill this estimate." is untrue for a draft with a payment: office Generate refuses while a native draft exists (`request_has_draft`). Copy everywhere: "The job's invoice is already finalized. Ask the office to bill this estimate."
13. **Spec deviation — customer-layer reload (lead ruling 2).** Spec §7.2 lets a reload-opened layer close with `replaceState`, which leaves no history entry, so a Back gesture would leave the estimate page (contradicting "never further"). On a reload that reopens the layer the page runs `history.replaceState` (strip the hash) and then `history.pushState('#customer')`; every close is a single `history.back()`. If the reload happened on an already-pushed entry the stack holds one extra estimate-page entry; one more Back stays on the page (accepted).
14. **Equipment keys rehydrate (lead ruling 5).** Equipment intents follow the M3b rule like the estimate intents: the card re-sends stored intents before it unlocks and stays locked with "Your last save may not have gone through. Try again." while any is unanswered; the sheet rehydrates its intent from storage and re-sends the OLD body with the OLD key before Save unlocks (an unknown add can never mint a second key and insert a second unit).
15. `replaceOutcome`: when the old unit is visible, live and native but nothing was written (the request changed under the batch), the answer is `STALE`, not the spec's catch-all 404 (review money minor 2); 404 stays for an invisible unit.
16. `createFieldEstimate` with the request gone (unreachable behind the preamble) answers `STALE`, not the estimate 404 copy.

**Rejected review items** (one line each):
- Spec m1, equipment preamble "checks only `r.status`": `findTechAssignments` already filters `isNull(appointments.cancelledAt)` (`src/lib/tech/ownership.ts`, `findTechAssignments`), so a row on a cancelled visit is never returned and never counts.
- Spec m7, native `<select>` in the equipment sheet: the tech app's existing material picker uses a native select (`tech-job-detail-client.tsx`) and a native picker is the better phone control; `src/components/ui/select.tsx` (Base UI) stays office-side.
- Spec m9, Undo restores the pre-removal snapshot and drops edits made in the next 5 seconds: Undo means "put it back as it was"; merging later edits into a restored option would rename options under the technician's thumb.
- Code minor, step 2 can leave a seeded draft behind when step 3 refuses: accepted by spec §5.3 step 2 ("the created draft stays with the job's materials; it is the job's invoice anyway").

## Global Constraints

- Gates before every commit: `npx tsc --noEmit` → 0; `npx eslint <changed files>` → 0 errors; `npx vitest run` never below the live baseline. **Capture the baseline before Task 1** (`npx vitest run 2>&1 | tail -5`, note files / passed / skipped in the task report); tests rewritten together with the code they pin are reported as a delta. No jsdom/RTL: component logic is extracted into pure helpers and tested in node. `node scripts/agent/verify-skills.mjs` → 0 missing when skills change (Task 11). After Task 1: `npx drizzle-kit generate` → "No schema changes".
- `.env.local` is the DEV Neon branch. NEVER point it at prod (`ep-withered-hill`). The integration suite refuses that host.
- neon-http: `db.transaction()` throws at runtime; every writer is ONE `db.batch` (`runBatch` from `invoice-field-writes.ts`), lock-first `L_req` → `L_inv` → row lock; deadlock `40P01` → `stale`.
- SQL rules (M3b, kept): every enum literal cast (`'sold'::estimate_status`, `'open'::estimate_status`, `'void'::invoice_state`, `'arrived'::request_status`, `…::equipment_type`); every fragment holding `OR` wrapped in its own parentheses and pinned by a `PgDialect` render test; `organization_id = $org` on EVERY table reference, subqueries and EXISTS bodies included; render tests assert parameter counts.
- Money is integer cents; tax = `Math.round(subtotal × bps / 10000)` client and server (`computeOptionTotals`, `src/lib/admin/money.ts`), `ROUND(sub * bps / 10000.0)::int` in `totalsSql`. Every write that sums money checks `INT32_MAX` (2 147 483 647) first → 400 `INVALID_INPUT` "That total is too large."; a 22003 inside the bill batch maps to the same answer. Tech GETs never select a cost column (tests assert no key containing `cost`).
- Tenancy and envelopes: tech routes `getTechSession()`, office routes `getAdminSession()`; `successResponse` / `errorResponse` (`@/lib/api-response`); `isUuid` (`@/lib/validation/uuid`); `slidingWindow(key, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs)` for writes, `adminRead` for GETs; `isSameOriginRequest` on every tech write; audit through `auditWrite` (`@/lib/tech/invoice-write-route`) with ids and enums ONLY, written only when the write created or changed something and never on a replay; logs carry codes and ids only (`errorCode` from `@/lib/logger`), never `err.message` in a response.
- Idempotency (M3b §4, unchanged): header `Idempotency-Key`; hash = `canonicalHash(parsed body)`; route = `request.nextUrl.pathname`; derived ids `ids.id("estimate" | "invoice" | "equipment")`. New stored codes: `ALREADY_DECIDED`, `ESTIMATE_EXPIRED`, `INVALID_OPTION`, `EQUIPMENT_RETIRED`, `INVOICE_CHANGED` (ruling 11) (plus the existing `ALREADY_BILLED`, `NO_LINES`, `INVOICE_LOCKED`, `INVALID_INPUT`). Never stored: `NO_CUSTOMER`, `STALE`, `NOT_LEAD`, `NOT_ON_SITE`, `JOB_CLOSED`, `ESTIMATE_NOT_SOLD`, `MANAGED_EXTERNALLY`, `NOT_FOUND`, `NOT_ASSIGNED`.
- Copy canon: sentence case; technician copy says "job", office copy says "request"; "technician", "sign in", "cancelled", Unicode `…`; no exclamation marks; human error copy only. Every user-facing string in this plan is EXACT; do not reword.
- Tech UI: base primitives only (`Card`, `Button`, `Input`, `Sheet side="bottom"`, `Skeleton`), `h-11` / `min-h-11` targets (`h-12` for primary money actions), `font-mono tabular-nums` money via `formatCentsExact` (`@/lib/admin/money-format`), inline `role="alert"` errors, `max-w-md` layout. Read `~/.claude/design-principles.md`, `.claude/skills/page-tech/SKILL.md` before Tasks 8–10; `page-estimates` + `admin-pages` before Task 7; `page-customers` before Task 10. Screenshots at 390 px with `node scripts/agent/screenshot-page.mjs <path> 390 <out> --tech` and LOOK at them.
- Hand-authored migration recipe (AGENTS.md): edit `schema.ts`; `npx drizzle-kit generate --name m3c_sell_on_site` writes `drizzle/0057_m3c_sell_on_site.sql`, `drizzle/meta/0057_snapshot.json` (new `id`, `prevId` = `5920bbd3-d4b7-469e-a765-f0489c727a87`, the 0056 snapshot id) and the `_journal.json` entry (`idx` 57, `version` "7", a fresh `when` > 1793927152374, `tag` "0057_m3c_sell_on_site", `breakpoints` true); overwrite the generated SQL with the idempotent hand-authored version (names identical to the generated ones; `--> statement-breakpoint` between statements); `npx drizzle-kit generate` → "No schema changes"; `npm run db:migrate` on dev right after, twice. Re-check `_journal.json` for the next free number before generating: if another workstream took 57, use the next number and rename the file and tag everywhere in this plan.
- Dev hazards: the dev default org `00000000-0000-0000-0000-000000000001` has a WORKING FieldPulse key and live Twilio. Never create requests through the API there and never tap statuses on its jobs. Throwaway orgs only via `createOrgCore` (`@/lib/admin/provisioning`), technician/customer/request/pricebook/tax rows inserted by SQL, orgs deleted afterwards. Probes: `NODE_OPTIONS=--conditions=react-server npx tsx probe-m3c-<task>.mts` at the repo root, unique names, deleted before committing; tech sessions with `MINT_ORG_ID=$ORG npx tsx scripts/agent/mint-tech-session.mjs`, assert the token's `organizationId === $ORG` before any fetch, send `Origin: http://localhost:3000`. No route in M3c queues a message; still run the queue guard (`SELECT count(*) FROM communication_jobs WHERE status='pending' AND scheduled_for <= now() + interval '15 minutes'` must be 0) before any browser walk and assert zero new `communication_jobs` rows for the throwaway org afterwards.
- Files another workstream is editing right now are OFF LIMITS: `src/lib/admin/current-visit.ts`, `src/components/admin/inventory/*`, the requests / calendar / dispatch pages and their queries (`src/lib/admin/queries.ts`, `appointment-queries.ts`, `request-status.ts`, `types.ts`, `src/app/api/admin/requests/**`). The spec requires no change in any of them. `vitest.config.ts` is shared: Task 11 re-reads it right before its edit and appends one line.
- Git: `git add` ONLY the task's files by path (never `git add -A` / `git add .`), never `--amend`, never force-push; other agents commit concurrently (retry once on `index.lock`). Every commit message ends with exactly these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6`
- Order (lead ruling 1): execution is SEQUENTIAL — Task 1, 2, 3, … 11, one at a time, each committed before the next starts. Every task's commit gate is the full `npx tsc --noEmit` → 0, `npx vitest run` → baseline or better, and `npx eslint <the task's changed files>` → 0 errors. A task whose change breaks an existing test owns updating it; that test file is listed in the task's **Files** and in the file map. Interfaces are listed in each task's **Interfaces → Consumes** line.

## Review Focus

1. **Ids in another case.** A path or body uuid in upper case (a hand-typed URL, a client that uppercases): a sell replay with the option id in upper case must still be a replay, not `ALREADY_DECIDED`; a bill on `/jobs/<UPPER RID>/…` must still find its estimate. Pinned by `sellOutcome treats an uppercase optionId and technician id as the same sale` (Task 3) and `billSoldEstimate accepts an uppercase request id` (Task 2); both use uuids with hex letters (`abcdef…`) and first assert `id.toUpperCase() !== id`, so deleting a `.toLowerCase()` makes them fail.
2. **Pricebook drift between building and saving.** An item deactivated after it was added to the draft, or the same item added twice to one option: the save refuses with "One of these items is no longer in the pricebook." and two lines of one item are kept as two lines. Pinned by `buildFieldEstimate refuses a deactivated item and keeps two lines of the same item` (Task 3).
3. **Money at the int4 edge.** 999 × an expensive item, or a sale billed onto a draft already near the limit: a 400 "That total is too large.", never a 500 and never a partial insert. Pinned by `buildFieldEstimate refuses an option total over INT32_MAX` (Task 3) and `billSoldEstimate maps a 22003 overflow to too_large` (Task 2).
4. **Reload and Back on the customer layer.** A reload with `#customer` after the estimate was sold (or the job closed) must land on the estimate page with the hash stripped; a reload that reopens the layer must re-own a history entry so Back closes it onto the estimate page, never further (ruling 13). Pinned by `layerStep strips the hash on a reload of an estimate that can no longer be sold` and `layerStep re-pushes #customer on a sellable reload so close is one back` (Task 9), and by the Task 9 walk's reload → Back step.
5. **The business-timezone day for install dates.** At 23:30 Eastern the UTC date is already tomorrow; "today" must still be accepted and "tomorrow" refused, and the stored instant is noon Eastern on that date across a DST change. Pinned by `parseEquipmentInput accepts today in the business timezone at 23:30 Eastern` and `noonInZone is noon Eastern on both sides of the DST change` (Task 4).

---

## File map (exclusive ownership)

| task | creates | modifies |
| --- | --- | --- |
| 1 | `drizzle/0057_m3c_sell_on_site.sql`, `drizzle/meta/0057_snapshot.json`, `src/lib/tech/field-sale-statuses.ts`, `src/lib/admin/estimate-billing-sql.ts` (+test) | `drizzle/meta/_journal.json`, `src/lib/db/schema.ts` |
| 2 | — | `src/lib/admin/invoice-field-writes.ts` (+test), `src/lib/tech/invoice-errors.ts` (+test), `src/lib/admin/invoice-queries.ts`, `src/lib/admin/invoice-queries.test.ts`, `src/lib/tech/invoice-queries.ts`, `src/lib/tech/invoice-queries.test.ts` (existing "cost" and "pendingWrite" cases updated), `src/lib/tech/invoice-view.ts`, `src/lib/tech/invoice-view-diff.test.ts`, `src/lib/tech/invoice-page-locks.test.ts`, `src/components/tech/invoice/invoice-lines.tsx`, `src/lib/tech/invoice-client-errors.ts` (+test) |
| 3 | `src/lib/tech/estimate-input.ts` (+test), `src/lib/tech/estimate-writes.ts` (+test), `src/lib/tech/estimate-errors.ts` (+test) | `src/lib/http/idempotency-codes.ts`, `src/lib/http/idempotency.test.ts` |
| 4 | `src/lib/tech/equipment-input.ts` (+test), `src/lib/tech/equipment-writes.ts` (+test), `src/lib/tech/equipment-errors.ts` (+test), `src/lib/tech/equipment-queries.ts` (+test), `src/lib/admin/crm-equipment-records.ts` (+test; also holds `replacedOnLabel` for the office page) | `src/lib/admin/crm-equipment-queries.ts` (+test), `src/lib/admin/crm-queries.ts`, `src/lib/admin/crm-types.ts` |
| 5 | `src/lib/tech/estimate-view.ts`, `src/lib/tech/estimate-display.ts` (+test), `src/lib/tech/estimate-queries.ts` (+test) | — |
| 6 | `src/app/api/tech/jobs/[id]/estimates/route.ts` (+test), `…/estimates/[eid]/sell/route.ts` (+test), `…/estimates/[eid]/bill/route.ts` (+test), `…/estimates/[eid]/decline/route.ts` (+test), `src/app/api/tech/jobs/[id]/equipment/route.ts` (+test) | `src/lib/tech/invoice-route-guards.ts` (+test) |
| 7 | `src/lib/admin/estimate-approval-copy.ts` (+test) | `src/lib/admin/estimate-queries.ts`, `src/lib/admin/estimate-queries.test.ts`, `src/lib/admin/estimate-detail.test.ts`, `src/lib/admin/estimate-list-pagination.test.ts`, `src/app/api/admin/estimates/route.ts` (+test), `src/app/api/admin/estimates/[id]/route.ts`, `src/hooks/use-estimates.ts`, `src/app/admin/(dashboard)/estimates/page.tsx`, `src/app/admin/(dashboard)/estimates/[id]/page.tsx` |
| 8 | `src/lib/tech/estimate-intents.ts` (+test), `src/lib/tech/add-item-done.ts` (+test), `src/lib/tech/estimate-builder.ts` (+test), `src/components/tech/estimates/{fetch-estimates,recover-intents,use-estimate-write}.ts`, `src/components/tech/estimates/{estimates-card,estimate-builder-client}.tsx`, `src/app/tech/jobs/[id]/estimates/new/page.tsx` | `src/hooks/use-idempotency-key.ts`, `src/components/tech/invoice/add-item-sheet.tsx` |
| 9 | `src/lib/tech/customer-view-state.ts` (+test), `src/lib/tech/estimate-page-copy.ts` (+test), `src/components/tech/estimates/{estimate-page-client,customer-view}.tsx`, `src/app/tech/jobs/[id]/estimates/[eid]/page.tsx` | — |
| 10 | `src/lib/tech/material-overlap.ts` (+test), `src/lib/tech/equipment-display.ts` (+test), `src/components/tech/equipment/{equipment-card,equipment-sheet}.tsx` | `src/components/tech/tech-job-detail-client.tsx`, `src/app/admin/(dashboard)/customers/[id]/page.tsx` |
| 11 | `tests/integration/field-estimate.test.ts` | `vitest.config.ts`, `.claude/skills/{page-tech,page-estimates,page-customers,page-invoices}/SKILL.md`, `replica/{features.csv,parity.md,build-log.md,architecture.md}`, memory `replica-program-fp-st.md` |

The spec §8 browser walk is run by the lead after Task 11 (throwaway org, 390×844); it is not a task.

---

### Task 1: Migration 0057, schema, billed(eid) SQL builders, status sets

**Files:**
- Create: `drizzle/0057_m3c_sell_on_site.sql`, `drizzle/meta/0057_snapshot.json` (generated), `src/lib/tech/field-sale-statuses.ts`, `src/lib/admin/estimate-billing-sql.ts`, `src/lib/admin/estimate-billing-sql.test.ts`
- Modify: `drizzle/meta/_journal.json` (generated entry), `src/lib/db/schema.ts` (`estimates` table ~line 2864, `invoiceLineItems` ~line 3033)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `field-sale-statuses.ts` (no imports, client-safe): `SELL_STATUSES = ["arrived","in_progress","on_hold"] as const`, `BILL_STATUSES = ["arrived","in_progress","on_hold","completed"] as const`, `CLOSED_STATUSES = ["completed","cancelled"] as const`, `type StatusGate = "ok" | "not_on_site" | "job_closed"`, `statusGate(status: string, allowed: readonly string[]): StatusGate`.
  - `estimate-billing-sql.ts`: `statusInSql(statuses: readonly string[]): SQL`, `eidParam(id: string): SQL`, `officeBilledSql(org: string, eid: SQL): SQL`, `jobBilledSql(org: string, eid: SQL): SQL`, `billedSql(org: string, eid: SQL): SQL` (parenthesised OR), `billingInvoiceIdSql(org: string, eid: SQL): SQL` (office invoice first, else the job invoice holding the lines). `eid` is a uuid-typed SQL expression: `eidParam(id)` or a column such as `sql.raw("e.id")` / `sql\`${estimates.id}\``.
  - Schema: `invoiceLineItems.estimateLineItemId`, `estimates.soldBy`, `estimates.soldVia`.

- [ ] **Step 1: Write the failing builder tests** — `src/lib/admin/estimate-billing-sql.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  billedSql, billingInvoiceIdSql, eidParam, jobBilledSql, officeBilledSql, statusInSql,
} from "./estimate-billing-sql";
import { BILL_STATUSES, SELL_STATUSES, statusGate } from "@/lib/tech/field-sale-statuses";

const ORG = "11111111-1111-4111-8111-111111111111";
const EID = "22222222-2222-4222-8222-222222222222";
const dialect = new PgDialect();
const q = (s: SQL) => dialect.sqlToQuery(s);
const text = (s: SQL) => q(s).sql.replace(/\s+/g, " ").trim();
const orgCount = (s: SQL) => q(s).params.filter((p) => p === ORG).length;

describe("billed(eid) builders (spec §5.3)", () => {
  it("office half: a non-void invoice born from the estimate, org-bound", () => {
    const s = officeBilledSql(ORG, eidParam(EID));
    expect(text(s)).toBe(
      "EXISTS (SELECT 1 FROM invoices obi WHERE obi.organization_id = $1::uuid AND obi.estimate_id = $2::uuid AND obi.state <> 'void'::invoice_state)",
    );
    expect(q(s).params).toEqual([ORG, EID]);
  });

  it("job half: linked lines on a non-void native invoice that no estimate created", () => {
    const s = jobBilledSql(ORG, eidParam(EID));
    const t = text(s);
    expect(t.startsWith("EXISTS (SELECT 1 FROM invoice_line_items jbx JOIN invoices jbi ON jbi.id = jbx.invoice_id")).toBe(true);
    expect(t).toContain("jbi.estimate_id IS NULL");
    expect(t).toContain("jbi.state <> 'void'::invoice_state");
    expect(t).toContain("jbi.fieldpulse_invoice_id IS NULL AND jbi.hcp_invoice_id IS NULL");
    expect(t).toContain(
      "jbx.estimate_line_item_id IN (SELECT jbl.id FROM estimate_line_items jbl JOIN estimates jbe ON jbe.sold_option_id = jbl.option_id",
    );
    expect(orgCount(s)).toBe(4);
    expect(q(s).params).toHaveLength(5);
  });

  it("billed(eid) wraps its OR in parentheses", () => {
    const s = billedSql(ORG, eidParam(EID));
    const t = text(s);
    expect(t.startsWith("(EXISTS (SELECT 1 FROM invoices obi")).toBe(true);
    expect(t).toContain(") OR EXISTS (SELECT 1 FROM invoice_line_items jbx");
    expect(t.endsWith("))")).toBe(true);
    expect(q(s).params).toHaveLength(7);
  });

  it("a column eid binds no estimate param", () => {
    const s = billedSql(ORG, sql.raw("e.id"));
    expect(q(s).params).toEqual([ORG, ORG, ORG, ORG, ORG]);
    expect(text(s)).toContain("obi.estimate_id = e.id");
    expect(text(s)).toContain("jbe.id = e.id");
  });

  it("the billing invoice id prefers the office invoice", () => {
    const t = text(billingInvoiceIdSql(ORG, eidParam(EID)));
    expect(t.startsWith("COALESCE(")).toBe(true);
    expect(t.indexOf("FROM invoices obi")).toBeLessThan(t.indexOf("FROM invoice_line_items jbx"));
    expect(t).toContain("ORDER BY obi.created_at DESC LIMIT 1");
    expect(t).toContain("ORDER BY jbi.created_at DESC LIMIT 1");
  });
});

describe("request-status sets", () => {
  it("statusInSql casts every literal", () => {
    expect(text(statusInSql(SELL_STATUSES))).toBe(
      "('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status)",
    );
    expect(text(statusInSql(BILL_STATUSES))).toContain("'completed'::request_status");
    expect(q(statusInSql(BILL_STATUSES)).params).toHaveLength(0);
  });

  it("statusGate splits before-arrival from closed", () => {
    for (const s of ["pending", "assigned", "scheduled", "en_route"]) expect(statusGate(s, SELL_STATUSES)).toBe("not_on_site");
    expect(statusGate("completed", SELL_STATUSES)).toBe("job_closed");
    expect(statusGate("cancelled", BILL_STATUSES)).toBe("job_closed");
    expect(statusGate("completed", BILL_STATUSES)).toBe("ok");
    expect(statusGate("on_hold", SELL_STATUSES)).toBe("ok");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/admin/estimate-billing-sql.test.ts`
Expected: FAIL — cannot resolve `./estimate-billing-sql`.

- [ ] **Step 3: Implement the two modules**

`src/lib/tech/field-sale-statuses.ts`:

```ts
/**
 * Request statuses the field-sale writes accept (M3c spec §5–§6). No imports:
 * shared by the SQL builders, the route preambles, the tech GETs and client
 * components.
 */
export const SELL_STATUSES = ["arrived", "in_progress", "on_hold"] as const;
export const BILL_STATUSES = ["arrived", "in_progress", "on_hold", "completed"] as const;
export const CLOSED_STATUSES = ["completed", "cancelled"] as const;

export type StatusGate = "ok" | "not_on_site" | "job_closed";

/** ok when allowed; a closed status that is not allowed → job_closed; anything else → not_on_site. */
export function statusGate(status: string, allowed: readonly string[]): StatusGate {
  if (allowed.includes(status)) return "ok";
  return (CLOSED_STATUSES as readonly string[]).includes(status) ? "job_closed" : "not_on_site";
}
```

`src/lib/admin/estimate-billing-sql.ts`:

```ts
/**
 * "Is this sold estimate billed?" (M3c spec §5.3) as SQL, shared by the field
 * bill, the office Generate guard, the office "Sold, not invoiced" filter and
 * the technician GET. Pure: drizzle `sql` only.
 *
 * billed(eid) = the OFFICE half (a non-void invoice with estimate_id = eid) OR
 * the JOB half (a non-void native invoice not born from an estimate holding a
 * line linked to one of the sold option's lines). `eid` is a uuid-typed SQL
 * expression: `eidParam(id)` or a column. Aliases are unique per builder so a
 * builder can sit inside a query that already uses e / i / x.
 */
import { sql, type SQL } from "drizzle-orm";

/** `('arrived'::request_status, …)` for a constant status list. */
export function statusInSql(statuses: readonly string[]): SQL {
  return sql.raw(`(${statuses.map((s) => `'${s}'::request_status`).join(", ")})`);
}

export const eidParam = (id: string): SQL => sql`${id}::uuid`;

export function officeBilledSql(org: string, eid: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM invoices obi WHERE obi.organization_id = ${org}::uuid AND obi.estimate_id = ${eid} AND obi.state <> 'void'::invoice_state)`;
}

/** The sold option's line ids. */
function soldLineIdsSql(org: string, eid: SQL): SQL {
  return sql`SELECT jbl.id FROM estimate_line_items jbl JOIN estimates jbe ON jbe.sold_option_id = jbl.option_id
    WHERE jbe.id = ${eid} AND jbe.organization_id = ${org}::uuid AND jbl.organization_id = ${org}::uuid`;
}

const jobLinesFrom = (org: string, eid: SQL): SQL =>
  sql`FROM invoice_line_items jbx JOIN invoices jbi ON jbi.id = jbx.invoice_id
    WHERE jbx.organization_id = ${org}::uuid AND jbi.organization_id = ${org}::uuid AND jbi.estimate_id IS NULL
      AND jbi.state <> 'void'::invoice_state AND jbi.fieldpulse_invoice_id IS NULL AND jbi.hcp_invoice_id IS NULL
      AND jbx.estimate_line_item_id IN (${soldLineIdsSql(org, eid)})`;

export function jobBilledSql(org: string, eid: SQL): SQL {
  return sql`EXISTS (SELECT 1 ${jobLinesFrom(org, eid)})`;
}

export function billedSql(org: string, eid: SQL): SQL {
  return sql`(${officeBilledSql(org, eid)} OR ${jobBilledSql(org, eid)})`;
}

/** The invoice that bills it: the newest non-void office invoice, else the newest job invoice holding its lines. */
export function billingInvoiceIdSql(org: string, eid: SQL): SQL {
  return sql`COALESCE(
    (SELECT obi.id FROM invoices obi WHERE obi.organization_id = ${org}::uuid AND obi.estimate_id = ${eid} AND obi.state <> 'void'::invoice_state ORDER BY obi.created_at DESC LIMIT 1),
    (SELECT jbi.id ${jobLinesFrom(org, eid)} ORDER BY jbi.created_at DESC LIMIT 1))`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/estimate-billing-sql.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Schema edits** in `src/lib/db/schema.ts` (`check` and `foreignKey` are already imported):
  - `estimates` columns, after `soldOptionId`:
    ```ts
    // M3c: who sold it (the selling technician for 'field', the admin for 'office'; NULL for 'portal' and old rows).
    soldBy: uuid("sold_by").references(() => users.id, { onDelete: "set null" }),
    // M3c: 'portal' | 'office' | 'field'; NULL on rows sold before M3c.
    soldVia: text("sold_via"),
    ```
    and in its table callback, after the last `uniqueIndex`:
    ```ts
    check("estimates_sold_via_check", sql`${table.soldVia} IN ('portal','office','field')`),
    ```
  - `invoiceLineItems` columns, after `jobMaterialId`:
    ```ts
    // M3c: set on lines copied from a sold estimate's option (field bill and office
    // Generate). NO ACTION: deleting a billed estimate line fails, so billed(eid)
    // stays armed; an org-delete cascade removes both sides in one statement.
    estimateLineItemId: uuid("estimate_line_item_id"),
    ```
    and replace its table callback with:
    ```ts
    (table) => [
      index("invoice_line_items_invoice_idx").on(table.invoiceId),
      index("invoice_line_items_estimate_line_idx").on(table.estimateLineItemId),
      // Explicit name: drizzle's default (66 chars) exceeds Postgres' 63-char identifier limit.
      foreignKey({
        name: "invoice_line_items_estimate_line_fk",
        columns: [table.estimateLineItemId],
        foreignColumns: [estimateLineItems.id],
      }),
    ],
    ```

- [ ] **Step 6: Generate, then hand-author the SQL.** Check `drizzle/meta/_journal.json`: the last `idx` must be 56. Run `npx drizzle-kit generate --name m3c_sell_on_site`. Compare the generated statement names with the file below (FK `invoice_line_items_estimate_line_fk`, `estimates_sold_by_users_id_fk`, check `estimates_sold_via_check`, index `invoice_line_items_estimate_line_idx`); then overwrite `drizzle/0057_m3c_sell_on_site.sql` with:

```sql
-- M3c Sell on site: the estimate-line link on invoice lines (the per-estimate
-- billed-once guard) and who sold an estimate through which path.
-- Idempotent throughout (one DO block per constraint).
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "estimate_line_item_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_estimate_line_fk" FOREIGN KEY ("estimate_line_item_id") REFERENCES "public"."estimate_line_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_line_items_estimate_line_idx" ON "invoice_line_items" USING btree ("estimate_line_item_id");
--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "sold_by" uuid;
--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "sold_via" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "estimates" ADD CONSTRAINT "estimates_sold_by_users_id_fk" FOREIGN KEY ("sold_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "estimates" ADD CONSTRAINT "estimates_sold_via_check" CHECK ("estimates"."sold_via" IN ('portal','office','field'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

  Confirm `drizzle/meta/0057_snapshot.json` has `"prevId": "5920bbd3-d4b7-469e-a765-f0489c727a87"` and the journal entry is `{ "idx": 57, "version": "7", "when": <generated>, "tag": "0057_m3c_sell_on_site", "breakpoints": true }`. Then run `npx drizzle-kit generate` → expected "No schema changes, nothing to migrate".

- [ ] **Step 7: Migrate dev twice and probe.** `npm run db:migrate` twice (the second run applies nothing). Probe `probe-m3c-1.mts` at the repo root:

```ts
import { config } from "dotenv";
config({ path: ".env.local" });
if ((process.env.DATABASE_URL ?? "").includes("ep-withered-hill")) throw new Error("prod");
const { db } = await import("./src/lib/db");
const { sql } = await import("drizzle-orm");
const cols = await db.execute(sql`SELECT table_name, column_name FROM information_schema.columns
  WHERE (table_name = 'invoice_line_items' AND column_name = 'estimate_line_item_id')
     OR (table_name = 'estimates' AND column_name IN ('sold_by', 'sold_via')) ORDER BY 1, 2`);
const cons = await db.execute(sql`SELECT conname FROM pg_constraint WHERE conname IN
  ('invoice_line_items_estimate_line_fk', 'estimates_sold_by_users_id_fk', 'estimates_sold_via_check') ORDER BY 1`);
const idx = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE indexname = 'invoice_line_items_estimate_line_idx'`);
console.log(JSON.stringify({ cols: cols.rows, cons: cons.rows, idx: idx.rows }));
```

  Run `NODE_OPTIONS=--conditions=react-server npx tsx probe-m3c-1.mts`. Expected: 3 columns, 3 constraints, 1 index. Delete the probe.

- [ ] **Step 8: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/estimate-billing-sql.ts src/lib/admin/estimate-billing-sql.test.ts src/lib/tech/field-sale-statuses.ts src/lib/db/schema.ts && npx vitest run
git add drizzle/0057_m3c_sell_on_site.sql drizzle/meta/0057_snapshot.json drizzle/meta/_journal.json src/lib/db/schema.ts src/lib/tech/field-sale-statuses.ts src/lib/admin/estimate-billing-sql.ts src/lib/admin/estimate-billing-sql.test.ts
git commit -m "$(cat <<'EOF'
feat(m3c): migration 0057 (estimate line link, sold_by/sold_via) and billed(eid) SQL builders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 2: Field bill writer, linked-line protection, office Generate guard, tech invoice view

**Files:**
- Modify: `src/lib/admin/invoice-field-writes.ts` (+ `invoice-field-writes.test.ts`), `src/lib/tech/invoice-errors.ts` (+ `invoice-errors.test.ts`), `src/lib/admin/invoice-queries.ts` (`createInvoiceFromSoldEstimate` ~68–163, `createRequestEstimateInvoice` ~178–223), `src/lib/admin/invoice-queries.test.ts` (~366–498; the existing literal at ~468 is replaced), `src/lib/tech/invoice-queries.ts` (`metaSql`, `linesSql`, `fullInvoice`) (+ `invoice-queries.test.ts`: the existing "lead view never carries a key containing 'cost'" (~183) and "pendingWrite" (~297) cases are updated), `src/lib/tech/invoice-view.ts`, `src/lib/tech/invoice-view-diff.test.ts`, `src/lib/tech/invoice-page-locks.test.ts`, `src/components/tech/invoice/invoice-lines.tsx`, `src/lib/tech/invoice-client-errors.ts` (+ `invoice-client-errors.test.ts`)

**Interfaces:**
- Consumes (Task 1): `billedSql`, `billingInvoiceIdSql`, `eidParam`, `jobBilledSql`, `statusInSql` from `@/lib/admin/estimate-billing-sql`; `BILL_STATUSES` from `@/lib/tech/field-sale-statuses`; column `invoice_line_items.estimate_line_item_id`.
- Produces:
  - `invoice-field-writes.ts`: `FieldReason` gains `"from_estimate"`; `type BillReason = "estimate_not_found" | "estimate_not_sold" | "managed_externally" | "no_lines" | "already_billed" | "invoice_locked" | "invoice_changed" | "not_lead" | "stale" | "too_large"`; `billLinesSql(p: { org; rid; me; inv; estimateId; lines: readonly { id: string; eli: string }[] }): SQL` (the step-3 INSERT, exported so the integration suite can run it twice — ruling of review money M2); `type BillResult = { ok: true; invoiceId: string; added: number; hasMaterials: boolean } | { ok: false; reason: BillReason; invoiceId?: string }`; `billSoldEstimate(actor: Actor & { requestId: string; techUserId: string }, estimateId: string, ids: { invoiceId: string }): Promise<BillResult>`; pure `draftOutcome(r, hasPayment): "continue" | BillReason`, `billOutcome(t): "added" | BillReason`, `exceedsInt32(subtotalCents: number, taxBps: number): boolean`, `isNumericOverflow(error: unknown): boolean`.
  - `invoice-errors.ts`: `RouteReason` covers `"from_estimate"` → 409 `FROM_ESTIMATE` "This item came from the approved estimate. Ask the office to change it."
  - `invoice-view.ts`: `TechInvoiceLine.fromEstimate: boolean`.
  - `src/lib/tech/invoice-queries.ts`: exported `metaSql(org, rid, me)`, `linesSql(org, inv)`; `pendingWrite` counts only `/api/tech/jobs/<rid>/invoice%` and `/api/tech/jobs/<rid>/signature`.
  - `createInvoiceFromSoldEstimate`: unchanged signature; also returns `{ ok: true, invoiceId: <job invoice>, created: false }` when the field bill already holds the estimate's lines.

- [ ] **Step 1: Write the failing writer tests.** Append to `src/lib/admin/invoice-field-writes.test.ts` (reuse its hoisted `readQueue` / `batch` / `getDefaultTaxBps` mocks and its `render` / `renderQ` helpers; add `billLinesSql, billSoldEstimate, billOutcome, draftOutcome, exceedsInt32, isNumericOverflow` to the import from `./invoice-field-writes`):

```ts
describe("removeInvoiceLine refuses an estimate-linked line (spec §5.3)", () => {
  beforeEach(() => { readQueue.length = 0; batch.mockReset(); getDefaultTaxBps.mockResolvedValue(0); });

  it("the DELETE carries estimate_line_item_id IS NULL and the tail reads from_estimate", async () => {
    batch.mockResolvedValueOnce([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ state: "draft", amount_paid_cents: 0, from_estimate: true }] }, { rows: [{ still_lead: true }] }]);
    const r = await removeInvoiceLine({ organizationId: ORG, requestId: REQ, techUserId: ME }, INV, LINE);
    expect(r).toEqual({ ok: false, reason: "from_estimate" });
    const s = (batch.mock.calls[0]![0] as unknown[]).map(render);
    expect(s[2]).toContain("AND estimate_line_item_id IS NULL");
    expect(s[4]).toContain("estimate_line_item_id IS NOT NULL) AS from_estimate");
  });

  it("a locked invoice still answers invoice_locked first", async () => {
    batch.mockResolvedValueOnce([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ state: "open", amount_paid_cents: 0, from_estimate: true }] }, { rows: [{ still_lead: true }] }]);
    expect(await removeInvoiceLine({ organizationId: ORG, requestId: REQ, techUserId: ME }, INV, LINE))
      .toEqual({ ok: false, reason: "invoice_locked" });
  });
});

describe("draftOutcome (spec §5.3 step 2; integration case (q))", () => {
  const ok = (state: string) => ({ ok: true, invoiceId: INV, state, created: false }) as never;
  const no = (reason: string) => ({ ok: false, reason }) as never;
  it.each([
    [ok("draft"), false, "continue"],
    [ok("draft"), true, "invoice_locked"],
    [ok("open"), false, "invoice_locked"],
    [ok("paid"), false, "invoice_changed"],
    [ok("refunded"), false, "invoice_changed"],
    [no("invoice_voided"), false, "invoice_changed"],
    [no("stale"), false, "stale"],
    [no("external_invoice"), false, "managed_externally"],
    [no("managed_externally"), false, "managed_externally"],
    [no("not_lead"), false, "not_lead"],
  ])("%j hasPayment=%s → %s", (r, hasPayment, expected) => {
    expect(draftOutcome(r, hasPayment)).toBe(expected);
  });
});

describe("billOutcome (spec §5.3 step 4)", () => {
  const base = { inserted: 0, stillLead: true, state: "draft", hasPayment: false, billed: false };
  it("inserted lines win", () => expect(billOutcome({ ...base, inserted: 2, billed: true })).toBe("added"));
  it("billed beats everything else (a takeover re-run of our own success)", () =>
    expect(billOutcome({ ...base, billed: true, stillLead: false, state: "open" })).toBe("already_billed"));
  it("not lead", () => expect(billOutcome({ ...base, stillLead: false })).toBe("not_lead"));
  it("a draft with a payment or an open invoice is locked", () => {
    expect(billOutcome({ ...base, hasPayment: true })).toBe("invoice_locked");
    expect(billOutcome({ ...base, state: "open" })).toBe("invoice_locked");
  });
  it("void or anything else is stale", () => {
    expect(billOutcome({ ...base, state: "void" })).toBe("stale");
    expect(billOutcome({ ...base })).toBe("stale");
    expect(billOutcome({ ...base, state: null })).toBe("stale");
  });
});

describe("money guards", () => {
  it("exceedsInt32 counts the tax", () => {
    expect(exceedsInt32(2_000_000_000, 0)).toBe(false);
    expect(exceedsInt32(2_000_000_000, 825)).toBe(true);
    expect(exceedsInt32(2_147_483_647, 0)).toBe(false);
    expect(exceedsInt32(2_147_483_648, 0)).toBe(true);
  });
  it("isNumericOverflow unwraps the Drizzle cause chain", () => {
    expect(isNumericOverflow({ code: "22003" })).toBe(true);
    expect(isNumericOverflow({ message: "x", cause: { cause: { code: "22003" } } })).toBe(true);
    expect(isNumericOverflow({ code: "23505" })).toBe(false);
    expect(isNumericOverflow(null)).toBe(false);
  });
});

describe("billSoldEstimate", () => {
  const EST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const EL1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const actorT = { organizationId: ORG, requestId: REQ, techUserId: ME };
  const pre = (over: Record<string, unknown> = {}) =>
    [{ status: "sold", service_request_id: REQ, synced: false, billed: false, billed_invoice_id: null, ...over }];
  const createRows = (state: "draft" | "open") => (state === "draft"
    ? [{ rows: [] }, { rows: [{ id: INV }] }, { rows: [] }, { rows: [{ id: INV, state }] }, { rows: [{ still_lead: true }] }]
    : [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ id: INV, state }] }, { rows: [{ still_lead: true }] }]);
  const billRows = (inserted: number, tail: Record<string, unknown>) => [
    { rows: [] }, { rows: [] }, { rows: Array.from({ length: inserted }, (_, i) => ({ id: `l${i}` })) }, { rows: [] },
    { rows: [{ state: "draft", amount_paid_cents: 0, billed: inserted > 0, billed_invoice_id: INV, has_materials: false, ...tail }] },
    { rows: [{ still_lead: true }] },
  ];
  const room = (over: Record<string, unknown> = {}) => [{ draft_exists: false, draft_sub: 0, materials_sub: 0, ...over }];
  /** Reads in order: pre-check, sold lines, the int4 headroom read, then createInvoiceFromJob's request row and materials. */
  const happyReads = () => readQueue.push(pre(), [{ id: EL1, line_total_cents: 5_000 }], room(),
    [{ customer_id: CUST, native: true, external_invoice: false }], []);

  beforeEach(() => { readQueue.length = 0; reads.length = 0; batch.mockReset(); getDefaultTaxBps.mockResolvedValue(825); });

  it("404 when the estimate is missing or on another request; nothing else runs", async () => {
    readQueue.push([]);
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "estimate_not_found" });
    readQueue.push(pre({ service_request_id: OTHER }));
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "estimate_not_found" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("billSoldEstimate accepts an uppercase request id", async () => {
    const RID_HEX = "abcdef12-3456-4abc-8def-0123456789ab"; // hex letters: upper-casing changes it
    expect(RID_HEX.toUpperCase()).not.toBe(RID_HEX);
    readQueue.push(pre({ status: "open", service_request_id: RID_HEX }));
    // Without the writer's toLowerCase() this answers estimate_not_found.
    expect(await billSoldEstimate({ ...actorT, requestId: RID_HEX.toUpperCase() }, EST, { invoiceId: INV }))
      .toEqual({ ok: false, reason: "estimate_not_sold" });
  });

  it("refuses before any invoice work: not sold, FieldPulse, no lines, already billed", async () => {
    readQueue.push(pre({ status: "open" }));
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "estimate_not_sold" });
    readQueue.push(pre({ synced: true }));
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "managed_externally" });
    readQueue.push(pre(), []);
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "no_lines" });
    readQueue.push(pre({ billed: true, billed_invoice_id: INV }), [{ id: EL1, line_total_cents: 5_000 }]);
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "already_billed", invoiceId: INV });
    expect(batch).not.toHaveBeenCalled();
  });

  it("too_large before drafting when the draft plus the sale overflows int4", async () => {
    readQueue.push(pre(), [{ id: EL1, line_total_cents: 2_000_000_000 }], room({ draft_exists: true, draft_sub: 200_000_000 }));
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "too_large" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("with no draft yet, the unbilled materials step 2 will seed count toward the int4 check", async () => {
    readQueue.push(pre(), [{ id: EL1, line_total_cents: 2_000_000_000 }], room({ materials_sub: 200_000_000 }));
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "too_large" });
    readQueue.push(pre(), [{ id: EL1, line_total_cents: 2_000_000_000 }], room({ draft_exists: true, draft_sub: 0, materials_sub: 200_000_000 }),
      [{ customer_id: CUST, native: true, external_invoice: false }], [], [{ amount_paid_cents: 0 }]);
    getDefaultTaxBps.mockResolvedValue(0);
    batch.mockResolvedValueOnce(createRows("draft")).mockResolvedValueOnce(billRows(1, {}));
    expect((await billSoldEstimate(actorT, EST, { invoiceId: INV })).ok).toBe(true); // an existing draft is adopted, not seeded
  });

  it("a 22003 inside createInvoiceFromJob (seeding materials) is too_large, not a 500", async () => {
    happyReads();
    batch.mockRejectedValueOnce({ message: "q", cause: { code: "22003" } });
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "too_large" });
  });

  it("this key's derived invoice was paid or voided → invoice_changed (stored: the next tap mints a new key and a new invoice id)", async () => {
    happyReads();
    readQueue.push([{ state: "paid" }], [{ billed: false, invoice_id: null }]);
    batch.mockResolvedValueOnce([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ still_lead: true }] }]);
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "invoice_changed" });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("drafts through createInvoiceFromJob, then inserts the sold lines under L_req → L_inv with NOT billed(eid)", async () => {
    happyReads();
    readQueue.push([{ amount_paid_cents: 0 }]);
    batch.mockResolvedValueOnce(createRows("draft")).mockResolvedValueOnce(billRows(1, {}));
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: true, invoiceId: INV, added: 1, hasMaterials: false });
    const s = (batch.mock.calls[1]![0] as unknown[]).map(render);
    expect(s[2]).toBe(render(billLinesSql({ org: ORG, rid: REQ, me: ME, inv: INV, estimateId: EST,
      lines: [{ id: renderQ((batch.mock.calls[1]![0] as unknown[])[2]).params[2] as string, eli: EL1 }] }))); // params: org, inv, then the v7 line id
    expect(s[0]).toBe(`SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE`);
    expect(s[1]).toContain("FROM invoices WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(s[2]).toMatch(/^INSERT INTO invoice_line_items \(id, organization_id, invoice_id, estimate_line_item_id, name, quantity, unit_price_cents, cost_cents, line_total_cents\)/);
    expect(s[2]).toContain("i.state = 'draft'::invoice_state AND i.amount_paid_cents = 0 AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL");
    expect(s[2]).toContain("r.status IN ('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status, 'completed'::request_status)");
    expect(s[2]).toContain("se.status = 'sold'::estimate_status AND se.fieldpulse_estimate_id IS NULL AND se.sold_option_id = el.option_id");
    expect(s[2]).toContain("AND NOT (EXISTS (SELECT 1 FROM invoices obi");
    expect(s[2]).toContain("ON CONFLICT (id) DO NOTHING RETURNING id");
    expect(s[3]).toContain("invoices.state = 'draft'::invoice_state AND invoices.amount_paid_cents = 0");
    expect(s[4]).toContain("AS has_materials");
  });

  it("an open job invoice re-checks billed(eid): billed → already_billed, else invoice_locked; no second batch", async () => {
    happyReads();
    readQueue.push([{ billed: false, invoice_id: null }]);
    batch.mockResolvedValueOnce(createRows("open"));
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "invoice_locked" });
    expect(batch).toHaveBeenCalledTimes(1);
    batch.mockReset();
    happyReads();
    readQueue.push([{ billed: true, invoice_id: OTHER }]);
    batch.mockResolvedValueOnce(createRows("open"));
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "already_billed", invoiceId: OTHER });
  });

  it("a batch that inserted nothing but sees billed(eid) answers already_billed with the invoice", async () => {
    happyReads();
    readQueue.push([{ amount_paid_cents: 0 }]);
    batch.mockResolvedValueOnce(createRows("draft")).mockResolvedValueOnce(billRows(0, { billed: true, billed_invoice_id: OTHER }));
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "already_billed", invoiceId: OTHER });
  });

  it("billSoldEstimate maps a 22003 overflow to too_large", async () => {
    happyReads();
    readQueue.push([{ amount_paid_cents: 0 }]);
    batch.mockResolvedValueOnce(createRows("draft")).mockRejectedValueOnce({ message: "q", cause: { code: "22003" } });
    expect(await billSoldEstimate(actorT, EST, { invoiceId: INV })).toEqual({ ok: false, reason: "too_large" });
  });
});
```

  Add to `src/lib/tech/invoice-errors.test.ts`:

```ts
it("FROM_ESTIMATE: a line from the approved estimate", () => {
  expect(fieldError("from_estimate")).toEqual({
    status: 409, code: "FROM_ESTIMATE", message: "This item came from the approved estimate. Ask the office to change it.",
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/admin/invoice-field-writes.test.ts src/lib/tech/invoice-errors.test.ts`
Expected: FAIL — `billSoldEstimate` / `draftOutcome` not exported; `from_estimate` missing from the map.

- [ ] **Step 3: Implement in `src/lib/admin/invoice-field-writes.ts`.**
  - Imports: add `import { v7 as uuidv7 } from "uuid";`, `import { billedSql, billingInvoiceIdSql, eidParam, statusInSql } from "@/lib/admin/estimate-billing-sql";`, `import { BILL_STATUSES } from "@/lib/tech/field-sale-statuses";`.
  - `FieldReason`: append `| "from_estimate"`.
  - `removeInvoiceLine`: the DELETE gains `AND estimate_line_item_id IS NULL` right after `organization_id = ${org}::uuid`; the state SELECT becomes

```ts
    sql`SELECT state, amount_paid_cents,
        EXISTS (SELECT 1 FROM invoice_line_items WHERE id = ${lineId}::uuid AND invoice_id = ${invoiceId}::uuid AND organization_id = ${org}::uuid AND estimate_line_item_id IS NOT NULL) AS from_estimate
      FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${org}::uuid AND ${scope.ridPred("service_request_id")}`,
```

    and after the `invoice_locked` check add `if (inv.from_estimate === true) return fail("from_estimate");`.
  - Append the bill section at the end of the file:

```ts
// ---------------------------------------------------------------- bill a sold estimate (M3c §5.3)

export type BillReason =
  | "estimate_not_found" | "estimate_not_sold" | "managed_externally" | "no_lines" | "already_billed"
  | "invoice_locked" | "invoice_changed" | "not_lead" | "stale" | "too_large";
export type BillResult =
  | { ok: true; invoiceId: string; added: number; hasMaterials: boolean }
  | { ok: false; reason: BillReason; invoiceId?: string };

const INT32_MAX = 2_147_483_647;
const BILL_IN = statusInSql(BILL_STATUSES);

/** subtotal + its tax would not fit an int4 money column. */
export function exceedsInt32(subtotalCents: number, taxBps: number): boolean {
  return subtotalCents + Math.round((subtotalCents * taxBps) / 10000) > INT32_MAX;
}

/** SQLSTATE 22003 (numeric value out of range) anywhere in the cause chain. */
export function isNumericOverflow(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e != null && depth < 4; depth++) {
    if ((e as { code?: unknown }).code === "22003") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

type DraftResult = Awaited<ReturnType<typeof createInvoiceFromJob>>;

/**
 * Step 2: what the bill does with createInvoiceFromJob's answer. The caller
 * re-checks billed(eid) before returning any non-continue reason.
 * paid / refunded / invoice_voided describe THIS key's derived invoice, which
 * the same key always derives again: they map to the STORED invoice_changed so
 * the client mints a new key (plan ruling 11, a spec deviation). A plain stale
 * (a deadlock included) stays unstored.
 */
export function draftOutcome(r: DraftResult, hasPayment: boolean): "continue" | BillReason {
  if (r.ok) {
    if (r.state === "draft") return hasPayment ? "invoice_locked" : "continue";
    if (r.state === "open") return "invoice_locked";
    return "invoice_changed"; // paid / refunded
  }
  if (r.reason === "not_lead") return "not_lead";
  if (r.reason === "external_invoice" || r.reason === "managed_externally") return "managed_externally";
  if (r.reason === "invoice_voided") return "invoice_changed";
  return "stale";
}

/** Step 4: the batch's answer. */
export function billOutcome(t: {
  inserted: number; stillLead: boolean; state: string | null; hasPayment: boolean; billed: boolean;
}): "added" | BillReason {
  if (t.inserted > 0) return "added";
  if (t.billed) return "already_billed";
  if (!t.stillLead) return "not_lead";
  if ((t.state === "draft" && t.hasPayment) || t.state === "open") return "invoice_locked";
  return "stale";
}

/**
 * Step 3's guarded INSERT: the sold option's lines onto THIS draft, only while
 * it is a native unpaid draft of the request, the caller is still lead, the
 * request may be billed, the estimate is sold and native, and NOT billed(eid).
 * Exported so the integration suite can prove the in-batch guard on its own.
 */
export function billLinesSql(p: {
  org: string; rid: string; me: string; inv: string; estimateId: string;
  lines: readonly { readonly id: string; readonly eli: string }[];
}): SQL {
  const { org, rid, inv, estimateId } = p;
  const values = sql.join(p.lines.map((l) => sql`(${l.id}::uuid, ${l.eli}::uuid)`), sql`, `);
  return sql`INSERT INTO invoice_line_items (id, organization_id, invoice_id, estimate_line_item_id, name, quantity, unit_price_cents, cost_cents, line_total_cents)
    SELECT v.id, ${org}::uuid, ${inv}::uuid, el.id, el.name, el.quantity, el.unit_price_cents, el.cost_cents, el.line_total_cents
    FROM (VALUES ${values}) AS v(id, eli) JOIN estimate_line_items el ON el.id = v.eli AND el.organization_id = ${org}::uuid
    WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.id = ${inv}::uuid AND i.organization_id = ${org}::uuid AND i.service_request_id = ${rid}::uuid
        AND i.state = 'draft'::invoice_state AND i.amount_paid_cents = 0 AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL)
      AND (${stillLeadSql(org, rid, p.me)})
      AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid AND r.status IN ${BILL_IN})
      AND EXISTS (SELECT 1 FROM estimates se WHERE se.id = ${estimateId}::uuid AND se.organization_id = ${org}::uuid AND se.service_request_id = ${rid}::uuid
        AND se.status = 'sold'::estimate_status AND se.fieldpulse_estimate_id IS NULL AND se.sold_option_id = el.option_id)
      AND NOT ${billedSql(org, eidParam(estimateId))}
    ON CONFLICT (id) DO NOTHING RETURNING id`;
}

const alreadyBilled = (invoiceId: unknown): BillResult =>
  invoiceId ? { ok: false, reason: "already_billed", invoiceId: String(invoiceId) } : { ok: false, reason: "already_billed" };

async function billedNow(org: string, estimateId: string): Promise<{ billed: boolean; invoiceId: unknown }> {
  const eid = eidParam(estimateId);
  const [row] = await readRows(sql`SELECT ${billedSql(org, eid)} AS billed, ${billingInvoiceIdSql(org, eid)} AS invoice_id`);
  return { billed: row?.billed === true, invoiceId: row?.invoice_id ?? null };
}

/**
 * Int4 headroom before drafting: an existing native draft is adopted as is;
 * with none, step 2 creates one seeded with the job's unbilled materials.
 */
function headroomSql(org: string, rid: string): SQL {
  return sql`SELECT
      EXISTS (SELECT 1 FROM invoices d WHERE d.organization_id = ${org}::uuid AND d.service_request_id = ${rid}::uuid
        AND d.state = 'draft'::invoice_state AND d.fieldpulse_invoice_id IS NULL AND d.hcp_invoice_id IS NULL) AS draft_exists,
      (SELECT COALESCE(SUM(l.line_total_cents), 0)::bigint FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id
        WHERE i.organization_id = ${org}::uuid AND l.organization_id = ${org}::uuid AND i.service_request_id = ${rid}::uuid
          AND i.state = 'draft'::invoice_state AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL) AS draft_sub,
      (SELECT COALESCE(SUM(m.quantity::bigint * m.unit_price_cents), 0)::bigint FROM job_materials m
        WHERE m.service_request_id = ${rid}::uuid AND m.organization_id = ${org}::uuid
          AND NOT ${materialBilledSql(org, rid, sql.raw("m.id"))}) AS materials_sub`;
}

/**
 * Put a sold estimate's option lines on the job's invoice, exactly once per
 * estimate (spec §5.3): pre-check → adopt-or-create the draft (M3b) → one
 * batch L_req → L_inv → billLinesSql (NOT billed(eid)) → totals → tails.
 */
export async function billSoldEstimate(
  actor: Actor & { requestId: string; techUserId: string },
  estimateId: string,
  ids: { invoiceId: string },
): Promise<BillResult> {
  const { organizationId: org, techUserId: me } = actor;
  const rid = actor.requestId.toLowerCase();
  const eid = eidParam(estimateId);

  // 1. Pre-check: no invoice is touched or created on a refusal.
  const [est] = await readRows(sql`SELECT e.status::text AS status, e.service_request_id,
      e.fieldpulse_estimate_id IS NOT NULL AS synced,
      ${billedSql(org, eid)} AS billed, ${billingInvoiceIdSql(org, eid)} AS billed_invoice_id
    FROM estimates e WHERE e.id = ${estimateId}::uuid AND e.organization_id = ${org}::uuid`);
  if (!est || String(est.service_request_id) !== rid) return { ok: false, reason: "estimate_not_found" };
  if (est.status !== "sold") return { ok: false, reason: "estimate_not_sold" };
  if (est.synced === true) return { ok: false, reason: "managed_externally" };
  const lines = await readRows(sql`SELECT el.id, el.line_total_cents FROM estimate_line_items el
      JOIN estimates e ON e.sold_option_id = el.option_id
    WHERE e.id = ${estimateId}::uuid AND e.organization_id = ${org}::uuid AND el.organization_id = ${org}::uuid
    ORDER BY el.id`);
  if (lines.length === 0) return { ok: false, reason: "no_lines" };
  if (est.billed === true) return alreadyBilled(est.billed_invoice_id);

  const taxBps = await getDefaultTaxBps(org);
  const [room] = await readRows(headroomSql(org, rid));
  const existing = room?.draft_exists === true ? Number(room.draft_sub ?? 0) : Number(room?.materials_sub ?? 0);
  const sale = lines.reduce((s, l) => s + Number(l.line_total_cents), 0);
  if (exceedsInt32(sale + existing, taxBps)) return { ok: false, reason: "too_large" };

  // 2. Draft: the normal M3b adopt-or-create (seeds the job's unbilled materials).
  let created: DraftResult;
  try {
    created = await createInvoiceFromJob({ ...actor, requestId: rid }, { invoiceId: ids.invoiceId });
  } catch (error) {
    if (isNumericOverflow(error)) return { ok: false, reason: "too_large" };
    throw error;
  }
  let hasPayment = false;
  if (created.ok && created.state === "draft") {
    const [row] = await readRows(sql`SELECT amount_paid_cents FROM invoices WHERE id = ${created.invoiceId}::uuid AND organization_id = ${org}::uuid`);
    hasPayment = Number(row?.amount_paid_cents ?? 0) > 0;
  }
  const step = draftOutcome(created, hasPayment);
  if (step !== "continue" || !created.ok) {
    const again = await billedNow(org, estimateId);
    if (again.billed) return alreadyBilled(again.invoiceId);
    return { ok: false, reason: step === "continue" ? "stale" : step };
  }
  const inv = created.invoiceId;

  // 3. One batch. Line ids are v7 in the estimate's line order; exactly-once is
  // NOT billed(eid) under L_req, not the ids.
  const lead = stillLeadSql(org, rid, me);
  let rows: Row[][] | Fail;
  try {
    rows = await runBatch([
      lockRequestSql(org, rid),
      lockInvoiceSql(org, inv),
      billLinesSql({ org, rid, me, inv, estimateId, lines: lines.map((l) => ({ id: uuidv7(), eli: String(l.id) })) }),
      totalsSql(org, inv, taxBps, LINE_GATE),
      sql`SELECT i.state::text AS state, i.amount_paid_cents,
          ${billedSql(org, eid)} AS billed, ${billingInvoiceIdSql(org, eid)} AS billed_invoice_id,
          EXISTS (SELECT 1 FROM invoice_line_items m WHERE m.invoice_id = i.id AND m.organization_id = ${org}::uuid AND m.job_material_id IS NOT NULL) AS has_materials
        FROM invoices i WHERE i.id = ${inv}::uuid AND i.organization_id = ${org}::uuid`,
      sql`SELECT (${lead}) AS still_lead`,
    ]);
  } catch (error) {
    if (isNumericOverflow(error)) return { ok: false, reason: "too_large" };
    throw error;
  }
  if (!Array.isArray(rows)) return { ok: false, reason: "stale" };

  // 4. Result.
  const inserted = rows[2]!.length;
  const tail = rows[4]![0];
  const outcome = billOutcome({
    inserted,
    stillLead: rows[5]![0]?.still_lead === true,
    state: tail ? String(tail.state) : null,
    hasPayment: Number(tail?.amount_paid_cents ?? 0) > 0,
    billed: tail?.billed === true,
  });
  if (outcome === "added") return { ok: true, invoiceId: inv, added: inserted, hasMaterials: tail?.has_materials === true };
  if (outcome === "already_billed") return alreadyBilled(tail?.billed_invoice_id);
  return { ok: false, reason: outcome };
}
```

  In `src/lib/tech/invoice-errors.ts` add to `MAP`:

```ts
  from_estimate: { status: 409, code: "FROM_ESTIMATE", message: "This item came from the approved estimate. Ask the office to change it." },
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/lib/admin/invoice-field-writes.test.ts src/lib/tech/invoice-errors.test.ts`
Expected: PASS except the existing case "removes under the draft + unpaid gate, T with amount_paid_cents = 0", whose parameter array pins the old state SELECT. Change its `expect(params()).toEqual([2, 2, 10, 5, 3, 4]);` to `expect(params()).toEqual([2, 2, 10, 5, 6, 4]);` (the state SELECT now also binds lineId, invoiceId and org for `from_estimate`); its `s[2]` text assertion still matches (the new `AND estimate_line_item_id IS NULL` sits before the gate it pins). Re-run → PASS.

- [ ] **Step 5: Failing office-guard tests** in `src/lib/admin/invoice-queries.test.ts` (this task owns the file; its existing cases change as shown).
  - `mockCreateSeq` becomes (adds `orderBy` for the lines read):

```ts
function mockCreateSeq(results: unknown[][]): void {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => {
            const r = results[i++] ?? [];
            const p = Promise.resolve(r);
            return Object.assign(p, { limit: () => Promise.resolve(r), orderBy: () => Promise.resolve(r) });
          },
        }),
      }) as never,
  );
}
```

  - In "creates an invoice (state 'open') from the sold option's snapshot on first call (no request)" the line fixture gains `id: "el-1"`; the case starts with

```ts
    const valuesSpy = vi.fn((v: unknown) => v);
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);
```

    and ends with

```ts
    const lineRows = valuesSpy.mock.calls.map((c) => c[0]).find(Array.isArray) as { id: string; estimateLineItemId: string }[];
    expect(lineRows[0]!.estimateLineItemId).toBe("el-1");
    expect(lineRows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // v7
```
  - In `describe("with a service request (spec §5.8)")`: `const LINE = { id: "el-1", name: "Repair", quantity: 1, unitPriceCents: 9000, costCents: 4000, lineTotalCents: 9000 };` and the case "locks the request, then inserts only when no native draft exists, lines gated on the invoice xmin" becomes:

```ts
    it("locks the request, then inserts only when no native draft exists and the job's invoice does not hold the lines; lines linked and xmin-gated", async () => {
      mockCreateSeq([[EST], [], [OPT], [LINE]]);
      vi.mocked(db.batch).mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "x" }] }, { rows: [] }] as never);
      const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
      expect(r.ok).toBe(true);
      const [lock, insert, lines] = batchStmts().map(render);
      expect(batchStmts()).toHaveLength(3);
      expect(lock).toContain("FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
      expect(insert).toMatch(/^INSERT INTO invoices .* SELECT .*'open'::invoice_state/);
      expect(insert).toContain(
        "WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id = $9::uuid AND service_request_id = $10::uuid AND state = 'draft'::invoice_state AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL) AND NOT EXISTS (SELECT 1 FROM invoice_line_items jbx",
      );
      expect(insert).toContain("jbi.estimate_id IS NULL");
      expect(insert.endsWith("ON CONFLICT DO NOTHING RETURNING id")).toBe(true);
      expect(renderQ(batchStmts()[1]).params).toHaveLength(15);
      expect(lines).toMatch(/^INSERT INTO invoice_line_items \(id, organization_id, invoice_id, estimate_line_item_id, name,/);
      expect(lines).toContain("WHERE EXISTS (SELECT 1 FROM invoices WHERE id = $");
      expect(lines).toContain("xmin = pg_current_xact_id()::xid)");
      // 1 line × (id, estimate line, name, qty, price, cost, total) + org + invoice + (invoice, org) in the gate
      expect(renderQ(batchStmts()[2]).params).toHaveLength(11);
      expect(renderQ(batchStmts()[2]).params).toContain("el-1");
    });

    it("returns the job's invoice when the field bill already holds the estimate's lines", async () => {
      mockCreateSeq([[EST], [], [OPT], [LINE], [], [{ invoiceId: "inv-job" }]]);
      vi.mocked(db.batch).mockResolvedValueOnce([{ rows: [] }, { rows: [] }, { rows: [] }] as never);
      const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
      expect(r).toEqual({ ok: true, invoiceId: "inv-job", created: false });
    });
```

    The two other cases in that describe ("refuses with request_has_draft…", "returns the estimate's invoice when a concurrent create won…") stay as they are: their select sequences end before the new job-invoice read, which then resolves `[]`.

  Run: `npx vitest run src/lib/admin/invoice-queries.test.ts` → FAIL (no link column, no job-half guard, no job-invoice read).

- [ ] **Step 6: Implement the office guard** in `src/lib/admin/invoice-queries.ts` (spec §5.4).
  - Imports: add `import { v7 as uuidv7 } from "uuid";` and `import { billingInvoiceIdSql, eidParam, jobBilledSql } from "@/lib/admin/estimate-billing-sql";` (dependency-free, safe on this widely imported module).
  - In `createInvoiceFromSoldEstimate`, the lines read becomes:

```ts
  const lines = await db
    .select({
      id: estimateLineItems.id,
      name: estimateLineItems.name,
      quantity: estimateLineItems.quantity,
      unitPriceCents: estimateLineItems.unitPriceCents,
      costCents: estimateLineItems.costCents,
      lineTotalCents: estimateLineItems.lineTotalCents,
    })
    .from(estimateLineItems)
    .where(withTenant(estimateLineItems, organizationId, eq(estimateLineItems.optionId, est.soldOptionId)))
    .orderBy(asc(estimateLineItems.id));
```

    and the no-request path's line insert becomes:

```ts
      db.insert(invoiceLineItems).values(
        lines.map(({ id, ...l }) => ({ ...l, id: uuidv7(), estimateLineItemId: id, organizationId, invoiceId })),
      ),
```

  - `type EstimateLine = { id: string; name: string; quantity: number; unitPriceCents: number; costCents: number; lineTotalCents: number };`
  - `createRequestEstimateInvoice` in full:

```ts
/**
 * Estimate-born invoice on a request (M3b spec §5.8, M3c spec §5.4): ONE batch
 * — L_req, then the INSERT refuses while the request has a NATIVE draft or the
 * job's invoice already holds this estimate's lines (the job half of
 * billed(eid)); the lines land only when this transaction wrote the invoice
 * (xmin gate), linked to their estimate line, v7 ids in line order.
 */
async function createRequestEstimateInvoice(
  org: string,
  rid: string,
  inv: string,
  est: { id: string; customerId: string | null },
  opt: { subtotalCents: number; taxCents: number; totalCents: number },
  lines: readonly EstimateLine[],
): Promise<CreateInvoiceResult> {
  // Lazy: the M3b writer module's import graph (tech field queries, inventory,
  // status writes) stays off this widely-imported module's load path.
  const { lockRequestSql, P_NATIVE } = await import("./invoice-field-writes");
  const items: SQL[] = [
    lockRequestSql(org, rid),
    sql`INSERT INTO invoices (id, organization_id, service_request_id, customer_id, estimate_id, state, subtotal_cents, tax_cents, total_cents, amount_paid_cents)
      SELECT ${inv}::uuid, ${org}::uuid, ${rid}::uuid, ${est.customerId}::uuid, ${est.id}::uuid, 'open'::invoice_state,
        ${opt.subtotalCents}::int, ${opt.taxCents}::int, ${opt.totalCents}::int, 0
      WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
        AND state = 'draft'::invoice_state AND ${P_NATIVE})
        AND NOT ${jobBilledSql(org, eidParam(est.id))}
      ON CONFLICT DO NOTHING RETURNING id`,
  ];
  if (lines.length > 0) {
    const values = sql.join(
      lines.map(
        (l) =>
          sql`(${uuidv7()}::uuid, ${l.id}::uuid, ${l.name}::text, ${l.quantity}::int, ${l.unitPriceCents}::int, ${l.costCents}::int, ${l.lineTotalCents}::int)`,
      ),
      sql`, `,
    );
    items.push(sql`INSERT INTO invoice_line_items (id, organization_id, invoice_id, estimate_line_item_id, name, quantity, unit_price_cents, cost_cents, line_total_cents)
      SELECT v.id, ${org}::uuid, ${inv}::uuid, v.eli, v.name, v.quantity, v.unit_price_cents, v.cost_cents, v.line_total_cents
      FROM (VALUES ${values}) AS v(id, eli, name, quantity, unit_price_cents, cost_cents, line_total_cents)
      WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ${inv}::uuid AND organization_id = ${org}::uuid AND xmin = pg_current_xact_id()::xid)`);
  }
  const out = (await db.batch(items.map((q) => db.execute(q)) as never)) as unknown as { rows: unknown[] }[];
  if (out[1]!.rows.length > 0) return { ok: true, invoiceId: inv, created: true };
  // No row: a concurrent create of THIS estimate won the per-estimate unique
  // index (return it, like the early return) …
  const [raced] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(withTenant(invoices, org, eq(invoices.estimateId, est.id)))
    .limit(1);
  if (raced) return { ok: true, invoiceId: raced.id, created: false };
  // … or the job's invoice already holds this estimate's lines: that invoice bills it …
  const [job] = await db
    .select({ invoiceId: sql<string | null>`${billingInvoiceIdSql(org, eidParam(est.id))}` })
    .from(estimates)
    .where(withTenant(estimates, org, eq(estimates.id, est.id)))
    .limit(1);
  if (job?.invoiceId) return { ok: true, invoiceId: job.invoiceId, created: false };
  // … or the request has a native draft.
  return { ok: false, reason: "request_has_draft" };
}
```

  Run: `npx vitest run src/lib/admin/invoice-queries.test.ts src/lib/admin/estimate-synced-guards.test.ts` → PASS.

- [ ] **Step 7: Tech invoice view.**
  - `src/lib/tech/invoice-view.ts`: `TechInvoiceLine` gains `/** Copied from a sold estimate: the field cannot remove it. */ readonly fromEstimate: boolean;`.
  - `src/lib/tech/invoice-queries.ts`: export `metaSql` and `linesSql`; in `metaSql` replace `AND k.route LIKE '/api/tech/jobs/' || ${rid}::text || '/%'` with `AND (k.route LIKE '/api/tech/jobs/' || ${rid}::text || '/invoice%' OR k.route = '/api/tech/jobs/' || ${rid}::text || '/signature')`; `linesSql` selects `estimate_line_item_id IS NOT NULL AS from_estimate`; `fullInvoice` maps `fromEstimate: l.from_estimate === true`.
  - Every object literal with `lineTotalCents` in `src/lib/tech/invoice-view-diff.test.ts` and `src/lib/tech/invoice-page-locks.test.ts` gains `fromEstimate: false`.
  - `src/lib/tech/invoice-queries.test.ts` (this task owns it; it already declares `REQ`, `ME`, `INV`, `ORG` and `render` — do NOT redeclare them):
    - In "lead view never carries a key containing 'cost' although the rows do" the expected line becomes `{ id: "l1", name: "Capacitor", quantity: 2, unitPriceCents: 5000, lineTotalCents: 10000, fromEstimate: false }`.
    - In "pendingWrite: in-progress key for (org, user) on this job's routes younger than 2 minutes" the regex becomes:

```ts
    expect(meta.sql).toMatch(/EXISTS \(SELECT 1 FROM idempotency_keys k WHERE k\.organization_id = \$\d+::uuid AND k\.user_id = \$\d+::uuid AND \(k\.route LIKE '\/api\/tech\/jobs\/' \|\| \$\d+::text \|\| '\/invoice%' OR k\.route = '\/api\/tech\/jobs\/' \|\| \$\d+::text \|\| '\/signature'\) AND k\.state = 'in_progress' AND k\.created_at > now\(\) - interval '2 minutes'\)/);
```

    - Add (import `metaSql`, `linesSql` next to `getTechInvoiceView`):

```ts
describe("M3c: the invoice view ignores estimate and equipment keys", () => {
  it("pendingWrite counts only the invoice and signature routes", () => {
    const t = render(metaSql(ORG, REQ, ME));
    expect(t).toContain("'/invoice%' OR k.route = '/api/tech/jobs/' ||");
    expect(t).not.toContain("'/%'");
  });
  it("lines say whether they came from an estimate, never their cost", () => {
    const t = render(linesSql(ORG, INV));
    expect(t).toContain("estimate_line_item_id IS NOT NULL AS from_estimate");
    expect(t).not.toContain("cost");
  });
});
```

  - `src/components/tech/invoice/invoice-lines.tsx`, in `InvoiceLines`: under the qty line add `{l.fromEstimate && <p className="text-[13px] text-muted-foreground">From the estimate</p>}` and change the remove guard to `{onRemove && !l.fromEstimate && (`.
  - `src/lib/tech/invoice-client-errors.ts`: `MESSAGE_CONFLICTS` gains `"FROM_ESTIMATE"` and `"JOB_CLOSED"` (the invoice routes now answer a cancelled job with `JOB_CLOSED`; the invoice client shows the server copy "Arrive at the job before invoicing." and refetches). Tests in `invoice-client-errors.test.ts`:

```ts
it("FROM_ESTIMATE and JOB_CLOSED show their message and refetch (M3c)", () => {
  expect(classifyWriteError(409, "FROM_ESTIMATE")).toBe("show_message_refetch");
  expect(classifyWriteError(409, "JOB_CLOSED")).toBe("show_message_refetch");
});
```

    and in `src/lib/tech/invoice-page-copy.test.ts` is NOT touched; `writeErrorCopy("show_message_refetch", { error: { code: "JOB_CLOSED", message: "Arrive at the job before invoicing." } }, false)` already returns the server message (its default branch).

  Run: `npx vitest run src/lib/tech src/lib/admin` → PASS.

- [ ] **Step 8: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/invoice-field-writes.ts src/lib/admin/invoice-field-writes.test.ts src/lib/tech/invoice-errors.ts src/lib/tech/invoice-errors.test.ts src/lib/admin/invoice-queries.ts src/lib/admin/invoice-queries.test.ts src/lib/tech/invoice-queries.ts src/lib/tech/invoice-queries.test.ts src/lib/tech/invoice-view.ts src/lib/tech/invoice-view-diff.test.ts src/lib/tech/invoice-page-locks.test.ts src/components/tech/invoice/invoice-lines.tsx src/lib/tech/invoice-client-errors.ts src/lib/tech/invoice-client-errors.test.ts && npx vitest run
git add src/lib/admin/invoice-field-writes.ts src/lib/admin/invoice-field-writes.test.ts src/lib/tech/invoice-errors.ts src/lib/tech/invoice-errors.test.ts src/lib/admin/invoice-queries.ts src/lib/admin/invoice-queries.test.ts src/lib/tech/invoice-queries.ts src/lib/tech/invoice-queries.test.ts src/lib/tech/invoice-view.ts src/lib/tech/invoice-view-diff.test.ts src/lib/tech/invoice-page-locks.test.ts src/components/tech/invoice/invoice-lines.tsx src/lib/tech/invoice-client-errors.ts src/lib/tech/invoice-client-errors.test.ts
git commit -m "$(cat <<'EOF'
feat(m3c): bill a sold estimate once per estimate; office Generate guard; linked lines stay put

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 3: Estimate writers — create, sell, decline; stored codes

**Files:**
- Create: `src/lib/tech/estimate-input.ts`, `src/lib/tech/estimate-input.test.ts`, `src/lib/tech/estimate-writes.ts`, `src/lib/tech/estimate-writes.test.ts`, `src/lib/tech/estimate-errors.ts`, `src/lib/tech/estimate-errors.test.ts`
- Modify: `src/lib/http/idempotency-codes.ts` (`STORED_CODES`), `src/lib/http/idempotency.test.ts` (the "STORED_CODES is exactly…" case, ~line 461)

**Interfaces:**
- Consumes: Task 1 `statusInSql`, `SELL_STATUSES`, `statusGate`; existing `lockRequestSql`, `readRows`, `runBatch`, `stillLeadSql` (`@/lib/admin/invoice-field-writes`), `getDefaultTaxBps` (`@/lib/admin/pricebook-queries`).
- Produces:
  - `estimate-input.ts` (pure, client-safe; no imports): `MAX_OPTIONS = 3`, `MAX_LINES_PER_OPTION = 40`, `MAX_QUANTITY = 999`, `MAX_OPTION_NAME = 40`, `MIN_SIGNATURE = 2`, `MAX_SIGNATURE = 200`, `OFFICE_SIGNATURE = "(admin)"`, `INT32_MAX`, types `CreateLineInput { pricebookItemId: string; quantity: number }`, `CreateOptionInput { name: string; lines: readonly CreateLineInput[] }`, `CreateEstimateInput { options: readonly CreateOptionInput[] }`, `PricedItem`, `BuiltOption`, `BuiltLine`; `hasDuplicateNames(names: readonly string[]): boolean`, `signatureNameOk(raw: string): boolean`, `buildFieldEstimate(input, items: ReadonlyMap<string, PricedItem>, taxBps: number, mintId: () => string): { ok: true; options: BuiltOption[]; lines: BuiltLine[]; totalCents: number } | { ok: false; reason: "item_inactive" | "too_large" }`.
  - `estimate-writes.ts`: `EstimateActor { organizationId; requestId; techUserId }`, `EstimateWriteReason = "estimate_not_found" | "no_customer" | "not_lead" | "not_on_site" | "job_closed" | "stale" | "already_decided" | "estimate_expired" | "invalid_option" | "item_inactive" | "too_large" | "managed_externally"`, `EstimateWriteResult = { ok: true; estimateId: string; created: boolean } | { ok: false; reason: EstimateWriteReason }`; `createFieldEstimate(actor, ids: { estimateId: string }, input: CreateEstimateInput)`, `sellFieldEstimate(actor, input: { estimateId: string; optionId: string; signatureName: string })`, `declineFieldEstimate(actor, estimateId: string)` — all `Promise<EstimateWriteResult>`; pure `createOutcome`, `sellOutcome`, `declineOutcome`.
  - `estimate-errors.ts`: `EstimateRouteReason` (= `EstimateWriteReason` ∪ Task 2's `BillReason` names, spelled out locally so this module has no runtime dependency on the writers), `estimateError(reason): { status; code; message }`, `estimateReasonResult(reason, details?: Record<string, unknown>): RunResult`.

- [ ] **Step 1: Failing pure tests** — `src/lib/tech/estimate-input.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFieldEstimate, hasDuplicateNames, INT32_MAX, signatureNameOk, type PricedItem } from "./estimate-input";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const items = new Map<string, PricedItem>([
  [A, { id: A, name: "Capacitor", priceCents: 12_500, costCents: 4_000 }],
  [B, { id: B, name: "Condenser fan motor", priceCents: 48_000, costCents: 21_000 }],
]);
let n = 0;
const mint = () => `id-${String(++n).padStart(3, "0")}`;

describe("hasDuplicateNames", () => {
  it("is case-insensitive and trims", () => {
    expect(hasDuplicateNames(["Good", " good "])).toBe(true);
    expect(hasDuplicateNames(["Good", "Better", "Best"])).toBe(false);
  });
});

describe("signatureNameOk (portal rule)", () => {
  it.each([["Pat", true], [" P ", false], ["Jo", true], ["(admin)", false], [" (admin) ", false], ["x".repeat(200), true], ["x".repeat(201), false]])(
    "%j → %s", (name, ok) => expect(signatureNameOk(name)).toBe(ok),
  );
});

describe("buildFieldEstimate", () => {
  it("snapshots names, prices and costs; totals with tax; headline = the largest option", () => {
    n = 0;
    const r = buildFieldEstimate({ options: [
      { name: " Good ", lines: [{ pricebookItemId: A, quantity: 2 }] },
      { name: "Better", lines: [{ pricebookItemId: A, quantity: 1 }, { pricebookItemId: B, quantity: 1 }] },
    ] }, items, 825, mint);
    if (!r.ok) throw new Error("expected ok");
    expect(r.options.map((o) => [o.name, o.sortOrder, o.subtotalCents, o.taxCents, o.totalCents])).toEqual([
      ["Good", 0, 25_000, 2_063, 27_063],
      ["Better", 1, 60_500, 4_991, 65_491],
    ]);
    expect(r.totalCents).toBe(65_491);
    expect(r.lines[0]).toEqual({ id: "id-002", optionId: "id-001", pricebookItemId: A, name: "Capacitor", quantity: 2, unitPriceCents: 12_500, costCents: 4_000, lineTotalCents: 25_000 });
    // ids in build order: option, its lines, next option, its lines
    expect([r.options[0]!.id, r.lines[0]!.id, r.options[1]!.id, r.lines[1]!.id, r.lines[2]!.id]).toEqual(["id-001", "id-002", "id-003", "id-004", "id-005"]);
  });

  it("buildFieldEstimate refuses a deactivated item and keeps two lines of the same item", () => {
    n = 0;
    const twice = buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: A, quantity: 1 }, { pricebookItemId: A, quantity: 3 }] }] }, items, 0, mint);
    expect(twice.ok && twice.lines.map((l) => l.quantity)).toEqual([1, 3]);
    const gone = buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", quantity: 1 }] }] }, items, 0, mint);
    expect(gone).toEqual({ ok: false, reason: "item_inactive" });
  });

  it("matches item ids case-insensitively", () => {
    const r = buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: A.toUpperCase(), quantity: 1 }] }] }, items, 0, mint);
    expect(r.ok).toBe(true);
  });

  it("buildFieldEstimate refuses an option total over INT32_MAX", () => {
    const big = new Map<string, PricedItem>([[A, { id: A, name: "Chiller", priceCents: 2_200_000, costCents: 0 }]]);
    expect(buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: A, quantity: 999 }] }] }, big, 0, mint))
      .toEqual({ ok: false, reason: "too_large" });
    const edge = new Map<string, PricedItem>([[A, { id: A, name: "Chiller", priceCents: 1_900_000, costCents: 0 }]]);
    // 999 × $19,000 = $18,981,000 subtotal + 825 bps tax = $20,546,932.50 → still fits
    expect(buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: A, quantity: 999 }] }] }, edge, 825, mint).ok).toBe(true);
    expect(INT32_MAX).toBe(2_147_483_647);
  });
});
```

  `src/lib/tech/estimate-errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { estimateError, estimateReasonResult } from "./estimate-errors";
import { isStorable } from "@/lib/http/idempotency";

describe("estimate route reasons (spec §4–§5)", () => {
  it.each([
    ["estimate_not_found", 404, "NOT_FOUND", "That estimate isn't on this job."],
    ["no_customer", 409, "NO_CUSTOMER", "Ask the office to add the customer before quoting."],
    ["not_lead", 403, "NOT_LEAD", "Only the lead technician can do that."],
    ["not_on_site", 409, "NOT_ON_SITE", "Arrive at the job first."],
    ["job_closed", 409, "JOB_CLOSED", "This job is closed."],
    ["stale", 409, "STALE", "This job changed. Try again."],
    ["already_decided", 409, "ALREADY_DECIDED", "This estimate was already decided."],
    ["estimate_expired", 409, "ESTIMATE_EXPIRED", "This estimate expired. Build a new one."],
    ["invalid_option", 400, "INVALID_OPTION", "That option isn't on this estimate."],
    ["item_inactive", 400, "INVALID_INPUT", "One of these items is no longer in the pricebook."],
    ["too_large", 400, "INVALID_INPUT", "That total is too large."],
    ["managed_externally", 409, "MANAGED_EXTERNALLY", "This job is managed in FieldPulse."],
    ["estimate_not_sold", 409, "ESTIMATE_NOT_SOLD", "Approve the estimate first."],
    ["no_lines", 409, "NO_LINES", "This estimate has no items."],
    ["already_billed", 409, "ALREADY_BILLED", "This estimate is already on an invoice."],
    ["invoice_locked", 409, "INVOICE_LOCKED", "The job's invoice is already finalized. Ask the office to bill this estimate."],
    ["invoice_changed", 409, "INVOICE_CHANGED", "The job's invoice changed. Try again."],
  ] as const)("%s → %i %s", (reason, status, code, message) => {
    expect(estimateError(reason)).toEqual({ status, code, message });
  });

  it("ALREADY_BILLED carries the invoice id", () => {
    expect(estimateReasonResult("already_billed", { invoiceId: "inv-1" })).toEqual({
      status: 409,
      envelope: { success: false, error: { message: "This estimate is already on an invoice.", code: "ALREADY_BILLED", details: { invoiceId: "inv-1" } } },
    });
  });

  it("stores exactly the terminal codes", () => {
    const stored = (r: Parameters<typeof estimateReasonResult>[0]) => {
      const x = estimateReasonResult(r);
      return isStorable(x.status, x.envelope);
    };
    for (const r of ["already_decided", "estimate_expired", "invalid_option", "already_billed", "no_lines", "invoice_locked", "invoice_changed", "item_inactive", "too_large"] as const) {
      expect(stored(r)).toBe(true);
    }
    for (const r of ["no_customer", "stale", "not_lead", "not_on_site", "job_closed", "estimate_not_sold", "managed_externally", "estimate_not_found"] as const) {
      expect(stored(r)).toBe(false);
    }
  });
});
```

  In `src/lib/http/idempotency.test.ts` change the expected `STORED_CODES` list to:

```ts
      ["ALREADY_BILLED", "ALREADY_DECIDED", "EQUIPMENT_RETIRED", "ESTIMATE_EXPIRED", "INVALID_INPUT", "INVALID_OPTION", "INVOICE_CHANGED", "INVOICE_LOCKED", "INVOICE_VOIDED", "ITEM_NOT_FOUND", "NO_LINES", "SEND_FAILED", "VALIDATION_ERROR"],
```

- [ ] **Step 2: Failing writer tests** — `src/lib/tech/estimate-writes.test.ts` (harness copied from `invoice-field-writes.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, batch, getDefaultTaxBps } = vi.hoisted(() => ({
  readQueue: [] as unknown[][],
  batch: vi.fn(),
  getDefaultTaxBps: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => ({
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err),
    }),
    batch,
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps, getPricebookItemById: vi.fn() }));

import {
  createFieldEstimate, createOutcome, declineFieldEstimate, declineOutcome, sellFieldEstimate, sellOutcome,
} from "./estimate-writes";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const EST = "44444444-4444-4444-8444-444444444444";
const OPT = "55555555-5555-4555-8555-555555555555";
const ITEM = "66666666-6666-4666-8666-666666666666";
const CUST = "77777777-7777-4777-8777-777777777777";
const actor = { organizationId: ORG, requestId: REQ, techUserId: ME };

const dialect = new PgDialect();
const renderQ = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL);
const render = (q: unknown) => renderQ(q).sql.replace(/\s+/g, " ").trim();
const stmts = (call = 0) => (batch.mock.calls[call]![0] as unknown[]).map(render);
const rowsOf = (...r: unknown[][]) => r.map((rows) => ({ rows }));

beforeEach(() => { readQueue.length = 0; batch.mockReset(); getDefaultTaxBps.mockResolvedValue(825); });

const body = { options: [{ name: "Good", lines: [{ pricebookItemId: ITEM, quantity: 2 }] }] };

describe("createFieldEstimate (spec §5.1)", () => {
  it("no customer → no_customer, nothing written", async () => {
    readQueue.push([{ customer_id: null }]);
    expect(await createFieldEstimate(actor, { estimateId: EST }, body)).toEqual({ ok: false, reason: "no_customer" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("an inactive or missing item → item_inactive, nothing written", async () => {
    readQueue.push([{ customer_id: CUST }], []);
    expect(await createFieldEstimate(actor, { estimateId: EST }, body)).toEqual({ ok: false, reason: "item_inactive" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("one batch: L_req → estimate gated on lead/status/customer → options and lines gated on its xmin → tail", async () => {
    readQueue.push([{ customer_id: CUST }], [{ id: ITEM, name: "Capacitor", price_cents: 12_500, cost_cents: 4_000 }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ id: EST }], [], [], [{ still_lead: true, status: "arrived", customer_id: CUST, exists: true }]));
    expect(await createFieldEstimate(actor, { estimateId: EST }, body)).toEqual({ ok: true, estimateId: EST, created: true });
    const s = stmts();
    expect(s).toHaveLength(5);
    expect(s[0]).toContain("FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(s[1]).toMatch(/^INSERT INTO estimates \(id, organization_id, service_request_id, customer_id, status, total_cents, expires_at, title, approval_token_hash\)/);
    expect(s[1]).toContain("'open'::estimate_status");
    expect(s[1]).toContain("now() + interval '30 days', 'Field estimate', NULL");
    expect(s[1]).toContain("r.status IN ('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status) AND r.customer_id = $");
    expect(s[1]).toContain("a.is_lead");
    expect(s[1]).toContain("ON CONFLICT (id) DO NOTHING RETURNING id");
    for (const i of [2, 3]) expect(s[i]).toContain("WHERE EXISTS (SELECT 1 FROM estimates WHERE id = $");
    for (const i of [2, 3]) expect(s[i]).toContain("xmin = pg_current_xact_id()::xid)");
    expect(s[2]).toContain("FROM (VALUES ($");
    // headline total = the only option's total: 25,000 + 2,063 tax
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[1]).params).toContain(27_063);
  });

  it("zero rows map through createOutcome", async () => {
    readQueue.push([{ customer_id: CUST }], [{ id: ITEM, name: "Capacitor", price_cents: 12_500, cost_cents: 4_000 }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [], [{ still_lead: true, status: "en_route", customer_id: CUST, exists: false }]));
    expect(await createFieldEstimate(actor, { estimateId: EST }, body)).toEqual({ ok: false, reason: "not_on_site" });
  });
});

describe("createOutcome", () => {
  const t = (over: Record<string, unknown>) => ({ still_lead: true, status: "arrived", customer_id: CUST, exists: false, ...over });
  it("an existing row with this id is a re-run, before every other answer", () =>
    expect(createOutcome(t({ exists: true, still_lead: false, status: "completed" }), CUST, EST)).toEqual({ ok: true, estimateId: EST, created: false }));
  it("then lead, status, customer", () => {
    expect(createOutcome(t({ still_lead: false }), CUST, EST)).toEqual({ ok: false, reason: "not_lead" });
    expect(createOutcome(t({ status: "scheduled" }), CUST, EST)).toEqual({ ok: false, reason: "not_on_site" });
    expect(createOutcome(t({ status: "completed" }), CUST, EST)).toEqual({ ok: false, reason: "job_closed" });
    expect(createOutcome(t({ customer_id: null }), CUST, EST)).toEqual({ ok: false, reason: "no_customer" });
    expect(createOutcome(t({}), CUST, EST)).toEqual({ ok: false, reason: "stale" });
    expect(createOutcome(undefined, CUST, EST)).toEqual({ ok: false, reason: "stale" });
  });
});

describe("sellFieldEstimate (spec §5.2)", () => {
  it("one guarded UPDATE under L_req and the estimate row lock", async () => {
    batch.mockResolvedValueOnce(rowsOf([], [], [{ id: EST }], [], []));
    expect(await sellFieldEstimate(actor, { estimateId: EST, optionId: OPT, signatureName: "  Pat Probe " }))
      .toEqual({ ok: true, estimateId: EST, created: true });
    const s = stmts();
    expect(s[1]).toBe("SELECT 1 FROM estimates WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(s[2]).toContain("SET status = 'sold'::estimate_status, sold_option_id = $1::uuid, signed_at = now(), signature_name = $2, signature_ip = NULL, sold_via = 'field', sold_by = $3::uuid, updated_at = now()");
    expect(s[2]).toContain("status = 'open'::estimate_status AND fieldpulse_estimate_id IS NULL AND (expires_at IS NULL OR expires_at > now())");
    expect(s[2]).toContain("EXISTS (SELECT 1 FROM estimate_options o WHERE o.id = $");
    expect(s[2]).toContain("r.status IN ('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status)");
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[2]).params).toContain("Pat Probe");
  });
});

describe("sellOutcome", () => {
  const ctx = { rid: REQ, me: ME, opt: OPT, eid: EST };
  const est = (over: Record<string, unknown>) => ({
    status: "open", service_request_id: REQ, sold_option_id: null, sold_via: null, sold_by: null,
    synced: false, past_expiry: false, option_ok: true, ...over,
  });
  const tail = { still_lead: true, request_status: "arrived" };
  it("missing or another request → estimate_not_found", () => {
    expect(sellOutcome(undefined, tail, ctx)).toEqual({ ok: false, reason: "estimate_not_found" });
    expect(sellOutcome(est({ service_request_id: CUST }), tail, ctx)).toEqual({ ok: false, reason: "estimate_not_found" });
  });
  it("our own field sale of this option is a replay, whatever name was typed", () =>
    expect(sellOutcome(est({ status: "sold", sold_option_id: OPT, sold_via: "field", sold_by: ME }), tail, ctx))
      .toEqual({ ok: true, estimateId: EST, created: false }));
  it("sellOutcome treats an uppercase optionId and technician id as the same sale", () => {
    // hex letters, so upper-casing really changes the strings; Postgres returns lower case
    const OPT_HEX = "abcdef01-2345-4abc-8def-abcdefabcdef";
    const ME_HEX = "fedcba98-7654-4fed-8cba-fedcbafedcba";
    const REQ_HEX = "abc12345-def6-4abc-8def-123456abcdef";
    for (const id of [OPT_HEX, ME_HEX, REQ_HEX]) expect(id.toUpperCase()).not.toBe(id);
    const row = est({ status: "sold", sold_option_id: OPT_HEX, sold_via: "field", sold_by: ME_HEX, service_request_id: REQ_HEX });
    // Without the toLowerCase() calls this is estimate_not_found / already_decided.
    expect(sellOutcome(row, tail, { eid: EST, opt: OPT_HEX.toUpperCase(), me: ME_HEX.toUpperCase(), rid: REQ_HEX.toUpperCase() }))
      .toEqual({ ok: true, estimateId: EST, created: false });
  });
  it("expired (stored or past expires_at) → estimate_expired", () => {
    expect(sellOutcome(est({ status: "expired" }), tail, ctx)).toEqual({ ok: false, reason: "estimate_expired" });
    expect(sellOutcome(est({ past_expiry: true }), tail, ctx)).toEqual({ ok: false, reason: "estimate_expired" });
  });
  it("any other decided state → already_decided (another option, portal, office, another technician, declined)", () => {
    for (const over of [
      { status: "sold", sold_option_id: CUST, sold_via: "field", sold_by: ME },
      { status: "sold", sold_option_id: OPT, sold_via: "portal", sold_by: null },
      { status: "sold", sold_option_id: OPT, sold_via: "field", sold_by: CUST },
      { status: "dismissed" },
    ]) expect(sellOutcome(est(over), tail, ctx)).toEqual({ ok: false, reason: "already_decided" });
  });
  it("then option, lead, request status", () => {
    expect(sellOutcome(est({ option_ok: false }), tail, ctx)).toEqual({ ok: false, reason: "invalid_option" });
    expect(sellOutcome(est({}), { still_lead: false, request_status: "arrived" }, ctx)).toEqual({ ok: false, reason: "not_lead" });
    expect(sellOutcome(est({}), { still_lead: true, request_status: "en_route" }, ctx)).toEqual({ ok: false, reason: "not_on_site" });
    expect(sellOutcome(est({}), { still_lead: true, request_status: "completed" }, ctx)).toEqual({ ok: false, reason: "job_closed" });
    expect(sellOutcome(est({}), tail, ctx)).toEqual({ ok: false, reason: "stale" });
  });
  it("a FieldPulse estimate → managed_externally", () =>
    expect(sellOutcome(est({ synced: true }), tail, ctx)).toEqual({ ok: false, reason: "managed_externally" }));
});

describe("declineFieldEstimate (spec §5.5)", () => {
  it("UPDATE to dismissed while open, native, of this request and lead", async () => {
    batch.mockResolvedValueOnce(rowsOf([], [{ id: EST }], [], []));
    expect(await declineFieldEstimate(actor, EST)).toEqual({ ok: true, estimateId: EST, created: true });
    const s = stmts();
    expect(s[1]).toContain("SET status = 'dismissed'::estimate_status, updated_at = now()");
    expect(s[1]).toContain("status = 'open'::estimate_status AND fieldpulse_estimate_id IS NULL AND (EXISTS (SELECT 1 FROM appointment_assignments");
  });
  it("declineOutcome: dismissed → replay; decided → already_decided; missing → 404; not lead", () => {
    const e = (over: Record<string, unknown>) => ({ status: "open", service_request_id: REQ, synced: false, ...over });
    const ctx = { rid: REQ, eid: EST };
    expect(declineOutcome(e({ status: "dismissed" }), { still_lead: true }, ctx)).toEqual({ ok: true, estimateId: EST, created: false });
    expect(declineOutcome(e({ status: "sold" }), { still_lead: true }, ctx)).toEqual({ ok: false, reason: "already_decided" });
    expect(declineOutcome(undefined, { still_lead: true }, ctx)).toEqual({ ok: false, reason: "estimate_not_found" });
    expect(declineOutcome(e({}), { still_lead: false }, ctx)).toEqual({ ok: false, reason: "not_lead" });
    expect(declineOutcome(e({}), { still_lead: true }, ctx)).toEqual({ ok: false, reason: "stale" });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/lib/tech/estimate-input.test.ts src/lib/tech/estimate-writes.test.ts src/lib/tech/estimate-errors.test.ts src/lib/http/idempotency.test.ts`
Expected: FAIL — modules missing; STORED_CODES list differs.

- [ ] **Step 4: Implement.**

`src/lib/tech/estimate-input.ts`:

```ts
/**
 * Field estimate input rules (M3c spec §5.1–§5.2), shared by the routes, the
 * writers and the builder. Pure, no imports: safe in a client bundle.
 */
export const MAX_OPTIONS = 3;
export const MAX_LINES_PER_OPTION = 40;
export const MAX_QUANTITY = 999;
export const MAX_OPTION_NAME = 40;
export const MIN_SIGNATURE = 2;
export const MAX_SIGNATURE = 200;
/** signature_name the office "Mark sold" path writes; never a customer's typed name. */
export const OFFICE_SIGNATURE = "(admin)";
export const INT32_MAX = 2_147_483_647;

export interface CreateLineInput { readonly pricebookItemId: string; readonly quantity: number }
export interface CreateOptionInput { readonly name: string; readonly lines: readonly CreateLineInput[] }
export interface CreateEstimateInput { readonly options: readonly CreateOptionInput[] }

export interface PricedItem { readonly id: string; readonly name: string; readonly priceCents: number; readonly costCents: number }
export interface BuiltOption {
  readonly id: string; readonly name: string; readonly sortOrder: number;
  readonly subtotalCents: number; readonly taxCents: number; readonly totalCents: number;
}
export interface BuiltLine {
  readonly id: string; readonly optionId: string; readonly pricebookItemId: string; readonly name: string;
  readonly quantity: number; readonly unitPriceCents: number; readonly costCents: number; readonly lineTotalCents: number;
}

export function hasDuplicateNames(names: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const n of names) {
    const k = n.trim().toLowerCase();
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/** The portal's rule: at least 2 characters once trimmed, at most 200, never the office marker. */
export function signatureNameOk(raw: string): boolean {
  const name = raw.trim();
  return name.length >= MIN_SIGNATURE && name.length <= MAX_SIGNATURE && name !== OFFICE_SIGNATURE;
}

/**
 * Snapshot each line from the org's ACTIVE pricebook items (`items`, keyed by
 * lower-case id) and total each option: subtotal = Σ quantity × regular price,
 * tax = round(subtotal × bps / 10000). Ids come from `mintId` in build order
 * (option, then its lines), so v7 ids read back ORDER BY id in build order.
 */
export function buildFieldEstimate(
  input: CreateEstimateInput,
  items: ReadonlyMap<string, PricedItem>,
  taxBps: number,
  mintId: () => string,
): { ok: true; options: BuiltOption[]; lines: BuiltLine[]; totalCents: number } | { ok: false; reason: "item_inactive" | "too_large" } {
  const options: BuiltOption[] = [];
  const lines: BuiltLine[] = [];
  for (const [sortOrder, opt] of input.options.entries()) {
    const optionId = mintId();
    let subtotal = 0;
    for (const l of opt.lines) {
      const item = items.get(l.pricebookItemId.toLowerCase());
      if (!item) return { ok: false, reason: "item_inactive" };
      const lineTotal = l.quantity * item.priceCents;
      subtotal += lineTotal;
      if (subtotal > INT32_MAX) return { ok: false, reason: "too_large" };
      lines.push({
        id: mintId(), optionId, pricebookItemId: item.id, name: item.name, quantity: l.quantity,
        unitPriceCents: item.priceCents, costCents: item.costCents, lineTotalCents: lineTotal,
      });
    }
    const tax = Math.round((subtotal * taxBps) / 10000);
    if (subtotal + tax > INT32_MAX) return { ok: false, reason: "too_large" };
    options.push({ id: optionId, name: opt.name.trim(), sortOrder, subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax });
  }
  return { ok: true, options, lines, totalCents: Math.max(...options.map((o) => o.totalCents)) };
}
```

`src/lib/tech/estimate-writes.ts`:

```ts
/**
 * Field estimate writers (M3c spec §5.1, §5.2, §5.5). Each write is ONE
 * db.batch: L_req first, then the guarded statement, then tail SELECTs that
 * the pure *Outcome mappers read when the guarded statement matched 0 rows.
 */
import { v7 as uuidv7 } from "uuid";
import { sql } from "drizzle-orm";
import { getDefaultTaxBps } from "@/lib/admin/pricebook-queries";
import { lockRequestSql, readRows, runBatch, stillLeadSql } from "@/lib/admin/invoice-field-writes";
import { statusInSql } from "@/lib/admin/estimate-billing-sql";
import { SELL_STATUSES, statusGate } from "@/lib/tech/field-sale-statuses";
import { buildFieldEstimate, type CreateEstimateInput, type PricedItem } from "@/lib/tech/estimate-input";

export interface EstimateActor { organizationId: string; requestId: string; techUserId: string }
export type EstimateWriteReason =
  | "estimate_not_found" | "no_customer" | "not_lead" | "not_on_site" | "job_closed" | "stale"
  | "already_decided" | "estimate_expired" | "invalid_option" | "item_inactive" | "too_large" | "managed_externally";
export type EstimateWriteResult =
  | { ok: true; estimateId: string; created: boolean }
  | { ok: false; reason: EstimateWriteReason };

type Row = Record<string, unknown>;
const fail = (reason: EstimateWriteReason): EstimateWriteResult => ({ ok: false, reason });
const SELL_IN = statusInSql(SELL_STATUSES);
const lower = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).toLowerCase());

/** The request's status as a refusal, or null when it allows selling. */
function statusReason(status: unknown): EstimateWriteReason | null {
  if (typeof status !== "string") return "stale";
  const gate = statusGate(status, SELL_STATUSES);
  return gate === "ok" ? null : gate;
}

// ---------------------------------------------------------------- create

export function createOutcome(tail: Row | undefined, cust: string, eid: string): EstimateWriteResult {
  if (!tail) return fail("stale");
  if (tail.exists === true) return { ok: true, estimateId: eid, created: false };
  if (tail.still_lead !== true) return fail("not_lead");
  const s = statusReason(tail.status);
  if (s) return fail(s);
  if (lower(tail.customer_id) !== cust.toLowerCase()) return fail("no_customer");
  return fail("stale");
}

export async function createFieldEstimate(
  actor: EstimateActor, ids: { estimateId: string }, input: CreateEstimateInput,
): Promise<EstimateWriteResult> {
  const { organizationId: org, requestId: rid, techUserId: me } = actor;
  const eid = ids.estimateId;
  const [req] = await readRows(sql`SELECT customer_id FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid`);
  if (!req) return fail("stale"); // unreachable behind the preamble; never the estimate 404 copy (plan ruling 16)
  const cust = (req.customer_id as string | null) ?? null;
  if (cust === null) return fail("no_customer");

  const itemIds = [...new Set(input.options.flatMap((o) => o.lines.map((l) => l.pricebookItemId.toLowerCase())))];
  const itemRows = await readRows(sql`SELECT id, name, price_cents, cost_cents FROM pricebook_items
    WHERE organization_id = ${org}::uuid AND active AND id IN (${sql.join(itemIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
  const items = new Map<string, PricedItem>(itemRows.map((r) => [String(r.id), {
    id: String(r.id), name: String(r.name), priceCents: Number(r.price_cents), costCents: Number(r.cost_cents),
  }]));
  const built = buildFieldEstimate(input, items, await getDefaultTaxBps(org), uuidv7);
  if (!built.ok) return fail(built.reason);

  const lead = stillLeadSql(org, rid, me);
  const mine = sql`EXISTS (SELECT 1 FROM estimates WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid AND xmin = pg_current_xact_id()::xid)`;
  const optionValues = sql.join(built.options.map((o) =>
    sql`(${o.id}::uuid, ${o.name}::text, ${o.sortOrder}::int, ${o.subtotalCents}::int, ${o.taxCents}::int, ${o.totalCents}::int)`), sql`, `);
  const lineValues = sql.join(built.lines.map((l) =>
    sql`(${l.id}::uuid, ${l.optionId}::uuid, ${l.pricebookItemId}::uuid, ${l.name}::text, ${l.quantity}::int, ${l.unitPriceCents}::int, ${l.costCents}::int, ${l.lineTotalCents}::int)`), sql`, `);

  const rows = await runBatch([
    lockRequestSql(org, rid),
    sql`INSERT INTO estimates (id, organization_id, service_request_id, customer_id, status, total_cents, expires_at, title, approval_token_hash)
      SELECT ${eid}::uuid, ${org}::uuid, ${rid}::uuid, ${cust}::uuid, 'open'::estimate_status, ${built.totalCents}::int,
        now() + interval '30 days', 'Field estimate', NULL
      WHERE (${lead}) AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
        AND r.status IN ${SELL_IN} AND r.customer_id = ${cust}::uuid)
      ON CONFLICT (id) DO NOTHING RETURNING id`,
    sql`INSERT INTO estimate_options (id, organization_id, estimate_id, name, sort_order, subtotal_cents, tax_cents, total_cents)
      SELECT v.id, ${org}::uuid, ${eid}::uuid, v.name, v.sort_order, v.subtotal_cents, v.tax_cents, v.total_cents
      FROM (VALUES ${optionValues}) AS v(id, name, sort_order, subtotal_cents, tax_cents, total_cents) WHERE ${mine}`,
    sql`INSERT INTO estimate_line_items (id, organization_id, option_id, pricebook_item_id, name, quantity, unit_price_cents, cost_cents, line_total_cents)
      SELECT v.id, ${org}::uuid, v.option_id, v.pricebook_item_id, v.name, v.quantity, v.unit_price_cents, v.cost_cents, v.line_total_cents
      FROM (VALUES ${lineValues}) AS v(id, option_id, pricebook_item_id, name, quantity, unit_price_cents, cost_cents, line_total_cents) WHERE ${mine}`,
    sql`SELECT (${lead}) AS still_lead, r.status::text AS status, r.customer_id,
        EXISTS (SELECT 1 FROM estimates e WHERE e.id = ${eid}::uuid AND e.organization_id = ${org}::uuid AND e.service_request_id = ${rid}::uuid) AS exists
      FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`,
  ]);
  if (!Array.isArray(rows)) return fail("stale");
  if (rows[1]!.length > 0) return { ok: true, estimateId: eid, created: true };
  return createOutcome(rows[4]![0], cust, eid);
}

// ---------------------------------------------------------------- sell

export function sellOutcome(
  est: Row | undefined, tail: Row | undefined, ctx: { rid: string; me: string; opt: string; eid: string },
): EstimateWriteResult {
  if (!est || lower(est.service_request_id) !== ctx.rid.toLowerCase()) return fail("estimate_not_found");
  if (est.synced === true) return fail("managed_externally");
  if (est.status === "sold" && lower(est.sold_option_id) === ctx.opt.toLowerCase()
    && est.sold_via === "field" && lower(est.sold_by) === ctx.me.toLowerCase()) {
    return { ok: true, estimateId: ctx.eid, created: false };
  }
  if (est.status === "expired" || (est.status === "open" && est.past_expiry === true)) return fail("estimate_expired");
  if (est.status !== "open") return fail("already_decided");
  if (est.option_ok !== true) return fail("invalid_option");
  if (tail?.still_lead !== true) return fail("not_lead");
  return fail(statusReason(tail.request_status) ?? "stale");
}

export async function sellFieldEstimate(
  actor: EstimateActor, input: { estimateId: string; optionId: string; signatureName: string },
): Promise<EstimateWriteResult> {
  const { organizationId: org, requestId: rid, techUserId: me } = actor;
  const { estimateId: eid, optionId: opt } = input;
  const lead = stillLeadSql(org, rid, me);
  const optionOk = sql`EXISTS (SELECT 1 FROM estimate_options o WHERE o.id = ${opt}::uuid AND o.estimate_id = ${eid}::uuid AND o.organization_id = ${org}::uuid)`;
  const rows = await runBatch([
    lockRequestSql(org, rid),
    sql`SELECT 1 FROM estimates WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid FOR NO KEY UPDATE`,
    sql`UPDATE estimates SET status = 'sold'::estimate_status, sold_option_id = ${opt}::uuid, signed_at = now(), signature_name = ${input.signatureName.trim()}, signature_ip = NULL, sold_via = 'field', sold_by = ${me}::uuid, updated_at = now()
      WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
        AND status = 'open'::estimate_status AND fieldpulse_estimate_id IS NULL AND (expires_at IS NULL OR expires_at > now())
        AND ${optionOk} AND (${lead})
        AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid AND r.status IN ${SELL_IN})
      RETURNING id`,
    sql`SELECT status::text AS status, service_request_id, sold_option_id, sold_via, sold_by,
        fieldpulse_estimate_id IS NOT NULL AS synced, (expires_at IS NOT NULL AND expires_at <= now()) AS past_expiry, ${optionOk} AS option_ok
      FROM estimates WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid`,
    sql`SELECT (${lead}) AS still_lead,
        (SELECT status::text FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid) AS request_status`,
  ]);
  if (!Array.isArray(rows)) return fail("stale");
  if (rows[2]!.length > 0) return { ok: true, estimateId: eid, created: true };
  return sellOutcome(rows[3]![0], rows[4]![0], { rid, me, opt, eid });
}

// ---------------------------------------------------------------- decline

export function declineOutcome(est: Row | undefined, tail: Row | undefined, ctx: { rid: string; eid: string }): EstimateWriteResult {
  if (!est || lower(est.service_request_id) !== ctx.rid.toLowerCase()) return fail("estimate_not_found");
  if (est.synced === true) return fail("managed_externally");
  if (est.status === "dismissed") return { ok: true, estimateId: ctx.eid, created: false };
  if (est.status !== "open") return fail("already_decided");
  if (tail?.still_lead !== true) return fail("not_lead");
  return fail("stale");
}

export async function declineFieldEstimate(actor: EstimateActor, estimateId: string): Promise<EstimateWriteResult> {
  const { organizationId: org, requestId: rid, techUserId: me } = actor;
  const eid = estimateId;
  const lead = stillLeadSql(org, rid, me);
  const rows = await runBatch([
    lockRequestSql(org, rid),
    sql`UPDATE estimates SET status = 'dismissed'::estimate_status, updated_at = now()
      WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
        AND status = 'open'::estimate_status AND fieldpulse_estimate_id IS NULL AND (${lead})
      RETURNING id`,
    sql`SELECT status::text AS status, service_request_id, fieldpulse_estimate_id IS NOT NULL AS synced
      FROM estimates WHERE id = ${eid}::uuid AND organization_id = ${org}::uuid`,
    sql`SELECT (${lead}) AS still_lead`,
  ]);
  if (!Array.isArray(rows)) return fail("stale");
  if (rows[1]!.length > 0) return { ok: true, estimateId: eid, created: true };
  return declineOutcome(rows[2]![0], rows[3]![0], { rid, eid });
}
```

`src/lib/tech/estimate-errors.ts`:

```ts
/**
 * Reason → HTTP status / code / copy for the estimate routes (M3c spec §4–§5),
 * technician copy ("job"). Bill reasons (Task 2's BillReason) are spelled out
 * here so this module has no runtime dependency on the writers.
 */
import type { RunResult } from "@/lib/http/idempotency";

export type EstimateRouteReason =
  | "estimate_not_found" | "no_customer" | "not_lead" | "not_on_site" | "job_closed" | "stale"
  | "already_decided" | "estimate_expired" | "invalid_option" | "item_inactive" | "too_large"
  | "managed_externally" | "estimate_not_sold" | "no_lines" | "already_billed" | "invoice_locked" | "invoice_changed";

type Shape = { status: number; code: string; message: string };

const TOO_LARGE: Shape = { status: 400, code: "INVALID_INPUT", message: "That total is too large." };

const MAP: Record<EstimateRouteReason, Shape> = {
  estimate_not_found: { status: 404, code: "NOT_FOUND", message: "That estimate isn't on this job." },
  no_customer: { status: 409, code: "NO_CUSTOMER", message: "Ask the office to add the customer before quoting." },
  not_lead: { status: 403, code: "NOT_LEAD", message: "Only the lead technician can do that." },
  not_on_site: { status: 409, code: "NOT_ON_SITE", message: "Arrive at the job first." },
  job_closed: { status: 409, code: "JOB_CLOSED", message: "This job is closed." },
  stale: { status: 409, code: "STALE", message: "This job changed. Try again." },
  already_decided: { status: 409, code: "ALREADY_DECIDED", message: "This estimate was already decided." },
  estimate_expired: { status: 409, code: "ESTIMATE_EXPIRED", message: "This estimate expired. Build a new one." },
  invalid_option: { status: 400, code: "INVALID_OPTION", message: "That option isn't on this estimate." },
  item_inactive: { status: 400, code: "INVALID_INPUT", message: "One of these items is no longer in the pricebook." },
  too_large: TOO_LARGE,
  managed_externally: { status: 409, code: "MANAGED_EXTERNALLY", message: "This job is managed in FieldPulse." },
  estimate_not_sold: { status: 409, code: "ESTIMATE_NOT_SOLD", message: "Approve the estimate first." },
  no_lines: { status: 409, code: "NO_LINES", message: "This estimate has no items." },
  already_billed: { status: 409, code: "ALREADY_BILLED", message: "This estimate is already on an invoice." },
  invoice_locked: { status: 409, code: "INVOICE_LOCKED", message: "The job's invoice is already finalized. Ask the office to bill this estimate." },
  // Stored (plan ruling 11): this key's derived invoice was paid or voided; a new key derives a new invoice.
  invoice_changed: { status: 409, code: "INVOICE_CHANGED", message: "The job's invoice changed. Try again." },
};

export function estimateError(reason: EstimateRouteReason): Shape {
  return { ...MAP[reason] };
}

export function estimateReasonResult(reason: EstimateRouteReason, details?: Record<string, unknown>): RunResult {
  const { status, code, message } = MAP[reason];
  return { status, envelope: { success: false, error: details ? { message, code, details } : { message, code } } };
}
```

`src/lib/http/idempotency-codes.ts`: add `"ALREADY_DECIDED"`, `"ESTIMATE_EXPIRED"`, `"INVALID_OPTION"`, `"EQUIPMENT_RETIRED"`, `"INVOICE_CHANGED"` to `STORED_CODES` and extend its doc comment: "M3c adds the estimate and equipment terminal codes (spec §4) and INVOICE_CHANGED (plan ruling 11: the bill's derived invoice was paid or voided, so the next try needs a new key)."

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/lib/tech/estimate-input.test.ts src/lib/tech/estimate-writes.test.ts src/lib/tech/estimate-errors.test.ts src/lib/http/idempotency.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/estimate-input.ts src/lib/tech/estimate-input.test.ts src/lib/tech/estimate-writes.ts src/lib/tech/estimate-writes.test.ts src/lib/tech/estimate-errors.ts src/lib/tech/estimate-errors.test.ts src/lib/http/idempotency-codes.ts src/lib/http/idempotency.test.ts && npx vitest run
git add src/lib/tech/estimate-input.ts src/lib/tech/estimate-input.test.ts src/lib/tech/estimate-writes.ts src/lib/tech/estimate-writes.test.ts src/lib/tech/estimate-errors.ts src/lib/tech/estimate-errors.test.ts src/lib/http/idempotency-codes.ts src/lib/http/idempotency.test.ts
git commit -m "$(cat <<'EOF'
feat(m3c): field estimate writers (create, sell, decline) and their stored codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 4: Equipment — input rules, add/replace writer, tech GET, office retired handling

**Files:**
- Create: `src/lib/tech/equipment-input.ts` (+ `equipment-input.test.ts`), `src/lib/tech/equipment-writes.ts` (+ `equipment-writes.test.ts`), `src/lib/tech/equipment-errors.ts` (+ `equipment-errors.test.ts`), `src/lib/tech/equipment-queries.ts` (+ `equipment-queries.test.ts`), `src/lib/admin/crm-equipment-records.ts` (+ `crm-equipment-records.test.ts`)
- Modify: `src/lib/admin/crm-equipment-queries.ts` (`recordCustomerEquipment` ~53–115) + `crm-equipment-queries.test.ts`, `src/lib/admin/crm-queries.ts` (list `aggCols` ~174, detail equipment read ~391–404 and mapping ~508–537), `src/lib/admin/crm-types.ts` (`EquipmentRecord`)

**Interfaces:**
- Consumes (Task 1): `statusInSql`, `BILL_STATUSES`; existing `lockRequestSql`, `readRows`, `runBatch` (`@/lib/admin/invoice-field-writes`), `findReadableJob` (`@/lib/tech/ownership`), `BUSINESS_BASE_LOCATION`.
- Produces:
  - `equipment-input.ts` (pure, client-safe): `EQUIPMENT_TYPE_VALUES`, `EquipmentTypeValue`, `EQUIPMENT_TEXT_MAX = 120`, `EquipmentRaw`, `EquipmentInput { equipmentType; make; model; serialNumber; locationInHome; notes; installDate: string | null (YYYY-MM-DD); replacesId: string | null (lower case) }`, `EquipmentFieldError`, `EQUIPMENT_ERROR_COPY`, `parseEquipmentInput(raw: EquipmentRaw, today: string)`, `todayInZone(now: Date, timeZone?): string`, `noonInZone(ymd: string, timeZone?): Date`, types `TechEquipmentUnit { id; equipmentType; make; model; serialNumber; locationInHome; notes; installDate: string | null; managedExternally: boolean }`, `TechEquipmentView { units: TechEquipmentUnit[]; canWrite: boolean }`.
  - `equipment-writes.ts`: `EquipmentReason = "no_customer" | "not_found" | "equipment_retired" | "managed_externally" | "stale"`, `EquipmentWriteResult = { ok: true; equipmentId: string; created: boolean; replaced: boolean } | { ok: false; reason: EquipmentReason }`, `locationRuleSql(unit: string, req: string): SQL`, `onJobSql(org, rid, me): SQL`, `addFieldEquipment(actor: { organizationId; requestId; techUserId }, ids: { equipmentId: string }, input: EquipmentInput): Promise<EquipmentWriteResult>`, pure `replaceOutcome(old: Row | undefined, newId: string): EquipmentWriteResult`.
  - `equipment-errors.ts`: `equipmentError(reason)`, `equipmentReasonResult(reason): RunResult`.
  - `equipment-queries.ts`: `unitsSql(org, rid)`, `canWriteSql(org, rid, me)`, `toUnit(row): TechEquipmentUnit`, `canWriteFrom(row): boolean`, `getTechEquipmentView(org, me, rid): Promise<{ kind: "not_found" } | { kind: "external" } | { kind: "ok"; view: TechEquipmentView }>`.
  - `crm-equipment-records.ts`: `equipmentRecords(rows)`, `liveEquipmentCount(rows)`, `replacedOnLabel(iso): string` ("Replaced Nov 6, 2026", business timezone; the office page imports it from here, never from a tech module); `EquipmentRecord` gains `retiredAt: string | null`, `replacedByEquipmentId: string | null` (null when the replacement row no longer exists).

- [ ] **Step 1: Failing input tests** — `src/lib/tech/equipment-input.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EQUIPMENT_TYPE_VALUES, noonInZone, parseEquipmentInput, todayInZone } from "./equipment-input";
import { EQUIPMENT_TYPE_OPTIONS } from "@/lib/admin/display-labels";

const TODAY = "2026-11-06";
const ok = (raw: Record<string, unknown>) => parseEquipmentInput(raw, TODAY);

describe("parseEquipmentInput (spec §5.6)", () => {
  it("type values match the shared labels", () => {
    expect([...EQUIPMENT_TYPE_VALUES]).toEqual(EQUIPMENT_TYPE_OPTIONS.map((o) => o.value));
  });
  it("trims, blanks become null, ids lower-cased", () => {
    expect(ok({ equipmentType: "ac", make: "  Carrier ", model: " ", replacesId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" })).toEqual({
      ok: true,
      value: { equipmentType: "ac", make: "Carrier", model: null, serialNumber: null, locationInHome: null, notes: null, installDate: null, replacesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
  });
  it("refuses an unknown type, a missing Other description, long text, bad dates and a bad replaces id", () => {
    expect(ok({ equipmentType: "jacuzzi" })).toEqual({ ok: false, error: "type" });
    expect(ok({ equipmentType: "other", notes: "  " })).toEqual({ ok: false, error: "describe" });
    expect(ok({ equipmentType: "other", notes: "Humidifier" }).ok).toBe(true);
    expect(ok({ equipmentType: "ac", serialNumber: "x".repeat(121) })).toEqual({ ok: false, error: "too_long" });
    expect(ok({ equipmentType: "ac", serialNumber: "x".repeat(120) }).ok).toBe(true);
    expect(ok({ equipmentType: "ac", installDate: "2026-02-30" })).toEqual({ ok: false, error: "date_invalid" });
    expect(ok({ equipmentType: "ac", installDate: "11/06/2026" })).toEqual({ ok: false, error: "date_invalid" });
    expect(ok({ equipmentType: "ac", installDate: "2026-11-07" })).toEqual({ ok: false, error: "date_future" });
    expect(ok({ equipmentType: "ac", replacesId: "nope" })).toEqual({ ok: false, error: "replaces" });
  });
  it("parseEquipmentInput accepts today in the business timezone at 23:30 Eastern", () => {
    const today = todayInZone(new Date("2026-11-07T04:30:00Z")); // 23:30 EST on Nov 6
    expect(today).toBe("2026-11-06");
    expect(parseEquipmentInput({ equipmentType: "furnace", installDate: "2026-11-06" }, today).ok).toBe(true);
    expect(parseEquipmentInput({ equipmentType: "furnace", installDate: "2026-11-07" }, today)).toEqual({ ok: false, error: "date_future" });
  });
});

describe("noonInZone", () => {
  it("noonInZone is noon Eastern on both sides of the DST change", () => {
    expect(noonInZone("2026-11-06").toISOString()).toBe("2026-11-06T17:00:00.000Z");
    expect(noonInZone("2026-07-04").toISOString()).toBe("2026-07-04T16:00:00.000Z");
    expect(noonInZone("2026-11-01").toISOString()).toBe("2026-11-01T17:00:00.000Z"); // DST ends that morning
    expect(noonInZone("2026-03-08").toISOString()).toBe("2026-03-08T16:00:00.000Z"); // DST starts that morning
  });
});
```

- [ ] **Step 2: Failing writer, errors, queries and office tests.**

`src/lib/tech/equipment-writes.test.ts` (same `db` mock harness as Task 3's `estimate-writes.test.ts`, minus the pricebook mock):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, batch } = vi.hoisted(() => ({ readQueue: [] as unknown[][], batch: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => ({
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err),
    }),
    batch,
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));

import { addFieldEquipment, locationRuleSql, onJobSql, replaceOutcome } from "./equipment-writes";
import type { EquipmentInput } from "./equipment-input";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const NEW = "44444444-4444-4444-8444-444444444444";
const OLD = "55555555-5555-4555-8555-555555555555";
const CUST = "66666666-6666-4666-8666-666666666666";
const actor = { organizationId: ORG, requestId: REQ, techUserId: ME };
const input = (over: Partial<EquipmentInput> = {}): EquipmentInput => ({
  equipmentType: "ac", make: "Carrier", model: null, serialNumber: null, locationInHome: null, notes: null,
  installDate: "2026-11-06", replacesId: null, ...over,
});

const dialect = new PgDialect();
const renderQ = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL);
const render = (q: unknown) => renderQ(q).sql.replace(/\s+/g, " ").trim();
const stmts = () => (batch.mock.calls[0]![0] as unknown[]).map(render);
const rowsOf = (...r: unknown[][]) => r.map((rows) => ({ rows }));

beforeEach(() => { readQueue.length = 0; batch.mockReset(); });

describe("SQL pieces", () => {
  it("location rule: request without a location → any unit; else same location or none (parenthesised OR)", () => {
    expect(render(locationRuleSql("ce", "r"))).toBe("(r.location_id IS NULL OR ce.location_id IS NULL OR ce.location_id = r.location_id)");
  });
  it("on the job: a non-cancelled assignment on a non-cancelled visit, org-bound twice", () => {
    const q = renderQ(onJobSql(ORG, REQ, ME));
    expect(q.sql).toContain("p.cancelled_at IS NULL");
    expect(q.sql).toContain("a.status <> 'cancelled'::request_status");
    expect(q.params.filter((p) => p === ORG)).toHaveLength(2);
  });
});

describe("addFieldEquipment (spec §5.6)", () => {
  it("no customer on the request → no_customer, nothing written", async () => {
    readQueue.push([{ customer_id: null }]);
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input())).toEqual({ ok: false, reason: "no_customer" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("add: INSERT … FROM service_requests with the request's location, noon Eastern install date, ON CONFLICT DO NOTHING", async () => {
    readQueue.push([{ customer_id: CUST }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ id: NEW }], []));
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input())).toEqual({ ok: true, equipmentId: NEW, created: true, replaced: false });
    const s = stmts();
    expect(s[1]).toMatch(/^INSERT INTO customer_equipment \(id, organization_id, customer_id, location_id, equipment_type, make, model, serial_number, location_in_home, notes, install_date\)/);
    expect(s[1]).toContain("r.location_id, $4::equipment_type");
    expect(s[1]).toContain("r.customer_id = $");
    expect(s[1]).toContain("r.status IN ('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status, 'completed'::request_status)");
    expect(s[1]).toContain("ON CONFLICT (id) DO NOTHING RETURNING id");
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[1]).params).toContain("2026-11-06T17:00:00.000Z");
  });

  it("add replay: the row exists → created:false", async () => {
    readQueue.push([{ customer_id: CUST }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [{ exists: true }]));
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input())).toEqual({ ok: true, equipmentId: NEW, created: false, replaced: false });
  });

  it("replace: lock the old row, insert only while it is live, retire it only when this transaction wrote the new row", async () => {
    readQueue.push([{ customer_id: CUST }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ "?column?": 1 }], [{ id: NEW }], [{ id: OLD }], []));
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input({ replacesId: OLD })))
      .toEqual({ ok: true, equipmentId: NEW, created: true, replaced: true });
    const s = stmts();
    expect(s).toHaveLength(5);
    expect(s[1]).toContain("FOR NO KEY UPDATE OF ce");
    expect(s[1]).toContain("ce.fieldpulse_asset_id IS NULL AND r.customer_id = $");
    expect(s[1]).toContain("a.status <> 'cancelled'::request_status");
    expect(s[1]).toContain("(r.location_id IS NULL OR ce.location_id IS NULL OR ce.location_id = r.location_id)");
    expect(s[2]).toContain("AND EXISTS (SELECT 1 FROM customer_equipment ce WHERE ce.id = $");
    expect(s[2]).toContain("ce.retired_at IS NULL AND ce.fieldpulse_asset_id IS NULL");
    expect(s[3]).toContain("SET retired_at = now(), replaced_by_equipment_id = $1::uuid, updated_at = now()");
    expect(s[3]).toContain("n.xmin = pg_current_xact_id()::xid");
    for (const st of s.slice(1, 5)) expect(st).toContain("ce.customer_id = $");
  });

  it("replace zero rows map through replaceOutcome", async () => {
    readQueue.push([{ customer_id: CUST }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [], [{ retired: true, replaced_by_equipment_id: "77777777-7777-4777-8777-777777777777", synced: false }]));
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input({ replacesId: OLD }))).toEqual({ ok: false, reason: "equipment_retired" });
  });
});

describe("replaceOutcome", () => {
  it("replay first, then retired, then FieldPulse; an invisible unit is not found; a visible live one that was not written is stale", () => {
    expect(replaceOutcome({ retired: true, replaced_by_equipment_id: NEW, synced: false }, NEW)).toEqual({ ok: true, equipmentId: NEW, created: false, replaced: true });
    expect(replaceOutcome({ retired: true, replaced_by_equipment_id: OLD, synced: false }, NEW)).toEqual({ ok: false, reason: "equipment_retired" });
    expect(replaceOutcome({ retired: false, replaced_by_equipment_id: null, synced: true }, NEW)).toEqual({ ok: false, reason: "managed_externally" });
    expect(replaceOutcome({ retired: false, replaced_by_equipment_id: null, synced: false }, NEW)).toEqual({ ok: false, reason: "stale" });
    expect(replaceOutcome(undefined, NEW)).toEqual({ ok: false, reason: "not_found" });
  });
});
```

`src/lib/tech/equipment-errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { equipmentError, equipmentReasonResult } from "./equipment-errors";
import { isStorable } from "@/lib/http/idempotency";

describe("equipment reasons", () => {
  it.each([
    ["no_customer", 409, "NO_CUSTOMER", "Ask the office to add the customer first."],
    ["not_found", 404, "NOT_FOUND", "That unit isn't at this address."],
    ["equipment_retired", 409, "EQUIPMENT_RETIRED", "That unit was already replaced."],
    ["managed_externally", 409, "MANAGED_EXTERNALLY", "That unit is managed in FieldPulse."],
    ["stale", 409, "STALE", "This job changed. Try again."],
  ] as const)("%s", (reason, status, code, message) => expect(equipmentError(reason)).toEqual({ status, code, message }));
  it("only EQUIPMENT_RETIRED is stored", () => {
    const r = equipmentReasonResult("equipment_retired");
    expect(isStorable(r.status, r.envelope)).toBe(true);
    const n = equipmentReasonResult("not_found");
    expect(isStorable(n.status, n.envelope)).toBe(false);
  });
});
```

  (`isStorable` reads `STORED_CODES`; `EQUIPMENT_RETIRED` was added there in Task 3, which is committed before this task starts.)

`src/lib/tech/equipment-queries.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
import { canWriteFrom, canWriteSql, toUnit, unitsSql } from "./equipment-queries";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const render = (s: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(s).sql.replace(/\s+/g, " ");

describe("tech equipment GET (spec §6)", () => {
  it("lists live units of the request's customer by the location rule, never retired ones", () => {
    const t = render(unitsSql(ORG, REQ));
    expect(t).toContain("ce.customer_id = r.customer_id AND ce.retired_at IS NULL");
    expect(t).toContain("(r.location_id IS NULL OR ce.location_id IS NULL OR ce.location_id = r.location_id)");
    expect(t).toContain("ce.fieldpulse_asset_id IS NOT NULL AS managed_externally");
    expect(t).not.toContain("cost");
  });
  it("canWrite needs the caller on the job, an on-site or completed status and a customer", () => {
    expect(render(canWriteSql(ORG, REQ, ME))).toContain("a.status <> 'cancelled'::request_status");
    expect(canWriteFrom({ on_job: true, status: "completed", has_customer: true })).toBe(true);
    expect(canWriteFrom({ on_job: true, status: "en_route", has_customer: true })).toBe(false);
    expect(canWriteFrom({ on_job: true, status: "cancelled", has_customer: true })).toBe(false);
    expect(canWriteFrom({ on_job: false, status: "arrived", has_customer: true })).toBe(false);
    expect(canWriteFrom({ on_job: true, status: "arrived", has_customer: false })).toBe(false);
    expect(canWriteFrom(undefined)).toBe(false);
  });
  it("maps a row", () => {
    expect(toUnit({ id: "u1", equipment_type: "ac", make: "Carrier", model: null, serial_number: "S1", location_in_home: null, notes: null,
      install_date: new Date("2026-11-06T17:00:00Z"), managed_externally: false })).toEqual({
      id: "u1", equipmentType: "ac", make: "Carrier", model: null, serialNumber: "S1", locationInHome: null, notes: null,
      installDate: "2026-11-06T17:00:00.000Z", managedExternally: false,
    });
  });
});
```

`src/lib/admin/crm-equipment-records.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { equipmentRecords, liveEquipmentCount, replacedOnLabel, type EquipmentRowLike } from "./crm-equipment-records";

const row = (id: string, over: Partial<EquipmentRowLike> = {}): EquipmentRowLike => ({
  id, equipmentType: "ac", make: null, model: null, serialNumber: null, installDate: null, warrantyExpiration: null,
  warrantyType: null, warrantyProvider: null, locationInHome: null, notes: null, fieldpulseAssetId: null,
  retiredAt: null, replacedByEquipmentId: null, ...over,
});

describe("office equipment list (spec §2)", () => {
  it("retired units sort last; the replacement link is null-safe; the count is live units only", () => {
    const rows = [
      row("old", { retiredAt: new Date("2026-11-06T17:00:00Z"), replacedByEquipmentId: "new" }),
      row("new"),
      row("gone-link", { retiredAt: new Date("2026-10-01T17:00:00Z"), replacedByEquipmentId: "deleted" }),
      row("live2"),
    ];
    const out = equipmentRecords(rows);
    expect(out.map((r) => r.id)).toEqual(["new", "live2", "old", "gone-link"]);
    expect(out[2]).toMatchObject({ retiredAt: "2026-11-06T17:00:00.000Z", replacedByEquipmentId: "new" });
    expect(out[3]!.replacedByEquipmentId).toBeNull();
    expect(liveEquipmentCount(rows)).toBe(2);
  });
  it("office retired label in the business timezone", () => {
    expect(replacedOnLabel("2026-11-06T17:00:00.000Z")).toBe("Replaced Nov 6, 2026");
    expect(replacedOnLabel("2026-11-07T03:00:00.000Z")).toBe("Replaced Nov 6, 2026"); // 22:00 Eastern
  });
});
```

  `src/lib/admin/crm-equipment-queries.test.ts`: the `drizzle-orm` mock gains `isNull: (...a: unknown[]) => ["isNull", ...a]`; the schema mock gains `retiredAt: "eq.retiredAt"`; the select mock records its where argument (`where: (w: unknown) => { whereSpy(w); return { limit: () => Promise.resolve(selectResult.value) }; }` with a hoisted `whereSpy = vi.fn()`); new case:

```ts
  it("ignores retired units when looking for a unit of the same type (M3c)", async () => {
    await recordCustomerEquipment(ORG, CUST, { equipmentType: "ac", make: "Carrier", installDate: null });
    expect(JSON.stringify(whereSpy.mock.calls[0]![0])).toContain("eq.retiredAt");
  });
```

  Run: `npx vitest run src/lib/tech/equipment-input.test.ts src/lib/tech/equipment-writes.test.ts src/lib/tech/equipment-errors.test.ts src/lib/tech/equipment-queries.test.ts src/lib/admin/crm-equipment-records.test.ts src/lib/admin/crm-equipment-queries.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement.**

`src/lib/tech/equipment-input.ts`:

```ts
/**
 * Field equipment input (M3c spec §5.6) and the equipment GET contract. Pure
 * and client-safe: the route, the writer and the equipment sheet share it.
 */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";

export const EQUIPMENT_TYPE_VALUES = ["ac", "furnace", "heat_pump", "boiler", "mini_split", "thermostat", "other"] as const;
export type EquipmentTypeValue = (typeof EQUIPMENT_TYPE_VALUES)[number];
export const EQUIPMENT_TEXT_MAX = 120;

const BUSINESS_TZ = BUSINESS_BASE_LOCATION.timezone;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface EquipmentRaw {
  readonly equipmentType?: unknown; readonly make?: unknown; readonly model?: unknown; readonly serialNumber?: unknown;
  readonly locationInHome?: unknown; readonly notes?: unknown; readonly installDate?: unknown; readonly replacesId?: unknown;
}

export interface EquipmentInput {
  readonly equipmentType: EquipmentTypeValue;
  readonly make: string | null;
  readonly model: string | null;
  readonly serialNumber: string | null;
  readonly locationInHome: string | null;
  readonly notes: string | null;
  /** YYYY-MM-DD in the business timezone, not in the future. */
  readonly installDate: string | null;
  /** Lower-case uuid of the unit this one replaces. */
  readonly replacesId: string | null;
}

export type EquipmentFieldError = "type" | "describe" | "too_long" | "date_invalid" | "date_future" | "replaces";

export const EQUIPMENT_ERROR_COPY: Record<EquipmentFieldError, string> = {
  type: "Choose the type of equipment.",
  describe: "Describe the equipment.",
  too_long: "Keep each field to 120 characters.",
  date_invalid: "Enter the install date as a date.",
  date_future: "The install date can't be in the future.",
  replaces: "Couldn't save that. Try again.",
};

export interface TechEquipmentUnit {
  readonly id: string;
  readonly equipmentType: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly serialNumber: string | null;
  readonly locationInHome: string | null;
  readonly notes: string | null;
  readonly installDate: string | null;
  readonly managedExternally: boolean;
}

export interface TechEquipmentView {
  readonly units: readonly TechEquipmentUnit[];
  readonly canWrite: boolean;
}

const TOO_LONG = Symbol("too_long");

function field(v: unknown): string | null | typeof TOO_LONG {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  return t.length > EQUIPMENT_TEXT_MAX ? TOO_LONG : t;
}

function isRealDate(ymd: string): boolean {
  const m = YMD_RE.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/** `today` is YYYY-MM-DD in the business timezone (`todayInZone`). */
export function parseEquipmentInput(
  raw: EquipmentRaw, today: string,
): { ok: true; value: EquipmentInput } | { ok: false; error: EquipmentFieldError } {
  const type = raw.equipmentType;
  if (typeof type !== "string" || !(EQUIPMENT_TYPE_VALUES as readonly string[]).includes(type)) return { ok: false, error: "type" };
  const make = field(raw.make);
  const model = field(raw.model);
  const serialNumber = field(raw.serialNumber);
  const locationInHome = field(raw.locationInHome);
  const notes = field(raw.notes);
  if ([make, model, serialNumber, locationInHome, notes].includes(TOO_LONG)) return { ok: false, error: "too_long" };
  if (type === "other" && notes === null) return { ok: false, error: "describe" };

  let installDate: string | null = null;
  if (typeof raw.installDate === "string" && raw.installDate.trim() !== "") {
    const d = raw.installDate.trim();
    if (!isRealDate(d)) return { ok: false, error: "date_invalid" };
    if (d > today) return { ok: false, error: "date_future" };
    installDate = d;
  }
  let replacesId: string | null = null;
  if (raw.replacesId !== undefined && raw.replacesId !== null && raw.replacesId !== "") {
    if (typeof raw.replacesId !== "string" || !UUID_RE.test(raw.replacesId)) return { ok: false, error: "replaces" };
    replacesId = raw.replacesId.toLowerCase();
  }
  return {
    ok: true,
    value: {
      equipmentType: type as EquipmentTypeValue,
      make: make as string | null, model: model as string | null, serialNumber: serialNumber as string | null,
      locationInHome: locationInHome as string | null, notes: notes as string | null, installDate, replacesId,
    },
  };
}

/** YYYY-MM-DD of `now` in the business timezone. */
export function todayInZone(now: Date, timeZone: string = BUSINESS_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - at.getTime();
}

/** Noon on `ymd` in the business timezone, as an instant (spec §5.6: "stored as noon"). */
export function noonInZone(ymd: string, timeZone: string = BUSINESS_TZ): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 12, 0, 0);
  return new Date(guess - zoneOffsetMs(new Date(guess), timeZone));
}
```

`src/lib/tech/equipment-writes.ts`:

```ts
/**
 * Field equipment add / replace (M3c spec §5.6). ONE db.batch: L_req, then (for
 * a replace) the old row's lock, the guarded INSERT, the xmin-gated retire and
 * a tail read; every statement repeats the caller-on-the-job check and
 * `service_requests.customer_id = $cust`.
 */
import { sql, type SQL } from "drizzle-orm";
import { lockRequestSql, readRows, runBatch } from "@/lib/admin/invoice-field-writes";
import { statusInSql } from "@/lib/admin/estimate-billing-sql";
import { BILL_STATUSES } from "@/lib/tech/field-sale-statuses";
import { noonInZone, type EquipmentInput } from "@/lib/tech/equipment-input";

export type EquipmentReason = "no_customer" | "not_found" | "equipment_retired" | "managed_externally" | "stale";
export type EquipmentWriteResult =
  | { ok: true; equipmentId: string; created: boolean; replaced: boolean }
  | { ok: false; reason: EquipmentReason };

type Row = Record<string, unknown>;
const fail = (reason: EquipmentReason): EquipmentWriteResult => ({ ok: false, reason });
const BILL_IN = statusInSql(BILL_STATUSES);

/** Shared by the GET and every write: request without a location → any unit; else the same location or none. */
export function locationRuleSql(unit: string, req: string): SQL {
  return sql.raw(`(${req}.location_id IS NULL OR ${unit}.location_id IS NULL OR ${unit}.location_id = ${req}.location_id)`);
}

/** The caller holds a non-cancelled assignment on a non-cancelled visit of the request. */
export function onJobSql(org: string, rid: string, me: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id
    WHERE p.service_request_id = ${rid}::uuid AND p.organization_id = ${org}::uuid AND a.organization_id = ${org}::uuid
      AND p.cancelled_at IS NULL AND a.technician_id = ${me}::uuid AND a.status <> 'cancelled'::request_status)`;
}

export function replaceOutcome(old: Row | undefined, newId: string): EquipmentWriteResult {
  if (!old) return fail("not_found");
  if (String(old.replaced_by_equipment_id ?? "").toLowerCase() === newId.toLowerCase()) {
    return { ok: true, equipmentId: newId, created: false, replaced: true };
  }
  if (old.retired === true) return fail("equipment_retired");
  if (old.synced === true) return fail("managed_externally");
  // Visible, live and native, yet nothing was written: the request changed under
  // the batch (status, assignment, customer). Plan ruling 15: STALE, not 404.
  return fail("stale");
}

export async function addFieldEquipment(
  actor: { organizationId: string; requestId: string; techUserId: string },
  ids: { equipmentId: string },
  input: EquipmentInput,
): Promise<EquipmentWriteResult> {
  const { organizationId: org, requestId: rid, techUserId: me } = actor;
  const neu = ids.equipmentId;
  const [req] = await readRows(sql`SELECT customer_id FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid`);
  if (!req) return fail("stale");
  const cust = (req.customer_id as string | null) ?? null;
  if (cust === null) return fail("no_customer");

  const onJob = onJobSql(org, rid, me);
  const reqOk = sql`r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid AND r.customer_id = ${cust}::uuid AND r.status IN ${BILL_IN} AND (${onJob})`;
  const installAt = input.installDate ? noonInZone(input.installDate).toISOString() : null;
  const insertNew = (extra: SQL): SQL => sql`INSERT INTO customer_equipment (id, organization_id, customer_id, location_id, equipment_type, make, model, serial_number, location_in_home, notes, install_date)
      SELECT ${neu}::uuid, ${org}::uuid, ${cust}::uuid, r.location_id, ${input.equipmentType}::equipment_type, ${input.make}::text, ${input.model}::text,
        ${input.serialNumber}::text, ${input.locationInHome}::text, ${input.notes}::text, ${installAt}::timestamptz
      FROM service_requests r WHERE ${reqOk}${extra}
      ON CONFLICT (id) DO NOTHING RETURNING id`;

  if (input.replacesId === null) {
    const rows = await runBatch([
      lockRequestSql(org, rid),
      insertNew(sql``),
      sql`SELECT EXISTS (SELECT 1 FROM customer_equipment WHERE id = ${neu}::uuid AND organization_id = ${org}::uuid AND customer_id = ${cust}::uuid) AS exists`,
    ]);
    if (!Array.isArray(rows)) return fail("stale");
    if (rows[1]!.length > 0) return { ok: true, equipmentId: neu, created: true, replaced: false };
    return rows[2]![0]?.exists === true ? { ok: true, equipmentId: neu, created: false, replaced: false } : fail("stale");
  }

  const old = input.replacesId;
  const oldVisible = sql`ce.id = ${old}::uuid AND ce.organization_id = ${org}::uuid AND ce.customer_id = ${cust}::uuid AND ${locationRuleSql("ce", "r")}`;
  const rows = await runBatch([
    lockRequestSql(org, rid),
    sql`SELECT 1 FROM customer_equipment ce JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
      WHERE ${oldVisible} AND ce.fieldpulse_asset_id IS NULL AND r.customer_id = ${cust}::uuid AND (${onJob}) FOR NO KEY UPDATE OF ce`,
    insertNew(sql` AND EXISTS (SELECT 1 FROM customer_equipment ce WHERE ${oldVisible} AND ce.retired_at IS NULL AND ce.fieldpulse_asset_id IS NULL)`),
    sql`UPDATE customer_equipment ce SET retired_at = now(), replaced_by_equipment_id = ${neu}::uuid, updated_at = now()
      FROM service_requests r
      WHERE ${oldVisible} AND ce.retired_at IS NULL AND ce.fieldpulse_asset_id IS NULL AND ${reqOk}
        AND EXISTS (SELECT 1 FROM customer_equipment n WHERE n.id = ${neu}::uuid AND n.organization_id = ${org}::uuid AND n.xmin = pg_current_xact_id()::xid)
      RETURNING ce.id`,
    sql`SELECT ce.retired_at IS NOT NULL AS retired, ce.replaced_by_equipment_id, ce.fieldpulse_asset_id IS NOT NULL AS synced
      FROM customer_equipment ce JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
      WHERE ${oldVisible}`,
  ]);
  if (!Array.isArray(rows)) return fail("stale");
  if (rows[2]!.length > 0) return { ok: true, equipmentId: neu, created: true, replaced: true };
  return replaceOutcome(rows[4]![0], neu);
}
```

  (In the UPDATE, `SET replaced_by_equipment_id = ${neu}` renders as `$1` because SET comes first; the test pins that.)

`src/lib/tech/equipment-errors.ts`:

```ts
/** Reason → HTTP status / code / copy for the field equipment route (M3c spec §5.6). */
import type { RunResult } from "@/lib/http/idempotency";
import type { EquipmentReason } from "@/lib/tech/equipment-writes";

type Shape = { status: number; code: string; message: string };

const MAP: Record<EquipmentReason, Shape> = {
  no_customer: { status: 409, code: "NO_CUSTOMER", message: "Ask the office to add the customer first." },
  not_found: { status: 404, code: "NOT_FOUND", message: "That unit isn't at this address." },
  equipment_retired: { status: 409, code: "EQUIPMENT_RETIRED", message: "That unit was already replaced." },
  managed_externally: { status: 409, code: "MANAGED_EXTERNALLY", message: "That unit is managed in FieldPulse." },
  stale: { status: 409, code: "STALE", message: "This job changed. Try again." },
};

export function equipmentError(reason: EquipmentReason): Shape {
  return { ...MAP[reason] };
}

export function equipmentReasonResult(reason: EquipmentReason): RunResult {
  const { status, code, message } = MAP[reason];
  return { status, envelope: { success: false, error: { message, code } } };
}
```

`src/lib/tech/equipment-queries.ts`:

```ts
/**
 * The job page's Equipment card read model (M3c spec §6): the customer's live
 * units by the location rule, and whether the caller may add or replace.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { findReadableJob } from "@/lib/tech/ownership";
import { BILL_STATUSES } from "@/lib/tech/field-sale-statuses";
import { locationRuleSql, onJobSql } from "@/lib/tech/equipment-writes";
import type { TechEquipmentUnit, TechEquipmentView } from "@/lib/tech/equipment-input";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function unitsSql(org: string, rid: string): SQL {
  return sql`SELECT ce.id, ce.equipment_type::text AS equipment_type, ce.make, ce.model, ce.serial_number, ce.location_in_home,
      ce.notes, ce.install_date, ce.fieldpulse_asset_id IS NOT NULL AS managed_externally
    FROM customer_equipment ce JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
    WHERE ce.organization_id = ${org}::uuid AND ce.customer_id = r.customer_id AND ce.retired_at IS NULL AND ${locationRuleSql("ce", "r")}
    ORDER BY ce.created_at, ce.id`;
}

export function canWriteSql(org: string, rid: string, me: string): SQL {
  return sql`SELECT (${onJobSql(org, rid, me)}) AS on_job, r.status::text AS status, r.customer_id IS NOT NULL AS has_customer
    FROM service_requests r WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`;
}

export function canWriteFrom(row: Row | undefined): boolean {
  return row?.on_job === true && row.has_customer === true
    && (BILL_STATUSES as readonly string[]).includes(String(row.status));
}

export function toUnit(r: Row): TechEquipmentUnit {
  return {
    id: String(r.id), equipmentType: String(r.equipment_type), make: str(r.make), model: str(r.model),
    serialNumber: str(r.serial_number), locationInHome: str(r.location_in_home), notes: str(r.notes),
    installDate: r.install_date ? new Date(r.install_date as string | Date).toISOString() : null,
    managedExternally: r.managed_externally === true,
  };
}

export async function getTechEquipmentView(
  org: string, me: string, rid: string,
): Promise<{ kind: "not_found" } | { kind: "external" } | { kind: "ok"; view: TechEquipmentView }> {
  const job = await findReadableJob(org, me, rid);
  if (!job) return { kind: "not_found" };
  if (!job.native) return { kind: "external" };
  const [units, gate] = await Promise.all([
    db.execute(unitsSql(org, rid)),
    db.execute(canWriteSql(org, rid, me)),
  ]);
  return {
    kind: "ok",
    view: { units: (units.rows as Row[]).map(toUnit), canWrite: canWriteFrom((gate.rows as Row[])[0]) },
  };
}
```

`src/lib/admin/crm-equipment-records.ts`:

```ts
/**
 * The customer profile's equipment list (M3c spec §2): live units first, then
 * retired ones; the replacement link only when that unit still exists; the
 * count covers live units only. Pure.
 */
import type { EquipmentRecord } from "./crm-types";

export interface EquipmentRowLike {
  readonly id: string; readonly equipmentType: string; readonly make: string | null; readonly model: string | null;
  readonly serialNumber: string | null; readonly installDate: Date | null; readonly warrantyExpiration: Date | null;
  readonly warrantyType: string | null; readonly warrantyProvider: string | null; readonly locationInHome: string | null;
  readonly notes: string | null; readonly fieldpulseAssetId: string | null;
  readonly retiredAt?: Date | null; readonly replacedByEquipmentId?: string | null;
}

export function equipmentRecords(rows: readonly EquipmentRowLike[]): EquipmentRecord[] {
  const ids = new Set(rows.map((r) => r.id));
  const live = rows.filter((r) => !r.retiredAt);
  const retired = rows.filter((r) => r.retiredAt);
  return [...live, ...retired].map((e) => ({
    id: e.id,
    equipmentType: e.equipmentType,
    make: e.make,
    model: e.model,
    serialNumber: e.serialNumber,
    installDate: e.installDate?.toISOString() ?? null,
    warrantyExpiration: e.warrantyExpiration?.toISOString() ?? null,
    warrantyType: e.warrantyType,
    warrantyProvider: e.warrantyProvider,
    locationInHome: e.locationInHome,
    notes: e.notes,
    fieldpulseAssetId: e.fieldpulseAssetId ?? null,
    retiredAt: e.retiredAt ? e.retiredAt.toISOString() : null,
    replacedByEquipmentId: e.replacedByEquipmentId && ids.has(e.replacedByEquipmentId) ? e.replacedByEquipmentId : null,
  }));
}

export function liveEquipmentCount(rows: readonly { readonly retiredAt?: Date | null }[]): number {
  return rows.filter((r) => !r.retiredAt).length;
}

export function replacedOnLabel(iso: string, timeZone: string = BUSINESS_BASE_LOCATION.timezone): string {
  return `Replaced ${new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso))}`;
}
```

  (`crm-equipment-records.ts` imports `BUSINESS_BASE_LOCATION` from `@/lib/config/business-location` next to the `EquipmentRecord` type import.)

  Office edits:
  - `crm-types.ts` `EquipmentRecord`: add `/** M3c: set when a newer unit replaced this one (listed last, muted). */ readonly retiredAt: string | null;` and `/** The replacing unit, only while it still exists. */ readonly replacedByEquipmentId: string | null;`.
  - `crm-queries.ts`: `aggCols.equipmentCount` becomes ``sql<number>`count(distinct ${customerEquipment.id}) filter (where ${customerEquipment.retiredAt} is null)::int` ``; in the customer detail, `equipmentCount: liveEquipmentCount(equipmentRows)` and `equipment: equipmentRecords(equipmentRows)` (import both from `./crm-equipment-records`; the inline `equipmentRows.map(...)` is removed).
  - `crm-equipment-queries.ts` `recordCustomerEquipment`: the existing-unit lookup's `and(...)` gains `isNull(customerEquipment.retiredAt)` (import `isNull` from `drizzle-orm`); doc line: "Retired units (replaced in the field) are ignored."

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/tech/equipment-input.test.ts src/lib/tech/equipment-writes.test.ts src/lib/tech/equipment-errors.test.ts src/lib/tech/equipment-queries.test.ts src/lib/admin/crm-equipment-records.test.ts src/lib/admin/crm-equipment-queries.test.ts src/lib/admin/crm-queries.test.ts src/lib/admin/crm-list-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/equipment-input.ts src/lib/tech/equipment-input.test.ts src/lib/tech/equipment-writes.ts src/lib/tech/equipment-writes.test.ts src/lib/tech/equipment-errors.ts src/lib/tech/equipment-errors.test.ts src/lib/tech/equipment-queries.ts src/lib/tech/equipment-queries.test.ts src/lib/admin/crm-equipment-records.ts src/lib/admin/crm-equipment-records.test.ts src/lib/admin/crm-equipment-queries.ts src/lib/admin/crm-equipment-queries.test.ts src/lib/admin/crm-queries.ts src/lib/admin/crm-types.ts && npx vitest run
git add src/lib/tech/equipment-input.ts src/lib/tech/equipment-input.test.ts src/lib/tech/equipment-writes.ts src/lib/tech/equipment-writes.test.ts src/lib/tech/equipment-errors.ts src/lib/tech/equipment-errors.test.ts src/lib/tech/equipment-queries.ts src/lib/tech/equipment-queries.test.ts src/lib/admin/crm-equipment-records.ts src/lib/admin/crm-equipment-records.test.ts src/lib/admin/crm-equipment-queries.ts src/lib/admin/crm-equipment-queries.test.ts src/lib/admin/crm-queries.ts src/lib/admin/crm-types.ts
git commit -m "$(cat <<'EOF'
feat(m3c): field equipment add/replace writer, location rule, retired units in the office

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 5: Technician estimates read model — view types, display helpers, GET query

**Files:**
- Create: `src/lib/tech/estimate-view.ts`, `src/lib/tech/estimate-display.ts` (+ `estimate-display.test.ts`), `src/lib/tech/estimate-queries.ts` (+ `estimate-queries.test.ts`)

**Interfaces:**
- Consumes (Task 1): `officeBilledSql`, `jobBilledSql`, `billingInvoiceIdSql`; `SELL_STATUSES`, `BILL_STATUSES`, `statusGate`. Existing: `P_LIVE`, `P_NATIVE` (`@/lib/admin/invoice-field-writes`), `findReadableJob`, `findActiveVisit`, `getDefaultTaxBps`, `getOrgConfig` (`@/lib/admin/org-config-queries`), `decrypt` (`@/lib/crypto`), `formatCentsExact`.
- Produces:
  - `estimate-view.ts` (types only, client-safe): `TechEstimateStatus = "open" | "sold" | "expired" | "declined"`, `EstimateBilling = "office" | "job" | "none"`, `TechEstimateLine { id; pricebookItemId: string | null; name; quantity; unitPriceCents; lineTotalCents }`, `TechEstimateOption { id; name; sortOrder; subtotalCents; taxCents; totalCents; lines }`, `TechEstimate { id; label; status; createdAt; expiresAt; signedAt; soldOptionId; soldVia; soldByMe; hasApprovalLink; billing; billingInvoiceId; options }`, `TechJobInvoiceRef { id; state: "draft" | "open"; hasPayment }`, `TechEstimatesView { companyName; customerDisplayName; isLead; canCreate; createBlockedReason; taxBps; requestStatus; hasOtherSold; jobInvoice; priorInvoicePaid; estimates }`.
  - `estimate-display.ts` (pure, client-safe): `derivedStatus(status, expiresAt, now)`, `estimateLabel(createdAt, optionCount, timeZone?)`, `STATUS_CHIP`, `soldOptionOf(e)`, `priceSummary(e)`, `BILLING_LINE`, `billingOf(officeBilled, jobBilled)`, `CREATE_BLOCKED`, `createBlockedReason({ isLead, status, hasCustomer })`, `canSell(view, estimate)`, `type SoldBillingView`, `soldBillingView(estimate, view)`, `SOLD_COPY`, `estimatesCardVisible(view)`.
  - `estimate-queries.ts`: `estimatesSql(org, rid, me)`, `optionsSql(org, rid)`, `linesSql(org, rid)`, `jobInvoiceSql(org, rid)`, `priorPaidSql(org, rid)`, pure `assembleEstimates(estRows, optRows, lineRows, now)`, `getTechEstimatesView(org, me, rid, now?): Promise<{ kind: "not_found" } | { kind: "external" } | { kind: "ok"; view: TechEstimatesView }>`.

- [ ] **Step 1: Failing display tests** — `src/lib/tech/estimate-display.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  BILLING_LINE, billingOf, canSell, createBlockedReason, derivedStatus, estimateLabel, estimatesCardVisible,
  priceSummary, SOLD_COPY, soldBillingView, STATUS_CHIP,
} from "./estimate-display";
import type { TechEstimate, TechEstimatesView } from "./estimate-view";

const NOW = new Date("2026-11-06T15:00:00Z");
const opt = (id: string, totalCents: number) => ({ id, name: id, sortOrder: 0, subtotalCents: totalCents, taxCents: 0, totalCents, lines: [] });

describe("estimate display (spec §2, §7.3)", () => {
  it("label: creation day in the business timezone, option count", () => {
    expect(estimateLabel("2026-11-06T15:00:00Z", 2)).toBe("Estimate · Nov 6 · 2 options");
    expect(estimateLabel("2026-11-07T03:30:00Z", 1)).toBe("Estimate · Nov 6 · 1 option"); // 22:30 Eastern
  });
  it("derived status: open past expires_at reads Expired; dismissed reads Declined", () => {
    expect(derivedStatus("open", "2026-11-06T14:59:59Z", NOW)).toBe("expired");
    expect(derivedStatus("open", "2026-12-06T00:00:00Z", NOW)).toBe("open");
    expect(derivedStatus("open", null, NOW)).toBe("open");
    expect(derivedStatus("dismissed", null, NOW)).toBe("declined");
    expect(derivedStatus("expired", null, NOW)).toBe("expired");
    expect(derivedStatus("sold", "2026-01-01T00:00:00Z", NOW)).toBe("sold");
    expect(STATUS_CHIP).toEqual({ open: "Open", sold: "Sold", expired: "Expired", declined: "Declined" });
  });
  it("price: the sold option's total, else the option range", () => {
    expect(priceSummary({ status: "open", soldOptionId: null, options: [opt("a", 120_000), opt("b", 481_200)] })).toBe("$1,200.00 – $4,812.00");
    expect(priceSummary({ status: "open", soldOptionId: null, options: [opt("a", 120_000)] })).toBe("$1,200.00");
    expect(priceSummary({ status: "sold", soldOptionId: "b", options: [opt("a", 120_000), opt("b", 481_200)] })).toBe("$4,812.00");
  });
  it("billing: office beats job beats none; copy per state", () => {
    expect(billingOf(true, true)).toBe("office");
    expect(billingOf(false, true)).toBe("job");
    expect(billingOf(false, false)).toBe("none");
    expect(BILLING_LINE).toEqual({ job: "On the job's invoice", office: "Billed by the office", none: "Not invoiced yet" });
  });
  it("create blocked reasons", () => {
    expect(createBlockedReason({ isLead: true, status: "arrived", hasCustomer: true })).toBeNull();
    expect(createBlockedReason({ isLead: false, status: "arrived", hasCustomer: true })).toBe("Only the lead technician can do that.");
    expect(createBlockedReason({ isLead: true, status: "en_route", hasCustomer: true })).toBe("Arrive at the job first.");
    expect(createBlockedReason({ isLead: true, status: "completed", hasCustomer: true })).toBe("This job is closed.");
    expect(createBlockedReason({ isLead: true, status: "on_hold", hasCustomer: false })).toBe("Ask the office to add the customer before quoting.");
  });
  it("canSell: the lead, an open estimate, an on-site request", () => {
    const v = { isLead: true, requestStatus: "in_progress" };
    expect(canSell(v, { status: "open" })).toBe(true);
    expect(canSell(v, { status: "sold" })).toBe(false);
    expect(canSell({ ...v, isLead: false }, { status: "open" })).toBe(false);
    expect(canSell({ ...v, requestStatus: "completed" }, { status: "open" })).toBe(false);
    expect(canSell(v, null)).toBe(false);
  });
  it("sold billing view (spec §7.3)", () => {
    const view = (over: Partial<TechEstimatesView>) => ({ jobInvoice: null, priorInvoicePaid: false, requestStatus: "in_progress", ...over }) as TechEstimatesView;
    const est = (over: Partial<TechEstimate>) => ({ billing: "none", billingInvoiceId: null, ...over }) as TechEstimate;
    expect(soldBillingView(est({ billing: "job", billingInvoiceId: "i1" }), view({}))).toEqual({ kind: "job", invoiceId: "i1" });
    expect(soldBillingView(est({ billing: "office" }), view({}))).toEqual({ kind: "office" });
    expect(soldBillingView(est({}), view({}))).toEqual({ kind: "add", newInvoice: false });
    expect(soldBillingView(est({}), view({ priorInvoicePaid: true }))).toEqual({ kind: "add", newInvoice: true });
    expect(soldBillingView(est({}), view({ jobInvoice: { id: "d", state: "draft", hasPayment: false } }))).toEqual({ kind: "add", newInvoice: false });
    expect(soldBillingView(est({}), view({ jobInvoice: { id: "d", state: "draft", hasPayment: true } }))).toEqual({ kind: "locked" });
    expect(soldBillingView(est({}), view({ jobInvoice: { id: "o", state: "open", hasPayment: false } }))).toEqual({ kind: "locked" });
    expect(soldBillingView(est({}), view({ requestStatus: "cancelled" }))).toEqual({ kind: "closed" });
    expect(SOLD_COPY.locked).toBe("The job's invoice is already finalized. Ask the office to bill this estimate."); // ruling 12
  });
  it("the card shows from arrival on, or whenever estimates exist", () => {
    expect(estimatesCardVisible({ requestStatus: "en_route", estimates: [] })).toBe(false);
    expect(estimatesCardVisible({ requestStatus: "arrived", estimates: [] })).toBe(true);
    expect(estimatesCardVisible({ requestStatus: "cancelled", estimates: [{} as TechEstimate] })).toBe(true);
  });
});
```

- [ ] **Step 2: Failing query tests** — `src/lib/tech/estimate-queries.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/admin/org-config-queries", () => ({ getOrgConfig: vi.fn() }));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
import { assembleEstimates, estimatesSql, jobInvoiceSql, linesSql, optionsSql } from "./estimate-queries";

const ORG = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const q = (s: SQL) => new PgDialect().sqlToQuery(s);
const render = (s: SQL) => q(s).sql.replace(/\s+/g, " ");

describe("tech estimates GET SQL (spec §6)", () => {
  it("native estimates of the request, newest first, with both billing halves", () => {
    const t = render(estimatesSql(ORG, RID, ME));
    expect(t).toContain("e.fieldpulse_estimate_id IS NULL");
    expect(t).toContain("ORDER BY e.created_at DESC, e.id DESC");
    expect(t).toContain("AS office_billed");
    expect(t).toContain("AS job_billed");
    expect(t).toContain("AS billing_invoice_id");
    expect(t).not.toContain("signature_name");
    expect(q(estimatesSql(ORG, RID, ME)).params.filter((p) => p === ORG).length).toBeGreaterThanOrEqual(1 + 1 + 4 + 1 + 4);
  });
  it("options and lines never select a cost; every table is org-bound", () => {
    for (const s of [optionsSql(ORG, RID), linesSql(ORG, RID)]) {
      expect(render(s)).not.toContain("cost");
    }
    expect(q(linesSql(ORG, RID)).params.filter((p) => p === ORG)).toHaveLength(3);
    expect(render(linesSql(ORG, RID))).toContain("ORDER BY l.id");
  });
  it("the job's invoice is the newest live native one", () => {
    const t = render(jobInvoiceSql(ORG, RID));
    expect(t).toContain("(state = 'draft'::invoice_state OR state = 'open'::invoice_state)");
    expect(t).toContain("amount_paid_cents > 0 AS has_payment");
  });
});

describe("assembleEstimates", () => {
  const NOW = new Date("2026-11-06T15:00:00Z");
  it("nests options and lines in order, derives status, billing and the label; no cost keys", () => {
    const out = assembleEstimates(
      [{ id: "e1", status: "sold", created_at: "2026-11-06T14:00:00Z", expires_at: "2026-12-06T14:00:00Z", signed_at: "2026-11-06T14:30:00Z",
        sold_option_id: "o2", sold_via: "field", sold_by_me: true, has_approval_link: false, office_billed: true, job_billed: true, billing_invoice_id: "inv-1" }],
      [{ id: "o1", estimate_id: "e1", name: "Good", sort_order: 0, subtotal_cents: 100, tax_cents: 8, total_cents: 108 },
       { id: "o2", estimate_id: "e1", name: "Better", sort_order: 1, subtotal_cents: 200, tax_cents: 17, total_cents: 217 }],
      [{ id: "l1", option_id: "o2", pricebook_item_id: "p1", name: "Coil", quantity: 2, unit_price_cents: 100, line_total_cents: 200 }],
      NOW,
    );
    expect(out[0]).toMatchObject({
      id: "e1", label: "Estimate · Nov 6 · 2 options", status: "sold", soldOptionId: "o2", soldVia: "field", soldByMe: true,
      billing: "office", billingInvoiceId: "inv-1", signedAt: "2026-11-06T14:30:00.000Z",
    });
    expect(out[0]!.options.map((o) => o.lines.length)).toEqual([0, 1]);
    expect(out[0]!.options[1]!.lines[0]).toEqual({ id: "l1", pricebookItemId: "p1", name: "Coil", quantity: 2, unitPriceCents: 100, lineTotalCents: 200 });
    expect(JSON.stringify(out)).not.toMatch(/cost/i);
  });
});
```

  Run: `npx vitest run src/lib/tech/estimate-display.test.ts src/lib/tech/estimate-queries.test.ts` → FAIL.

- [ ] **Step 3: Implement.**

`src/lib/tech/estimate-view.ts`:

```ts
/**
 * GET /api/tech/jobs/[id]/estimates contract (M3c spec §6, plus requestStatus
 * and priorInvoicePaid — plan ruling 1). TYPES ONLY: shared by the server and
 * client components. Never a cost field, never the typed signature name.
 */
export type TechEstimateStatus = "open" | "sold" | "expired" | "declined";
export type EstimateBilling = "office" | "job" | "none";

export interface TechEstimateLine {
  readonly id: string;
  readonly pricebookItemId: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

export interface TechEstimateOption {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly lines: readonly TechEstimateLine[];
}

export interface TechEstimate {
  readonly id: string;
  /** "Estimate · Nov 6 · 2 options" (creation day, business timezone). */
  readonly label: string;
  readonly status: TechEstimateStatus;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly signedAt: string | null;
  readonly soldOptionId: string | null;
  readonly soldVia: string | null;
  readonly soldByMe: boolean;
  readonly hasApprovalLink: boolean;
  readonly billing: EstimateBilling;
  readonly billingInvoiceId: string | null;
  readonly options: readonly TechEstimateOption[];
}

export interface TechJobInvoiceRef {
  readonly id: string;
  readonly state: "draft" | "open";
  readonly hasPayment: boolean;
}

export interface TechEstimatesView {
  readonly companyName: string | null;
  readonly customerDisplayName: string | null;
  readonly isLead: boolean;
  readonly canCreate: boolean;
  readonly createBlockedReason: string | null;
  readonly taxBps: number;
  readonly requestStatus: string;
  readonly hasOtherSold: boolean;
  /** The request's newest live native invoice. */
  readonly jobInvoice: TechJobInvoiceRef | null;
  /** A paid or refunded native invoice exists (a bill now starts a new invoice). */
  readonly priorInvoicePaid: boolean;
  readonly estimates: readonly TechEstimate[];
}
```

`src/lib/tech/estimate-display.ts`:

```ts
/**
 * Pure display rules for the technician estimate surfaces (M3c spec §2, §7.3).
 * Client-safe: no db, no server-only imports.
 */
import { formatCentsExact } from "@/lib/admin/money-format";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { BILL_STATUSES, SELL_STATUSES, statusGate } from "./field-sale-statuses";
import type { EstimateBilling, TechEstimate, TechEstimateOption, TechEstimateStatus, TechEstimatesView } from "./estimate-view";

const BUSINESS_TZ = BUSINESS_BASE_LOCATION.timezone;

export function derivedStatus(status: string, expiresAt: string | Date | null, now: Date): TechEstimateStatus {
  if (status === "sold") return "sold";
  if (status === "dismissed") return "declined";
  if (status === "expired") return "expired";
  if (expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime()) return "expired";
  return "open";
}

export function estimateLabel(createdAt: string | Date, optionCount: number, timeZone: string = BUSINESS_TZ): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(new Date(createdAt));
  return `Estimate · ${day} · ${optionCount} ${optionCount === 1 ? "option" : "options"}`;
}

export const STATUS_CHIP: Record<TechEstimateStatus, string> = { open: "Open", sold: "Sold", expired: "Expired", declined: "Declined" };

export function soldOptionOf(e: Pick<TechEstimate, "soldOptionId" | "options">): TechEstimateOption | null {
  return e.options.find((o) => o.id === e.soldOptionId) ?? null;
}

export function priceSummary(e: Pick<TechEstimate, "status" | "soldOptionId" | "options">): string {
  const sold = e.status === "sold" ? soldOptionOf(e) : null;
  if (sold) return formatCentsExact(sold.totalCents);
  const totals = e.options.map((o) => o.totalCents);
  if (totals.length === 0) return formatCentsExact(0);
  const lo = Math.min(...totals);
  const hi = Math.max(...totals);
  return lo === hi ? formatCentsExact(lo) : `${formatCentsExact(lo)} – ${formatCentsExact(hi)}`;
}

export const BILLING_LINE: Record<EstimateBilling, string> = {
  job: "On the job's invoice",
  office: "Billed by the office",
  none: "Not invoiced yet",
};

export function billingOf(officeBilled: boolean, jobBilled: boolean): EstimateBilling {
  if (officeBilled) return "office";
  return jobBilled ? "job" : "none";
}

export const CREATE_BLOCKED = {
  notLead: "Only the lead technician can do that.",
  before: "Arrive at the job first.",
  closed: "This job is closed.",
  noCustomer: "Ask the office to add the customer before quoting.",
} as const;

export function createBlockedReason(p: { isLead: boolean; status: string; hasCustomer: boolean }): string | null {
  if (!p.isLead) return CREATE_BLOCKED.notLead;
  const gate = statusGate(p.status, SELL_STATUSES);
  if (gate === "job_closed") return CREATE_BLOCKED.closed;
  if (gate === "not_on_site") return CREATE_BLOCKED.before;
  return p.hasCustomer ? null : CREATE_BLOCKED.noCustomer;
}

/** Show to customer / Customer declined are offered (spec §7.2). */
export function canSell(
  view: Pick<TechEstimatesView, "isLead" | "requestStatus">, e: Pick<TechEstimate, "status"> | null,
): boolean {
  return view.isLead && e?.status === "open" && statusGate(view.requestStatus, SELL_STATUSES) === "ok";
}

export type SoldBillingView =
  | { readonly kind: "add"; readonly newInvoice: boolean }
  | { readonly kind: "locked" }
  | { readonly kind: "job"; readonly invoiceId: string | null }
  | { readonly kind: "office" }
  | { readonly kind: "closed" };

export function soldBillingView(
  e: Pick<TechEstimate, "billing" | "billingInvoiceId">,
  view: Pick<TechEstimatesView, "jobInvoice" | "priorInvoicePaid" | "requestStatus">,
): SoldBillingView {
  if (e.billing === "job") return { kind: "job", invoiceId: e.billingInvoiceId };
  if (e.billing === "office") return { kind: "office" };
  if (statusGate(view.requestStatus, BILL_STATUSES) !== "ok") return { kind: "closed" };
  const inv = view.jobInvoice;
  if (inv === null) return { kind: "add", newInvoice: view.priorInvoicePaid };
  if (inv.state === "draft" && !inv.hasPayment) return { kind: "add", newInvoice: false };
  return { kind: "locked" };
}

export const SOLD_COPY = {
  locked: "The job's invoice is already finalized. Ask the office to bill this estimate.", // plan ruling 12 (spec deviation)
  newInvoice: "This goes on a new invoice.",
  added: "Added. Get the customer's signature on the invoice before finalizing.",
  overlap: "Check the invoice for parts that are also on the estimate.",
  approvalLink: "A link was also sent to the customer.",
} as const;

export function estimatesCardVisible(view: Pick<TechEstimatesView, "requestStatus" | "estimates">): boolean {
  return (BILL_STATUSES as readonly string[]).includes(view.requestStatus) || view.estimates.length > 0;
}
```

`src/lib/tech/estimate-queries.ts`:

```ts
/**
 * GET /api/tech/jobs/[id]/estimates read model (M3c spec §6). Small org-scoped
 * raw reads; no cost column and no signature_name is ever selected.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getDefaultTaxBps } from "@/lib/admin/pricebook-queries";
import { getOrgConfig } from "@/lib/admin/org-config-queries";
import { P_LIVE, P_NATIVE } from "@/lib/admin/invoice-field-writes";
import { billingInvoiceIdSql, jobBilledSql, officeBilledSql } from "@/lib/admin/estimate-billing-sql";
import { findActiveVisit, findReadableJob } from "@/lib/tech/ownership";
import { billingOf, createBlockedReason, derivedStatus, estimateLabel } from "@/lib/tech/estimate-display";
import type { TechEstimate, TechEstimateOption, TechEstimatesView, TechJobInvoiceRef } from "@/lib/tech/estimate-view";

type Row = Record<string, unknown>;
const E = sql.raw("e.id");
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

async function rows(q: SQL): Promise<Row[]> {
  return (await db.execute(q)).rows as Row[];
}

export function estimatesSql(org: string, rid: string, me: string): SQL {
  return sql`SELECT e.id, e.status::text AS status, e.created_at, e.expires_at, e.signed_at, e.sold_option_id, e.sold_via,
      (e.sold_by IS NOT NULL AND e.sold_by = ${me}::uuid) AS sold_by_me,
      (e.approval_token_hash IS NOT NULL) AS has_approval_link,
      ${officeBilledSql(org, E)} AS office_billed, ${jobBilledSql(org, E)} AS job_billed,
      ${billingInvoiceIdSql(org, E)} AS billing_invoice_id
    FROM estimates e
    WHERE e.organization_id = ${org}::uuid AND e.service_request_id = ${rid}::uuid AND e.fieldpulse_estimate_id IS NULL
    ORDER BY e.created_at DESC, e.id DESC`;
}

export function optionsSql(org: string, rid: string): SQL {
  return sql`SELECT o.id, o.estimate_id, o.name, o.sort_order, o.subtotal_cents, o.tax_cents, o.total_cents
    FROM estimate_options o JOIN estimates e ON e.id = o.estimate_id
    WHERE o.organization_id = ${org}::uuid AND e.organization_id = ${org}::uuid AND e.service_request_id = ${rid}::uuid
      AND e.fieldpulse_estimate_id IS NULL
    ORDER BY o.sort_order, o.id`;
}

export function linesSql(org: string, rid: string): SQL {
  return sql`SELECT l.id, l.option_id, l.pricebook_item_id, l.name, l.quantity, l.unit_price_cents, l.line_total_cents
    FROM estimate_line_items l JOIN estimate_options o ON o.id = l.option_id JOIN estimates e ON e.id = o.estimate_id
    WHERE l.organization_id = ${org}::uuid AND o.organization_id = ${org}::uuid AND e.organization_id = ${org}::uuid
      AND e.service_request_id = ${rid}::uuid AND e.fieldpulse_estimate_id IS NULL
    ORDER BY l.id`;
}

export function jobInvoiceSql(org: string, rid: string): SQL {
  return sql`SELECT id, state::text AS state, amount_paid_cents > 0 AS has_payment
    FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid AND ${P_LIVE} AND ${P_NATIVE}
    ORDER BY created_at DESC, id DESC LIMIT 1`;
}

export function priorPaidSql(org: string, rid: string): SQL {
  return sql`SELECT EXISTS (SELECT 1 FROM invoices WHERE organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
    AND state IN ('paid'::invoice_state, 'refunded'::invoice_state) AND ${P_NATIVE}) AS paid`;
}

export function assembleEstimates(estRows: readonly Row[], optRows: readonly Row[], lineRows: readonly Row[], now: Date): TechEstimate[] {
  const linesByOption = new Map<string, TechEstimateOption["lines"][number][]>();
  for (const l of lineRows) {
    const key = String(l.option_id);
    const list = linesByOption.get(key) ?? [];
    list.push({
      id: String(l.id), pricebookItemId: str(l.pricebook_item_id), name: String(l.name), quantity: Number(l.quantity),
      unitPriceCents: Number(l.unit_price_cents), lineTotalCents: Number(l.line_total_cents),
    });
    linesByOption.set(key, list);
  }
  const optionsByEstimate = new Map<string, TechEstimateOption[]>();
  for (const o of optRows) {
    const key = String(o.estimate_id);
    const list = optionsByEstimate.get(key) ?? [];
    list.push({
      id: String(o.id), name: String(o.name), sortOrder: Number(o.sort_order), subtotalCents: Number(o.subtotal_cents),
      taxCents: Number(o.tax_cents), totalCents: Number(o.total_cents), lines: linesByOption.get(String(o.id)) ?? [],
    });
    optionsByEstimate.set(key, list);
  }
  return estRows.map((e) => {
    const options = optionsByEstimate.get(String(e.id)) ?? [];
    return {
      id: String(e.id),
      label: estimateLabel(e.created_at as string | Date, options.length),
      status: derivedStatus(String(e.status), (e.expires_at as string | Date | null) ?? null, now),
      createdAt: iso(e.created_at) ?? "",
      expiresAt: iso(e.expires_at),
      signedAt: iso(e.signed_at),
      soldOptionId: str(e.sold_option_id),
      soldVia: str(e.sold_via),
      soldByMe: e.sold_by_me === true,
      hasApprovalLink: e.has_approval_link === true,
      billing: billingOf(e.office_billed === true, e.job_billed === true),
      billingInvoiceId: str(e.billing_invoice_id),
      options,
    };
  });
}

async function companyNameOf(org: string): Promise<string | null> {
  try {
    return (await getOrgConfig(org)).companyName ?? null;
  } catch {
    return null;
  }
}

async function customerNameOf(org: string, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const [row] = await rows(sql`SELECT name_encrypted FROM customers WHERE id = ${customerId}::uuid AND organization_id = ${org}::uuid`);
  if (!row?.name_encrypted) return null;
  try {
    return decrypt(String(row.name_encrypted));
  } catch {
    return null;
  }
}

export async function getTechEstimatesView(
  org: string, me: string, rid: string, now: Date = new Date(),
): Promise<{ kind: "not_found" } | { kind: "external" } | { kind: "ok"; view: TechEstimatesView }> {
  const job = await findReadableJob(org, me, rid);
  if (!job) return { kind: "not_found" };
  if (!job.native) return { kind: "external" };
  const [visit, estRows, optRows, lineRows, invRows, priorRows, taxBps, companyName, customerDisplayName] = await Promise.all([
    findActiveVisit(org, rid),
    rows(estimatesSql(org, rid, me)),
    rows(optionsSql(org, rid)),
    rows(linesSql(org, rid)),
    rows(jobInvoiceSql(org, rid)),
    rows(priorPaidSql(org, rid)),
    getDefaultTaxBps(org),
    companyNameOf(org),
    customerNameOf(org, job.customerId),
  ]);
  const isLead = visit?.leadTechnicianId === me;
  const reason = createBlockedReason({ isLead, status: job.status, hasCustomer: job.customerId !== null });
  const estimates = assembleEstimates(estRows, optRows, lineRows, now);
  const inv = invRows[0];
  const jobInvoice: TechJobInvoiceRef | null = inv
    ? { id: String(inv.id), state: inv.state === "open" ? "open" : "draft", hasPayment: inv.has_payment === true }
    : null;
  return {
    kind: "ok",
    view: {
      companyName, customerDisplayName, isLead, canCreate: reason === null, createBlockedReason: reason, taxBps,
      requestStatus: job.status, hasOtherSold: estimates.some((e) => e.status === "sold"), jobInvoice,
      priorInvoicePaid: priorRows[0]?.paid === true, estimates,
    },
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/tech/estimate-display.test.ts src/lib/tech/estimate-queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/estimate-view.ts src/lib/tech/estimate-display.ts src/lib/tech/estimate-display.test.ts src/lib/tech/estimate-queries.ts src/lib/tech/estimate-queries.test.ts && npx vitest run
git add src/lib/tech/estimate-view.ts src/lib/tech/estimate-display.ts src/lib/tech/estimate-display.test.ts src/lib/tech/estimate-queries.ts src/lib/tech/estimate-queries.test.ts
git commit -m "$(cat <<'EOF'
feat(m3c): technician estimates read model (billing tri-state, labels, create gate)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 6: Routes — preamble options, equipment preamble, estimates GET/POST, sell, bill, decline, equipment GET/POST

**Files:**
- Modify: `src/lib/tech/invoice-route-guards.ts` (+ `invoice-route-guards.test.ts`)
- Create: `src/app/api/tech/jobs/[id]/estimates/route.ts` (+ `route.test.ts`), `src/app/api/tech/jobs/[id]/estimates/[eid]/sell/route.ts` (+ `route.test.ts`), `src/app/api/tech/jobs/[id]/estimates/[eid]/bill/route.ts` (+ `route.test.ts`), `src/app/api/tech/jobs/[id]/estimates/[eid]/decline/route.ts` (+ `route.test.ts`), `src/app/api/tech/jobs/[id]/equipment/route.ts` (+ `route.test.ts`)

**Interfaces:**
- Consumes: Task 1 `SELL_STATUSES`, `BILL_STATUSES`, `statusGate`; Task 2 `billSoldEstimate`; Task 3 `createFieldEstimate`, `sellFieldEstimate`, `declineFieldEstimate`, `estimateReasonResult`, `hasDuplicateNames`, `signatureNameOk`, `MAX_*`; Task 4 `addFieldEquipment`, `equipmentReasonResult`, `parseEquipmentInput`, `todayInZone`, `EQUIPMENT_ERROR_COPY`, `getTechEquipmentView`; Task 5 `getTechEstimatesView`; existing `readWriteBody`, `readKey`, `okResult`, `auditWrite` (`@/lib/tech/invoice-write-route`), `withIdempotency`, `canonicalHash`, `toResponse` (`@/lib/http/idempotency`), `findTechAssignments`.
- Produces:
  - `invoice-route-guards.ts`: `PreambleOptions { bucket; statuses; beforeCopy; closedCopy }`, `INVOICE_PREAMBLE`, `ESTIMATE_PREAMBLE`, `BILL_PREAMBLE`, `EQUIPMENT_PREAMBLE`, `statusRefusal(status, opts): { code: "NOT_ON_SITE" | "JOB_CLOSED"; message: string } | null`, `techWritePreamble(request, id, opts = INVOICE_PREAMBLE)` (invoice callers unchanged), `techEquipmentPreamble(request, id)`.
  - HTTP contracts (spec §6): `GET /api/tech/jobs/[id]/estimates` → `TechEstimatesView`; `POST …/estimates` 201/200 `{ estimateId, created }`; `POST …/estimates/[eid]/sell` 200 `{ estimateId, status: "sold", created }`; `POST …/estimates/[eid]/bill` 200 `{ invoiceId, added, hasMaterials }`; `POST …/estimates/[eid]/decline` 200 `{ estimateId, status: "dismissed", created }`; `GET /api/tech/jobs/[id]/equipment` → `TechEquipmentView`; `POST …/equipment` 201/200 `{ equipmentId, created }`. Idempotency route = the literal path; intent bodies are the parsed bodies.

- [ ] **Step 1: Failing guard tests.** In `src/lib/tech/invoice-route-guards.test.ts`: add `findTechAssignments: vi.fn()` to `h` and to the ownership mock; import `ESTIMATE_PREAMBLE, BILL_PREAMBLE, statusRefusal, techEquipmentPreamble`; change the `NOT_ON_SITE` table to `["scheduled", "assigned", "en_route", "submitted"]` and add:

```ts
  it("409 JOB_CLOSED for a cancelled request (invoice copy unchanged)", async () => {
    h.findReadableJob.mockResolvedValue({ ...JOB, status: "cancelled" });
    await expectFail(409, "JOB_CLOSED", "Arrive at the job before invoicing.");
  });

  it("estimate options: own bucket, sell statuses, split copy", async () => {
    h.findReadableJob.mockResolvedValue({ ...JOB, status: "completed" });
    const r = await techWritePreamble(req, REQ, ESTIMATE_PREAMBLE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await r.response.json()).toEqual({ success: false, error: { code: "JOB_CLOSED", message: "This job is closed." } });
    expect(h.slidingWindow).toHaveBeenCalledWith(`tech:estimate:write:${ME}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    h.findReadableJob.mockResolvedValue({ ...JOB, status: "en_route" });
    const r2 = await techWritePreamble(req, REQ, ESTIMATE_PREAMBLE);
    if (!r2.ok) expect(await r2.response.json()).toEqual({ success: false, error: { code: "NOT_ON_SITE", message: "Arrive at the job first." } });
    h.findReadableJob.mockResolvedValue({ ...JOB, status: "completed" });
    expect((await techWritePreamble(req, REQ, BILL_PREAMBLE)).ok).toBe(true);
  });

  it("statusRefusal", () => {
    expect(statusRefusal("arrived", ESTIMATE_PREAMBLE)).toBeNull();
    expect(statusRefusal("pending", ESTIMATE_PREAMBLE)).toEqual({ code: "NOT_ON_SITE", message: "Arrive at the job first." });
    expect(statusRefusal("cancelled", BILL_PREAMBLE)).toEqual({ code: "JOB_CLOSED", message: "This job is closed." });
  });
});

describe("techEquipmentPreamble (spec §5.6)", () => {
  const row = (status: string) => ({ status, isLead: false, assignmentId: "x", appointmentId: "a", appointmentNumber: 1, cancelledAt: null, enRouteAt: null, arrivedAt: null, startedAt: null, completedAt: null, technicianId: ME });
  beforeEach(() => h.findTechAssignments.mockResolvedValue([row("arrived")]));

  it("a helper on the job passes; the lead check is not applied", async () => {
    h.findActiveVisit.mockResolvedValue({ appointmentId: "a", leadTechnicianId: OTHER });
    expect((await techEquipmentPreamble(req, REQ)).ok).toBe(true);
    expect(h.slidingWindow).toHaveBeenCalledWith(`tech:equipment:write:${ME}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
  });
  it("403 NOT_ASSIGNED with only cancelled rows", async () => {
    h.findTechAssignments.mockResolvedValue([row("cancelled")]);
    const r = await techEquipmentPreamble(req, REQ);
    if (!r.ok) expect(await r.response.json()).toEqual({ success: false, error: { code: "NOT_ASSIGNED", message: "Only a technician working this job can do that." } });
    expect(r.ok).toBe(false);
  });
  it("a completed request still takes equipment; a cancelled one does not", async () => {
    h.findReadableJob.mockResolvedValue({ ...JOB, status: "completed" });
    expect((await techEquipmentPreamble(req, REQ)).ok).toBe(true);
    h.findReadableJob.mockResolvedValue({ ...JOB, status: "cancelled" });
    expect((await techEquipmentPreamble(req, REQ)).ok).toBe(false);
  });
  it("409 MANAGED_EXTERNALLY on a FieldPulse job", async () => {
    h.findReadableJob.mockResolvedValue({ ...JOB, native: false });
    const r = await techEquipmentPreamble(req, REQ);
    if (!r.ok) expect(r.response.status).toBe(409);
  });
```

  (The closing `});` of the existing `describe("techWritePreamble")` moves to after `statusRefusal`, as shown.)

  Run: `npx vitest run src/lib/tech/invoice-route-guards.test.ts` → FAIL.

- [ ] **Step 2: Implement the guards.** Replace the top half of `src/lib/tech/invoice-route-guards.ts` (everything above `resolveTarget`, which stays as is) with:

```ts
/**
 * Shared gates for the tech WRITE routes — invoice (M3b §6.1), estimate and
 * bill (M3c §6), equipment (M3c §5.6) — and the invoice target check every
 * invoice write runs inside its idempotency `run` (M3b §6.2). Each gate
 * short-circuits before the next one is evaluated.
 */
import type { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getTechSession } from "@/lib/auth/tech-session";
import type { TechSessionPayload } from "@/lib/auth/tech-config";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse } from "@/lib/api-response";
import { findActiveVisit, findReadableJob, findTechAssignments } from "@/lib/tech/ownership";
import { P_LIVE, P_NATIVE } from "@/lib/admin/invoice-field-writes";
import { BILL_STATUSES, SELL_STATUSES, statusGate } from "@/lib/tech/field-sale-statuses";

export type ReadableJob = NonNullable<Awaited<ReturnType<typeof findReadableJob>>>;

export type PreambleResult =
  | { ok: true; session: TechSessionPayload; job: ReadableJob; requestId: string }
  | { ok: false; response: NextResponse };

export interface PreambleOptions {
  /** Rate-limit bucket: `tech:<bucket>:write:<user>`. */
  readonly bucket: string;
  /** Request statuses the write accepts. */
  readonly statuses: readonly string[];
  /** 409 NOT_ON_SITE copy (pending / assigned / scheduled / en_route). */
  readonly beforeCopy: string;
  /** 409 JOB_CLOSED copy (completed / cancelled not in `statuses`). */
  readonly closedCopy: string;
}

export const INVOICE_PREAMBLE: PreambleOptions = {
  bucket: "invoice", statuses: BILL_STATUSES,
  beforeCopy: "Arrive at the job before invoicing.", closedCopy: "Arrive at the job before invoicing.",
};
export const ESTIMATE_PREAMBLE: PreambleOptions = {
  bucket: "estimate", statuses: SELL_STATUSES, beforeCopy: "Arrive at the job first.", closedCopy: "This job is closed.",
};
export const BILL_PREAMBLE: PreambleOptions = { ...ESTIMATE_PREAMBLE, statuses: BILL_STATUSES };
export const EQUIPMENT_PREAMBLE: PreambleOptions = { ...ESTIMATE_PREAMBLE, bucket: "equipment", statuses: BILL_STATUSES };

export function statusRefusal(
  status: string, opts: PreambleOptions,
): { code: "NOT_ON_SITE" | "JOB_CLOSED"; message: string } | null {
  const gate = statusGate(status, opts.statuses);
  if (gate === "ok") return null;
  return gate === "job_closed" ? { code: "JOB_CLOSED", message: opts.closedCopy } : { code: "NOT_ON_SITE", message: opts.beforeCopy };
}

const fail = (message: string, code: string, status: number) =>
  ({ ok: false as const, response: errorResponse(message, code, status) });

/** session → same-origin → uuid → rate limit. */
async function frontGates(
  request: NextRequest, id: string, bucket: string,
): Promise<{ ok: true; session: TechSessionPayload } | { ok: false; response: NextResponse }> {
  const session = await getTechSession();
  if (!session) return fail("Unauthorized", "UNAUTHORIZED", 401);
  if (!isSameOriginRequest(request)) return fail("Forbidden", "FORBIDDEN", 403);
  if (!isUuid(id)) return fail("Invalid request ID format", "INVALID_ID", 400);
  const rate = slidingWindow(`tech:${bucket}:write:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
  if (!rate.allowed) return fail("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
  return { ok: true, session };
}

/** Lead-only writes: front gates → readable job 404 → native 409 → active lead 403 → status 409. */
export async function techWritePreamble(
  request: NextRequest, id: string, opts: PreambleOptions = INVOICE_PREAMBLE,
): Promise<PreambleResult> {
  const front = await frontGates(request, id, opts.bucket);
  if (!front.ok) return front;
  const { session } = front;
  const job = await findReadableJob(session.organizationId, session.userId, id);
  if (!job) return fail("This job isn't yours.", "NOT_FOUND", 404);
  if (!job.native) return fail("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
  const visit = await findActiveVisit(session.organizationId, id);
  if (!visit || visit.leadTechnicianId !== session.userId) return fail("Only the lead technician can do that.", "NOT_LEAD", 403);
  const refusal = statusRefusal(job.status, opts);
  if (refusal) return fail(refusal.message, refusal.code, 409);
  return { ok: true, session, job, requestId: id };
}

/** Equipment writes (any technician working the job): front gates → readable job → native → a non-cancelled assignment → status. */
export async function techEquipmentPreamble(request: NextRequest, id: string): Promise<PreambleResult> {
  const front = await frontGates(request, id, EQUIPMENT_PREAMBLE.bucket);
  if (!front.ok) return front;
  const { session } = front;
  const job = await findReadableJob(session.organizationId, session.userId, id);
  if (!job) return fail("This job isn't yours.", "NOT_FOUND", 404);
  if (!job.native) return fail("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
  const mine = await findTechAssignments(session.organizationId, session.userId, id);
  if (!mine.some((r) => r.status !== "cancelled")) {
    return fail("Only a technician working this job can do that.", "NOT_ASSIGNED", 403);
  }
  const refusal = statusRefusal(job.status, EQUIPMENT_PREAMBLE);
  if (refusal) return fail(refusal.message, refusal.code, 409);
  return { ok: true, session, job, requestId: id };
}
```

  Run: `npx vitest run src/lib/tech/invoice-route-guards.test.ts src/app/api/tech/jobs/\[id\]/invoice` → PASS (invoice routes call `techWritePreamble(request, id)` unchanged).

- [ ] **Step 3: Failing route tests** (five files, each self-contained; the harness mirrors `invoice/finalize/route.test.ts`):

`src/app/api/tech/jobs/[id]/estimates/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  getTechSession: vi.fn(),
  slidingWindow: vi.fn(),
  getView: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  create: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/tech/invoice-route-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/invoice-route-guards")>()),
  techWritePreamble: h.preamble,
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/tech/estimate-queries", () => ({ getTechEstimatesView: h.getView }));
vi.mock("@/lib/tech/estimate-writes", () => ({ createFieldEstimate: h.create }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { GET, POST } from "./route";
import { ESTIMATE_PREAMBLE } from "@/lib/tech/invoice-route-guards";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const ITEM = "33333333-3333-4333-8333-333333333333";
const EST = "44444444-4444-4444-8444-444444444444";
const PATH = `/api/tech/jobs/${RID}/estimates`;
const ctx = { params: Promise.resolve({ id: RID }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } };
const post = (body: unknown, key: string | null = "k-1", raw?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }), ctx);
};
const get = () => GET(new NextRequest(`http://localhost${PATH}`), ctx);
const BODY = { options: [{ name: "Good", lines: [{ pricebookItemId: ITEM, quantity: 2 }] }, { name: "Better", lines: [{ pricebookItemId: ITEM, quantity: 3 }] }] };

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.getTechSession.mockResolvedValue({ userId: U, organizationId: ORG });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current ? { ...h.replay.current, replayed: true } : { ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false });
  h.create.mockResolvedValue({ ok: true, estimateId: EST, created: true });
  h.getView.mockResolvedValue({ kind: "ok", view: { estimates: [] } });
});

describe("GET /api/tech/jobs/[id]/estimates", () => {
  it("401 without a session; 400 on a bad id; 429 over the read limit", async () => {
    h.getTechSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
    h.slidingWindow.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 1 });
    expect((await get()).status).toBe(429);
  });
  it("404 not readable; 409 MANAGED_EXTERNALLY on a FieldPulse job; 200 the view", async () => {
    h.getView.mockResolvedValueOnce({ kind: "not_found" });
    expect((await get()).status).toBe(404);
    h.getView.mockResolvedValueOnce({ kind: "external" });
    const ext = await get();
    expect(ext.status).toBe(409);
    expect((await json(ext)).error?.code).toBe("MANAGED_EXTERNALLY");
    const ok = await get();
    expect(ok.status).toBe(200);
    expect(h.getView).toHaveBeenCalledWith(ORG, U, RID);
  });
});

describe("POST /api/tech/jobs/[id]/estimates", () => {
  it("uses the estimate preamble and returns its refusal untouched", async () => {
    h.preamble.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "NOT_ON_SITE", message: "Arrive at the job first." } }, { status: 409 }) });
    expect((await post(BODY)).status).toBe(409);
    expect(h.preamble).toHaveBeenCalledWith(expect.anything(), RID, ESTIMATE_PREAMBLE);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("400 INVALID_INPUT for bad bodies: no options, 4 options, empty option, qty 0 / 1000, long name, extra keys", async () => {
    const line = { pricebookItemId: ITEM, quantity: 1 };
    for (const body of [
      { options: [] },
      { options: [1, 2, 3, 4].map((i) => ({ name: `O${i}`, lines: [line] })) },
      { options: [{ name: "Good", lines: [] }] },
      { options: [{ name: "Good", lines: [{ ...line, quantity: 0 }] }] },
      { options: [{ name: "Good", lines: [{ ...line, quantity: 1000 }] }] },
      { options: [{ name: "x".repeat(41), lines: [line] }] },
      { options: [{ name: "Good", lines: [line], extra: 1 }] },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe("INVALID_INPUT");
    }
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("400 'Two options have the same name.' case-insensitively", async () => {
    const res = await post({ options: [{ name: "Good", lines: BODY.options[0]!.lines }, { name: " good", lines: BODY.options[0]!.lines }] });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toEqual({ code: "INVALID_INPUT", message: "Two options have the same name." });
  });
  it("400 IDEMPOTENCY_KEY_REQUIRED without a key", async () => {
    expect((await json(await post(BODY, null))).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
  it("201 on create with the derived id and an estimate_created audit; 200 on a re-run without one", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ success: true, data: { estimateId: EST, created: true } });
    expect(h.create).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, { estimateId: "derived-estimate" }, BODY);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "estimate_created", entity: "estimate", entityId: EST, details: `estimateId:${EST} options:2` }));
    h.logAudit.mockClear();
    h.create.mockResolvedValueOnce({ ok: true, estimateId: EST, created: false });
    expect((await post(BODY)).status).toBe(200);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("maps writer refusals", async () => {
    for (const [reason, status, code] of [["no_customer", 409, "NO_CUSTOMER"], ["not_lead", 403, "NOT_LEAD"], ["job_closed", 409, "JOB_CLOSED"], ["item_inactive", 400, "INVALID_INPUT"], ["too_large", 400, "INVALID_INPUT"], ["stale", 409, "STALE"]] as const) {
      h.create.mockResolvedValueOnce({ ok: false, reason });
      const res = await post(BODY);
      expect(res.status).toBe(status);
      expect((await json(res)).error?.code).toBe(code);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("a replay returns the stored status and writes no audit", async () => {
    h.replay.current = { status: 201, envelope: { success: true, data: { estimateId: EST, created: true } } };
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect((await json(res)).data).toEqual({ estimateId: EST, created: true, replayed: true });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
```

`src/app/api/tech/jobs/[id]/estimates/[eid]/sell/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  sell: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tech/invoice-route-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/invoice-route-guards")>()),
  techWritePreamble: h.preamble,
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/tech/estimate-writes", () => ({ sellFieldEstimate: h.sell }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { POST } from "./route";
import { ESTIMATE_PREAMBLE } from "@/lib/tech/invoice-route-guards";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const EST = "44444444-4444-4444-8444-444444444444";
const OPT = "55555555-5555-4555-8555-555555555555";
const PATH = `/api/tech/jobs/${RID}/estimates/${EST}/sell`;
const ctx = { params: Promise.resolve({ id: RID, eid: EST }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const post = (body: unknown, key: string | null = "k-1") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: JSON.stringify(body) }), ctx);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current ? { ...h.replay.current, replayed: true } : { ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false });
  h.sell.mockResolvedValue({ ok: true, estimateId: EST, created: true });
});

describe("POST /api/tech/jobs/[id]/estimates/[eid]/sell", () => {
  it("uses the estimate preamble and returns its refusal untouched", async () => {
    h.preamble.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "NOT_LEAD", message: "x" } }, { status: 403 }) });
    expect((await post({ optionId: OPT, signatureName: "Pat Probe" })).status).toBe(403);
    expect(h.preamble).toHaveBeenCalledWith(expect.anything(), RID, ESTIMATE_PREAMBLE);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("404 for a non-uuid estimate id", async () => {
    const res = await POST(new NextRequest("http://localhost/x", { method: "POST", headers: { "idempotency-key": "k" }, body: "{}" }),
      { params: Promise.resolve({ id: RID, eid: "nope" }) });
    expect([res.status, (await json(res)).error?.code]).toEqual([404, "NOT_FOUND"]);
  });
  it("400 INVALID_INPUT for a bad body; 400 'Type your full name to approve.' for a 1-letter name or the office marker", async () => {
    for (const body of [{ optionId: "nope", signatureName: "Pat" }, { optionId: OPT }, { optionId: OPT, signatureName: "Pat", x: 1 }]) {
      expect((await json(await post(body))).error?.code).toBe("INVALID_INPUT");
    }
    for (const signatureName of ["P", "  ", "(admin)"]) {
      expect((await json(await post({ optionId: OPT, signatureName }))).error).toEqual({ code: "INVALID_INPUT", message: "Type your full name to approve." });
    }
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("400 IDEMPOTENCY_KEY_REQUIRED without a key", async () => {
    expect((await json(await post({ optionId: OPT, signatureName: "Pat" }, null))).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
  it("200 { estimateId, status: 'sold', created } and an estimate_sold audit on a fresh sale", async () => {
    const res = await post({ optionId: OPT, signatureName: " Pat Probe " });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ estimateId: EST, status: "sold", created: true });
    expect(h.sell).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, { estimateId: EST, optionId: OPT, signatureName: " Pat Probe " });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "estimate_sold", entity: "estimate", entityId: EST, details: `estimateId:${EST} optionId:${OPT} via:field` }));
  });
  it("a writer replay (created:false) is 200 without an audit; a key replay writes none either", async () => {
    h.sell.mockResolvedValueOnce({ ok: true, estimateId: EST, created: false });
    expect((await post({ optionId: OPT, signatureName: "Pat" })).status).toBe(200);
    h.replay.current = { status: 200, envelope: { success: true, data: { estimateId: EST, status: "sold", created: true } } };
    expect((await json(await post({ optionId: OPT, signatureName: "Pat" }))).data).toEqual({ estimateId: EST, status: "sold", created: true, replayed: true });
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("maps refusals", async () => {
    for (const [reason, status, code] of [["already_decided", 409, "ALREADY_DECIDED"], ["estimate_expired", 409, "ESTIMATE_EXPIRED"], ["invalid_option", 400, "INVALID_OPTION"], ["estimate_not_found", 404, "NOT_FOUND"], ["not_lead", 403, "NOT_LEAD"], ["job_closed", 409, "JOB_CLOSED"], ["stale", 409, "STALE"]] as const) {
      h.sell.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({ optionId: OPT, signatureName: "Pat" });
      expect([res.status, (await json(res)).error?.code]).toEqual([status, code]);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
```

`src/app/api/tech/jobs/[id]/estimates/[eid]/bill/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  bill: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tech/invoice-route-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/invoice-route-guards")>()),
  techWritePreamble: h.preamble,
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/admin/invoice-field-writes", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin/invoice-field-writes")>()),
  billSoldEstimate: h.bill,
}));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { POST } from "./route";
import { BILL_PREAMBLE } from "@/lib/tech/invoice-route-guards";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const EST = "44444444-4444-4444-8444-444444444444";
const PATH = `/api/tech/jobs/${RID}/estimates/${EST}/bill`;
const ctx = { params: Promise.resolve({ id: RID, eid: EST }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } };
const post = (body: unknown, key: string | null = "k-1", raw?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }), ctx);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current ? { ...h.replay.current, replayed: true } : { ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false });
  h.bill.mockResolvedValue({ ok: true, invoiceId: "inv-1", added: 2, hasMaterials: true });
});

describe("POST /api/tech/jobs/[id]/estimates/[eid]/bill", () => {
  it("uses the invoicing statuses with the estimate copy; a refusal is returned untouched", async () => {
    h.preamble.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "JOB_CLOSED", message: "x" } }, { status: 409 }) });
    expect((await post({})).status).toBe(409);
    expect(h.preamble).toHaveBeenCalledWith(expect.anything(), RID, BILL_PREAMBLE);
    expect(h.bill).not.toHaveBeenCalled();
  });
  it("an absent body reads as {}; extra keys are 400; no key is 400", async () => {
    expect((await post(null, "k", "")).status).toBe(200);
    expect((await json(await post({ x: 1 }))).error?.code).toBe("INVALID_INPUT");
    expect((await json(await post({}, null))).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
  it("200 { invoiceId, added, hasMaterials } with the derived invoice id; estimate_billed audit", async () => {
    const res = await post({});
    expect((await json(res)).data).toEqual({ invoiceId: "inv-1", added: 2, hasMaterials: true });
    expect(h.bill).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, EST, { invoiceId: "derived-invoice" });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "estimate_billed", entity: "estimate", entityId: EST, details: `estimateId:${EST} invoiceId:inv-1 added:2` }));
  });
  it("a key replay returns the stored 200 without an audit", async () => {
    h.replay.current = { status: 200, envelope: { success: true, data: { invoiceId: "inv-1", added: 2, hasMaterials: false } } };
    expect((await post({})).status).toBe(200);
    expect(h.bill).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("ALREADY_BILLED carries details.invoiceId; the other refusals map with their copy", async () => {
    h.bill.mockResolvedValueOnce({ ok: false, reason: "already_billed", invoiceId: "inv-9" });
    expect((await json(await post({}))).error).toEqual({ code: "ALREADY_BILLED", message: "This estimate is already on an invoice.", details: { invoiceId: "inv-9" } });
    h.bill.mockResolvedValueOnce({ ok: false, reason: "invoice_locked" });
    expect((await json(await post({}))).error).toEqual({ code: "INVOICE_LOCKED", message: "The job's invoice is already finalized. Ask the office to bill this estimate." });
    h.bill.mockResolvedValueOnce({ ok: false, reason: "invoice_changed" });
    expect((await json(await post({}))).error).toEqual({ code: "INVOICE_CHANGED", message: "The job's invoice changed. Try again." });
    for (const [reason, status, code] of [["no_lines", 409, "NO_LINES"], ["estimate_not_sold", 409, "ESTIMATE_NOT_SOLD"], ["stale", 409, "STALE"], ["too_large", 400, "INVALID_INPUT"], ["managed_externally", 409, "MANAGED_EXTERNALLY"], ["estimate_not_found", 404, "NOT_FOUND"], ["not_lead", 403, "NOT_LEAD"]] as const) {
      h.bill.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({});
      expect([res.status, (await json(res)).error?.code]).toEqual([status, code]);
    }
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
```

`src/app/api/tech/jobs/[id]/estimates/[eid]/decline/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  withIdempotency: vi.fn(),
  decline: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tech/invoice-route-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/invoice-route-guards")>()),
  techWritePreamble: h.preamble,
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/tech/estimate-writes", () => ({ declineFieldEstimate: h.decline }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { POST } from "./route";
import { ESTIMATE_PREAMBLE } from "@/lib/tech/invoice-route-guards";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const EST = "44444444-4444-4444-8444-444444444444";
const PATH = `/api/tech/jobs/${RID}/estimates/${EST}/decline`;
const ctx = { params: Promise.resolve({ id: RID, eid: EST }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const post = (body: unknown, key: string | null = "k-1") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: JSON.stringify(body) }), ctx);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    ({ ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false }));
});

describe("POST /api/tech/jobs/[id]/estimates/[eid]/decline", () => {
  it("uses the estimate preamble", async () => {
    h.decline.mockResolvedValueOnce({ ok: true, estimateId: EST, created: true });
    await post({});
    expect(h.preamble).toHaveBeenCalledWith(expect.anything(), RID, ESTIMATE_PREAMBLE);
    expect(h.decline).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, EST);
  });
  it("200 { estimateId, status: 'dismissed', created } with an estimate_declined audit only when it changed", async () => {
    h.decline.mockResolvedValueOnce({ ok: true, estimateId: EST, created: true });
    expect((await json(await post({}))).data).toEqual({ estimateId: EST, status: "dismissed", created: true });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "estimate_declined", details: `estimateId:${EST}` }));
    h.logAudit.mockClear();
    h.decline.mockResolvedValueOnce({ ok: true, estimateId: EST, created: false });
    expect((await post({})).status).toBe(200);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("ALREADY_DECIDED / NOT_FOUND / NOT_LEAD; extra keys 400", async () => {
    for (const [reason, status, code] of [["already_decided", 409, "ALREADY_DECIDED"], ["estimate_not_found", 404, "NOT_FOUND"], ["not_lead", 403, "NOT_LEAD"]] as const) {
      h.decline.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({});
      expect([res.status, (await json(res)).error?.code]).toEqual([status, code]);
    }
    expect((await post({ x: 1 })).status).toBe(400);
  });
});
```

`src/app/api/tech/jobs/[id]/equipment/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  getTechSession: vi.fn(),
  slidingWindow: vi.fn(),
  getView: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  add: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/tech/invoice-route-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/invoice-route-guards")>()),
  techEquipmentPreamble: h.preamble,
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/tech/equipment-queries", () => ({ getTechEquipmentView: h.getView }));
vi.mock("@/lib/tech/equipment-writes", () => ({ addFieldEquipment: h.add }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { GET, POST } from "./route";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const OLD = "66666666-6666-4666-8666-666666666666";
const PATH = `/api/tech/jobs/${RID}/equipment`;
const ctx = { params: Promise.resolve({ id: RID }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const post = (body: unknown, key: string | null = "k-1") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: JSON.stringify(body) }), ctx);
};
const get = () => GET(new NextRequest(`http://localhost${PATH}`), ctx);
const parsed = (over: Record<string, unknown> = {}) => ({
  equipmentType: "ac", make: null, model: null, serialNumber: null, locationInHome: null, notes: null, installDate: null, replacesId: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.getTechSession.mockResolvedValue({ userId: U, organizationId: ORG });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current ? { ...h.replay.current, replayed: true } : { ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false });
});

describe("GET /api/tech/jobs/[id]/equipment", () => {
  it("401 / 400 / 429 / 404 / 409 / 200", async () => {
    h.getTechSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
    h.slidingWindow.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 1 });
    expect((await get()).status).toBe(429);
    h.getView.mockResolvedValueOnce({ kind: "not_found" });
    expect((await get()).status).toBe(404);
    h.getView.mockResolvedValueOnce({ kind: "external" });
    expect((await get()).status).toBe(409);
    h.getView.mockResolvedValueOnce({ kind: "ok", view: { units: [], canWrite: true } });
    expect((await json(await get())).data).toEqual({ units: [], canWrite: true });
    expect(h.getView).toHaveBeenLastCalledWith(ORG, U, RID);
  });
});

describe("POST /api/tech/jobs/[id]/equipment", () => {
  it("returns the equipment preamble's refusal untouched", async () => {
    h.preamble.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "NOT_ASSIGNED", message: "x" } }, { status: 403 }) });
    expect((await post({ equipmentType: "ac" })).status).toBe(403);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("semantic validation copy (Other needs a description, future date, unknown type, bad replaces id)", async () => {
    expect((await json(await post({ equipmentType: "other" }))).error).toEqual({ code: "INVALID_INPUT", message: "Describe the equipment." });
    expect((await json(await post({ equipmentType: "ac", installDate: "2999-01-01" }))).error).toEqual({ code: "INVALID_INPUT", message: "The install date can't be in the future." });
    expect((await json(await post({ equipmentType: "jacuzzi" }))).error).toEqual({ code: "INVALID_INPUT", message: "Choose the type of equipment." });
    expect((await json(await post({ equipmentType: "ac", replacesId: "nope" }))).error?.code).toBe("INVALID_INPUT");
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("201 add with equipment_added; 201 replace with equipment_replaced; 200 replay without an audit", async () => {
    h.add.mockResolvedValueOnce({ ok: true, equipmentId: "eq-1", created: true, replaced: false });
    const a = await post({ equipmentType: "ac", make: "Carrier" });
    expect(a.status).toBe(201);
    expect((await json(a)).data).toEqual({ equipmentId: "eq-1", created: true });
    expect(h.add).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, { equipmentId: "derived-equipment" }, parsed({ make: "Carrier" }));
    expect(h.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "equipment_added", entity: "equipment", details: "equipmentId:eq-1" }));
    h.add.mockResolvedValueOnce({ ok: true, equipmentId: "eq-2", created: true, replaced: true });
    expect((await post({ equipmentType: "ac", replacesId: OLD })).status).toBe(201);
    expect(h.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "equipment_replaced", details: `equipmentId:eq-2 replacesId:${OLD}` }));
    h.logAudit.mockClear();
    h.add.mockResolvedValueOnce({ ok: true, equipmentId: "eq-2", created: false, replaced: true });
    expect((await post({ equipmentType: "ac", replacesId: OLD })).status).toBe(200);
    h.replay.current = { status: 201, envelope: { success: true, data: { equipmentId: "eq-2", created: true } } };
    expect((await post({ equipmentType: "ac", replacesId: OLD })).status).toBe(201);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("EQUIPMENT_RETIRED / MANAGED_EXTERNALLY / NOT_FOUND / NO_CUSTOMER / STALE", async () => {
    for (const [reason, status, code] of [["equipment_retired", 409, "EQUIPMENT_RETIRED"], ["managed_externally", 409, "MANAGED_EXTERNALLY"], ["not_found", 404, "NOT_FOUND"], ["no_customer", 409, "NO_CUSTOMER"], ["stale", 409, "STALE"]] as const) {
      h.add.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({ equipmentType: "ac", replacesId: OLD });
      expect([res.status, (await json(res)).error?.code]).toEqual([status, code]);
    }
  });
});
```

  Run: `npx vitest run "src/app/api/tech/jobs/[id]/estimates" "src/app/api/tech/jobs/[id]/equipment"` → FAIL (routes missing).

- [ ] **Step 4: Implement the routes.**

`src/app/api/tech/jobs/[id]/estimates/route.ts`:

```ts
/**
 * GET /api/tech/jobs/[id]/estimates — the job's native estimates (M3c spec §6):
 * tech session → uuid → read rate limit → view (404 not readable, 409 on a
 * FieldPulse/HCP job). Never a cost field or a typed signature name.
 *
 * POST — build a field estimate (spec §5.1): estimate preamble → body → unique
 * option names → key → idempotent run → 201 created / 200 re-run; audit
 * `estimate_created` on a fresh create only.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger, errorCode } from "@/lib/logger";
import { ESTIMATE_PREAMBLE, techWritePreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { getTechEstimatesView } from "@/lib/tech/estimate-queries";
import { createFieldEstimate } from "@/lib/tech/estimate-writes";
import { estimateReasonResult } from "@/lib/tech/estimate-errors";
import { hasDuplicateNames, MAX_LINES_PER_OPTION, MAX_OPTION_NAME, MAX_OPTIONS, MAX_QUANTITY } from "@/lib/tech/estimate-input";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:estimate:read:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getTechEstimatesView(session.organizationId, session.userId, id);
    if (r.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    if (r.kind === "external") return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load tech estimates");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}

const lineSchema = z.object({ pricebookItemId: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_QUANTITY) }).strict();
const optionSchema = z.object({
  name: z.string().trim().min(1).max(MAX_OPTION_NAME),
  lines: z.array(lineSchema).min(1).max(MAX_LINES_PER_OPTION),
}).strict();
const createSchema = z.object({ options: z.array(optionSchema).min(1).max(MAX_OPTIONS) }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pre = await techWritePreamble(request, id, ESTIMATE_PREAMBLE);
    if (!pre.ok) return pre.response;
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, createSchema);
    if (!body.ok) return body.response;
    if (hasDuplicateNames(body.data.options.map((o) => o.name))) {
      return errorResponse("Two options have the same name.", "INVALID_INPUT", 400);
    }
    const key = readKey(request);
    if (!key.ok) return key.response;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async (ids) => {
        const r = await createFieldEstimate({ organizationId, requestId: pre.requestId, techUserId: userId }, { estimateId: ids.id("estimate") }, body.data);
        if (!r.ok) return estimateReasonResult(r.reason);
        return okResult(r.created ? 201 : 200, { estimateId: r.estimateId, created: r.created });
      },
    );
    if (result.envelope.success && !result.replayed && result.envelope.data.created === true) {
      const estimateId = String(result.envelope.data.estimateId);
      await auditWrite({
        organizationId, userId, action: "estimate_created", entity: "estimate", entityId: estimateId,
        details: `estimateId:${estimateId} options:${body.data.options.length}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to create field estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/tech/jobs/[id]/estimates/[eid]/sell/route.ts`:

```ts
/**
 * POST /api/tech/jobs/[id]/estimates/[eid]/sell — the customer picked an option
 * and typed their name on the lead's phone (M3c spec §5.2). Estimate preamble →
 * estimate id → body (name ≥ 2 characters, never "(admin)") → key → idempotent
 * run → 200; audit `estimate_sold` on a fresh sale. Sell never bills.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { logger, errorCode } from "@/lib/logger";
import { ESTIMATE_PREAMBLE, techWritePreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { sellFieldEstimate } from "@/lib/tech/estimate-writes";
import { estimateReasonResult } from "@/lib/tech/estimate-errors";
import { MAX_SIGNATURE, signatureNameOk } from "@/lib/tech/estimate-input";

export const dynamic = "force-dynamic";

const sellSchema = z.object({ optionId: z.string().uuid(), signatureName: z.string().max(MAX_SIGNATURE * 2) }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; eid: string }> }) {
  try {
    const { id, eid } = await params;
    const pre = await techWritePreamble(request, id, ESTIMATE_PREAMBLE);
    if (!pre.ok) return pre.response;
    if (!isUuid(eid)) return errorResponse("That estimate isn't on this job.", "NOT_FOUND", 404);
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, sellSchema);
    if (!body.ok) return body.response;
    if (!signatureNameOk(body.data.signatureName)) return errorResponse("Type your full name to approve.", "INVALID_INPUT", 400);
    const key = readKey(request);
    if (!key.ok) return key.response;
    const { optionId, signatureName } = body.data;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async () => {
        const r = await sellFieldEstimate({ organizationId, requestId: pre.requestId, techUserId: userId }, { estimateId: eid, optionId, signatureName });
        if (!r.ok) return estimateReasonResult(r.reason);
        return okResult(200, { estimateId: r.estimateId, status: "sold", created: r.created });
      },
    );
    if (result.envelope.success && !result.replayed && result.envelope.data.created === true) {
      await auditWrite({
        organizationId, userId, action: "estimate_sold", entity: "estimate", entityId: eid,
        details: `estimateId:${eid} optionId:${optionId} via:field`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to sell field estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/tech/jobs/[id]/estimates/[eid]/bill/route.ts`:

```ts
/**
 * POST /api/tech/jobs/[id]/estimates/[eid]/bill — put a sold estimate's lines
 * on the job's invoice, once per estimate (M3c spec §5.3). Invoicing statuses,
 * estimate copy (plan ruling 3) → `{}` body → key → idempotent run → 200
 * `{ invoiceId, added, hasMaterials }`; audit `estimate_billed` on a fresh add.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { logger, errorCode } from "@/lib/logger";
import { BILL_PREAMBLE, techWritePreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { billSoldEstimate } from "@/lib/admin/invoice-field-writes";
import { estimateReasonResult } from "@/lib/tech/estimate-errors";

export const dynamic = "force-dynamic";

const billSchema = z.object({}).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; eid: string }> }) {
  try {
    const { id, eid } = await params;
    const pre = await techWritePreamble(request, id, BILL_PREAMBLE);
    if (!pre.ok) return pre.response;
    if (!isUuid(eid)) return errorResponse("That estimate isn't on this job.", "NOT_FOUND", 404);
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, billSchema, true);
    if (!body.ok) return body.response;
    const key = readKey(request);
    if (!key.ok) return key.response;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async (ids) => {
        const r = await billSoldEstimate({ organizationId, requestId: pre.requestId, techUserId: userId }, eid, { invoiceId: ids.id("invoice") });
        if (!r.ok) return estimateReasonResult(r.reason, r.reason === "already_billed" && r.invoiceId ? { invoiceId: r.invoiceId } : undefined);
        return okResult(200, { invoiceId: r.invoiceId, added: r.added, hasMaterials: r.hasMaterials });
      },
    );
    if (result.envelope.success && !result.replayed) {
      const { invoiceId, added } = result.envelope.data as { invoiceId: string; added: number };
      await auditWrite({
        organizationId, userId, action: "estimate_billed", entity: "estimate", entityId: eid,
        details: `estimateId:${eid} invoiceId:${invoiceId} added:${added}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to bill field estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/tech/jobs/[id]/estimates/[eid]/decline/route.ts`:

```ts
/**
 * POST /api/tech/jobs/[id]/estimates/[eid]/decline — "Customer declined"
 * (M3c spec §5.5): estimate preamble → `{}` → key → idempotent run → 200
 * `{ estimateId, status: "dismissed", created }`; audit `estimate_declined`
 * only when this call changed it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { logger, errorCode } from "@/lib/logger";
import { ESTIMATE_PREAMBLE, techWritePreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { declineFieldEstimate } from "@/lib/tech/estimate-writes";
import { estimateReasonResult } from "@/lib/tech/estimate-errors";

export const dynamic = "force-dynamic";

const declineSchema = z.object({}).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; eid: string }> }) {
  try {
    const { id, eid } = await params;
    const pre = await techWritePreamble(request, id, ESTIMATE_PREAMBLE);
    if (!pre.ok) return pre.response;
    if (!isUuid(eid)) return errorResponse("That estimate isn't on this job.", "NOT_FOUND", 404);
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, declineSchema, true);
    if (!body.ok) return body.response;
    const key = readKey(request);
    if (!key.ok) return key.response;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async () => {
        const r = await declineFieldEstimate({ organizationId, requestId: pre.requestId, techUserId: userId }, eid);
        if (!r.ok) return estimateReasonResult(r.reason);
        return okResult(200, { estimateId: r.estimateId, status: "dismissed", created: r.created });
      },
    );
    if (result.envelope.success && !result.replayed && result.envelope.data.created === true) {
      await auditWrite({ organizationId, userId, action: "estimate_declined", entity: "estimate", entityId: eid, details: `estimateId:${eid}` });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to decline field estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/tech/jobs/[id]/equipment/route.ts`:

```ts
/**
 * GET /api/tech/jobs/[id]/equipment — live units at the job's address by the
 * location rule, plus whether the caller may add or replace (M3c spec §6).
 * POST — add a unit or replace one (spec §5.6): equipment preamble (any
 * technician working the job) → body → semantic validation → key → idempotent
 * run → 201 created / 200 replay; audit `equipment_added` / `equipment_replaced`.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger, errorCode } from "@/lib/logger";
import { techEquipmentPreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { getTechEquipmentView } from "@/lib/tech/equipment-queries";
import { addFieldEquipment } from "@/lib/tech/equipment-writes";
import { equipmentReasonResult } from "@/lib/tech/equipment-errors";
import { EQUIPMENT_ERROR_COPY, parseEquipmentInput, todayInZone } from "@/lib/tech/equipment-input";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:equipment:read:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getTechEquipmentView(session.organizationId, session.userId, id);
    if (r.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    if (r.kind === "external") return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load job equipment");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}

const text = z.string().max(400).optional();
const equipmentSchema = z.object({
  equipmentType: z.string(), make: text, model: text, serialNumber: text, locationInHome: text, notes: text,
  installDate: text, replacesId: z.string().uuid().optional(),
}).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pre = await techEquipmentPreamble(request, id);
    if (!pre.ok) return pre.response;
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, equipmentSchema);
    if (!body.ok) return body.response;
    const parsed = parseEquipmentInput(body.data, todayInZone(new Date()));
    if (!parsed.ok) return errorResponse(EQUIPMENT_ERROR_COPY[parsed.error], "INVALID_INPUT", 400);
    const key = readKey(request);
    if (!key.ok) return key.response;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async (ids) => {
        const r = await addFieldEquipment({ organizationId, requestId: pre.requestId, techUserId: userId }, { equipmentId: ids.id("equipment") }, parsed.value);
        if (!r.ok) return equipmentReasonResult(r.reason);
        return okResult(r.created ? 201 : 200, { equipmentId: r.equipmentId, created: r.created });
      },
    );
    if (result.envelope.success && !result.replayed && result.envelope.data.created === true) {
      const equipmentId = String(result.envelope.data.equipmentId);
      const replacesId = parsed.value.replacesId;
      await auditWrite({
        organizationId, userId, action: replacesId ? "equipment_replaced" : "equipment_added", entity: "equipment", entityId: equipmentId,
        details: replacesId ? `equipmentId:${equipmentId} replacesId:${replacesId}` : `equipmentId:${equipmentId}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to add field equipment");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/lib/tech/invoice-route-guards.test.ts "src/app/api/tech/jobs/[id]"`
Expected: PASS (invoice, estimate and equipment route suites).

- [ ] **Step 6: Probe on a throwaway org** (`probe-m3c-6.mts`, the Global Constraints recipe): `createOrgCore`; insert by SQL a technician, a customer (`name_encrypted` via `encrypt` from `src/lib/crypto.ts`), a pricebook item (`price_cents` 12 500, `cost_cents` 4 000, active), a request with `assigned_to` = the technician and `customer_id`, status `arrived`; mint `MINT_ORG_ID=$ORG npx tsx scripts/agent/mint-tech-session.mjs` and assert the token's org; with the dev server running, `fetch` with `Cookie`, `Origin: http://localhost:3000`, `Idempotency-Key`: `POST …/estimates` two options → 201; same key → 201 with `replayed: true`; `GET …/estimates` → two options, no key containing `cost` (`JSON.stringify(body).toLowerCase().includes("cost")` is false); `POST …/sell` → 200; `POST …/bill` → 200 `added` 1; a new key → 409 `ALREADY_BILLED` with `details.invoiceId`; `POST …/equipment` `{ equipmentType: "ac", make: "Carrier" }` → 201. Delete the org (`DELETE FROM organizations WHERE id = $ORG`) and the probe.

- [ ] **Step 7: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/invoice-route-guards.ts src/lib/tech/invoice-route-guards.test.ts "src/app/api/tech/jobs/[id]/estimates" "src/app/api/tech/jobs/[id]/equipment" && npx vitest run
git add src/lib/tech/invoice-route-guards.ts src/lib/tech/invoice-route-guards.test.ts "src/app/api/tech/jobs/[id]/estimates/route.ts" "src/app/api/tech/jobs/[id]/estimates/route.test.ts" "src/app/api/tech/jobs/[id]/estimates/[eid]/sell/route.ts" "src/app/api/tech/jobs/[id]/estimates/[eid]/sell/route.test.ts" "src/app/api/tech/jobs/[id]/estimates/[eid]/bill/route.ts" "src/app/api/tech/jobs/[id]/estimates/[eid]/bill/route.test.ts" "src/app/api/tech/jobs/[id]/estimates/[eid]/decline/route.ts" "src/app/api/tech/jobs/[id]/estimates/[eid]/decline/route.test.ts" "src/app/api/tech/jobs/[id]/equipment/route.ts" "src/app/api/tech/jobs/[id]/equipment/route.test.ts"
git commit -m "$(cat <<'EOF'
feat(m3c): estimate, bill, decline and equipment routes; per-surface preamble options

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 7: Office — sold_via / sold_by, "Sold, not invoiced" filter, approval line on the estimate detail

**Files:**
- Create: `src/lib/admin/estimate-approval-copy.ts` (+ `estimate-approval-copy.test.ts`)
- Modify: `src/lib/admin/estimate-queries.ts` (`approveEstimate` ~158–220, `listEstimates` ~444–560, `EstimateDetailView` + `getEstimateDetailById` ~600–760, `markEstimateSold` ~803–850), `src/lib/admin/estimate-queries.test.ts`, `src/lib/admin/estimate-detail.test.ts` (new cases; its existing fixtures keep passing because the legacy check is `soldVia == null`), `src/lib/admin/estimate-list-pagination.test.ts`, `src/app/api/admin/estimates/route.ts` (bucket whitelist) + `route.test.ts`, `src/app/api/admin/estimates/[id]/route.ts` (PATCH passes the admin id), `src/hooks/use-estimates.ts` (bucket type), `src/app/admin/(dashboard)/estimates/page.tsx` (tab), `src/app/admin/(dashboard)/estimates/[id]/page.tsx` (approval card)

**Interfaces:**
- Consumes (Task 1): `jobBilledSql`; columns `estimates.sold_via` / `sold_by`.
- Produces: `markEstimateSold(organizationId, id, optionId, soldBy: string | null = null, now = new Date())`; `listEstimates(org, { bucket: 'not_invoiced' })`; `EstimateDetailView` gains `soldVia: string | null`, `soldByName: string | null`; `approvalLines(input, formatWhen, formatDay): ApprovalSegment[][]` in `estimate-approval-copy.ts` (`ApprovalSegment = { text: string; strong?: true }`; strong segments render as today's `font-medium text-foreground` names).

- [ ] **Step 1: Failing tests.**

`src/lib/admin/estimate-approval-copy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { approvalLines, type ApprovalSegment } from "./estimate-approval-copy";

const when = () => "Nov 6, 2:05 PM";
const day = () => "Nov 6, 2026";
const plain = (lines: ApprovalSegment[][]) => lines.map((l) => l.map((s) => s.text).join(""));
const strong = (lines: ApprovalSegment[][]) => lines.flat().filter((s) => s.strong).map((s) => s.text);
const base = { signatureName: null, soldByName: null, markedSoldBy: null, signedAt: "x" };

describe("office approval line (spec §2)", () => {
  it("field: who typed the name, then 'Signed on site with <technician> · <time>'", () => {
    const l = approvalLines({ ...base, soldVia: "field", signatureName: "Pat Probe", soldByName: "Sam Tech" }, when, day);
    expect(plain(l)).toEqual(["Signed by Pat Probe.", "Signed on site with Sam Tech · Nov 6, 2:05 PM"]);
    expect(strong(l)).toEqual(["Pat Probe", "Sam Tech"]);
  });
  it("field with a deleted technician", () => {
    expect(plain(approvalLines({ ...base, soldVia: "field", signatureName: "Pat" }, when, day))[1])
      .toBe("Signed on site with a technician · Nov 6, 2:05 PM");
  });
  it("office: 'Marked sold by <admin name>' and no time", () => {
    const l = approvalLines({ ...base, soldVia: "office", signatureName: "(admin)", soldByName: "Raymond" }, when, day);
    expect(plain(l)).toEqual(["Marked sold by Raymond"]);
    expect(strong(l)).toEqual(["Raymond"]);
  });
  it("old office rows keep today's wording, name in bold", () => {
    const l = approvalLines({ ...base, soldVia: null, signatureName: "(admin)", markedSoldBy: "Ann" }, when, day);
    expect(plain(l)).toEqual(["Marked sold in the office by Ann on Nov 6, 2026."]);
    expect(strong(l)).toEqual(["Ann"]);
    expect(plain(approvalLines({ ...base, soldVia: null, signatureName: "(admin)" }, when, day))).toEqual(["Marked sold in the office on Nov 6, 2026."]);
  });
  it("portal and old customer rows as today", () => {
    const l = approvalLines({ ...base, soldVia: "portal", signatureName: "Pat" }, when, day);
    expect(plain(l)).toEqual(["Signed by Pat on Nov 6, 2026."]);
    expect(strong(l)).toEqual(["Pat"]);
    expect(plain(approvalLines({ ...base, soldVia: null }, when, day))).toEqual(["Signed by customer on Nov 6, 2026."]);
  });
});
```

  `src/lib/admin/estimate-queries.test.ts` — import `approveEstimate` next to `markEstimateSold` and add:

```ts
describe("sold_via / sold_by (M3c spec §3)", () => {
  it("markEstimateSold writes sold_via='office' and the admin id", async () => {
    mockSelectSeq([[{ id: "est-1", status: "open", fieldpulseEstimateId: null }], [{ id: "opt-1" }]]);
    const set = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "est-1" }]) })) }));
    vi.mocked(db.update).mockReturnValueOnce({ set } as never);
    expect(await markEstimateSold(ORG, "est-1", "opt-1", "admin-1")).toEqual({ ok: true, estimateId: "est-1" });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "sold", soldVia: "office", soldBy: "admin-1", signatureName: "(admin)" }));
  });

  it("approveEstimate (portal) writes sold_via='portal' and no seller", async () => {
    mockSelectSeq([[{ id: "est-1", organizationId: ORG, status: "open", expiresAt: null }], [{ id: "opt-1" }]]);
    const set = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "est-1" }]) })) }));
    vi.mocked(db.update).mockReturnValueOnce({ set } as never);
    expect(await approveEstimate({ token: "t", optionId: "opt-1", signatureName: "Pat", signatureIp: "1.2.3.4" }))
      .toEqual({ ok: true, estimateId: "est-1" });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "sold", soldVia: "portal", soldBy: null, signatureName: "Pat", signatureIp: "1.2.3.4" }));
  });
});
```

  `src/lib/admin/estimate-detail.test.ts` — add:

```ts
describe("getEstimateDetailById — who sold it (M3c)", () => {
  it("a field sale carries sold_via and the technician's name, and skips the audit lookup", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "Pat Probe", soldVia: "field", soldByName: "Sam Tech" }], []]);
    const d = await getEstimateDetailById("org-1", "est-1");
    expect(d).toMatchObject({ soldVia: "field", soldByName: "Sam Tech", markedSoldBy: null });
    expect(db.select).toHaveBeenCalledTimes(2); // header + options only
  });
  it("an office sale since M3c names the admin from sold_by, not the audit log", async () => {
    mockSelectSeq([[{ ...HEADER, signatureName: "(admin)", soldVia: "office", soldByName: "Raymond" }], []]);
    const d = await getEstimateDetailById("org-1", "est-1");
    expect(d).toMatchObject({ soldVia: "office", soldByName: "Raymond", markedSoldBy: null });
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
```

  `src/lib/admin/estimate-list-pagination.test.ts` — add next to the other bucket cases:

```ts
  it("bucket=not_invoiced: sold, native, no invoice of any state, not job-billed (M3c)", async () => {
    queuePage();
    await listEstimates(ORG, { bucket: "not_invoiced" });
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ""));
    expect(wheres.some((w) => w.includes("NOT EXISTS (SELECT 1 FROM invoices ni WHERE ni.organization_id ="))).toBe(true);
    expect(wheres.some((w) => w.includes("jbx.estimate_line_item_id IN"))).toBe(true);
    expect(wheres.some((w) => w.includes("'sold'::estimate_status"))).toBe(true);
  });
```

  `src/app/api/admin/estimates/route.test.ts` — change the route import to `import { GET, POST } from "./route";` and add:

```ts
describe("GET /api/admin/estimates — Sold, not invoiced (M3c)", () => {
  it("passes bucket=not_invoiced through", async () => {
    listEstimates.mockResolvedValue({ estimates: [], total: 0 });
    getEstimatePipelineStats.mockResolvedValue({});
    const res = await GET(new NextRequest("https://app.example.com/api/admin/estimates?bucket=not_invoiced"));
    expect(res.status).toBe(200);
    expect(listEstimates).toHaveBeenCalledWith("org-1", expect.objectContaining({ bucket: "not_invoiced" }));
  });
});
```

  Run: `npx vitest run src/lib/admin/estimate-approval-copy.test.ts src/lib/admin/estimate-queries.test.ts src/lib/admin/estimate-detail.test.ts src/lib/admin/estimate-list-pagination.test.ts src/app/api/admin/estimates/route.test.ts` → FAIL.

- [ ] **Step 2: Implement.**

`src/lib/admin/estimate-approval-copy.ts`:

```ts
/**
 * The office estimate detail's "Approval" lines (M3c spec §2): a field sale
 * names who typed the name and the technician ("Signed on site with …", weaker
 * evidence than the portal's remote e-sign: no IP); an office sale since M3c
 * reads "Marked sold by <admin name>"; portal and pre-M3c rows read as today.
 * Names are `strong` segments (today's bold names). Pure.
 */
const OFFICE_SIGNATURE = "(admin)";

export interface ApprovalSegment {
  readonly text: string;
  readonly strong?: true;
}

export interface ApprovalInput {
  readonly soldVia: string | null;
  readonly signatureName: string | null;
  readonly soldByName: string | null;
  /** Legacy office rows: the name from the `estimate_marked_sold` audit row. */
  readonly markedSoldBy: string | null;
  readonly signedAt: string;
}

const name = (text: string): ApprovalSegment => ({ text, strong: true });
const t = (text: string): ApprovalSegment => ({ text });

export function approvalLines(
  e: ApprovalInput, formatWhen: (iso: string) => string, formatDay: (iso: string) => string,
): ApprovalSegment[][] {
  if (e.soldVia === "field") {
    return [
      [t("Signed by "), name(e.signatureName ?? "the customer"), t(".")],
      [t("Signed on site with "), e.soldByName ? name(e.soldByName) : t("a technician"), t(` · ${formatWhen(e.signedAt)}`)],
    ];
  }
  if (e.soldVia === "office") {
    const who = e.soldByName ?? e.markedSoldBy;
    return [who ? [t("Marked sold by "), name(who)] : [t("Marked sold in the office")]];
  }
  if (e.signatureName === OFFICE_SIGNATURE) {
    return [e.markedSoldBy
      ? [t("Marked sold in the office by "), name(e.markedSoldBy), t(` on ${formatDay(e.signedAt)}.`)]
      : [t(`Marked sold in the office on ${formatDay(e.signedAt)}.`)]];
  }
  return [[t("Signed by "), name(e.signatureName ?? "customer"), t(` on ${formatDay(e.signedAt)}.`)]];
}
```

  `src/lib/admin/estimate-queries.ts`:
  - `approveEstimate`'s `.set({...})` gains `soldVia: "portal", soldBy: null,`.
  - `markEstimateSold(organizationId: string, id: string, optionId: string, soldBy: string | null = null, now: Date = new Date())`; its `.set({...})` gains `soldVia: "office", soldBy,`.
  - `listEstimates` opts `bucket?: 'open' | 'won' | 'lost' | 'draft' | 'not_invoiced'`; import `jobBilledSql` from `./estimate-billing-sql`; the bucket push becomes:

```ts
  if (opts.bucket === 'not_invoiced') {
    // Sold, not invoiced (M3c spec §2): native sold, no invoice of ANY state born
    // from it (a voided office invoice means the office handled it, like
    // Generate), and not on the job's invoice.
    extraConditions.push(sql`(${estimates.status} = 'sold'::estimate_status AND ${estimates.fieldpulseEstimateId} IS NULL
      AND NOT EXISTS (SELECT 1 FROM invoices ni WHERE ni.organization_id = ${organizationId}::uuid AND ni.estimate_id = ${estimates.id})
      AND NOT ${jobBilledSql(organizationId, sql`${estimates.id}`)})`);
  } else if (opts.bucket) {
    extraConditions.push(sql`(${BUCKET_CASE_SQL}) = ${opts.bucket}`);
  }
```

  - `EstimateDetailView` gains:

```ts
  /** 'portal' | 'office' | 'field'; null on rows sold before M3c. */
  readonly soldVia: string | null;
  /** The selling technician (field) or admin (office); null when unknown or deleted. */
  readonly soldByName: string | null;
```

  - `getEstimateDetailById` in full:

```ts
export async function getEstimateDetailById(
  organizationId: string,
  id: string,
): Promise<EstimateDetailView | null> {
  const [est] = await db
    .select({
      id: estimates.id,
      status: estimates.status,
      totalCents: estimates.totalCents,
      customerId: estimates.customerId,
      serviceRequestId: estimates.serviceRequestId,
      soldOptionId: estimates.soldOptionId,
      signedAt: estimates.signedAt,
      signatureName: estimates.signatureName,
      expiresAt: estimates.expiresAt,
      createdAt: estimates.createdAt,
      dueDate: estimates.dueDate,
      fieldpulseEstimateId: estimates.fieldpulseEstimateId,
      fieldpulseStatusName: estimates.fieldpulseStatusName,
      title: estimates.title,
      fieldpulseData: estimates.fieldpulseData,
      soldVia: estimates.soldVia,
      soldByName: users.name,
      nameEncrypted: customers.nameEncrypted,
      invoiceId: invoices.id,
    })
    .from(estimates)
    // Org-scope the joins too (defense in depth).
    .leftJoin(customers, and(eq(customers.id, estimates.customerId), eq(customers.organizationId, organizationId)))
    // At most one invoice per estimate (invoices_estimate_unique), so the
    // detail can show "View invoice" instead of a second Generate.
    .leftJoin(invoices, and(eq(invoices.estimateId, estimates.id), eq(invoices.organizationId, organizationId)))
    // M3c: who sold it (technician for field, admin for office).
    .leftJoin(users, and(eq(users.id, estimates.soldBy), eq(users.organizationId, organizationId)))
    .where(withTenant(estimates, organizationId, eq(estimates.id, id)))
    .limit(1);

  if (!est) return null;

  const { fieldpulseEstimateId, fieldpulseStatusName, fieldpulseData, nameEncrypted, invoiceId, soldVia, soldByName, ...header } = est;
  // Only pre-M3c office rows need the audit log; since M3c sold_by names the admin.
  const markedSoldBy =
    est.signatureName === ADMIN_SIGNATURE && soldVia == null ? await findMarkedSoldBy(organizationId, est.id) : null;
  // Admin detail: include snapshotted cost so the UI can show margin.
  const options = await loadOptionsWithLineItems(organizationId, est.id, true);
  return {
    ...header,
    customerName: safeDecryptName(nameEncrypted ?? null),
    markedSoldBy,
    soldVia: soldVia ?? null,
    soldByName: soldByName ?? null,
    options,
    syncedSource: fieldpulseEstimateId != null ? "fieldpulse" : null,
    fieldpulseStatusName: fieldpulseStatusName ?? null,
    fieldpulseData: (fieldpulseData as Record<string, unknown> | null) ?? null,
    invoiceId: invoiceId ?? null,
  };
}
```

  - `src/app/api/admin/estimates/[id]/route.ts` PATCH: `markEstimateSold(session.organizationId, id, parsed.data.optionId, session.userId)`.
  - `src/app/api/admin/estimates/route.ts` GET:

```ts
    const VALID_BUCKETS = new Set(['open', 'won', 'lost', 'draft', 'not_invoiced'] as const);
    type ValidBucket = 'open' | 'won' | 'lost' | 'draft' | 'not_invoiced';
```

  - `src/hooks/use-estimates.ts`: `readonly bucket?: 'open' | 'won' | 'lost' | 'draft' | 'not_invoiced';`.
  - `src/app/admin/(dashboard)/estimates/page.tsx`:

```tsx
type Bucket = 'open' | 'won' | 'lost' | 'draft' | 'not_invoiced';
```

```tsx
const TABS: ReadonlyArray<TabDef> = [
  { value: 'open',  label: 'Open' },
  { value: 'won',   label: 'Won' },
  { value: 'lost',  label: 'Lost' },
  { value: 'draft', label: 'Draft' },
  { value: 'not_invoiced', label: 'Sold, not invoiced' },
  { value: null,    label: 'All' },
];

/** The pipeline stats have no "not invoiced" bucket: that tab shows no count or total. */
type StatBucket = Exclude<Bucket, 'not_invoiced'>;

function tabCount(stats: EstimatePipelineStats | null, bucket: Bucket | null): number | undefined {
  if (!stats || bucket === 'not_invoiced') return undefined;
  if (bucket === null) return stats.openCount + stats.wonCount + stats.lostCount + stats.draftCount;
  return stats[`${bucket as StatBucket}Count`];
}

function tabCents(stats: EstimatePipelineStats | null, bucket: Bucket | null): number | undefined {
  if (!stats || bucket === 'not_invoiced') return undefined;
  if (bucket === null) return stats.openCents + stats.wonCents + stats.lostCents + stats.draftCents;
  return stats[`${bucket as StatBucket}Cents`];
}

function emptyMessage(bucket: Bucket | null): string {
  if (bucket === 'open')  return 'No open estimates — the pipeline is clear.';
  if (bucket === 'won')   return 'No won estimates yet.';
  if (bucket === 'lost')  return 'No lost estimates.';
  if (bucket === 'draft') return 'No draft estimates.';
  if (bucket === 'not_invoiced') return 'No sold estimates are waiting for an invoice.';
  return 'No estimates yet. Create one to send a customer a proposal.';
}
```

    In `restoreFiltersFromUrl`: `const buckets: readonly string[] = ['open', 'won', 'lost', 'draft', 'not_invoiced'];`. The `SegmentedControl` options map becomes:

```tsx
          options={TABS.map((tab) => {
            const cents = tabCents(stats, tab.value);
            return {
              value: tab.value ?? 'all',
              label: cents === undefined ? tab.label : `${tab.label} · ${formatCentsExact(cents)}`,
              badge: tabCount(stats, tab.value),
            };
          })}
```

  - `src/app/admin/(dashboard)/estimates/[id]/page.tsx`: the `EstimateDetail` interface gains `readonly soldVia: string | null;` and `readonly soldByName: string | null;`; add next to `formatDay`:

```tsx
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
```

    and the Approval card's `CardContent` becomes (import `approvalLines` from `@/lib/admin/estimate-approval-copy`):

```tsx
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            {approvalLines(
              {
                soldVia: estimate.soldVia,
                signatureName: estimate.signatureName,
                soldByName: estimate.soldByName,
                markedSoldBy: estimate.markedSoldBy,
                signedAt: estimate.signedAt,
              },
              formatWhen,
              formatDay,
            ).map((line, i) => (
              <p key={i}>
                {line.map((seg, j) =>
                  seg.strong ? <span key={j} className="font-medium text-foreground">{seg.text}</span> : <span key={j}>{seg.text}</span>,
                )}
              </p>
            ))}
          </CardContent>
```

- [ ] **Step 3: Run to verify they pass**

Run: `npx vitest run src/lib/admin/estimate-approval-copy.test.ts src/lib/admin/estimate-queries.test.ts src/lib/admin/estimate-detail.test.ts src/lib/admin/estimate-list-pagination.test.ts src/lib/admin/estimate-synced-guards.test.ts src/lib/admin/invoice-queries.test.ts src/app/api/admin/estimates`
Expected: PASS.

- [ ] **Step 4: Look at it.** Dev server running; `node scripts/agent/screenshot-page.mjs "/admin/estimates?bucket=not_invoiced" 1280 /tmp/m3c-7-list.png` and a field-sold estimate's detail (the Task 6 probe recipe on a throwaway org with `MINT_ORG_ID` sells one). Read `.claude/skills/page-estimates/SKILL.md` and `admin-pages` first; the tab follows the existing SegmentedControl style.

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/estimate-approval-copy.ts src/lib/admin/estimate-approval-copy.test.ts src/lib/admin/estimate-queries.ts src/lib/admin/estimate-queries.test.ts src/lib/admin/estimate-detail.test.ts src/lib/admin/estimate-list-pagination.test.ts src/app/api/admin/estimates/route.ts src/app/api/admin/estimates/route.test.ts "src/app/api/admin/estimates/[id]/route.ts" src/hooks/use-estimates.ts "src/app/admin/(dashboard)/estimates/page.tsx" "src/app/admin/(dashboard)/estimates/[id]/page.tsx" && npx vitest run
git add src/lib/admin/estimate-approval-copy.ts src/lib/admin/estimate-approval-copy.test.ts src/lib/admin/estimate-queries.ts src/lib/admin/estimate-queries.test.ts src/lib/admin/estimate-detail.test.ts src/lib/admin/estimate-list-pagination.test.ts src/app/api/admin/estimates/route.ts src/app/api/admin/estimates/route.test.ts "src/app/api/admin/estimates/[id]/route.ts" src/hooks/use-estimates.ts "src/app/admin/(dashboard)/estimates/page.tsx" "src/app/admin/(dashboard)/estimates/[id]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(m3c): office sees who sold an estimate and a Sold, not invoiced filter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 8: Client plumbing, the job's Estimates card, the builder

**Files:**
- Create: `src/lib/tech/estimate-intents.ts` (+ `estimate-intents.test.ts`), `src/lib/tech/add-item-done.ts` (+ `add-item-done.test.ts`), `src/lib/tech/estimate-builder.ts` (+ `estimate-builder.test.ts`), `src/components/tech/estimates/fetch-estimates.ts`, `src/components/tech/estimates/recover-intents.ts`, `src/components/tech/estimates/use-estimate-write.ts`, `src/components/tech/estimates/estimates-card.tsx`, `src/components/tech/estimates/estimate-builder-client.tsx`, `src/app/tech/jobs/[id]/estimates/new/page.tsx`
- Modify: `src/hooks/use-idempotency-key.ts`, `src/components/tech/invoice/add-item-sheet.tsx`

**Interfaces:**
- Consumes: Task 3 `MAX_OPTIONS`, `MAX_LINES_PER_OPTION`, `MAX_QUANTITY`, `MAX_OPTION_NAME`, `hasDuplicateNames`, `CreateEstimateInput`; Task 5 `TechEstimatesView`, `TechEstimate`, `STATUS_CHIP`, `BILLING_LINE`, `priceSummary`, `soldOptionOf`, `estimatesCardVisible`; the Task 6 routes at runtime; M3b `nextKeyState`/`outcomeEvent` (`invoice-key-state.ts`), `parseIntents`/`serializeIntents` (`invoice-intent-persist.ts`), `classifyWriteError`, `mintKey`, `postJson` (`src/components/tech/invoice/post-json.ts`), `AddItemSheet`, `computeOptionTotals`, `formatCentsExact`.
- Produces:
  - `useIdempotencyKey({ intentId, requestId, persist, storageKey?, rehydrate? })` (defaults keep every M3b caller unchanged).
  - `estimate-intents.ts`: `ESTIMATE_INTENTS_KEY(rid)` = `tech:estimate:<rid>:intents`, `ESTIMATE_INTENT` (`create`, `sell(eid)`, `bill(eid)`, `decline(eid)`, `equipmentAdd`, `equipmentReplace(unitId)`), `StoredWrite { path; payload }`, `isStoredWrite`, `storedToRecover(raw, match)`, `recoveryKeeps(outcome)`, `withoutIntent(raw, intentId)`, `estimateWriteCopy(outcome, envelope)`.
  - `fetchEstimates(jobId): Promise<{ kind: "ok"; view } | { kind: "hidden" } | { kind: "error" }>`; `recoverEstimateIntents(requestId, match): Promise<{ unresolved: number; succeeded: { intentId; data }[] }>`; `useEstimateWrite(requestId, intentId, rehydrate = false): { phase; send(path, payload): Promise<EstimateSend>; settle(outcome, landed) }` with `EstimateSend = { sent: false } | { sent: true; status: number | null; envelope; outcome: WriteOutcome; resentOld: boolean }`.
  - `EstimatesCard({ jobId, refreshKey, onLoaded? })`; `EstimateBuilderClient({ jobId })`; page `/tech/jobs/[id]/estimates/new`.
  - `estimate-builder.ts`: `DraftLine`, `DraftOption`, `OptionChange`, `positionalName`, `startOptions`, `nextOptionNames`, `addLine`, `removeLine`, `setQuantity`, `optionFooter`, `checkDraft`, `DRAFT_KEY`, `serializeDraft`, `parseDraft`.
  - `add-item-done.ts`: `doneAction({ picked, canRetry, adding }): "wait" | "close" | "add_then_close"`.

- [ ] **Step 1: Failing pure tests.**

`src/lib/tech/estimate-builder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  addLine, checkDraft, nextOptionNames, optionFooter, parseDraft, removeLine, serializeDraft, setQuantity, startOptions,
  type DraftOption,
} from "./estimate-builder";

const names = (o: readonly DraftOption[]) => o.map((x) => x.name);
const line = (key: string, qty = 1) => ({ key, pricebookItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Capacitor", unitPriceCents: 12_500, quantity: qty });

describe("nextOptionNames (spec §7.1)", () => {
  it("starts with Option 1", () => expect(names(startOptions("a"))).toEqual(["Option 1"]));
  it("add with nothing edited renames by position: two → Good, Better; three → Good, Better, Best", () => {
    const two = nextOptionNames(startOptions("a"), { type: "add", key: "b" });
    expect(names(two)).toEqual(["Good", "Better"]);
    expect(names(nextOptionNames(two, { type: "add", key: "c" }))).toEqual(["Good", "Better", "Best"]);
  });
  it("add with an edited option keeps names and calls the new one Option N", () => {
    const edited = nextOptionNames(nextOptionNames(startOptions("a"), { type: "add", key: "b" }), { type: "rename", key: "a", name: "Repair" });
    expect(names(nextOptionNames(edited, { type: "add", key: "c" }))).toEqual(["Repair", "Better", "Option 3"]);
  });
  it("never more than three", () => {
    let o = startOptions("a");
    for (const k of ["b", "c", "d"]) o = nextOptionNames(o, { type: "add", key: k });
    expect(o).toHaveLength(3);
  });
  it("remove with nothing edited renames by position; one left → Option 1", () => {
    let o = startOptions("a");
    o = nextOptionNames(nextOptionNames(o, { type: "add", key: "b" }), { type: "add", key: "c" });
    o = nextOptionNames(o, { type: "remove", key: "a" });
    expect(names(o)).toEqual(["Good", "Better"]);
    expect(names(nextOptionNames(o, { type: "remove", key: "b" }))).toEqual(["Option 1"]);
  });
  it("remove keeps names when a remaining option is edited; the last option cannot be removed", () => {
    let o = nextOptionNames(nextOptionNames(startOptions("a"), { type: "add", key: "b" }), { type: "add", key: "c" });
    o = nextOptionNames(o, { type: "rename", key: "c", name: "Premium" });
    expect(names(nextOptionNames(o, { type: "remove", key: "a" }))).toEqual(["Better", "Premium"]);
    expect(nextOptionNames(startOptions("a"), { type: "remove", key: "a" })).toHaveLength(1);
  });
  it("rename marks edited", () => expect(nextOptionNames(startOptions("a"), { type: "rename", key: "a", name: "X" })[0]!.edited).toBe(true));
});

describe("lines and totals", () => {
  it("add, quantity 1–999, remove", () => {
    let o = addLine(startOptions("a"), "a", line("l1"));
    o = setQuantity(o, "a", "l1", 1200);
    expect(o[0]!.lines[0]!.quantity).toBe(999);
    o = setQuantity(o, "a", "l1", 0);
    expect(o[0]!.lines[0]!.quantity).toBe(1);
    expect(removeLine(o, "a", "l1")[0]!.lines).toEqual([]);
  });
  it("footer: Subtotal · Tax · Total from taxBps", () => {
    expect(optionFooter([line("l1", 2)], 825)).toBe("Subtotal $250.00 · Tax $20.63 · Total $270.63");
    expect(optionFooter([], 825)).toBe("Subtotal $0.00 · Tax $0.00 · Total $0.00");
  });
});

describe("checkDraft (spec §7.1 inline reasons)", () => {
  const two = (a: DraftOption["lines"], b: DraftOption["lines"]) =>
    [{ key: "a", name: "Good", edited: false, lines: a }, { key: "b", name: "Better", edited: false, lines: b }];
  it("names the option that needs an item", () => expect(checkDraft(two([line("l1")], []))).toEqual({ ok: false, reason: "Better needs an item." }));
  it("refuses blank, duplicate and long names", () => {
    expect(checkDraft([{ key: "a", name: " ", edited: true, lines: [line("l1")] }])).toEqual({ ok: false, reason: "Name every option." });
    expect(checkDraft([{ key: "a", name: "Good", edited: true, lines: [line("l1")] }, { key: "b", name: "good ", edited: true, lines: [line("l2")] }]))
      .toEqual({ ok: false, reason: "Two options have the same name." });
    expect(checkDraft([{ key: "a", name: "x".repeat(41), edited: true, lines: [line("l1")] }])).toEqual({ ok: false, reason: "Keep option names to 40 characters." });
  });
  it("refuses more than 40 items in an option", () => {
    const many = Array.from({ length: 41 }, (_, i) => line(`l${i}`));
    expect(checkDraft([{ key: "a", name: "Good", edited: false, lines: many }])).toEqual({ ok: false, reason: "Good has more than 40 items." });
  });
  it("builds the POST body with trimmed names", () => {
    expect(checkDraft(two([line("l1", 2)], [line("l2")]))).toEqual({ ok: true, body: { options: [
      { name: "Good", lines: [{ pricebookItemId: line("x").pricebookItemId, quantity: 2 }] },
      { name: "Better", lines: [{ pricebookItemId: line("x").pricebookItemId, quantity: 1 }] },
    ] } });
  });
});

describe("draft persistence", () => {
  it("round-trips", () => {
    const o = addLine(startOptions("a"), "a", line("l1", 3));
    expect(parseDraft(serializeDraft(o))).toEqual(o);
  });
  it("parseDraft ignores a corrupted or oversized draft", () => {
    for (const raw of [null, "", "{", "[]", JSON.stringify({ v: 2, options: [] }), JSON.stringify({ v: 1, options: [] }),
      JSON.stringify({ v: 1, options: Array.from({ length: 4 }, (_, i) => ({ key: `k${i}`, name: "x", edited: false, lines: [] })) }),
      JSON.stringify({ v: 1, options: [{ key: "a", name: "x", edited: false, lines: [{ key: "l", pricebookItemId: "p", name: "n", unitPriceCents: -1, quantity: 1 }] }] }),
      JSON.stringify({ v: 1, options: [{ key: "a", name: "x", edited: false, lines: [{ key: "l", pricebookItemId: "p", name: "n", unitPriceCents: 1, quantity: 1000 }] }] }),
    ]) expect(parseDraft(raw)).toBeNull();
  });
});
```

`src/lib/tech/estimate-intents.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  ESTIMATE_INTENT, ESTIMATE_INTENTS_KEY, estimateWriteCopy, isStoredWrite, recoveryKeeps, storedToRecover, withoutIntent,
} from "./estimate-intents";
import { INTENTS_STORAGE_KEY, serializeIntents } from "./invoice-intent-persist";

const write = (path: string) => ({ path, payload: { optionId: "o", signatureName: "Pat" } });
const raw = serializeIntents({
  "estimate:sell:e1": { phase: "sent", key: "k1", bodyHash: "h1", body: write("/api/tech/jobs/r/estimates/e1/sell") },
  "estimate:bill:e2": { phase: "unknown", key: "k2", bodyHash: "h2", body: write("/api/tech/jobs/r/estimates/e2/bill") },
  "equipment:add": { phase: "sent", key: "k3", bodyHash: "h3", body: { path: "https://evil.example/x", payload: {} } },
});

describe("estimate intents (spec §7)", () => {
  it("own storage key and intent ids", () => {
    expect(ESTIMATE_INTENTS_KEY("r")).toBe("tech:estimate:r:intents");
    expect(ESTIMATE_INTENTS_KEY("r")).not.toBe(INTENTS_STORAGE_KEY("r"));
    expect([ESTIMATE_INTENT.create, ESTIMATE_INTENT.sell("e"), ESTIMATE_INTENT.bill("e"), ESTIMATE_INTENT.decline("e"), ESTIMATE_INTENT.equipmentAdd, ESTIMATE_INTENT.equipmentReplace("u")])
      .toEqual(["estimate:create", "estimate:sell:e", "estimate:bill:e", "estimate:decline:e", "equipment:add", "equipment:replace:u"]);
  });
  it("a stored write must target this app's tech job routes", () => {
    expect(isStoredWrite(write("/api/tech/jobs/r/estimates"))).toBe(true);
    expect(isStoredWrite({ path: "https://evil.example/x", payload: {} })).toBe(false);
    expect(isStoredWrite({ path: "/api/tech/jobs/r" })).toBe(false);
  });
  it("storedToRecover picks matching, well-formed intents", () => {
    expect(storedToRecover(raw, (id) => id.startsWith("estimate:")).map((x) => [x.intentId, x.key])).toEqual([["estimate:sell:e1", "k1"], ["estimate:bill:e2", "k2"]]);
    expect(storedToRecover(raw, (id) => id.startsWith("equipment:"))).toEqual([]);
    expect(storedToRecover(null, () => true)).toEqual([]);
  });
  it("withoutIntent removes one entry and returns null when empty", () => {
    const one = withoutIntent(raw, "estimate:sell:e1");
    expect(storedToRecover(one, () => true).map((x) => x.intentId)).toEqual(["estimate:bill:e2"]);
    expect(withoutIntent(serializeIntents({ a: { phase: "sent", key: "k", bodyHash: "h", body: write("/api/tech/jobs/r/x") } }), "a")).toBeNull();
  });
  it("recovery keeps only answers that are still unknown", () => {
    expect(recoveryKeeps("retry_same_key_after_refetch")).toBe(true);
    expect(recoveryKeeps("wait_then_refetch")).toBe(true);
    for (const o of ["success_refetch", "show_message_refetch", "spent_new_key", "already_saved_refetch", "refetch_new_key"] as const) expect(recoveryKeeps(o)).toBe(false);
  });
  it("write copy: server copy for definitive refusals, our copy for unknowns", () => {
    expect(estimateWriteCopy("retry_same_key_after_refetch", null)).toBe("Your last tap may not have saved. Try again.");
    expect(estimateWriteCopy("wait_then_refetch", null)).toBe("Still saving your last tap…");
    expect(estimateWriteCopy("show_message_refetch", { error: { code: "ALREADY_DECIDED", message: "This estimate was already decided." } })).toBe("This estimate was already decided.");
    expect(estimateWriteCopy("spent_new_key", { error: { code: "IDEMPOTENCY_KEY_REUSED", message: "x" } })).toBe("That tap didn't go through. Try again.");
    expect(estimateWriteCopy("show_message_refetch", null)).toBe("Couldn't save that. Try again.");
  });
});
```

`src/lib/tech/add-item-done.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { doneAction } from "./add-item-done";

describe("Add item sheet Done (spec §7.1)", () => {
  it("adds the pending picked item first", () => expect(doneAction({ picked: true, canRetry: false, adding: false })).toBe("add_then_close"));
  it("just closes with nothing picked or an unknown add pending retry", () => {
    expect(doneAction({ picked: false, canRetry: false, adding: false })).toBe("close");
    expect(doneAction({ picked: true, canRetry: true, adding: false })).toBe("close");
  });
  it("waits while an add is in flight", () => expect(doneAction({ picked: true, canRetry: false, adding: true })).toBe("wait"));
});
```

  Run: `npx vitest run src/lib/tech/estimate-builder.test.ts src/lib/tech/estimate-intents.test.ts src/lib/tech/add-item-done.test.ts` → FAIL.

- [ ] **Step 2: Implement the pure modules.**

`src/lib/tech/estimate-builder.ts`:

```ts
/**
 * Pure state rules for the field estimate builder (M3c spec §7.1): option
 * naming, lines, totals, the inline save reason and the sessionStorage draft.
 */
import { computeOptionTotals } from "@/lib/admin/money";
import { formatCentsExact } from "@/lib/admin/money-format";
import {
  hasDuplicateNames, MAX_LINES_PER_OPTION, MAX_OPTION_NAME, MAX_OPTIONS, MAX_QUANTITY, type CreateEstimateInput,
} from "./estimate-input";

export interface DraftLine {
  readonly key: string;
  readonly pricebookItemId: string;
  readonly name: string;
  /** Display only: the server re-snapshots the price on save. */
  readonly unitPriceCents: number;
  readonly quantity: number;
}

export interface DraftOption {
  readonly key: string;
  readonly name: string;
  /** The technician typed this name: automatic renaming stops. */
  readonly edited: boolean;
  readonly lines: readonly DraftLine[];
}

export type OptionChange =
  | { readonly type: "add"; readonly key: string }
  | { readonly type: "remove"; readonly key: string }
  | { readonly type: "rename"; readonly key: string; readonly name: string };

const TIERS = ["Good", "Better", "Best"] as const;

export function positionalName(index: number, count: number): string {
  if (count === 1) return "Option 1";
  return TIERS[index] ?? `Option ${index + 1}`;
}

const byPosition = (options: readonly DraftOption[]): DraftOption[] =>
  options.map((o, i) => ({ ...o, name: positionalName(i, options.length) }));

export function startOptions(key: string): DraftOption[] {
  return [{ key, name: "Option 1", edited: false, lines: [] }];
}

export function nextOptionNames(options: readonly DraftOption[], change: OptionChange): DraftOption[] {
  switch (change.type) {
    case "add": {
      if (options.length >= MAX_OPTIONS) return [...options];
      const next: DraftOption[] = [...options, { key: change.key, name: "", edited: false, lines: [] }];
      if (!options.some((o) => o.edited)) return byPosition(next);
      return next.map((o, i) => (i === next.length - 1 ? { ...o, name: `Option ${i + 1}` } : o));
    }
    case "remove": {
      if (options.length <= 1) return [...options];
      const rest = options.filter((o) => o.key !== change.key);
      return rest.some((o) => o.edited) ? rest : byPosition(rest);
    }
    case "rename":
      return options.map((o) => (o.key === change.key ? { ...o, name: change.name, edited: true } : o));
  }
}

const withOption = (options: readonly DraftOption[], key: string, fn: (o: DraftOption) => DraftOption): DraftOption[] =>
  options.map((o) => (o.key === key ? fn(o) : o));

export function addLine(options: readonly DraftOption[], optionKey: string, line: DraftLine): DraftOption[] {
  return withOption(options, optionKey, (o) => ({ ...o, lines: [...o.lines, line] }));
}

export function removeLine(options: readonly DraftOption[], optionKey: string, lineKey: string): DraftOption[] {
  return withOption(options, optionKey, (o) => ({ ...o, lines: o.lines.filter((l) => l.key !== lineKey) }));
}

export function setQuantity(options: readonly DraftOption[], optionKey: string, lineKey: string, quantity: number): DraftOption[] {
  const q = Math.min(MAX_QUANTITY, Math.max(1, Math.trunc(quantity) || 1));
  return withOption(options, optionKey, (o) => ({ ...o, lines: o.lines.map((l) => (l.key === lineKey ? { ...l, quantity: q } : l)) }));
}

export function optionFooter(lines: readonly DraftLine[], taxBps: number): string {
  const t = computeOptionTotals(lines, taxBps);
  return `Subtotal ${formatCentsExact(t.subtotalCents)} · Tax ${formatCentsExact(t.taxCents)} · Total ${formatCentsExact(t.totalCents)}`;
}

export type DraftCheck = { readonly ok: true; readonly body: CreateEstimateInput } | { readonly ok: false; readonly reason: string };

export function checkDraft(options: readonly DraftOption[]): DraftCheck {
  if (options.some((o) => o.name.trim() === "")) return { ok: false, reason: "Name every option." };
  if (options.some((o) => o.name.trim().length > MAX_OPTION_NAME)) return { ok: false, reason: "Keep option names to 40 characters." };
  if (hasDuplicateNames(options.map((o) => o.name))) return { ok: false, reason: "Two options have the same name." };
  const empty = options.find((o) => o.lines.length === 0);
  if (empty) return { ok: false, reason: `${empty.name.trim()} needs an item.` };
  const full = options.find((o) => o.lines.length > MAX_LINES_PER_OPTION);
  if (full) return { ok: false, reason: `${full.name.trim()} has more than 40 items.` };
  return {
    ok: true,
    body: { options: options.map((o) => ({ name: o.name.trim(), lines: o.lines.map((l) => ({ pricebookItemId: l.pricebookItemId, quantity: l.quantity })) })) },
  };
}

export const DRAFT_KEY = (requestId: string) => `tech:estimate:${requestId}:draft`;

export function serializeDraft(options: readonly DraftOption[]): string {
  return JSON.stringify({ v: 1, options });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (l: unknown): l is DraftLine =>
  isObj(l) && typeof l.key === "string" && typeof l.pricebookItemId === "string" && typeof l.name === "string"
  && Number.isInteger(l.unitPriceCents) && (l.unitPriceCents as number) >= 0
  && Number.isInteger(l.quantity) && (l.quantity as number) >= 1 && (l.quantity as number) <= MAX_QUANTITY;
const isOption = (o: unknown): o is DraftOption =>
  isObj(o) && typeof o.key === "string" && typeof o.name === "string" && typeof o.edited === "boolean"
  && Array.isArray(o.lines) && o.lines.length <= MAX_LINES_PER_OPTION && o.lines.every(isLine);

/** A stored draft, or null when absent, corrupted, from another version or out of bounds. */
export function parseDraft(raw: string | null): DraftOption[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(parsed) || parsed.v !== 1 || !Array.isArray(parsed.options)) return null;
  const options = parsed.options;
  if (options.length < 1 || options.length > MAX_OPTIONS || !options.every(isOption)) return null;
  return options as DraftOption[];
}
```

`src/lib/tech/estimate-intents.ts`:

```ts
/**
 * Idempotency intents for the estimate and equipment writes (M3c spec §7):
 * their own sessionStorage key (never the M3b invoice key), stored bodies that
 * carry their own path so a reload can re-send them, and the write copy.
 */
import { parseIntents, serializeIntents } from "./invoice-intent-persist";
import type { WriteOutcome } from "./invoice-key-state";

export const ESTIMATE_INTENTS_KEY = (requestId: string) => `tech:estimate:${requestId}:intents`;

export const ESTIMATE_INTENT = {
  create: "estimate:create",
  sell: (estimateId: string) => `estimate:sell:${estimateId}`,
  bill: (estimateId: string) => `estimate:bill:${estimateId}`,
  decline: (estimateId: string) => `estimate:decline:${estimateId}`,
  equipmentAdd: "equipment:add",
  equipmentReplace: (unitId: string) => `equipment:replace:${unitId}`,
} as const;

export interface StoredWrite {
  readonly path: string;
  readonly payload: unknown;
}

export function isStoredWrite(v: unknown): v is StoredWrite {
  if (typeof v !== "object" || v === null || !("payload" in v)) return false;
  const path = (v as { path?: unknown }).path; // read once: a second cast after `in` narrowing is TS2352
  return typeof path === "string" && path.startsWith("/api/tech/jobs/");
}

export interface RecoverableIntent {
  readonly intentId: string;
  readonly key: string;
  readonly write: StoredWrite;
}

export function storedToRecover(raw: string | null, match: (intentId: string) => boolean): RecoverableIntent[] {
  const out: RecoverableIntent[] = [];
  for (const [intentId, s] of Object.entries(parseIntents(raw))) {
    if (!match(intentId) || s.phase === "idle" || !isStoredWrite(s.body)) continue;
    out.push({ intentId, key: s.key, write: s.body });
  }
  return out;
}

/** An answer that still leaves the write's fate unknown keeps it stored. */
export function recoveryKeeps(outcome: WriteOutcome): boolean {
  return outcome === "retry_same_key_after_refetch" || outcome === "wait_then_refetch";
}

/** The stored map without `intentId`, or null when nothing is left. */
export function withoutIntent(raw: string | null, intentId: string): string | null {
  const rest = Object.fromEntries(Object.entries(parseIntents(raw)).filter(([id]) => id !== intentId));
  return Object.keys(rest).length === 0 ? null : serializeIntents(rest);
}

export interface EnvelopeLike {
  readonly error?: { readonly code?: string; readonly message?: string };
}

const FALLBACK = "Couldn't save that. Try again.";

export function estimateWriteCopy(outcome: WriteOutcome, envelope: EnvelopeLike | null): string {
  switch (outcome) {
    case "retry_same_key_after_refetch":
      return "Your last tap may not have saved. Try again.";
    case "wait_then_refetch":
      return "Still saving your last tap…";
    case "spent_new_key":
      return envelope?.error?.code === "IDEMPOTENCY_KEY_REUSED" ? "That tap didn't go through. Try again." : envelope?.error?.message ?? FALLBACK;
    default:
      return envelope?.error?.message ?? FALLBACK;
  }
}
```

`src/lib/tech/add-item-done.ts`:

```ts
/** "Done" on the Add item sheet (M3c spec §7.1): add the pending pick first, never drop it. */
export type DoneAction = "wait" | "close" | "add_then_close";

export function doneAction(s: { readonly picked: boolean; readonly canRetry: boolean; readonly adding: boolean }): DoneAction {
  if (s.adding) return "wait";
  return s.picked && !s.canRetry ? "add_then_close" : "close";
}
```

  Run the three test files → PASS.

- [ ] **Step 3: Hook and sheet.**

  `src/hooks/use-idempotency-key.ts` — full replacement:

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { IDLE, nextKeyState, type KeyEvent, type KeyState } from '@/lib/tech/invoice-key-state';
import { INTENTS_STORAGE_KEY, parseIntents, persistOps, serializeIntents } from '@/lib/tech/invoice-intent-persist';

/** Read-modify-write one request's intent map. Storage can throw (private
 * mode, quota); persistence is then best effort and the in-memory state rules. */
function applyPersist(storageKey: string, intentId: string, op: 'write' | 'clear', next: KeyState): void {
  try {
    const rest = Object.fromEntries(
      Object.entries(parseIntents(window.sessionStorage.getItem(storageKey))).filter(([id]) => id !== intentId),
    );
    const map = op === 'write' ? { ...rest, [intentId]: next } : rest;
    if (Object.keys(map).length === 0) window.sessionStorage.removeItem(storageKey);
    else window.sessionStorage.setItem(storageKey, serializeIntents(map));
  } catch {
    /* storage unavailable: keep going in memory */
  }
}

/**
 * One idempotency intent (M3b spec §7.5). `dispatch` runs `nextKeyState`
 * synchronously against the latest state, persists the transition BEFORE it
 * returns (so `dispatch({ type: 'sent' })` is on disk before the caller's
 * fetch), and returns the new state so the caller can read the key at once.
 * `persist: false` for the signature intent (its body is a Blob).
 * `storageKey` (default: the invoice key) lets M3c keep estimate and equipment
 * intents apart; `rehydrate: false` leaves stored intents to the caller's own
 * recovery (M3c surfaces re-send them before unlocking).
 *
 * Send rule: callers gate on the EDIT dispatch's phase. Dispatch
 * `edit(currentBody)` first and proceed only when the result is `armed` (first
 * send) or `unknown` (re-send of the old body); a `sent` result means a request
 * is already in flight (`sent + sent` is a no-op), so the tap must not POST.
 */
export function useIdempotencyKey(opts: {
  intentId: string;
  requestId: string;
  persist: boolean;
  storageKey?: (requestId: string) => string;
  rehydrate?: boolean;
}): { state: KeyState; dispatch(e: KeyEvent): KeyState } {
  const { intentId, requestId, persist } = opts;
  const keyFor = opts.storageKey ?? INTENTS_STORAGE_KEY;
  const rehydrate = opts.rehydrate ?? true;
  const [state, setState] = useState<KeyState>(IDLE);
  const stateRef = useRef<KeyState>(IDLE);

  // Rehydrate an in-flight intent after a reload (a persisted `sent` comes back
  // as `unknown`). Runs after mount: sessionStorage does not exist on the server.
  useEffect(() => {
    if (!persist || !rehydrate) return;
    let restored: KeyState | undefined;
    try {
      restored = parseIntents(window.sessionStorage.getItem(keyFor(requestId)))[intentId];
    } catch {
      restored = undefined;
    }
    if (restored && stateRef.current.phase === 'idle') {
      stateRef.current = restored;
      setState(restored);
    }
  }, [persist, rehydrate, keyFor, requestId, intentId]);

  const dispatch = useCallback(
    (e: KeyEvent): KeyState => {
      const prev = stateRef.current;
      const next = nextKeyState(prev, e);
      if (next === prev) return prev;
      if (persist) {
        const op = persistOps(prev, next);
        if (op !== 'none') applyPersist(keyFor(requestId), intentId, op, next);
      }
      stateRef.current = next;
      setState(next);
      return next;
    },
    [persist, keyFor, requestId, intentId],
  );

  return { state, dispatch };
}
```

  `src/components/tech/invoice/add-item-sheet.tsx`:
  - `import { doneAction } from '@/lib/tech/add-item-done';`
  - `add` returns its status: signature `async function add(retrying = false): Promise<WriteResult['status'] | null>`; `if (!picked) return null;` at the top and `return r.status;` at the end.
  - New function after `add`:

```tsx
  /** Done adds the pending pick (with its quantity) before closing; an add that did not land keeps the sheet open. */
  async function done(): Promise<void> {
    const action = doneAction({ picked: picked !== null, canRetry, adding });
    if (action === 'wait') return;
    if (action === 'add_then_close') {
      const status = await add();
      // 'dropped': add() already reset and closed the sheet — never close twice.
      if (status !== 'done') return;
    }
    reset();
    onClose();
  }
```

  - The Done button's `onClick` becomes `() => void done()`.

- [ ] **Step 4: Client plumbing.**

`src/components/tech/estimates/fetch-estimates.ts`:

```ts
/** GET the job's estimates. hidden = not readable (404) or not native (409). Never throws. */
import type { TechEstimatesView } from '@/lib/tech/estimate-view';

export type EstimatesFetch = { readonly kind: 'ok'; readonly view: TechEstimatesView } | { readonly kind: 'hidden' } | { readonly kind: 'error' };

export async function fetchEstimates(jobId: string): Promise<EstimatesFetch> {
  try {
    const res = await fetch(`/api/tech/jobs/${jobId}/estimates`, { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: TechEstimatesView } | null;
    if (res.ok && body?.success && body.data) return { kind: 'ok', view: body.data };
    if (res.status === 404 || res.status === 409) return { kind: 'hidden' };
    return { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}
```

`src/components/tech/estimates/recover-intents.ts`:

```ts
/**
 * Re-send estimate / equipment intents a reload left in flight (M3b rule, M3c
 * spec §7): OLD body, OLD key, before the surface unlocks. A definitive
 * answer clears the stored intent; an unknown one stays for "Try again".
 */
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';
import { ESTIMATE_INTENTS_KEY, recoveryKeeps, storedToRecover, withoutIntent } from '@/lib/tech/estimate-intents';
import { postJson } from '@/components/tech/invoice/post-json';

export interface RecoveryResult {
  readonly unresolved: number;
  readonly succeeded: ReadonlyArray<{ readonly intentId: string; readonly data: Record<string, unknown> }>;
}

export async function recoverEstimateIntents(requestId: string, match: (intentId: string) => boolean): Promise<RecoveryResult> {
  const storageKey = ESTIMATE_INTENTS_KEY(requestId);
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey);
  } catch {
    return { unresolved: 0, succeeded: [] };
  }
  let unresolved = 0;
  const succeeded: { intentId: string; data: Record<string, unknown> }[] = [];
  for (const item of storedToRecover(raw, match)) {
    const res = await postJson(item.write.path, item.write.payload, item.key);
    const env = res.status === null ? null : res.envelope;
    const outcome = classifyWriteError(res.status, env?.error?.code ?? null, env?.error?.details);
    if (recoveryKeeps(outcome)) {
      unresolved += 1;
      continue;
    }
    if (outcome === 'success_refetch' && env?.data && typeof env.data === 'object') {
      succeeded.push({ intentId: item.intentId, data: env.data as Record<string, unknown> });
    }
    try {
      const next = withoutIntent(window.sessionStorage.getItem(storageKey), item.intentId);
      if (next === null) window.sessionStorage.removeItem(storageKey);
      else window.sessionStorage.setItem(storageKey, next);
    } catch {
      /* storage unavailable */
    }
  }
  return { unresolved, succeeded };
}
```

`src/components/tech/estimates/use-estimate-write.ts`:

```ts
'use client';

import { useCallback } from 'react';
import { useIdempotencyKey } from '@/hooks/use-idempotency-key';
import { mintKey } from '@/lib/http/idempotency-codes';
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';
import { outcomeEvent, type KeyPhase, type WriteOutcome } from '@/lib/tech/invoice-key-state';
import { ESTIMATE_INTENTS_KEY, type StoredWrite } from '@/lib/tech/estimate-intents';
import { postJson, type Envelope } from '@/components/tech/invoice/post-json';

export type EstimateSend =
  | { readonly sent: false }
  | { readonly sent: true; readonly status: number | null; readonly envelope: Envelope | null; readonly outcome: WriteOutcome; readonly resentOld: boolean };

/**
 * One keyed write (M3c spec §7): the M3b reducer, persisted under the estimate
 * storage key. `rehydrate: false` (default) for surfaces whose mount recovery
 * re-sends stored intents first (builder, estimate page, equipment card);
 * `rehydrate: true` for the equipment sheet, which restores its own intent and
 * re-sends it before Save unlocks (plan ruling 14). A double tap while `sent`
 * sends nothing; an `unknown` intent re-sends its OLD body and OLD key
 * (resentOld tells the caller). After the caller has refetched, it calls
 * `settle(outcome, landed)`.
 */
export function useEstimateWrite(requestId: string, intentId: string, rehydrate = false) {
  const { state, dispatch } = useIdempotencyKey({
    intentId, requestId, persist: true, storageKey: ESTIMATE_INTENTS_KEY, rehydrate,
  });

  const send = useCallback(async (path: string, payload: unknown): Promise<EstimateSend> => {
    const write: StoredWrite = { path, payload };
    const hash = JSON.stringify(write);
    dispatch({ type: 'open', bodyHash: hash, body: write, mint: mintKey });
    const pre = dispatch({ type: 'edit', bodyHash: hash, body: write, mint: mintKey });
    if (pre.phase !== 'armed' && pre.phase !== 'unknown') return { sent: false };
    const s = dispatch({ type: 'sent' });
    if (s.phase !== 'sent') return { sent: false };
    const stored = s.body as StoredWrite;
    const res = await postJson(stored.path, stored.payload, s.key);
    const envelope = res.status === null ? null : res.envelope;
    const outcome = classifyWriteError(res.status, envelope?.error?.code ?? null, envelope?.error?.details);
    return { sent: true, status: res.status, envelope, outcome, resentOld: s.bodyHash !== hash };
  }, [dispatch]);

  const settle = useCallback((outcome: WriteOutcome, landed: boolean): void => {
    const ev = outcomeEvent(outcome, landed);
    if (ev) dispatch({ type: ev });
  }, [dispatch]);

  return { phase: state.phase as KeyPhase, send, settle };
}
```

- [ ] **Step 5: The Estimates card** — `src/components/tech/estimates/estimates-card.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BILLING_LINE, STATUS_CHIP, estimatesCardVisible, priceSummary, soldOptionOf } from '@/lib/tech/estimate-display';
import type { TechEstimate, TechEstimateStatus, TechEstimatesView } from '@/lib/tech/estimate-view';
import { fetchEstimates } from './fetch-estimates';

const CHIP_TONE: Record<TechEstimateStatus, string> = {
  open: 'border-border bg-surface-raised text-foreground',
  sold: 'border-success-border bg-success-light text-success-strong',
  expired: 'border-border bg-surface-raised text-muted-foreground',
  declined: 'border-border bg-surface-raised text-muted-foreground',
};

function RowBody({ e, showOption }: { readonly e: TechEstimate; readonly showOption: boolean }) {
  const sold = e.status === 'sold' ? soldOptionOf(e) : null;
  return (
    <span className="min-w-0 flex-1 space-y-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium">{e.label}</span>
        <span className={`rounded-[3px] border px-1.5 py-0.5 text-[13px] font-medium ${CHIP_TONE[e.status]}`}>{STATUS_CHIP[e.status]}</span>
      </span>
      <span className="block font-mono text-[14px] tabular-nums">{priceSummary(e)}</span>
      {e.status === 'sold' && (
        <span className="block text-[13px] text-muted-foreground">
          {showOption && sold ? `${sold.name} · ` : ''}{BILLING_LINE[e.billing]}
        </span>
      )}
    </span>
  );
}

/**
 * The job page's Estimates card (M3c spec §2): native estimates newest first,
 * the lead's New estimate (or why not), helpers read-only. Refetches when
 * `refreshKey` changes (a status tap) and when the tab becomes visible.
 */
export function EstimatesCard({
  jobId,
  refreshKey,
  onLoaded,
}: {
  readonly jobId: string;
  readonly refreshKey: number;
  readonly onLoaded?: (view: TechEstimatesView | null) => void;
}) {
  const [view, setView] = useState<TechEstimatesView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'hidden' | 'error'>('loading');

  const load = useCallback(async () => {
    const r = await fetchEstimates(jobId);
    if (r.kind === 'ok') {
      setView(r.view);
      setState('ok');
      onLoaded?.(r.view);
    } else if (r.kind === 'hidden') {
      setState('hidden');
      onLoaded?.(null);
    } else {
      setState((s) => (s === 'ok' ? s : 'error'));
    }
  }, [jobId, onLoaded]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  // Nothing until the first answer: on a job before arrival the card would
  // otherwise flash a skeleton and then hide (review spec m11).
  if (state === 'loading' || state === 'hidden' || (view && !estimatesCardVisible(view))) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Estimates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === 'error' || !view ? (
          <p role="alert" className="text-[15px] text-danger-strong">Couldn&apos;t load this job&apos;s estimates.</p>
        ) : (
          <>
            {view.estimates.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">No estimates on this job yet.</p>
            ) : (
              <ul className="divide-y divide-border" aria-label="Estimates">
                {view.estimates.map((e) => (
                  <li key={e.id}>
                    {view.isLead ? (
                      <Link href={`/tech/jobs/${jobId}/estimates/${e.id}`} className="flex min-h-11 items-center gap-2 py-2 active:bg-accent">
                        <RowBody e={e} showOption={false} />
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      </Link>
                    ) : (
                      <div className="flex min-h-11 items-center gap-2 py-2">
                        <RowBody e={e} showOption />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {view.isLead && (view.canCreate ? (
              <Link
                href={`/tech/jobs/${jobId}/estimates/new`}
                className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-border-input bg-surface-raised px-4 text-[15px] font-medium active:bg-accent"
              >
                <Plus className="size-4" aria-hidden /> New estimate
              </Link>
            ) : (
              view.createBlockedReason && <p className="text-[15px] text-muted-foreground">{view.createBlockedReason}</p>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: The builder** — `src/app/tech/jobs/[id]/estimates/new/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { EstimateBuilderClient } from '@/components/tech/estimates/estimate-builder-client';
import { isUuid } from '@/lib/validation/uuid';

/** Field estimate builder (M3c spec §7.1). Next.js 16: params is a Promise. */
export default async function NewEstimatePage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return <EstimateBuilderClient jobId={id} />;
}
```

`src/components/tech/estimates/estimate-builder-client.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Minus, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import { mintKey } from '@/lib/http/idempotency-codes';
import { AddItemSheet, type PricebookHit } from '@/components/tech/invoice/add-item-sheet';
import type { WriteResult } from '@/components/tech/invoice/use-invoice-writes';
import {
  DRAFT_KEY, addLine, checkDraft, nextOptionNames, optionFooter, parseDraft, removeLine, serializeDraft, setQuantity, startOptions,
  type DraftOption,
} from '@/lib/tech/estimate-builder';
import { MAX_OPTION_NAME, MAX_OPTIONS, MAX_QUANTITY } from '@/lib/tech/estimate-input';
import { ESTIMATE_INTENT, estimateWriteCopy } from '@/lib/tech/estimate-intents';
import type { TechEstimatesView } from '@/lib/tech/estimate-view';
import { fetchEstimates } from './fetch-estimates';
import { recoverEstimateIntents } from './recover-intents';
import { useEstimateWrite } from './use-estimate-write';

const UNDO_MS = 5000;

type Undo = { readonly label: string; readonly snapshot: readonly DraftOption[] };

function clearDraft(jobId: string): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY(jobId));
  } catch {
    /* storage unavailable */
  }
}

/** The lead builds up to three options from the pricebook (M3c spec §7.1). */
export function EstimateBuilderClient({ jobId }: { readonly jobId: string }) {
  const router = useRouter();
  const [view, setView] = useState<TechEstimatesView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [options, setOptions] = useState<readonly DraftOption[]>(() => startOptions(mintKey()));
  const [restored, setRestored] = useState(false);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(true);
  /** retry: 'recover' = a reload left the last save unanswered (re-send it); 'save' = this save's answer is unknown. */
  const [message, setMessage] = useState<{ readonly text: string; readonly retry: 'recover' | 'save' | null } | null>(null);
  const create = useEstimateWrite(jobId, ESTIMATE_INTENT.create);

  const openSaved = useCallback((estimateId: unknown) => {
    clearDraft(jobId);
    router.push(typeof estimateId === 'string' ? `/tech/jobs/${jobId}/estimates/${estimateId}` : `/tech/jobs/${jobId}`);
  }, [jobId, router]);

  // Restore the draft once on mount, then keep it in sessionStorage.
  useEffect(() => {
    try {
      const draft = parseDraft(window.sessionStorage.getItem(DRAFT_KEY(jobId)));
      if (draft) setOptions(draft);
    } catch {
      /* storage unavailable */
    }
    setRestored(true);
  }, [jobId]);

  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(DRAFT_KEY(jobId), serializeDraft(options));
    } catch {
      /* storage unavailable */
    }
  }, [jobId, options, restored]);

  const recover = useCallback(async () => {
    setRecovering(true);
    const rec = await recoverEstimateIntents(jobId, (id) => id === ESTIMATE_INTENT.create);
    const saved = rec.succeeded.find((s) => s.intentId === ESTIMATE_INTENT.create);
    if (saved) {
      openSaved(saved.data.estimateId);
      return;
    }
    setMessage(rec.unresolved > 0 ? { text: 'Your last save may not have gone through. Try again.', retry: 'recover' } : null);
    setRecovering(false);
  }, [jobId, openSaved]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await recover();
      const r = await fetchEstimates(jobId);
      if (cancelled) return;
      if (r.kind === 'ok') {
        setView(r.view);
        setLoadState('ok');
      } else {
        setLoadState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, recover]);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

  const onAdd = useCallback(async (item: PricebookHit, quantity: number): Promise<WriteResult> => {
    if (!sheetFor) return { status: 'skipped', message: null };
    setOptions((prev) => addLine(prev, sheetFor, {
      key: mintKey(), pricebookItemId: item.id, name: item.name, unitPriceCents: item.priceCents, quantity,
    }));
    return { status: 'done', message: null };
  }, [sheetFor]);

  async function save(): Promise<void> {
    const check = checkDraft(options);
    if (!check.ok || saving || recovering) return;
    setSaving(true);
    setMessage(null);
    const r = await create.send(`/api/tech/jobs/${jobId}/estimates`, check.body);
    if (!r.sent) {
      setSaving(false);
      return;
    }
    create.settle(r.outcome, false);
    if (r.outcome === 'success_refetch') {
      openSaved((r.envelope?.data as { estimateId?: unknown } | undefined)?.estimateId);
      return;
    }
    if (r.outcome === 'already_saved_refetch') {
      openSaved(null);
      return;
    }
    setSaving(false);
    setMessage({
      text: estimateWriteCopy(r.outcome, r.envelope),
      retry: r.outcome === 'retry_same_key_after_refetch' || r.outcome === 'wait_then_refetch' ? 'save' : null,
    });
  }

  function removeOption(o: DraftOption): void {
    setUndo({ label: `Removed ${o.name.trim() || 'the option'}.`, snapshot: options });
    setOptions((prev) => nextOptionNames(prev, { type: 'remove', key: o.key }));
  }

  function removeItem(optionKey: string, lineKey: string, name: string): void {
    setUndo({ label: `Removed ${name}.`, snapshot: options });
    setOptions((prev) => removeLine(prev, optionKey, lineKey));
  }

  const back = (
    <Link href={`/tech/jobs/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
      <ArrowLeft className="size-4" /> Back to the job
    </Link>
  );

  if (loadState === 'loading' || !restored) {
    return <div className="space-y-4">{back}<Skeleton className="h-40 w-full rounded-xl" /></div>;
  }
  if (loadState === 'error' || !view) {
    return <div className="space-y-4">{back}<p role="alert" className="text-[15px] text-danger-strong">Couldn&apos;t load this job. Go back and try again.</p></div>;
  }
  if (!view.isLead) {
    return <div className="space-y-4">{back}<p className="text-[15px]">Only the lead technician can open this.</p></div>;
  }

  const check = checkDraft(options);
  const taxBps = view.taxBps;
  const locked = saving || recovering;

  return (
    <div className="space-y-4 pb-6">
      {back}
      <h2 className="text-[20px] font-semibold tracking-tight">New estimate</h2>
      {view.hasOtherSold && <p className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">This job already has a sold estimate.</p>}
      {!view.canCreate && view.createBlockedReason && <p className="text-[15px] text-muted-foreground">{view.createBlockedReason}</p>}

      {options.map((o, i) => (
        <Card key={o.key}>
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <Input
              aria-label={`Option ${i + 1} name`}
              value={o.name}
              maxLength={MAX_OPTION_NAME}
              disabled={locked}
              onChange={(e) => setOptions((prev) => nextOptionNames(prev, { type: 'rename', key: o.key, name: e.target.value }))}
              className="h-11 flex-1 rounded-xl text-[16px] font-medium"
            />
            {options.length >= 2 && (
              <Button variant="ghost" className="h-11 rounded-xl px-3 text-[15px]" disabled={locked} onClick={() => removeOption(o)}>
                Remove option
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {o.lines.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">No items yet.</p>
            ) : (
              <ul className="divide-y divide-border" aria-label={`${o.name} items`}>
                {o.lines.map((l) => (
                  <li key={l.key} className="flex min-h-14 items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 text-[15px] break-words">{l.name}</span>
                    <Button variant="outline" className="size-11 rounded-xl" aria-label={`Fewer ${l.name}`} disabled={locked || l.quantity <= 1}
                      onClick={() => setOptions((prev) => setQuantity(prev, o.key, l.key, l.quantity - 1))}>
                      <Minus className="size-4" />
                    </Button>
                    <span className="w-8 text-center font-mono text-[15px] tabular-nums" aria-label="Quantity">{l.quantity}</span>
                    <Button variant="outline" className="size-11 rounded-xl" aria-label={`More ${l.name}`} disabled={locked || l.quantity >= MAX_QUANTITY}
                      onClick={() => setOptions((prev) => setQuantity(prev, o.key, l.key, l.quantity + 1))}>
                      <Plus className="size-4" />
                    </Button>
                    <span className="w-24 text-right font-mono text-[15px] tabular-nums">{formatCentsExact(l.unitPriceCents * l.quantity)}</span>
                    <Button variant="ghost" className="size-11 rounded-xl text-muted-foreground" aria-label={`Remove ${l.name}`} disabled={locked}
                      onClick={() => removeItem(o.key, l.key, l.name)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={locked} onClick={() => setSheetFor(o.key)}>
              <Plus className="mr-1 size-4" /> Add item
            </Button>
            <p className="font-mono text-[13px] tabular-nums text-muted-foreground">{optionFooter(o.lines, taxBps)}</p>
          </CardContent>
        </Card>
      ))}

      {options.length < MAX_OPTIONS && (
        <Button variant="outline" className="h-11 w-full rounded-xl text-[15px]" disabled={locked}
          onClick={() => setOptions((prev) => nextOptionNames(prev, { type: 'add', key: mintKey() }))}>
          Add option
        </Button>
      )}

      {undo && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised px-3 py-2 text-[15px]">
          <span>{undo.label}</span>
          <Button variant="ghost" className="h-11 rounded-xl px-3 text-[15px]" onClick={() => { setOptions(undo.snapshot); setUndo(null); }}>Undo</Button>
        </div>
      )}

      {!check.ok && <p className="text-[15px] text-muted-foreground">{check.reason}</p>}
      {message && <p role="alert" className="text-[15px] text-danger-strong">{message.text}</p>}
      <Button className="h-12 w-full rounded-xl text-[16px]"
        // A retry re-sends the OLD body, so it stays tappable even while the edited draft is invalid (review spec m8).
        disabled={locked || (!message?.retry && (!check.ok || !view.canCreate))}
        onClick={() => void (message?.retry === 'recover' ? recover() : save())}>
        {saving || recovering ? 'Saving…' : message?.retry ? 'Try again' : 'Save estimate'}
      </Button>

      {confirmDiscard ? (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <p className="text-[15px]">Discard this draft?</p>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 flex-1 rounded-xl text-[15px]" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
            <Button variant="destructive" className="h-11 flex-1 rounded-xl text-[15px]"
              onClick={() => { clearDraft(jobId); setOptions(startOptions(mintKey())); setConfirmDiscard(false); }}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" className="h-11 w-full rounded-xl text-[15px]" disabled={locked} onClick={() => setConfirmDiscard(true)}>
          Discard draft
        </Button>
      )}

      <AddItemSheet open={sheetFor !== null} onClose={() => setSheetFor(null)} onAdd={onAdd} disabled={locked} />
    </div>
  );
}
```

  (`Try again` after an unknown save goes through `save()`: the intent is `unknown`, so `useEstimateWrite.send` re-sends the stored body with the stored key; edits made after an unknown save are only sent after the old body's answer — the M3b rule. `Try again` after a reload re-runs `recover()`, which re-sends the stored intent itself; a new key is never minted while a create may be in flight.)

- [ ] **Step 7: Look at it.** With the dev server and a throwaway org from the Task 6 probe recipe (request `arrived`, a customer, two pricebook items, a default tax rate row): open `/tech/jobs/<rid>/estimates/new` at 390 px (`node scripts/agent/screenshot-page.mjs /tech/jobs/<rid>/estimates/new 390 /tmp/m3c-8-builder.png --tech` with `MINT_ORG_ID=$ORG`), add a second option (names become Good / Better), add an item through the sheet with Done (the pending pick is added), check the footer math, reload (the draft comes back), Save (lands on `/tech/jobs/<rid>/estimates/<eid>`, which 404s until Task 9 is built — expected). Look at every screenshot. Delete the org.

- [ ] **Step 8: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/estimate-intents.ts src/lib/tech/estimate-intents.test.ts src/lib/tech/add-item-done.ts src/lib/tech/add-item-done.test.ts src/lib/tech/estimate-builder.ts src/lib/tech/estimate-builder.test.ts src/components/tech/estimates src/hooks/use-idempotency-key.ts src/components/tech/invoice/add-item-sheet.tsx "src/app/tech/jobs/[id]/estimates/new/page.tsx" && npx vitest run
git add src/lib/tech/estimate-intents.ts src/lib/tech/estimate-intents.test.ts src/lib/tech/add-item-done.ts src/lib/tech/add-item-done.test.ts src/lib/tech/estimate-builder.ts src/lib/tech/estimate-builder.test.ts src/components/tech/estimates/fetch-estimates.ts src/components/tech/estimates/recover-intents.ts src/components/tech/estimates/use-estimate-write.ts src/components/tech/estimates/estimates-card.tsx src/components/tech/estimates/estimate-builder-client.tsx "src/app/tech/jobs/[id]/estimates/new/page.tsx" src/hooks/use-idempotency-key.ts src/components/tech/invoice/add-item-sheet.tsx
git commit -m "$(cat <<'EOF'
feat(m3c): estimate builder, Estimates card, keyed writes under their own storage key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 9: The estimate page and the customer view

**Files:**
- Create: `src/lib/tech/customer-view-state.ts` (+ `customer-view-state.test.ts`), `src/lib/tech/estimate-page-copy.ts` (+ `estimate-page-copy.test.ts`), `src/components/tech/estimates/estimate-page-client.tsx`, `src/components/tech/estimates/customer-view.tsx`, `src/app/tech/jobs/[id]/estimates/[eid]/page.tsx`

**Interfaces:**
- Consumes: Task 3 `signatureNameOk`; Task 5 `TechEstimate`, `TechEstimatesView`, `canSell`, `soldBillingView`, `soldOptionOf`, `STATUS_CHIP`, `BILLING_LINE`, `SOLD_COPY`; Task 8 `fetchEstimates`, `recoverEstimateIntents`, `useEstimateWrite`, `ESTIMATE_INTENT`, `estimateWriteCopy`; portal `approveBlockedHint` (`@/lib/portal/estimate-decision`).
- Produces: `CUSTOMER_HASH = "#customer"`, `LayerState = { open: boolean }`, `LayerEvent`, `LayerEffect = "push" | "back" | "strip" | "strip_push" | "none"`, `LAYER_CLOSED`, `LAYER_OPEN`, `layerStep(state, event): { state; effect }`; `estimate-page-copy.ts`: `CUSTOMER_COPY`, `customerHeading`, `initialChoice`, `previewLines`, `showAllLabel`, `footerSummary`, `approveConfirmCopy`, `saleResult`, `afterCheck`, `approvedLine`, `DECLINE_COPY`, `SOLD_ACTIONS`; `EstimatePageClient({ jobId, estimateId })`, `CustomerView({ estimate, companyName, customerDisplayName, onApprove, onClose })`; page `/tech/jobs/[id]/estimates/[eid]`.

- [ ] **Step 1: Failing pure tests.**

`src/lib/tech/customer-view-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CUSTOMER_HASH, LAYER_CLOSED, LAYER_OPEN, layerStep } from "./customer-view-state";

describe("customer layer history (spec §7.2, plan ruling 13)", () => {
  it("Show to customer pushes one #customer entry; a second show does nothing", () => {
    expect(layerStep(LAYER_CLOSED, { type: "show" })).toEqual({ state: LAYER_OPEN, effect: "push" });
    expect(layerStep(LAYER_OPEN, { type: "show" })).toEqual({ state: LAYER_OPEN, effect: "none" });
  });
  it("Back (popstate without the hash) closes the layer onto the estimate page, nothing more", () => {
    expect(layerStep(LAYER_OPEN, { type: "popstate", hash: "" })).toEqual({ state: LAYER_CLOSED, effect: "none" });
    expect(layerStep(LAYER_CLOSED, { type: "popstate", hash: "" })).toEqual({ state: LAYER_CLOSED, effect: "none" });
  });
  it("Forward onto a stale #customer entry never reopens it", () => {
    expect(layerStep(LAYER_CLOSED, { type: "popstate", hash: CUSTOMER_HASH })).toEqual({ state: LAYER_CLOSED, effect: "strip" });
  });
  it("layerStep re-pushes #customer on a sellable reload so close is one back", () => {
    const reopened = layerStep(LAYER_CLOSED, { type: "mount", hash: CUSTOMER_HASH, sellable: true });
    expect(reopened).toEqual({ state: LAYER_OPEN, effect: "strip_push" });
    expect(layerStep(reopened.state, { type: "close" })).toEqual({ state: LAYER_CLOSED, effect: "back" });
    // React StrictMode mounts twice: the second mount must not push another entry.
    expect(layerStep(reopened.state, { type: "mount", hash: CUSTOMER_HASH, sellable: true })).toEqual({ state: LAYER_OPEN, effect: "none" });
  });
  it("a mount without the hash leaves the layer closed", () => {
    expect(layerStep(LAYER_CLOSED, { type: "mount", hash: "", sellable: true })).toEqual({ state: LAYER_CLOSED, effect: "none" });
  });
  it("layerStep strips the hash on a reload of an estimate that can no longer be sold", () => {
    expect(layerStep(LAYER_CLOSED, { type: "mount", hash: CUSTOMER_HASH, sellable: false })).toEqual({ state: LAYER_CLOSED, effect: "strip" });
  });
  it("every close of an open layer is a single back; closing a closed layer does nothing", () => {
    expect(layerStep(LAYER_OPEN, { type: "close" })).toEqual({ state: LAYER_CLOSED, effect: "back" });
    expect(layerStep(LAYER_CLOSED, { type: "close" })).toEqual({ state: LAYER_CLOSED, effect: "none" });
  });
});
```

`src/lib/tech/estimate-page-copy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  afterCheck, approveConfirmCopy, approvedLine, CUSTOMER_COPY, customerHeading, footerSummary, initialChoice, previewLines,
  saleResult, showAllLabel,
} from "./estimate-page-copy";

describe("customer view copy and rules (spec §7.2)", () => {
  it("heading", () => {
    expect(customerHeading("Pat Probe")).toBe("Estimate for Pat Probe");
    expect(customerHeading(null)).toBe("Your estimate");
  });
  it("radio pre-select: only a single option is pre-selected", () => {
    expect(initialChoice([{ id: "a" }])).toBe("a");
    expect(initialChoice([{ id: "a" }, { id: "b" }])).toBeNull();
  });
  it("cards show the first 3 lines; Show all N items beyond that", () => {
    expect(previewLines([1, 2, 3, 4], false)).toEqual([1, 2, 3]);
    expect(previewLines([1, 2, 3, 4], true)).toEqual([1, 2, 3, 4]);
    expect(showAllLabel(3)).toBeNull();
    expect(showAllLabel(5)).toBe("Show all 5 items");
  });
  it("footer and confirm copy", () => {
    expect(footerSummary(null)).toBe("Choose an option");
    expect(footerSummary({ name: "Better", totalCents: 481_200 })).toBe("Better · $4,812.00");
    expect(approveConfirmCopy("Better", 481_200)).toBe("Approve Better for $4,812.00?");
  });
  it("sale result: success, check by refetch, or the customer-safe failure", () => {
    expect(saleResult("success_refetch")).toBe("success");
    expect(saleResult("already_saved_refetch")).toBe("success");
    expect(saleResult("retry_same_key_after_refetch")).toBe("check");
    expect(saleResult("wait_then_refetch")).toBe("check");
    expect(saleResult("show_message_refetch")).toBe("failed");
    expect(saleResult("spent_new_key")).toBe("failed");
  });
  it("after an unknown result: success only when THIS technician sold THIS option", () => {
    expect(afterCheck({ status: "sold", soldByMe: true, soldOptionId: "b" }, "b")).toBe(true);
    expect(afterCheck({ status: "sold", soldByMe: true, soldOptionId: "a" }, "b")).toBe(false);
    expect(afterCheck({ status: "sold", soldByMe: false, soldOptionId: "b" }, "b")).toBe(false);
    expect(afterCheck({ status: "open", soldByMe: false, soldOptionId: null }, "b")).toBe(false);
    expect(afterCheck(null, "b")).toBe(false);
  });
  it("exact customer-facing strings", () => {
    expect(CUSTOMER_COPY.failed).toBe("Something went wrong. Please hand the phone back to your technician.");
    expect(CUSTOMER_COPY.approved).toBe("Approved. Thank you.");
    expect(CUSTOMER_COPY.consent).toBe("By typing your name and approving, you authorize the selected work.");
    expect(CUSTOMER_COPY.nameLabel).toBe("Type your full name to sign");
    expect(CUSTOMER_COPY.handBackPrompt).toBe("Please hand the phone back to your technician.");
  });
  it("technician's approved line in the business timezone", () => {
    expect(approvedLine("2026-11-06T19:05:00Z", "Better")).toBe("Approved · Nov 6, 2:05 PM · Better");
  });
});
```

  Run: `npx vitest run src/lib/tech/customer-view-state.test.ts src/lib/tech/estimate-page-copy.test.ts` → FAIL.

- [ ] **Step 2: Implement the pure modules.**

`src/lib/tech/customer-view-state.ts`:

```ts
/**
 * The customer layer's history machine (M3c spec §7.2, plan ruling 13). Pure:
 * the estimate page applies `effect` with window.history — push =
 * pushState('#customer'); back = history.back(); strip = replaceState without
 * the hash; strip_push = strip, then push. Next 16 keeps its router state
 * across native pushState / replaceState.
 *
 * An open layer always owns exactly one '#customer' entry: Show to customer
 * pushes it, and a reload that reopens the layer strips the reloaded entry and
 * pushes a fresh one. So every close is one Back onto the estimate page, never
 * further.
 */
export const CUSTOMER_HASH = "#customer";

export type LayerState = { readonly open: boolean };
export type LayerEvent =
  | { readonly type: "show" }
  | { readonly type: "mount"; readonly hash: string; readonly sellable: boolean }
  | { readonly type: "popstate"; readonly hash: string }
  | { readonly type: "close" };
export type LayerEffect = "push" | "back" | "strip" | "strip_push" | "none";

export const LAYER_CLOSED: LayerState = { open: false };
export const LAYER_OPEN: LayerState = { open: true };

export function layerStep(s: LayerState, e: LayerEvent): { state: LayerState; effect: LayerEffect } {
  switch (e.type) {
    case "show":
      return s.open ? { state: s, effect: "none" } : { state: LAYER_OPEN, effect: "push" };
    case "mount":
      if (s.open) return { state: s, effect: "none" }; // StrictMode's second mount
      if (e.hash !== CUSTOMER_HASH) return { state: LAYER_CLOSED, effect: "none" };
      return e.sellable ? { state: LAYER_OPEN, effect: "strip_push" } : { state: LAYER_CLOSED, effect: "strip" };
    case "popstate":
      if (e.hash === CUSTOMER_HASH) return s.open ? { state: s, effect: "none" } : { state: LAYER_CLOSED, effect: "strip" };
      return { state: LAYER_CLOSED, effect: "none" };
    case "close":
      return s.open ? { state: LAYER_CLOSED, effect: "back" } : { state: s, effect: "none" };
  }
}
```

`src/lib/tech/estimate-page-copy.ts`:

```ts
/**
 * Copy and small rules for the technician estimate page and the customer view
 * (M3c spec §7.2–§7.3). The customer view never shows server text: any failure
 * reads CUSTOMER_COPY.failed and the technician sees the reason afterwards.
 */
import { formatCentsExact } from "@/lib/admin/money-format";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import type { WriteOutcome } from "./invoice-key-state";
import type { TechEstimate, TechEstimateOption } from "./estimate-view";

export const CUSTOMER_COPY = {
  choose: "Choose an option",
  nameLabel: "Type your full name to sign",
  consent: "By typing your name and approving, you authorize the selected work.",
  approve: "Approve",
  approving: "Approving…",
  goBack: "Go back",
  notNow: "Not now",
  checking: "Checking…",
  approved: "Approved. Thank you.",
  handBack: "Hand back to technician",
  failed: "Something went wrong. Please hand the phone back to your technician.",
  handBackPrompt: "Please hand the phone back to your technician.",
  imTech: "I'm the technician",
} as const;

export const DECLINE_COPY = {
  button: "Customer declined",
  confirm: "Mark this estimate as declined?",
  yes: "Mark declined",
  no: "Go back",
} as const;

export const SOLD_ACTIONS = {
  show: "Show to customer",
  add: "Add to the job's invoice",
  adding: "Adding…",
  leave: "Leave for the office",
  openInvoice: "Open invoice",
} as const;

export function customerHeading(customerDisplayName: string | null): string {
  return customerDisplayName ? `Estimate for ${customerDisplayName}` : "Your estimate";
}

/** The portal's rule: nothing pre-selected with two or more options. */
export function initialChoice(options: readonly { readonly id: string }[]): string | null {
  return options.length === 1 ? options[0]!.id : null;
}

export function previewLines<T>(lines: readonly T[], expanded: boolean): readonly T[] {
  return expanded ? lines : lines.slice(0, 3);
}

export function showAllLabel(count: number): string | null {
  return count > 3 ? `Show all ${count} items` : null;
}

export function footerSummary(o: Pick<TechEstimateOption, "name" | "totalCents"> | null): string {
  return o ? `${o.name} · ${formatCentsExact(o.totalCents)}` : CUSTOMER_COPY.choose;
}

export function approveConfirmCopy(name: string, totalCents: number): string {
  return `Approve ${name} for ${formatCentsExact(totalCents)}?`;
}

/** First answer to a sell: success, check by refetch (unknown), or failed. */
export function saleResult(outcome: WriteOutcome): "success" | "check" | "failed" {
  if (outcome === "success_refetch" || outcome === "already_saved_refetch") return "success";
  if (outcome === "retry_same_key_after_refetch" || outcome === "wait_then_refetch") return "check";
  return "failed";
}

export function afterCheck(e: Pick<TechEstimate, "status" | "soldByMe" | "soldOptionId"> | null, chosenOptionId: string): boolean {
  return e !== null && e.status === "sold" && e.soldByMe && e.soldOptionId === chosenOptionId;
}

export function approvedLine(signedAt: string | null, optionName: string | null, timeZone: string = BUSINESS_BASE_LOCATION.timezone): string {
  const when = signedAt
    ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(signedAt))
    : null;
  return ["Approved", when, optionName].filter(Boolean).join(" · ");
}
```

  Run the two test files → PASS.

- [ ] **Step 3: The page.** `src/app/tech/jobs/[id]/estimates/[eid]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { EstimatePageClient } from '@/components/tech/estimates/estimate-page-client';
import { isUuid } from '@/lib/validation/uuid';

/** The lead's estimate page with the #customer layer (M3c spec §7.2–§7.3). Next.js 16: params is a Promise. */
export default async function TechEstimatePage({ params }: { readonly params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await params;
  if (!isUuid(id) || !isUuid(eid)) notFound();
  return <EstimatePageClient jobId={id} estimateId={eid} />;
}
```

- [ ] **Step 4: The customer view** — `src/components/tech/estimates/customer-view.tsx`:

```tsx
'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCentsExact } from '@/lib/admin/money-format';
import { approveBlockedHint } from '@/lib/portal/estimate-decision';
import { MAX_SIGNATURE, signatureNameOk } from '@/lib/tech/estimate-input';
import {
  CUSTOMER_COPY, approveConfirmCopy, customerHeading, footerSummary, initialChoice, previewLines, showAllLabel,
} from '@/lib/tech/estimate-page-copy';
import type { TechEstimate } from '@/lib/tech/estimate-view';

type Screen = 'choose' | 'confirm' | 'sending' | 'checking' | 'success' | 'failed' | 'handback';

const MONEY = 'font-mono tabular-nums';

function Total({ label, cents, strong = false }: { readonly label: string; readonly cents: number; readonly strong?: boolean }) {
  return (
    <span className={`flex items-baseline justify-between gap-3 ${strong ? 'text-[17px] font-semibold' : 'text-[15px] text-muted-foreground'}`}>
      <span>{label}</span>
      <span className={MONEY}>{formatCentsExact(cents)}</span>
    </span>
  );
}

/**
 * The full-screen customer layer (M3c spec §7.2): opaque over the technician
 * header, Guide, Sign out and location card; pick an option, type a name,
 * approve, hand back. Shows no server text.
 */
export function CustomerView({
  estimate,
  companyName,
  customerDisplayName,
  onApprove,
  onClose,
}: {
  readonly estimate: TechEstimate;
  readonly companyName: string | null;
  readonly customerDisplayName: string | null;
  readonly onApprove: (optionId: string, signatureName: string, onChecking: () => void) => Promise<'success' | 'failed'>;
  readonly onClose: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(() => initialChoice(estimate.options));
  const [name, setName] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [screen, setScreen] = useState<Screen>('choose');
  const [typing, setTyping] = useState(false);
  const chosen = estimate.options.find((o) => o.id === choice) ?? null;
  const nameOk = signatureNameOk(name);
  const hint = approveBlockedHint(chosen !== null, nameOk);
  const sending = screen === 'sending' || screen === 'checking';
  const choosing = screen === 'choose';

  async function confirm(): Promise<void> {
    if (!chosen || !nameOk || sending) return;
    setScreen('sending');
    setScreen(await onApprove(chosen.id, name.trim(), () => setScreen('checking')));
  }

  const layer = (children: ReactNode) => (
    <div role="dialog" aria-modal="true" aria-label={customerHeading(customerDisplayName)} className="fixed inset-0 z-50 bg-canvas">
      <div className="mx-auto flex h-dvh w-full max-w-md flex-col">{children}</div>
    </div>
  );

  const endScreen = (text: string, action: string) => layer(
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <p role="status" className="text-[20px] font-semibold">{text}</p>
      <Button className="h-12 w-full rounded-xl text-[16px]" onClick={onClose}>{action}</Button>
    </div>,
  );

  if (screen === 'success') return endScreen(CUSTOMER_COPY.approved, CUSTOMER_COPY.handBack);
  if (screen === 'failed') return endScreen(CUSTOMER_COPY.failed, CUSTOMER_COPY.handBack);
  if (screen === 'handback') return endScreen(CUSTOMER_COPY.handBackPrompt, CUSTOMER_COPY.imTech);

  return layer(
    <>
      <header className="flex items-start justify-between gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="min-w-0">
          {companyName && <p className="truncate text-[13px] text-muted-foreground">{companyName}</p>}
          <h2 className="text-[20px] font-semibold tracking-tight">{customerHeading(customerDisplayName)}</h2>
        </div>
        <Button variant="ghost" className="h-11 shrink-0 rounded-xl px-3 text-[15px]" disabled={sending} onClick={() => setScreen('handback')}>
          {CUSTOMER_COPY.notNow}
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <h3 className="text-[17px] font-semibold">{CUSTOMER_COPY.choose}</h3>
        <div role="radiogroup" aria-label={CUSTOMER_COPY.choose} className="space-y-3">
          {estimate.options.map((o) => {
            const selected = o.id === choice;
            const open = expanded.has(o.id);
            const more = showAllLabel(o.lines.length);
            return (
              <div key={o.id} className={`rounded-xl border bg-surface ${selected ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}>
                <label className="flex cursor-pointer gap-3 p-4">
                  <input
                    type="radio"
                    name="estimate-option"
                    value={o.id}
                    checked={selected}
                    disabled={!choosing}
                    onChange={() => setChoice(o.id)}
                    className="mt-1 size-5 shrink-0 accent-primary"
                  />
                  <span className="block min-w-0 flex-1 space-y-2">
                    <span className="block text-[17px] font-semibold">{o.name}</span>
                    <span className="block space-y-1">
                      {previewLines(o.lines, open).map((l) => (
                        <span key={l.id} className="flex items-baseline justify-between gap-3 text-[15px]">
                          <span className="min-w-0 break-words">{l.quantity > 1 ? `${l.name} × ${l.quantity}` : l.name}</span>
                          <span className={MONEY}>{formatCentsExact(l.lineTotalCents)}</span>
                        </span>
                      ))}
                    </span>
                    <span className="block space-y-0.5 border-t border-border pt-2">
                      <Total label="Subtotal" cents={o.subtotalCents} />
                      <Total label="Tax" cents={o.taxCents} />
                      <Total label="Total" cents={o.totalCents} strong />
                    </span>
                  </span>
                </label>
                {more && !open && (
                  <button
                    type="button"
                    className="min-h-11 w-full border-t border-border px-4 text-left text-[15px] text-link"
                    onClick={() => setExpanded((prev) => new Set(prev).add(o.id))}
                  >
                    {more}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <label className="block space-y-1.5 pt-2">
          <span className="text-[15px] font-medium">{CUSTOMER_COPY.nameLabel}</span>
          <Input
            value={name}
            maxLength={MAX_SIGNATURE}
            autoComplete="name"
            autoCapitalize="words"
            disabled={!choosing}
            onChange={(e) => setName(e.target.value)}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            className="h-12 rounded-xl text-[17px]"
          />
        </label>
        <p className="text-[13px] text-muted-foreground">{CUSTOMER_COPY.consent}</p>
        {hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}
      </div>

      {!typing && (
        <div className="border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {choosing ? (
            <div className="flex items-center gap-3">
              <p className={`min-w-0 flex-1 truncate text-[15px] ${MONEY}`}>{footerSummary(chosen)}</p>
              <Button className="h-12 rounded-xl px-6 text-[16px]" disabled={!chosen || !nameOk} onClick={() => setScreen('confirm')}>
                {CUSTOMER_COPY.approve}
              </Button>
            </div>
          ) : screen === 'checking' ? (
            <p role="status" className="py-3 text-center text-[15px]">{CUSTOMER_COPY.checking}</p>
          ) : chosen ? (
            <div className="space-y-3">
              <p className="text-[17px] font-semibold">{approveConfirmCopy(chosen.name, chosen.totalCents)}</p>
              <div className="flex gap-2">
                <Button variant="outline" className="h-12 flex-1 rounded-xl text-[16px]" disabled={sending} onClick={() => setScreen('choose')}>
                  {CUSTOMER_COPY.goBack}
                </Button>
                <Button className="h-12 flex-1 rounded-xl text-[16px]" disabled={sending} onClick={() => void confirm()}>
                  {screen === 'sending' ? CUSTOMER_COPY.approving : CUSTOMER_COPY.approve}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </>,
  );
}
```

- [ ] **Step 5: The technician estimate page** — `src/components/tech/estimates/estimate-page-client.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import { CUSTOMER_HASH, LAYER_CLOSED, layerStep, type LayerEffect, type LayerEvent, type LayerState } from '@/lib/tech/customer-view-state';
import { DECLINE_COPY, SOLD_ACTIONS, afterCheck, approvedLine, saleResult } from '@/lib/tech/estimate-page-copy';
import { BILLING_LINE, SOLD_COPY, STATUS_CHIP, canSell, soldBillingView, soldOptionOf } from '@/lib/tech/estimate-display';
import { ESTIMATE_INTENT, estimateWriteCopy } from '@/lib/tech/estimate-intents';
import type { TechEstimate, TechEstimateOption, TechEstimatesView } from '@/lib/tech/estimate-view';
import { CustomerView } from './customer-view';
import { fetchEstimates } from './fetch-estimates';
import { recoverEstimateIntents } from './recover-intents';
import { useEstimateWrite } from './use-estimate-write';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MONEY = 'font-mono tabular-nums';

function findEstimate(view: TechEstimatesView | null, eid: string): TechEstimate | null {
  return view?.estimates.find((x) => x.id === eid) ?? null;
}

function runEffect(effect: LayerEffect): void {
  const strip = () => window.history.replaceState(null, '', window.location.pathname + window.location.search);
  if (effect === 'push') window.history.pushState(null, '', CUSTOMER_HASH);
  else if (effect === 'back') window.history.back();
  else if (effect === 'strip') strip();
  else if (effect === 'strip_push') {
    // A reload reopened the layer: give it its own entry so Back closes it (plan ruling 13).
    strip();
    window.history.pushState(null, '', CUSTOMER_HASH);
  }
}

function OptionBlock({ o }: { readonly o: TechEstimateOption }) {
  return (
    <section className="space-y-2 rounded-xl border border-border p-3" aria-label={o.name}>
      <h3 className="text-[15px] font-semibold">{o.name}</h3>
      <ul className="space-y-1">
        {o.lines.map((l) => (
          <li key={l.id} className="flex items-baseline justify-between gap-3 text-[15px]">
            <span className="min-w-0 break-words">{l.name} <span className={`${MONEY} text-[13px] text-muted-foreground`}>{l.quantity} × {formatCentsExact(l.unitPriceCents)}</span></span>
            <span className={MONEY}>{formatCentsExact(l.lineTotalCents)}</span>
          </li>
        ))}
      </ul>
      <p className={`${MONEY} text-[13px] text-muted-foreground`}>
        Subtotal {formatCentsExact(o.subtotalCents)} · Tax {formatCentsExact(o.taxCents)} · Total {formatCentsExact(o.totalCents)}
      </p>
    </section>
  );
}

/** The lead's estimate page (M3c spec §7.3) and the #customer layer (§7.2). */
export function EstimatePageClient({ jobId, estimateId }: { readonly jobId: string; readonly estimateId: string }) {
  const router = useRouter();
  const eid = estimateId.toLowerCase();
  const [view, setView] = useState<TechEstimatesView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error' | 'hidden'>('loading');
  const [recovering, setRecovering] = useState(true);
  /** Stored intents a reload left unanswered: the page stays locked until they are (M3b rule). */
  const [unresolved, setUnresolved] = useState(0);
  const [layer, setLayer] = useState<LayerState>(LAYER_CLOSED);
  const layerRef = useRef<LayerState>(LAYER_CLOSED);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [busy, setBusy] = useState<'bill' | 'decline' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [added, setAdded] = useState<{ readonly hasMaterials: boolean } | null>(null);
  const { send: sellSend, settle: sellSettle } = useEstimateWrite(jobId, ESTIMATE_INTENT.sell(eid));
  const { send: billSend, settle: billSettle } = useEstimateWrite(jobId, ESTIMATE_INTENT.bill(eid));
  const { send: declineSend, settle: declineSettle } = useEstimateWrite(jobId, ESTIMATE_INTENT.decline(eid));

  const refetch = useCallback(async (): Promise<TechEstimatesView | null> => {
    const r = await fetchEstimates(jobId);
    if (r.kind === 'ok') {
      setView(r.view);
      setLoadState('ok');
      return r.view;
    }
    setLoadState((s) => (r.kind === 'hidden' ? 'hidden' : s === 'ok' ? s : 'error'));
    return null;
  }, [jobId, setView, setLoadState]); // setters listed: react-hooks/preserve-manual-memoization

  const dispatchLayer = useCallback((e: LayerEvent) => {
    const prev = layerRef.current;
    const step = layerStep(prev, e);
    layerRef.current = step.state;
    setLayer(step.state);
    runEffect(step.effect);
    if (prev.open && !step.state.open) void refetch(); // the layer closed: show the technician the real state
  }, [refetch, setLayer]);

  /** Re-send this estimate's stored intents (old body, old key); state only changes after the await. */
  const runRecovery = useCallback(async (): Promise<TechEstimatesView | null> => {
    const rec = await recoverEstimateIntents(jobId, (id) => id.endsWith(`:${eid}`));
    const v = await refetch();
    setUnresolved(rec.unresolved);
    setRecovering(false);
    return v;
  }, [jobId, eid, refetch, setUnresolved, setRecovering]);

  // Mount: recovery (a reload during Approving…), then load, then the #customer rule.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const v = await runRecovery();
      if (cancelled) return;
      dispatchLayer({ type: 'mount', hash: window.location.hash, sellable: v !== null && canSell(v, findEstimate(v, eid)) });
    })();
    return () => {
      cancelled = true;
    };
  }, [eid, runRecovery, dispatchLayer]);

  useEffect(() => {
    const onPop = () => dispatchLayer({ type: 'popstate', hash: window.location.hash });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [dispatchLayer]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch]);

  const approve = useCallback(async (optionId: string, signatureName: string, onChecking: () => void): Promise<'success' | 'failed'> => {
    const r = await sellSend(`/api/tech/jobs/${jobId}/estimates/${eid}/sell`, { optionId, signatureName });
    if (!r.sent) {
      // A sell for this estimate is still in flight: let the refetch decide, never a premature failure (review spec m10).
      onChecking();
      return afterCheck(findEstimate(await refetch(), eid), optionId) ? 'success' : 'failed';
    }
    const first = saleResult(r.outcome);
    if (first === 'success') {
      sellSettle(r.outcome, false);
      return 'success';
    }
    if (first === 'check') {
      onChecking();
      if (r.outcome === 'wait_then_refetch') await sleep(2000);
      const ok = afterCheck(findEstimate(await refetch(), eid), optionId);
      sellSettle(r.outcome, ok);
      return ok ? 'success' : 'failed';
    }
    sellSettle(r.outcome, false);
    return 'failed';
  }, [jobId, eid, sellSend, sellSettle, refetch]);

  async function addToInvoice(): Promise<void> {
    setBusy('bill');
    setNote(null);
    setAdded(null);
    const r = await billSend(`/api/tech/jobs/${jobId}/estimates/${eid}/bill`, {});
    if (!r.sent) {
      setBusy(null);
      return;
    }
    const code = r.envelope?.error?.code ?? null;
    if (r.outcome === 'success_refetch') {
      billSettle(r.outcome, false);
      setAdded({ hasMaterials: (r.envelope?.data as { hasMaterials?: boolean } | undefined)?.hasMaterials === true });
      await refetch();
    } else if (code === 'ALREADY_BILLED') {
      // Rendered as the billed state after the refetch, never as an error (spec §5.3 step 4).
      billSettle(r.outcome, false);
      await refetch();
    } else if (r.outcome === 'retry_same_key_after_refetch' || r.outcome === 'wait_then_refetch') {
      if (r.outcome === 'wait_then_refetch') await sleep(2000);
      const e = findEstimate(await refetch(), eid);
      const landed = e !== null && e.billing !== 'none';
      billSettle(r.outcome, landed);
      if (!landed) setNote(estimateWriteCopy(r.outcome, r.envelope));
    } else {
      billSettle(r.outcome, false);
      await refetch();
      setNote(estimateWriteCopy(r.outcome, r.envelope));
    }
    setBusy(null);
  }

  async function markDeclined(): Promise<void> {
    setBusy('decline');
    setNote(null);
    const r = await declineSend(`/api/tech/jobs/${jobId}/estimates/${eid}/decline`, {});
    if (!r.sent) {
      setBusy(null);
      return;
    }
    if (r.outcome === 'retry_same_key_after_refetch' || r.outcome === 'wait_then_refetch') {
      if (r.outcome === 'wait_then_refetch') await sleep(2000);
      const e = findEstimate(await refetch(), eid);
      const landed = e?.status === 'declined';
      declineSettle(r.outcome, landed);
      if (!landed) setNote(estimateWriteCopy(r.outcome, r.envelope));
    } else {
      declineSettle(r.outcome, false);
      await refetch();
      if (r.outcome !== 'success_refetch') setNote(estimateWriteCopy(r.outcome, r.envelope));
    }
    setConfirmDecline(false);
    setBusy(null);
  }

  const back = (
    <Link href={`/tech/jobs/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
      <ArrowLeft className="size-4" /> Back to the job
    </Link>
  );
  const e = findEstimate(view, eid);

  if (loadState === 'loading') return <div className="space-y-4">{back}<Skeleton className="h-48 w-full rounded-xl" /></div>;
  if (loadState !== 'ok' || !view) {
    return <div className="space-y-4">{back}<p role="alert" className="text-[15px] text-danger-strong">Couldn&apos;t load this estimate. Go back and try again.</p></div>;
  }
  if (!view.isLead) return <div className="space-y-4">{back}<p className="text-[15px]">Only the lead technician can open this.</p></div>;
  if (!e) return <div className="space-y-4">{back}<p className="text-[15px]">That estimate isn&apos;t on this job.</p></div>;

  const locked = recovering || unresolved > 0 || busy !== null;
  const sellable = canSell(view, e);
  const sold = e.status === 'sold' ? soldOptionOf(e) : null;
  const billingView = e.status === 'sold' ? soldBillingView(e, view) : null;

  return (
    <div className="space-y-4 pb-6">
      {back}
      {unresolved > 0 && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">
          <span>Your last tap may not have saved. Try again.</span>
          <Button variant="outline" className="h-11 shrink-0 rounded-xl px-4 text-[15px]" disabled={recovering}
            onClick={() => { setRecovering(true); void runRecovery(); }}>
            Try again
          </Button>
        </div>
      )}
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-[17px]">{e.label}</CardTitle>
          <p className="text-[13px] font-medium text-muted-foreground">{STATUS_CHIP[e.status]}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {e.status === 'sold' && sold ? (
            <>
              <p className="text-[15px] font-medium">{approvedLine(e.signedAt, sold.name)}</p>
              <OptionBlock o={sold} />
              {billingView?.kind === 'add' && (
                <div className="space-y-2">
                  {billingView.newInvoice && <p className="text-[15px] text-muted-foreground">{SOLD_COPY.newInvoice}</p>}
                  <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => void addToInvoice()}>
                    {busy === 'bill' ? SOLD_ACTIONS.adding : SOLD_ACTIONS.add}
                  </Button>
                  <Button variant="outline" className="h-11 w-full rounded-xl text-[15px]" disabled={locked} onClick={() => router.push(`/tech/jobs/${jobId}`)}>
                    {SOLD_ACTIONS.leave}
                  </Button>
                </div>
              )}
              {billingView?.kind === 'locked' && <p className="text-[15px]">{SOLD_COPY.locked}</p>}
              {billingView?.kind === 'office' && <p className="text-[15px]">{BILLING_LINE.office}</p>}
              {billingView?.kind === 'closed' && <p className="text-[15px] text-muted-foreground">{BILLING_LINE.none}</p>}
              {billingView?.kind === 'job' && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[15px]">{BILLING_LINE.job}</p>
                  <Link href={`/tech/jobs/${jobId}/invoice`} className="inline-flex h-11 items-center rounded-xl border border-border-input bg-surface-raised px-4 text-[15px] font-medium active:bg-accent">
                    {SOLD_ACTIONS.openInvoice}
                  </Link>
                </div>
              )}
              {added && (
                <div role="status" className="space-y-1 rounded-md border border-success-border bg-success-light px-3 py-2 text-[15px]">
                  <p>{SOLD_COPY.added}</p>
                  {added.hasMaterials && <p>{SOLD_COPY.overlap}</p>}
                </div>
              )}
            </>
          ) : (
            <>
              {e.options.map((o) => <OptionBlock key={o.id} o={o} />)}
              {e.status === 'open' && e.hasApprovalLink && <p className="text-[13px] text-muted-foreground">{SOLD_COPY.approvalLink}</p>}
              {sellable && !confirmDecline && (
                <div className="space-y-2">
                  <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => dispatchLayer({ type: 'show' })}>
                    {SOLD_ACTIONS.show}
                  </Button>
                  <Button variant="outline" className="h-11 w-full rounded-xl text-[15px]" disabled={locked} onClick={() => setConfirmDecline(true)}>
                    {DECLINE_COPY.button}
                  </Button>
                </div>
              )}
              {sellable && confirmDecline && (
                <div className="space-y-2 rounded-xl border border-border p-3">
                  <p className="text-[15px]">{DECLINE_COPY.confirm}</p>
                  <div className="flex gap-2">
                    <Button variant="outline" className="h-11 flex-1 rounded-xl text-[15px]" disabled={locked} onClick={() => setConfirmDecline(false)}>{DECLINE_COPY.no}</Button>
                    <Button variant="destructive" className="h-11 flex-1 rounded-xl text-[15px]" disabled={locked} onClick={() => void markDeclined()}>{DECLINE_COPY.yes}</Button>
                  </div>
                </div>
              )}
            </>
          )}
          {note && <p role="alert" className="text-[15px] text-danger-strong">{note}</p>}
        </CardContent>
      </Card>

      {layer.open && (
        <CustomerView
          estimate={e}
          companyName={view.companyName}
          customerDisplayName={view.customerDisplayName}
          onApprove={approve}
          onClose={() => dispatchLayer({ type: 'close' })}
        />
      )}
    </div>
  );
}
```

  (The layer keeps rendering the estimate it opened on, even after a refetch marks it sold, so the success screen stays until the technician takes the phone back.)

- [ ] **Step 6: Look at it and walk the layer.** Throwaway org (Task 6 recipe), a two-option open estimate made through the builder: 390 px screenshots of the estimate page, the layer with nothing selected (Approve disabled, the hint shows), the confirm, the success screen, the hand-back screen. In a Playwright script with the minted cookie: tap Show to customer → `document.elementFromPoint(20, 20)` and the Sign out button's center both land inside `[role=dialog]`; `history.back()` → the layer is gone and the URL has no hash and is still the estimate page; Show to customer → reload → the layer is back → `history.back()` → the layer is gone, the URL has no hash and is still the estimate page (ruling 13) → Show to customer again; choose Better, type a name, Approve, confirm → "Approved. Thank you." → Hand back → the page shows "Approved · … · Better" and `Add to the job's invoice`. Delete the org.

- [ ] **Step 7: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/customer-view-state.ts src/lib/tech/customer-view-state.test.ts src/lib/tech/estimate-page-copy.ts src/lib/tech/estimate-page-copy.test.ts src/components/tech/estimates/estimate-page-client.tsx src/components/tech/estimates/customer-view.tsx "src/app/tech/jobs/[id]/estimates/[eid]/page.tsx" && npx vitest run
git add src/lib/tech/customer-view-state.ts src/lib/tech/customer-view-state.test.ts src/lib/tech/estimate-page-copy.ts src/lib/tech/estimate-page-copy.test.ts src/components/tech/estimates/estimate-page-client.tsx src/components/tech/estimates/customer-view.tsx "src/app/tech/jobs/[id]/estimates/[eid]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(m3c): estimate page and the customer view (#customer layer, approve, hand back, bill)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 10: Equipment card and sheet, job page wiring, materials overlap, office retired units

**Files:**
- Create: `src/lib/tech/material-overlap.ts` (+ `material-overlap.test.ts`), `src/lib/tech/equipment-display.ts` (+ `equipment-display.test.ts`), `src/components/tech/equipment/equipment-card.tsx`, `src/components/tech/equipment/equipment-sheet.tsx`
- Modify: `src/components/tech/tech-job-detail-client.tsx` (imports; state near line 100; `onStatusChanged` ~line 455; after `<TechJobSummary>` ~line 450; the material form's warning ~line 576; after the Materials card ~line 615), `src/app/admin/(dashboard)/customers/[id]/page.tsx` (Equipment `SectionCard` ~lines 630–700)

**Interfaces:**
- Consumes: Task 4 `TechEquipmentUnit`, `TechEquipmentView`, `parseEquipmentInput`, `todayInZone`, `EQUIPMENT_ERROR_COPY`, `EquipmentRecord.retiredAt` / `replacedByEquipmentId` / `CustomerDetail.equipmentCount` (live only); Task 5 `TechEstimatesView`, `soldOptionOf`; Task 8 `EstimatesCard`, `useEstimateWrite`, `recoverEstimateIntents`, `ESTIMATE_INTENT`, `estimateWriteCopy`; `TechSheet` (`src/components/tech/invoice/tech-sheet.tsx`); `EQUIPMENT_TYPE_OPTIONS`, `equipmentTypeLabel` (`@/lib/admin/display-labels`).
- Produces: `materialOverlapWarning(soldIds, selectedItemId): string | null`, `soldPricebookItemIds(view): ReadonlySet<string>`, `OVERLAP_WARNING`; `equipment-display.ts`: `EQUIPMENT_COPY`, `unitDetails(unit)`, `replaceHeading(unit)`, `EquipmentForm`, `emptyForm()`, `formForReplace(unit)`, `formBody(form, replacesId)`; `EquipmentCard({ jobId, refreshKey })`, `EquipmentSheet({ jobId, replacing, onClose, onSaved })`.

- [ ] **Step 1: Failing pure tests.**

`src/lib/tech/material-overlap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { materialOverlapWarning, OVERLAP_WARNING, soldPricebookItemIds } from "./material-overlap";
import type { TechEstimatesView } from "./estimate-view";

const est = (status: string, soldOptionId: string | null, options: { id: string; items: (string | null)[] }[]) => ({
  status, soldOptionId,
  options: options.map((o) => ({ id: o.id, lines: o.items.map((p, i) => ({ id: `${o.id}-${i}`, pricebookItemId: p })) })),
});

describe("materials overlap warning (spec §7.4)", () => {
  it("collects the sold option's pricebook items only", () => {
    const view = { estimates: [
      est("sold", "b", [{ id: "a", items: ["p1"] }, { id: "b", items: ["p2", null] }]),
      est("open", null, [{ id: "c", items: ["p3"] }]),
    ] } as unknown as Pick<TechEstimatesView, "estimates">;
    expect([...soldPricebookItemIds(view)]).toEqual(["p2"]);
    expect(soldPricebookItemIds(null).size).toBe(0);
  });
  it("warns only for a catalog pick that is on a sold estimate", () => {
    const ids = new Set(["p2"]);
    expect(materialOverlapWarning(ids, "p2")).toBe(OVERLAP_WARNING);
    expect(OVERLAP_WARNING).toBe("This part is on the sold estimate. Add it only if it's extra.");
    expect(materialOverlapWarning(ids, "p9")).toBeNull();
    expect(materialOverlapWarning(ids, "")).toBeNull();
  });
});
```

`src/lib/tech/equipment-display.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emptyForm, formBody, formForReplace, replaceHeading, unitDetails } from "./equipment-display";

const unit = { id: "u1", equipmentType: "ac", make: "Carrier", model: "24ACC6", serialNumber: "S123", locationInHome: null, notes: null, installDate: null, managedExternally: false };

describe("equipment display (spec §7.5)", () => {
  it("Replacing <make> <type in lower case>", () => {
    expect(replaceHeading(unit)).toBe("Replacing Carrier air conditioner");
    expect(replaceHeading({ ...unit, make: null, equipmentType: "furnace" })).toBe("Replacing furnace");
  });
  it("details line", () => {
    expect(unitDetails(unit)).toBe("Carrier · 24ACC6 · S/N S123");
    expect(unitDetails({ ...unit, make: null, model: null, serialNumber: null })).toBe("");
  });
  it("replace pre-fills the old unit's type only", () => {
    expect(formForReplace(unit)).toEqual({ ...emptyForm(), equipmentType: "ac" });
  });
  it("the POST body drops blanks, trims, and carries replacesId", () => {
    expect(formBody({ ...emptyForm(), equipmentType: "ac", make: "  Trane ", model: " " }, "u1")).toEqual({ equipmentType: "ac", make: "Trane", replacesId: "u1" });
    expect(formBody({ ...emptyForm(), equipmentType: "other", notes: "Humidifier", installDate: "2026-11-06" }, null))
      .toEqual({ equipmentType: "other", notes: "Humidifier", installDate: "2026-11-06" });
  });
});
```

  Run: `npx vitest run src/lib/tech/material-overlap.test.ts src/lib/tech/equipment-display.test.ts` → FAIL.

- [ ] **Step 2: Implement the pure modules.**

`src/lib/tech/material-overlap.ts`:

```ts
/** The material form's warning when a part is already on a sold estimate (M3c spec §7.4). Pure. */
import type { TechEstimatesView } from "./estimate-view";

export const OVERLAP_WARNING = "This part is on the sold estimate. Add it only if it's extra.";

export function soldPricebookItemIds(view: Pick<TechEstimatesView, "estimates"> | null): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const e of view?.estimates ?? []) {
    if (e.status !== "sold") continue;
    const sold = e.options.find((o) => o.id === e.soldOptionId);
    for (const l of sold?.lines ?? []) if (l.pricebookItemId) ids.add(l.pricebookItemId);
  }
  return ids;
}

export function materialOverlapWarning(soldIds: ReadonlySet<string>, selectedItemId: string): string | null {
  return selectedItemId !== "" && soldIds.has(selectedItemId) ? OVERLAP_WARNING : null;
}
```

`src/lib/tech/equipment-display.ts`:

```ts
/** Equipment card / sheet copy and form mapping (M3c spec §7.5). Pure. */
import { equipmentTypeLabel } from "@/lib/admin/display-labels";
import type { TechEquipmentUnit } from "./equipment-input";

export const EQUIPMENT_COPY = {
  title: "Equipment",
  add: "Add equipment",
  replace: "Replace",
  managed: "Managed in FieldPulse",
  empty: "No equipment recorded at this address.",
  type: "Type",
  make: "Make",
  model: "Model",
  serial: "Serial number",
  location: "Location in home",
  installDate: "Install date",
  describe: "Describe it",
  save: "Save",
  saving: "Saving…",
  sheetDescription: "Record the unit at this address.",
  loadError: "Couldn't load the equipment at this address.",
} as const;

export function unitDetails(u: Pick<TechEquipmentUnit, "make" | "model" | "serialNumber">): string {
  return [u.make, u.model, u.serialNumber ? `S/N ${u.serialNumber}` : null].filter(Boolean).join(" · ");
}

export function replaceHeading(u: Pick<TechEquipmentUnit, "make" | "equipmentType">): string {
  return `Replacing ${u.make ? `${u.make} ` : ""}${equipmentTypeLabel(u.equipmentType).toLowerCase()}`;
}

export interface EquipmentForm {
  readonly equipmentType: string;
  readonly make: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly locationInHome: string;
  readonly installDate: string;
  readonly notes: string;
}

export function emptyForm(): EquipmentForm {
  return { equipmentType: "", make: "", model: "", serialNumber: "", locationInHome: "", installDate: "", notes: "" };
}

export function formForReplace(u: Pick<TechEquipmentUnit, "equipmentType">): EquipmentForm {
  return { ...emptyForm(), equipmentType: u.equipmentType };
}

/** Non-blank trimmed fields only; `notes` only for Other (the sheet hides it otherwise). */
export function formBody(f: EquipmentForm, replacesId: string | null): Record<string, string> {
  const out: Record<string, string> = { equipmentType: f.equipmentType };
  const put = (k: keyof EquipmentForm) => {
    const v = f[k].trim();
    if (v !== "") out[k] = v;
  };
  put("make");
  put("model");
  put("serialNumber");
  put("locationInHome");
  put("installDate");
  if (f.equipmentType === "other") put("notes");
  if (replacesId) out.replacesId = replacesId;
  return out;
}
```

  Run the two test files → PASS.

- [ ] **Step 3: The equipment sheet** — `src/components/tech/equipment/equipment-sheet.tsx` (plan ruling 14: the sheet rehydrates its intent from `sessionStorage` and, when it comes back `unknown`, re-sends the OLD body with the OLD key before Save unlocks; an unknown add can never mint a second key):

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TechSheet } from '@/components/tech/invoice/tech-sheet';
import { EQUIPMENT_TYPE_OPTIONS } from '@/lib/admin/display-labels';
import { EQUIPMENT_ERROR_COPY, parseEquipmentInput, todayInZone, type TechEquipmentUnit } from '@/lib/tech/equipment-input';
import { EQUIPMENT_COPY, emptyForm, formBody, formForReplace, replaceHeading, type EquipmentForm } from '@/lib/tech/equipment-display';
import { ESTIMATE_INTENT, estimateWriteCopy } from '@/lib/tech/estimate-intents';
import { useEstimateWrite, type EstimateSend } from '@/components/tech/estimates/use-estimate-write';

const FIELD = 'h-11 rounded-xl text-[16px]';
const UNKNOWN_COPY = 'Your last save may not have gone through. Try again.';
const EARLIER_COPY = 'Your earlier save went through first. Check the equipment list.';

/**
 * Add a unit, or replace `replacing` (M3c spec §7.5). Mount with
 * `key={intentId}` so each unit's replace has its own idempotency intent.
 * `onSaved` reloads the card and resolves true when the reload shows the write
 * landed (for a replace: the old unit left the list).
 */
export function EquipmentSheet({
  jobId,
  replacing,
  onClose,
  onSaved,
}: {
  readonly jobId: string;
  readonly replacing: TechEquipmentUnit | null;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<boolean>;
}) {
  const intentId = replacing ? ESTIMATE_INTENT.equipmentReplace(replacing.id) : ESTIMATE_INTENT.equipmentAdd;
  const { phase, send, settle } = useEstimateWrite(jobId, intentId, true);
  const [form, setForm] = useState<EquipmentForm>(() => (replacing ? formForReplace(replacing) : emptyForm()));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const resent = useRef(false);
  const today = todayInZone(new Date());
  const path = `/api/tech/jobs/${jobId}/equipment`;
  const set = (k: keyof EquipmentForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  /** Shared answer handling for a save and for the rehydrated re-send. */
  async function handle(r: EstimateSend): Promise<void> {
    if (!r.sent) return;
    if (r.outcome === 'success_refetch' || r.outcome === 'already_saved_refetch') {
      settle(r.outcome, false);
      await onSaved();
      setSaving(false);
      if (r.resentOld) {
        setError(EARLIER_COPY); // the OLD body landed; the edited form was not sent
        return;
      }
      onClose();
      return;
    }
    const unknown = r.outcome === 'retry_same_key_after_refetch' || r.outcome === 'wait_then_refetch';
    const landed = unknown ? await onSaved() : false;
    settle(r.outcome, landed);
    setSaving(false);
    if (landed) {
      onClose();
      return;
    }
    setError(unknown ? UNKNOWN_COPY : estimateWriteCopy(r.outcome, r.envelope));
  }

  // Rehydrated as `unknown` (a reload or a closed sheet left it unanswered):
  // re-send the stored body with the stored key before anything else. `send`
  // re-sends the stored body whatever payload it is given while `unknown`.
  useEffect(() => {
    if (phase !== 'unknown' || resent.current) return;
    resent.current = true;
    void send(path, {}).then(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per rehydrated intent
  }, [phase]);

  async function save(): Promise<void> {
    const body = formBody(form, replacing?.id ?? null);
    if (phase !== 'unknown') {
      const check = parseEquipmentInput(body, today);
      if (!check.ok) {
        setError(EQUIPMENT_ERROR_COPY[check.error]);
        return;
      }
    }
    setSaving(true);
    setError(null);
    const r = await send(path, body);
    if (!r.sent) {
      setSaving(false);
      return;
    }
    await handle(r);
  }

  const locked = saving || phase === 'sent';

  return (
    <TechSheet
      open
      onClose={onClose}
      busy={locked}
      title={replacing ? replaceHeading(replacing) : EQUIPMENT_COPY.add}
      description={EQUIPMENT_COPY.sheetDescription}
    >
      <div className="space-y-3 px-4">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-muted-foreground">{EQUIPMENT_COPY.type}</span>
          <select
            value={form.equipmentType}
            onChange={set('equipmentType')}
            disabled={locked}
            className="flex h-11 w-full rounded-xl border border-border-input bg-surface-raised px-3 text-[16px]"
          >
            <option value="">Choose…</option>
            {EQUIPMENT_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {form.equipmentType === 'other' && (
          <label className="block space-y-1.5">
            <span className="text-[13px] font-medium text-muted-foreground">{EQUIPMENT_COPY.describe}</span>
            <Input value={form.notes} onChange={set('notes')} maxLength={120} disabled={locked} className={FIELD} />
          </label>
        )}
        {([['make', EQUIPMENT_COPY.make], ['model', EQUIPMENT_COPY.model], ['serialNumber', EQUIPMENT_COPY.serial], ['locationInHome', EQUIPMENT_COPY.location]] as const).map(([k, label]) => (
          <label key={k} className="block space-y-1.5">
            <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
            <Input value={form[k]} onChange={set(k)} maxLength={120} disabled={locked} className={FIELD} autoComplete="off" />
          </label>
        ))}
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-muted-foreground">{EQUIPMENT_COPY.installDate}</span>
          <Input type="date" max={today} value={form.installDate} onChange={set('installDate')} disabled={locked} className={FIELD} />
        </label>
        {error && <p role="alert" className="text-[15px] text-danger-strong">{error}</p>}
        <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => void save()}>
          {locked ? EQUIPMENT_COPY.saving : phase === 'unknown' ? 'Try again' : EQUIPMENT_COPY.save}
        </Button>
      </div>
    </TechSheet>
  );
}
```

  (`handle` is a plain function, not a `useCallback`: it only runs from events and the one-shot effect, so the React compiler memoizes it and no manual-memoization rule applies.)

- [ ] **Step 4: The equipment card** — `src/components/tech/equipment/equipment-card.tsx`. The card shows only to technicians who can write (spec §2: a non-cancelled assignment on a non-cancelled visit), re-sends stored equipment intents on mount and stays locked with a Try again while any is unanswered (ruling 14):

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { equipmentTypeLabel } from '@/lib/admin/display-labels';
import { EQUIPMENT_COPY, unitDetails } from '@/lib/tech/equipment-display';
import { ESTIMATE_INTENT } from '@/lib/tech/estimate-intents';
import type { TechEquipmentUnit, TechEquipmentView } from '@/lib/tech/equipment-input';
import { recoverEstimateIntents } from '@/components/tech/estimates/recover-intents';
import { EquipmentSheet } from './equipment-sheet';

const UNRESOLVED_COPY = 'Your last save may not have gone through. Try again.';

async function fetchEquipment(jobId: string): Promise<{ kind: 'ok'; view: TechEquipmentView } | { kind: 'hidden' } | { kind: 'error' }> {
  try {
    const res = await fetch(`/api/tech/jobs/${jobId}/equipment`, { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: TechEquipmentView } | null;
    if (res.ok && body?.success && body.data) return { kind: 'ok', view: body.data };
    if (res.status === 404 || res.status === 409) return { kind: 'hidden' };
    return { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

/** The job page's Equipment card (M3c spec §7.5): live units at this address, Add, Replace. */
export function EquipmentCard({ jobId, refreshKey }: { readonly jobId: string; readonly refreshKey: number }) {
  const [view, setView] = useState<TechEquipmentView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'hidden' | 'error'>('loading');
  const [recovering, setRecovering] = useState(true);
  const [unresolved, setUnresolved] = useState(0);
  const [sheet, setSheet] = useState<{ readonly replacing: TechEquipmentUnit | null } | null>(null);

  const load = useCallback(async (): Promise<TechEquipmentView | null> => {
    const r = await fetchEquipment(jobId);
    if (r.kind === 'ok') {
      setView(r.view);
      setState('ok');
      return r.view;
    }
    setState((s) => (r.kind === 'hidden' ? 'hidden' : s === 'ok' ? s : 'error'));
    return null;
  }, [jobId, setView, setState]);

  /** Re-send stored equipment intents (old body, old key), then reload; state changes only after the awaits. */
  const runRecovery = useCallback(async (): Promise<void> => {
    const rec = await recoverEstimateIntents(jobId, (id) => id.startsWith('equipment:'));
    await load();
    setUnresolved(rec.unresolved);
    setRecovering(false);
  }, [jobId, load, setUnresolved, setRecovering]);

  useEffect(() => {
    void runRecovery();
  }, [runRecovery, refreshKey]);

  /** Reload; for a replace, true once the old unit has left the list (the write landed). */
  const onSaved = useCallback(async (): Promise<boolean> => {
    const replacing = sheet?.replacing ?? null;
    const v = await load();
    if (!v) return false;
    return replacing !== null && !v.units.some((u) => u.id === replacing.id);
  }, [load, sheet]);

  if (state === 'loading' || state === 'hidden' || (view && !view.canWrite)) return null;
  const locked = recovering || unresolved > 0;
  const intentId = sheet?.replacing ? ESTIMATE_INTENT.equipmentReplace(sheet.replacing.id) : ESTIMATE_INTENT.equipmentAdd;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">{EQUIPMENT_COPY.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === 'error' || !view ? (
          <p role="alert" className="text-[15px] text-danger-strong">{EQUIPMENT_COPY.loadError}</p>
        ) : (
          <>
            {unresolved > 0 && (
              <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">
                <span>{UNRESOLVED_COPY}</span>
                <Button variant="outline" className="h-11 shrink-0 rounded-xl px-4 text-[15px]" disabled={recovering}
                  onClick={() => { setRecovering(true); void runRecovery(); }}>
                  Try again
                </Button>
              </div>
            )}
            {view.units.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">{EQUIPMENT_COPY.empty}</p>
            ) : (
              <ul className="divide-y divide-border" aria-label={EQUIPMENT_COPY.title}>
                {view.units.map((u) => (
                  <li key={u.id} className="flex min-h-14 items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium">{equipmentTypeLabel(u.equipmentType)}</p>
                      {unitDetails(u) && <p className="text-[13px] text-muted-foreground break-words">{unitDetails(u)}</p>}
                    </div>
                    {u.managedExternally ? (
                      <span className="shrink-0 text-[13px] text-muted-foreground">{EQUIPMENT_COPY.managed}</span>
                    ) : (
                      <Button variant="outline" className="h-11 shrink-0 rounded-xl px-4 text-[15px]" disabled={locked}
                        onClick={() => setSheet({ replacing: u })}>
                        {EQUIPMENT_COPY.replace}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={locked} onClick={() => setSheet({ replacing: null })}>
              {EQUIPMENT_COPY.add}
            </Button>
          </>
        )}
      </CardContent>
      {sheet && (
        <EquipmentSheet key={intentId} jobId={jobId} replacing={sheet.replacing} onClose={() => setSheet(null)} onSaved={onSaved} />
      )}
    </Card>
  );
}
```

  (The card's mount recovery and the sheet's rehydration never race: the sheet opens only after recovery finished with nothing unanswered, and recovery clears every intent it resolved.)

- [ ] **Step 5: Wire the job page** (`src/components/tech/tech-job-detail-client.tsx`; this file is NOT touched by the requests/calendar/dispatch workstream):
  - Imports:

```tsx
import { EstimatesCard } from '@/components/tech/estimates/estimates-card';
import { EquipmentCard } from '@/components/tech/equipment/equipment-card';
import { materialOverlapWarning, soldPricebookItemIds } from '@/lib/tech/material-overlap';
import type { TechEstimatesView } from '@/lib/tech/estimate-view';
```

  - State, after `const [timeline, setTimeline] = useState<TimelineEntry[]>([]);`:

```tsx
  // A status tap can open or close selling and equipment: both cards refetch on it.
  const [refreshKey, setRefreshKey] = useState(0);
  const [estimatesView, setEstimatesView] = useState<TechEstimatesView | null>(null);
  const onEstimatesLoaded = useCallback((v: TechEstimatesView | null) => setEstimatesView(v), []);
```

  - In `onStatusChanged`, after `void loadTimesheet();`: `setRefreshKey((k) => k + 1);`
  - Right after the `<TechJobSummary … />` element: `<EstimatesCard jobId={id} refreshKey={refreshKey} onLoaded={onEstimatesLoaded} />`
  - After `const lateWarning = lateMaterialWarning(invoiceState);`: `const overlapWarning = materialOverlapWarning(soldPricebookItemIds(estimatesView), selectedItemId);`
  - After the `{lateWarning && (…)}` block inside the material form:

```tsx
            {overlapWarning && (
              <p className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px] text-foreground">
                {overlapWarning}
              </p>
            )}
```

  - Right after the Materials `</Card>` (before the On-site note): `<EquipmentCard jobId={id} refreshKey={refreshKey} />`

- [ ] **Step 6: Office customer page** (`src/app/admin/(dashboard)/customers/[id]/page.tsx`, Equipment `SectionCard`; read `.claude/skills/page-customers/SKILL.md` first):
  - `count={customer.equipment.length}` → `count={customer.equipmentCount}` (live units only).
  - Import `replacedOnLabel` from `@/lib/admin/crm-equipment-records` (Task 4; an office page never imports a tech module).
  - Each unit's wrapper (HEAD lines ~649–651, split over three lines):

```tsx
              <div
                key={eq.id}
                className="rounded-lg border bg-muted/20 p-3"
              >
```

    becomes

```tsx
              <div
                key={eq.id}
                id={`equipment-${eq.id}`}
                className={`rounded-lg border bg-muted/20 p-3 ${eq.retiredAt ? 'opacity-60' : ''}`}
              >
```
  - Under the make/model line add:

```tsx
                {eq.retiredAt && (
                  <p className="text-xs text-muted-foreground">
                    {replacedOnLabel(eq.retiredAt)}
                    {eq.replacedByEquipmentId && (
                      <>
                        {' · '}
                        <a href={`#equipment-${eq.replacedByEquipmentId}`} className="text-link underline-offset-2 hover:underline">
                          See the replacement
                        </a>
                      </>
                    )}
                  </p>
                )}
```

  (Ordering — live first, retired last — comes from the server, Task 4.)

- [ ] **Step 7: Look at it.** Throwaway org (Task 6 recipe) with a customer, two live units (one FieldPulse: `fieldpulse_asset_id = 'fp-1'`), a sold estimate whose option holds pricebook item P: job page at 390 px shows Estimates after the summary and Equipment after Materials; picking P in the material form shows the overlap warning (the part still saves); Replace on the native unit → sheet titled "Replacing <make> air conditioner", type pre-filled → Save → the old unit leaves the card; the FieldPulse unit reads "Managed in FieldPulse" with no Replace; Add with type Other and no description → "Describe the equipment."; throttle the network to offline, Add a unit (unknown answer, "Your last save may not have gone through. Try again."), close the sheet, go back online, reopen Add → the sheet re-sends the stored body first and the card shows ONE new unit; the office customer page (admin session with `MINT_ORG_ID`) lists the retired unit last, muted, "Replaced <date> · See the replacement", and the count excludes it. Look at every screenshot. Delete the org.

- [ ] **Step 8: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/material-overlap.ts src/lib/tech/material-overlap.test.ts src/lib/tech/equipment-display.ts src/lib/tech/equipment-display.test.ts src/components/tech/equipment src/components/tech/tech-job-detail-client.tsx "src/app/admin/(dashboard)/customers/[id]/page.tsx" && npx vitest run
git add src/lib/tech/material-overlap.ts src/lib/tech/material-overlap.test.ts src/lib/tech/equipment-display.ts src/lib/tech/equipment-display.test.ts src/components/tech/equipment/equipment-card.tsx src/components/tech/equipment/equipment-sheet.tsx src/components/tech/tech-job-detail-client.tsx "src/app/admin/(dashboard)/customers/[id]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(m3c): equipment add/replace on the job page, estimates card wired in, overlap warning, retired units in the office

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 11: Integration suite (a)–(t) on the dev DB, then docs

**Files:**
- Create: `tests/integration/field-estimate.test.ts`
- Modify: `vitest.config.ts` (append one line to `INTEGRATION_SUITES`; another workstream edits this file — re-read it right before the edit), `.claude/skills/page-tech/SKILL.md`, `.claude/skills/page-estimates/SKILL.md`, `.claude/skills/page-customers/SKILL.md`, `.claude/skills/page-invoices/SKILL.md`, `replica/features.csv` (lines 129, 132, 133), `replica/parity.md` (regenerated), `replica/build-log.md`, `replica/architecture.md` (M3c paragraph ~line 595), memory file `/Users/sizbei/.claude/projects/-Users-sizbei-Documents-GitHub-ai-hvac-agent/memory/replica-program-fp-st.md` (not committed: outside the repo)

**Interfaces:**
- Consumes: everything above (writers, queries, idempotency, routes' run bodies mirrored here as `*Via` helpers).
- Produces: the suite file; docs.

- [ ] **Step 1: Write the suite** — `tests/integration/field-estimate.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Field estimate integration suite (M3c spec §8) against the DEV database
 * (`VITEST_INTEGRATION=1`). Drives the writers through `withIdempotency`
 * exactly as the routes do (the `*Via` helpers mirror the route run bodies),
 * never HTTP. Two throwaway orgs via createOrgCore (the second for tenancy),
 * both deleted in afterAll even on failure. Every fixture UPDATE is by id AND
 * organization_id. No customer phone is ever set; nothing queues a message.
 * Case (q) is the `draftOutcome` unit test in invoice-field-writes.test.ts.
 */

type EW = typeof import("@/lib/tech/estimate-writes");
type FW = typeof import("@/lib/admin/invoice-field-writes");
type QW = typeof import("@/lib/tech/equipment-writes");
type IQ = typeof import("@/lib/admin/invoice-queries");
type EQ = typeof import("@/lib/admin/estimate-queries");
type TQ = typeof import("@/lib/tech/estimate-queries");
type TI = typeof import("@/lib/tech/invoice-queries");
type TE = typeof import("@/lib/tech/equipment-queries");
type ID = typeof import("@/lib/http/idempotency");
type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;
type RunOut = Awaited<ReturnType<ID["withIdempotency"]>>;
type CreateBody = Parameters<EW["createFieldEstimate"]>[2];

let ew: EW; let fw: FW; let qw: QW; let iq: IQ; let eq: EQ; let tq: TQ; let ti: TI; let te: TE; let idem: ID;
let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let okResult: typeof import("@/lib/tech/invoice-write-route").okResult;
let estimateReasonResult: typeof import("@/lib/tech/estimate-errors").estimateReasonResult;
let equipmentReasonResult: typeof import("@/lib/tech/equipment-errors").equipmentReasonResult;
let parseEquipmentInput: typeof import("@/lib/tech/equipment-input").parseEquipmentInput;
let todayInZone: typeof import("@/lib/tech/equipment-input").todayInZone;

let org = "";
let org2 = "";
let tech = "";
let cust = "";
let itemA = "";
let itemB = "";
let taxBps = 0;

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

/** A request assigned to the technician (the trigger makes visit #1 + the lead row). */
async function newJob(o: { customer?: boolean; locationId?: string | null; status?: string } = {}): Promise<string> {
  const sess = (await run(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`))[0]!.id as string;
  const customerId = o.customer === false ? null : cust;
  return (await run(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,customer_id,location_id,issue_type,urgency,description,reference_number,scheduled_date,status)
    VALUES (${org},${sess},${tech},${customerId},${o.locationId ?? null},'no_heat','medium','Probe request','PRB-'||substr(md5(random()::text),1,8),now(),${o.status ?? "arrived"}::request_status)
    RETURNING id`))[0]!.id as string;
}

async function addMaterial(rid: string, qty: number, priceCents: number): Promise<string> {
  return (await run(sql`INSERT INTO job_materials (organization_id,service_request_id,description,quantity,unit_cost_cents,unit_price_cents,created_by)
    VALUES (${org},${rid},'Probe part',${qty},100,${priceCents},${tech}) RETURNING id`))[0]!.id as string;
}

async function unit(o: { locationId: string | null; make?: string; fieldpulseAssetId?: string; customerId?: string; orgId?: string }): Promise<string> {
  return (await run(sql`INSERT INTO customer_equipment (organization_id,customer_id,equipment_type,location_id,make,fieldpulse_asset_id)
    VALUES (${o.orgId ?? org},${o.customerId ?? cust},'ac'::equipment_type,${o.locationId},${o.make ?? null},${o.fieldpulseAssetId ?? null}) RETURNING id`))[0]!.id as string;
}

const actor = (rid: string) => ({ organizationId: org, requestId: rid, techUserId: tech });
const scope = (route: string, key: string) => ({ organizationId: org, userId: tech, route, key });
const base = (rid: string) => `/api/tech/jobs/${rid}/estimates`;

/** The estimates POST route's run body. */
function createVia(rid: string, key: string, body: CreateBody): Promise<RunOut> {
  return idem.withIdempotency(scope(base(rid), key), idem.canonicalHash(body), async (ids) => {
    const r = await ew.createFieldEstimate(actor(rid), { estimateId: ids.id("estimate") }, body);
    if (!r.ok) return estimateReasonResult(r.reason);
    return okResult(r.created ? 201 : 200, { estimateId: r.estimateId, created: r.created });
  });
}

/** The sell route's run body. */
function sellVia(rid: string, eid: string, key: string, body: { optionId: string; signatureName: string }): Promise<RunOut> {
  return idem.withIdempotency(scope(`${base(rid)}/${eid}/sell`, key), idem.canonicalHash(body), async () => {
    const r = await ew.sellFieldEstimate(actor(rid), { estimateId: eid, ...body });
    if (!r.ok) return estimateReasonResult(r.reason);
    return okResult(200, { estimateId: r.estimateId, status: "sold", created: r.created });
  });
}

/** The bill route's run body. */
function billVia(rid: string, eid: string, key: string): Promise<RunOut> {
  return idem.withIdempotency(scope(`${base(rid)}/${eid}/bill`, key), idem.canonicalHash({}), async (ids) => {
    const r = await fw.billSoldEstimate(actor(rid), eid, { invoiceId: ids.id("invoice") });
    if (!r.ok) return estimateReasonResult(r.reason, r.reason === "already_billed" && r.invoiceId ? { invoiceId: r.invoiceId } : undefined);
    return okResult(200, { invoiceId: r.invoiceId, added: r.added, hasMaterials: r.hasMaterials });
  });
}

/** The decline route's run body. */
function declineVia(rid: string, eid: string, key: string): Promise<RunOut> {
  return idem.withIdempotency(scope(`${base(rid)}/${eid}/decline`, key), idem.canonicalHash({}), async () => {
    const r = await ew.declineFieldEstimate(actor(rid), eid);
    if (!r.ok) return estimateReasonResult(r.reason);
    return okResult(200, { estimateId: r.estimateId, status: "dismissed", created: r.created });
  });
}

/** The equipment POST route's run body. */
function equipVia(rid: string, key: string, raw: Record<string, string>): Promise<RunOut> {
  const parsed = parseEquipmentInput(raw, todayInZone(new Date()));
  if (!parsed.ok) throw new Error(`bad fixture: ${parsed.error}`);
  return idem.withIdempotency(scope(`/api/tech/jobs/${rid}/equipment`, key), idem.canonicalHash(raw), async (ids) => {
    const r = await qw.addFieldEquipment(actor(rid), { equipmentId: ids.id("equipment") }, parsed.value);
    if (!r.ok) return equipmentReasonResult(r.reason);
    return okResult(r.created ? 201 : 200, { equipmentId: r.equipmentId, created: r.created });
  });
}

const data = (r: RunOut): Row => {
  if (!r.envelope.success) throw new Error(`expected success, got ${JSON.stringify(r.envelope)}`);
  return r.envelope.data;
};
const code = (r: RunOut): string | undefined => (r.envelope.success ? undefined : r.envelope.error.code);
const details = (r: RunOut): unknown => (r.envelope.success ? undefined : r.envelope.error.details);

const TWO = (good = 1, better = 1): CreateBody => ({ options: [
  { name: "Good", lines: [{ pricebookItemId: itemA, quantity: good }] },
  { name: "Better", lines: [{ pricebookItemId: itemA, quantity: better }, { pricebookItemId: itemB, quantity: 1 }] },
] });

async function optionIds(eid: string): Promise<string[]> {
  return (await run(sql`SELECT id FROM estimate_options WHERE estimate_id = ${eid} AND organization_id = ${org} ORDER BY sort_order`)).map((r) => String(r.id));
}

/** Build TWO() and sell Better. */
async function soldEstimate(rid: string): Promise<{ eid: string; good: string; better: string }> {
  const eid = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
  const [good, better] = await optionIds(eid);
  expect(data(await sellVia(rid, eid, randomUUID(), { optionId: better!, signatureName: "Pat Probe" })).created).toBe(true);
  return { eid, good: good!, better: better! };
}

async function estimateRow(eid: string): Promise<Row> {
  return (await run(sql`SELECT * FROM estimates WHERE id = ${eid} AND organization_id = ${org}`))[0]!;
}
async function invoiceRow(inv: string): Promise<Row> {
  return (await run(sql`SELECT * FROM invoices WHERE id = ${inv} AND organization_id = ${org}`))[0]!;
}
async function invoicesOf(rid: string): Promise<Row[]> {
  return run(sql`SELECT id, state, estimate_id FROM invoices WHERE service_request_id = ${rid} AND organization_id = ${org} ORDER BY created_at, id`);
}
async function linesOf(inv: string): Promise<Row[]> {
  return run(sql`SELECT id, estimate_line_item_id, job_material_id, line_total_cents FROM invoice_line_items WHERE invoice_id = ${inv} AND organization_id = ${org} ORDER BY created_at, id`);
}
async function view(rid: string) {
  const r = await tq.getTechEstimatesView(org, tech, rid);
  if (r.kind !== "ok") throw new Error(`view ${r.kind}`);
  return r.view;
}
async function estimateOf(rid: string, eid: string) {
  return (await view(rid)).estimates.find((e) => e.id === eid) ?? null;
}
async function notInvoicedIds(): Promise<string[]> {
  return (await eq.listEstimates(org, { bucket: "not_invoiced", limit: 500 })).estimates.map((e) => e.id);
}
/** create → one catalog line → finalize: the job's open invoice. */
async function openJobInvoice(rid: string): Promise<string> {
  const c = await fw.createInvoiceFromJob(actor(rid), { invoiceId: randomUUID() });
  if (!c.ok) throw new Error(c.reason);
  expect((await fw.addInvoiceLine(actor(rid), c.invoiceId, { lineId: randomUUID() }, { pricebookItemId: itemA, quantity: 1 })).ok).toBe(true);
  expect((await fw.finalizeInvoice(actor(rid), c.invoiceId)).ok).toBe(true);
  return c.invoiceId;
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");

  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  ew = await import("@/lib/tech/estimate-writes");
  fw = await import("@/lib/admin/invoice-field-writes");
  qw = await import("@/lib/tech/equipment-writes");
  iq = await import("@/lib/admin/invoice-queries");
  eq = await import("@/lib/admin/estimate-queries");
  tq = await import("@/lib/tech/estimate-queries");
  ti = await import("@/lib/tech/invoice-queries");
  te = await import("@/lib/tech/equipment-queries");
  idem = await import("@/lib/http/idempotency");
  ({ okResult } = await import("@/lib/tech/invoice-write-route"));
  ({ estimateReasonResult } = await import("@/lib/tech/estimate-errors"));
  ({ equipmentReasonResult } = await import("@/lib/tech/equipment-errors"));
  ({ parseEquipmentInput, todayInZone } = await import("@/lib/tech/equipment-input"));
  const { createOrgCore } = await import("@/lib/admin/provisioning");
  const { encrypt } = await import("@/lib/crypto");
  const { getDefaultTaxBps } = await import("@/lib/admin/pricebook-queries");

  const mkOrg = async (label: string) => {
    const out = await createOrgCore({
      name: `Probe Org Field Estimate ${label} ${randomUUID().slice(0, 8)}`,
      createdBy: null,
      ownerEmail: null,
      ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
    return out.result.organizationId;
  };
  org = await mkOrg("A");
  org2 = await mkOrg("B");
  tech = (await run(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
    VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example','Probe Technician','technician','x',true) RETURNING id`))[0]!.id as string;
  cust = (await run(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Pat Probe")}) RETURNING id`))[0]!.id as string;
  itemA = (await run(sql`INSERT INTO pricebook_items (organization_id,type,name,cost_cents,price_cents,active)
    VALUES (${org},'service'::pricebook_item_type,'Probe capacitor',4000,12500,true) RETURNING id`))[0]!.id as string;
  itemB = (await run(sql`INSERT INTO pricebook_items (organization_id,type,name,cost_cents,price_cents,active)
    VALUES (${org},'service'::pricebook_item_type,'Probe fan motor',21000,48000,true) RETURNING id`))[0]!.id as string;
  await db.execute(sql`INSERT INTO tax_rates (organization_id,name,rate_bps,is_default,active) VALUES (${org},'Probe tax',825,true,true) ON CONFLICT DO NOTHING`);
  taxBps = await getDefaultTaxBps(org);
}, 90_000);

afterAll(async () => {
  for (const id of [org, org2].filter(Boolean)) {
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}`);
    } catch (error) {
      console.error(`afterAll: could not delete probe org ${id}`, error);
    }
  }
}, 60_000);

describe("field estimates (dev DB)", () => {
  it("(a) create: two options, v7 ids in build order, total = max, re-run creates nothing; no customer → NO_CUSTOMER", async () => {
    const rid = await newJob();
    const key = randomUUID();
    const r = await createVia(rid, key, TWO(2, 1));
    expect(r.status).toBe(201);
    const eid = data(r).estimateId as string;
    const opts = await run(sql`SELECT id, name, total_cents FROM estimate_options WHERE estimate_id = ${eid} AND organization_id = ${org} ORDER BY sort_order`);
    expect(opts.map((o) => o.name)).toEqual(["Good", "Better"]);
    expect(String(opts[0]!.id) < String(opts[1]!.id)).toBe(true);
    const lines = await run(sql`SELECT option_id FROM estimate_line_items WHERE option_id IN (${opts[0]!.id}, ${opts[1]!.id}) AND organization_id = ${org} ORDER BY id`);
    expect(lines.map((l) => l.option_id)).toEqual([opts[0]!.id, opts[1]!.id, opts[1]!.id]);
    expect(Number(opts[1]!.total_cents)).toBe(60_500 + Math.round((60_500 * taxBps) / 10000));
    const est = await estimateRow(eid);
    expect(Number(est.total_cents)).toBe(Math.max(...opts.map((o) => Number(o.total_cents))));
    expect(est).toMatchObject({ status: "open", title: "Field estimate", approval_token_hash: null, customer_id: cust, sold_via: null });

    const again = await createVia(rid, key, TWO(2, 1));
    expect([again.status, again.replayed]).toEqual([201, true]);
    expect(await ew.createFieldEstimate(actor(rid), { estimateId: eid }, TWO(2, 1))).toEqual({ ok: true, estimateId: eid, created: false });
    const [{ n }] = await run(sql`SELECT count(*)::int AS n FROM estimate_options WHERE estimate_id = ${eid} AND organization_id = ${org}`) as [{ n: number }];
    expect(n).toBe(2);

    const bare = await newJob({ customer: false });
    const nc = await createVia(bare, randomUUID(), TWO());
    expect([nc.status, code(nc)]).toEqual([409, "NO_CUSTOMER"]);
  }, 60_000);

  it("(b) sell: field sale; same option + same technician + any name → success; other option / portal-sold → ALREADY_DECIDED", async () => {
    const rid = await newJob();
    const eid = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
    const [good, better] = await optionIds(eid);
    const s = await sellVia(rid, eid, randomUUID(), { optionId: better!, signatureName: "Pat Probe" });
    expect([s.status, data(s)]).toEqual([200, { estimateId: eid, status: "sold", created: true }]);
    expect(await estimateRow(eid)).toMatchObject({ status: "sold", sold_option_id: better, sold_via: "field", sold_by: tech, signature_name: "Pat Probe", signature_ip: null });

    const again = await sellVia(rid, eid, randomUUID(), { optionId: better!, signatureName: "Someone Else" });
    expect([again.status, data(again).created]).toEqual([200, false]);
    expect((await estimateRow(eid)).signature_name).toBe("Pat Probe");
    expect(code(await sellVia(rid, eid, randomUUID(), { optionId: good!, signatureName: "Pat" }))).toBe("ALREADY_DECIDED");

    const eid2 = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
    const [, b2] = await optionIds(eid2);
    await db.execute(sql`UPDATE estimates SET status = 'sold'::estimate_status, sold_option_id = ${b2!}, sold_via = 'portal', signed_at = now(), signature_name = 'Pat'
      WHERE id = ${eid2} AND organization_id = ${org}`);
    expect(code(await sellVia(rid, eid2, randomUUID(), { optionId: b2!, signatureName: "Pat" }))).toBe("ALREADY_DECIDED");
  }, 60_000);

  it("(c) bill: lines once with links; totals = Σ lines + tax; same key replays; a new key → ALREADY_BILLED, no new invoice", async () => {
    const rid = await newJob();
    const { eid, better } = await soldEstimate(rid);
    expect(await notInvoicedIds()).toContain(eid);
    const key = randomUUID();
    const b = await billVia(rid, eid, key);
    expect(b.status).toBe(200);
    expect(data(b)).toMatchObject({ added: 2, hasMaterials: false });
    const inv = data(b).invoiceId as string;
    const sold = await run(sql`SELECT id FROM estimate_line_items WHERE option_id = ${better} AND organization_id = ${org} ORDER BY id`);
    const lines = await linesOf(inv);
    expect(lines.map((l) => l.estimate_line_item_id)).toEqual(sold.map((s) => s.id));
    const sum = lines.reduce((s, l) => s + Number(l.line_total_cents), 0);
    expect(await invoiceRow(inv)).toMatchObject({ state: "draft", subtotal_cents: sum, total_cents: sum + Math.round((sum * taxBps) / 10000) });
    expect(await notInvoicedIds()).not.toContain(eid);
    expect((await estimateOf(rid, eid))?.billing).toBe("job");

    const replay = await billVia(rid, eid, key);
    expect([replay.status, replay.replayed]).toEqual([200, true]);
    const fresh = await billVia(rid, eid, randomUUID());
    expect([fresh.status, code(fresh), details(fresh)]).toEqual([409, "ALREADY_BILLED", { invoiceId: inv }]);
    expect(await invoicesOf(rid)).toHaveLength(1);
    expect(await linesOf(inv)).toHaveLength(2);
  }, 60_000);

  it("(d) two concurrent bills with different keys and no draft → one draft, lines once", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    // One retry each on an unstored STALE (a transient 40P01 deadlock under load), with a new key.
    const billOnce = async (): Promise<RunOut> => {
      const r = await billVia(rid, eid, randomUUID());
      return code(r) === "STALE" ? billVia(rid, eid, randomUUID()) : r;
    };
    const [a, b] = await Promise.all([billOnce(), billOnce()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([code(a), code(b)].filter(Boolean)).toEqual(["ALREADY_BILLED"]);
    const invs = await invoicesOf(rid);
    expect(invs).toHaveLength(1);
    expect(invs[0]!.state).toBe("draft");
    expect((await linesOf(String(invs[0]!.id))).filter((l) => l.estimate_line_item_id !== null)).toHaveLength(2);
  }, 60_000);

  it("(d2) the in-batch guard alone: billLinesSql run twice with the pre-check skipped → the second inserts nothing", async () => {
    const rid = await newJob();
    const { eid, better } = await soldEstimate(rid);
    const c = await fw.createInvoiceFromJob(actor(rid), { invoiceId: randomUUID() });
    if (!c.ok) throw new Error(c.reason);
    const sold = await run(sql`SELECT id FROM estimate_line_items WHERE option_id = ${better} AND organization_id = ${org} ORDER BY id`);
    // Fresh ids every run, exactly like a re-run of step 3: only NOT billed(eid) can stop the second.
    const stmt = () => fw.billLinesSql({ org, rid, me: tech, inv: c.invoiceId, estimateId: eid, lines: sold.map((l) => ({ id: randomUUID(), eli: String(l.id) })) });
    expect((await db.execute(stmt())).rows).toHaveLength(2);
    expect((await db.execute(stmt())).rows).toHaveLength(0);
    expect((await linesOf(c.invoiceId)).filter((l) => l.estimate_line_item_id !== null)).toHaveLength(2);
  }, 60_000);

  it("(d3) this key's derived invoice was voided → stored INVOICE_CHANGED; the same key replays it; a new key bills (ruling 11)", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    const key = randomUUID();
    const derived = idem.derivedId(scope(`${base(rid)}/${eid}/bill`, key), "invoice");
    expect(await fw.createInvoiceFromJob(actor(rid), { invoiceId: derived })).toMatchObject({ ok: true, invoiceId: derived, created: true });
    await db.execute(sql`UPDATE invoices SET state = 'void'::invoice_state WHERE id = ${derived} AND organization_id = ${org}`);
    const r = await billVia(rid, eid, key);
    expect([r.status, code(r)]).toEqual([409, "INVOICE_CHANGED"]);
    const again = await billVia(rid, eid, key);
    expect([again.replayed, code(again)]).toEqual([true, "INVOICE_CHANGED"]);
    const fresh = await billVia(rid, eid, randomUUID());
    expect(fresh.status).toBe(200);
    expect(data(fresh).invoiceId).not.toBe(derived);
  }, 60_000);

  it("(e) office Generate after a field bill returns the field invoice (draft and after finalize)", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    const inv = data(await billVia(rid, eid, randomUUID())).invoiceId as string;
    expect(await iq.createInvoiceFromSoldEstimate(org, eid)).toEqual({ ok: true, invoiceId: inv, created: false });
    expect((await fw.finalizeInvoice(actor(rid), inv)).ok).toBe(true);
    expect(await iq.createInvoiceFromSoldEstimate(org, eid)).toEqual({ ok: true, invoiceId: inv, created: false });
    expect(await invoicesOf(rid)).toHaveLength(1);
  }, 60_000);

  it("(f)(r) office invoice first → field bill ALREADY_BILLED, billing office; voided → filter drops it, Generate returns the void invoice, billing none, a field bill works", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    const office = await iq.createInvoiceFromSoldEstimate(org, eid);
    if (!office.ok) throw new Error(office.reason);
    expect((await linesOf(office.invoiceId)).every((l) => l.estimate_line_item_id !== null)).toBe(true);
    const refused = await billVia(rid, eid, randomUUID());
    expect([code(refused), details(refused)]).toEqual(["ALREADY_BILLED", { invoiceId: office.invoiceId }]);
    expect((await estimateOf(rid, eid))?.billing).toBe("office");
    expect(await notInvoicedIds()).not.toContain(eid);

    await db.execute(sql`UPDATE invoices SET state = 'void'::invoice_state WHERE id = ${office.invoiceId} AND organization_id = ${org}`);
    expect(await notInvoicedIds()).not.toContain(eid);
    expect(await iq.createInvoiceFromSoldEstimate(org, eid)).toEqual({ ok: true, invoiceId: office.invoiceId, created: false });
    expect((await estimateOf(rid, eid))?.billing).toBe("none");
    const field = await billVia(rid, eid, randomUUID());
    expect(field.status).toBe(200);
    expect(data(field).invoiceId).not.toBe(office.invoiceId);
    expect((await estimateOf(rid, eid))?.billing).toBe("job");
  }, 60_000);

  it("(f) billing precedence: office beats job when both halves hold (synthetic office row)", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    expect(data(await billVia(rid, eid, randomUUID())).added).toBe(2);
    await db.execute(sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,estimate_id,state) VALUES (${org},${rid},${cust},${eid},'open'::invoice_state)`);
    expect((await estimateOf(rid, eid))?.billing).toBe("office");
  }, 60_000);

  it("(g) the job's invoice is open and the estimate unbilled → INVOICE_LOCKED (stored), no draft created", async () => {
    const rid = await newJob();
    await openJobInvoice(rid);
    const { eid } = await soldEstimate(rid);
    const key = randomUUID();
    const r = await billVia(rid, eid, key);
    expect([r.status, code(r)]).toEqual([409, "INVOICE_LOCKED"]);
    expect((await invoicesOf(rid)).map((i) => i.state)).toEqual(["open"]);
    const [k] = await run(sql`SELECT state FROM idempotency_keys WHERE organization_id = ${org} AND user_id = ${tech} AND route = ${`${base(rid)}/${eid}/bill`} AND key = ${key}`);
    expect(k!.state).toBe("done");
    expect((await view(rid)).jobInvoice).toMatchObject({ state: "open", hasPayment: false });
  }, 60_000);

  it("(h) two sold estimates on one request bill independently onto the same draft", async () => {
    const rid = await newJob();
    const one = await soldEstimate(rid);
    const two = await soldEstimate(rid);
    expect((await view(rid)).hasOtherSold).toBe(true);
    const a = await billVia(rid, one.eid, randomUUID());
    const b = await billVia(rid, two.eid, randomUUID());
    expect(data(a).invoiceId).toBe(data(b).invoiceId);
    expect((await linesOf(data(a).invoiceId as string)).filter((l) => l.estimate_line_item_id !== null)).toHaveLength(4);
    expect(code(await billVia(rid, one.eid, randomUUID()))).toBe("ALREADY_BILLED");
    expect(code(await billVia(rid, two.eid, randomUUID()))).toBe("ALREADY_BILLED");
  }, 60_000);

  it("(i) equipment: replace retires and links; replays; a second key → EQUIPMENT_RETIRED; location rule both ways; FieldPulse unit refused", async () => {
    const L1 = randomUUID();
    const L2 = randomUUID();
    const rid = await newJob({ locationId: L1 });
    const located = await unit({ locationId: L1, make: "Carrier" });
    const unlocated = await unit({ locationId: null });
    const elsewhere = await unit({ locationId: L2 });
    const fp = await unit({ locationId: L1, fieldpulseAssetId: `fp-${randomUUID()}` });
    const v = await te.getTechEquipmentView(org, tech, rid);
    if (v.kind !== "ok") throw new Error(v.kind);
    const listed = v.view.units.map((u) => u.id);
    expect(listed).toEqual(expect.arrayContaining([located, unlocated, fp]));
    expect(listed).not.toContain(elsewhere);
    expect(v.view.canWrite).toBe(true);
    expect(v.view.units.find((u) => u.id === fp)?.managedExternally).toBe(true);

    const key = randomUUID();
    const body = { equipmentType: "ac", make: "Trane", replacesId: unlocated };
    const r = await equipVia(rid, key, body);
    expect(r.status).toBe(201);
    const neu = data(r).equipmentId as string;
    const [old] = await run(sql`SELECT retired_at, replaced_by_equipment_id FROM customer_equipment WHERE id = ${unlocated} AND organization_id = ${org}`);
    expect(old!.retired_at).not.toBeNull();
    expect(old!.replaced_by_equipment_id).toBe(neu);
    const [n] = await run(sql`SELECT location_id, retired_at, customer_id FROM customer_equipment WHERE id = ${neu} AND organization_id = ${org}`);
    expect(n).toMatchObject({ location_id: L1, retired_at: null, customer_id: cust });

    expect((await equipVia(rid, key, body)).replayed).toBe(true);
    const parsed = parseEquipmentInput(body, todayInZone(new Date()));
    if (!parsed.ok) throw new Error("fixture");
    expect(await qw.addFieldEquipment(actor(rid), { equipmentId: neu }, parsed.value)).toEqual({ ok: true, equipmentId: neu, created: false, replaced: true });
    expect(code(await equipVia(rid, randomUUID(), body))).toBe("EQUIPMENT_RETIRED");
    expect(code(await equipVia(rid, randomUUID(), { equipmentType: "ac", replacesId: fp }))).toBe("MANAGED_EXTERNALLY");
    expect(code(await equipVia(rid, randomUUID(), { equipmentType: "ac", replacesId: elsewhere }))).toBe("NOT_FOUND");

    const after = await te.getTechEquipmentView(org, tech, rid);
    if (after.kind !== "ok") throw new Error(after.kind);
    expect(after.view.units.map((u) => u.id)).not.toContain(unlocated);

    const rid2 = await newJob({ locationId: null });
    expect((await equipVia(rid2, randomUUID(), { equipmentType: "furnace", replacesId: elsewhere })).status).toBe(201);
  }, 60_000);

  it("(j) tenancy: another org's estimate or equipment id → NOT_FOUND", async () => {
    const rid = await newJob();
    const foreignEst = (await run(sql`INSERT INTO estimates (organization_id,status,total_cents) VALUES (${org2},'open'::estimate_status,100) RETURNING id`))[0]!.id as string;
    const foreignOpt = (await run(sql`INSERT INTO estimate_options (organization_id,estimate_id,name,subtotal_cents,tax_cents,total_cents)
      VALUES (${org2},${foreignEst},'Good',100,0,100) RETURNING id`))[0]!.id as string;
    expect(code(await sellVia(rid, foreignEst, randomUUID(), { optionId: foreignOpt, signatureName: "Pat" }))).toBe("NOT_FOUND");
    expect(code(await billVia(rid, foreignEst, randomUUID()))).toBe("NOT_FOUND");
    expect(code(await declineVia(rid, foreignEst, randomUUID()))).toBe("NOT_FOUND");
    const { encrypt } = await import("@/lib/crypto");
    const foreignCust = (await run(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org2},${encrypt("Other Org")}) RETURNING id`))[0]!.id as string;
    const foreignUnit = await unit({ locationId: null, customerId: foreignCust, orgId: org2 });
    expect(code(await equipVia(rid, randomUUID(), { equipmentType: "ac", replacesId: foreignUnit }))).toBe("NOT_FOUND");
    const [fu] = await run(sql`SELECT retired_at FROM customer_equipment WHERE id = ${foreignUnit} AND organization_id = ${org2}`);
    expect(fu!.retired_at).toBeNull();
  }, 60_000);

  it("(j2) same org: another request's estimate or another customer's unit → NOT_FOUND", async () => {
    const ridA = await newJob();
    const ridB = await newJob();
    const sold = await soldEstimate(ridB);
    const openEid = data(await createVia(ridB, randomUUID(), TWO())).estimateId as string;
    const [openOpt] = await optionIds(openEid);
    expect(code(await sellVia(ridA, openEid, randomUUID(), { optionId: openOpt!, signatureName: "Pat" }))).toBe("NOT_FOUND");
    expect(code(await billVia(ridA, sold.eid, randomUUID()))).toBe("NOT_FOUND");
    expect(code(await declineVia(ridA, openEid, randomUUID()))).toBe("NOT_FOUND");
    expect((await estimateRow(openEid)).status).toBe("open");
    expect(await invoicesOf(ridA)).toHaveLength(0);
    const { encrypt } = await import("@/lib/crypto");
    const otherCust = (await run(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Other Customer")}) RETURNING id`))[0]!.id as string;
    const theirs = await unit({ locationId: null, customerId: otherCust });
    expect(code(await equipVia(ridA, randomUUID(), { equipmentType: "ac", replacesId: theirs }))).toBe("NOT_FOUND");
  }, 60_000);

  it("(k) expired → ESTIMATE_EXPIRED; decline → dismissed, replay → success, then sell → ALREADY_DECIDED", async () => {
    const rid = await newJob();
    const eid = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
    const [good] = await optionIds(eid);
    await db.execute(sql`UPDATE estimates SET expires_at = now() - interval '1 minute' WHERE id = ${eid} AND organization_id = ${org}`);
    expect(code(await sellVia(rid, eid, randomUUID(), { optionId: good!, signatureName: "Pat" }))).toBe("ESTIMATE_EXPIRED");
    expect((await estimateOf(rid, eid))?.status).toBe("expired");

    const eid2 = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
    const [g2] = await optionIds(eid2);
    expect(data(await declineVia(rid, eid2, randomUUID()))).toEqual({ estimateId: eid2, status: "dismissed", created: true });
    expect((await estimateRow(eid2)).status).toBe("dismissed");
    expect(data(await declineVia(rid, eid2, randomUUID()))).toEqual({ estimateId: eid2, status: "dismissed", created: false });
    expect(code(await sellVia(rid, eid2, randomUUID(), { optionId: g2!, signatureName: "Pat" }))).toBe("ALREADY_DECIDED");
    expect((await estimateOf(rid, eid2))?.status).toBe("declined");
  }, 60_000);

  it("(l) materials logged before the sale, no draft → the bill's draft holds the materials and the estimate lines", async () => {
    const rid = await newJob();
    const m = await addMaterial(rid, 1, 3_000);
    const { eid } = await soldEstimate(rid);
    const b = await billVia(rid, eid, randomUUID());
    expect(data(b)).toMatchObject({ added: 2, hasMaterials: true });
    const lines = await linesOf(data(b).invoiceId as string);
    expect(lines.filter((l) => l.job_material_id === m)).toHaveLength(1);
    expect(lines.filter((l) => l.estimate_line_item_id !== null)).toHaveLength(2);
  }, 60_000);

  it("(m) an estimate-linked line can't be removed in the field (FROM_ESTIMATE) nor its estimate line deleted (FK)", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    const inv = data(await billVia(rid, eid, randomUUID())).invoiceId as string;
    const [l] = (await linesOf(inv)).filter((x) => x.estimate_line_item_id !== null);
    expect(await fw.removeInvoiceLine(actor(rid), inv, String(l!.id))).toEqual({ ok: false, reason: "from_estimate" });
    expect(await linesOf(inv)).toHaveLength(2);
    let caught: unknown = null;
    try {
      await db.execute(sql`DELETE FROM estimate_line_items WHERE id = ${String(l!.estimate_line_item_id)} AND organization_id = ${org}`);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
  }, 60_000);

  it("(n) a zero-line sold estimate → NO_LINES, no invoice", async () => {
    const rid = await newJob();
    const est = (await run(sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents)
      VALUES (${org},${rid},${cust},'sold'::estimate_status,0) RETURNING id`))[0]!.id as string;
    const opt = (await run(sql`INSERT INTO estimate_options (organization_id,estimate_id,name,subtotal_cents,tax_cents,total_cents)
      VALUES (${org},${est},'Good',0,0,0) RETURNING id`))[0]!.id as string;
    await db.execute(sql`UPDATE estimates SET sold_option_id = ${opt} WHERE id = ${est} AND organization_id = ${org}`);
    expect(code(await billVia(rid, est, randomUUID()))).toBe("NO_LINES");
    expect(await invoicesOf(rid)).toHaveLength(0);
  }, 60_000);

  it("(o) a draft with a recorded payment → INVOICE_LOCKED, nothing added", async () => {
    const rid = await newJob();
    const c = await fw.createInvoiceFromJob(actor(rid), { invoiceId: randomUUID() });
    if (!c.ok) throw new Error(c.reason);
    await db.execute(sql`UPDATE invoices SET amount_paid_cents = 100 WHERE id = ${c.invoiceId} AND organization_id = ${org}`);
    const { eid } = await soldEstimate(rid);
    expect((await view(rid)).jobInvoice).toMatchObject({ id: c.invoiceId, state: "draft", hasPayment: true });
    expect(code(await billVia(rid, eid, randomUUID()))).toBe("INVOICE_LOCKED");
    expect((await linesOf(c.invoiceId)).filter((l) => l.estimate_line_item_id !== null)).toHaveLength(0);
  }, 60_000);

  it("(p) the job's earlier invoice paid, no live invoice → the bill creates a new draft with the sale", async () => {
    const rid = await newJob();
    const first = await openJobInvoice(rid);
    await db.execute(sql`UPDATE invoices SET state = 'paid'::invoice_state, amount_paid_cents = total_cents WHERE id = ${first} AND organization_id = ${org}`);
    const { eid } = await soldEstimate(rid);
    const v = await view(rid);
    expect([v.jobInvoice, v.priorInvoicePaid]).toEqual([null, true]);
    const b = await billVia(rid, eid, randomUUID());
    expect(b.status).toBe(200);
    expect(data(b).invoiceId).not.toBe(first);
    expect((await invoiceRow(data(b).invoiceId as string)).state).toBe("draft");
  }, 60_000);

  it("(s) estimate-linked lines read fromEstimate in the tech invoice view", async () => {
    const rid = await newJob();
    const m = await addMaterial(rid, 1, 3_000);
    const { eid } = await soldEstimate(rid);
    expect(data(await billVia(rid, eid, randomUUID())).added).toBe(2);
    const r = await ti.getTechInvoiceView(org, tech, rid);
    if (r.kind !== "ok" || !r.view.invoice || !("lines" in r.view.invoice)) throw new Error("expected the lead's full invoice");
    expect(r.view.invoice.lines.map((l) => l.fromEstimate).sort()).toEqual([false, true, true]);
    expect(m).toBeTruthy();
  }, 60_000);

  it("(t) an in-flight estimate or equipment key does not set the invoice view's pendingWrite; an invoice key does", async () => {
    const rid = await newJob();
    for (const route of [base(rid), `/api/tech/jobs/${rid}/equipment`]) {
      await db.execute(sql`INSERT INTO idempotency_keys (organization_id,user_id,route,key,request_hash,state,attempt_id)
        VALUES (${org},${tech},${route},${randomUUID()},'h','in_progress',${randomUUID()})`);
    }
    const before = await ti.getTechInvoiceView(org, tech, rid);
    if (before.kind !== "ok") throw new Error(before.kind);
    expect(before.view.pendingWrite).toBe(false);
    await db.execute(sql`INSERT INTO idempotency_keys (organization_id,user_id,route,key,request_hash,state,attempt_id)
      VALUES (${org},${tech},${`/api/tech/jobs/${rid}/invoice/finalize`},${randomUUID()},'h','in_progress',${randomUUID()})`);
    const after = await ti.getTechInvoiceView(org, tech, rid);
    if (after.kind !== "ok") throw new Error(after.kind);
    expect(after.view.pendingWrite).toBe(true);
  }, 60_000);

  it("migration 0057 applies twice, statement by statement", async () => {
    const statements = readFileSync("drizzle/0057_m3c_sell_on_site.sql", "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBe(7);
    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) await db.execute(sql.raw(stmt));
    }
  }, 60_000);
});
```

- [ ] **Step 2: Register the suite.** Re-read `vitest.config.ts` (another workstream appends to the same array), then append inside `INTEGRATION_SUITES`, after the last entry:

```ts
  // M3c sell on site: estimates, bill once, equipment against the dev DB (two throwaway orgs).
  "tests/integration/field-estimate.test.ts",
```

- [ ] **Step 3: Run it**

Run: `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-estimate.test.ts`
Expected: PASS (23 tests). Then `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-invoice.test.ts` still PASS (M3b regression), and `npx vitest run` (unit gate) still excludes both. Confirm both probe orgs are gone: `SELECT count(*) FROM organizations WHERE name LIKE 'Probe Org Field Estimate%'` → 0.

- [ ] **Step 4: Commit the suite**

```bash
npx tsc --noEmit && npx eslint tests/integration/field-estimate.test.ts vitest.config.ts && npx vitest run
git add tests/integration/field-estimate.test.ts vitest.config.ts
git commit -m "$(cat <<'EOF'
test(m3c): field estimate integration suite (a)-(t) on throwaway orgs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

- [ ] **Step 5: Docs (spec §9).**
  - `.claude/skills/page-tech/SKILL.md` — add a section after "Collect (M3b …)":

```markdown
**Sell on site (M3c, `/tech/jobs/[id]/estimates/new`, `/tech/jobs/[id]/estimates/[eid]`):**
- **Files:** pages `src/app/tech/jobs/[id]/estimates/{new,[eid]}/page.tsx` · components
  `src/components/tech/estimates/` (`estimates-card.tsx`, `estimate-builder-client.tsx`,
  `estimate-page-client.tsx`, `customer-view.tsx`, `use-estimate-write.ts`,
  `recover-intents.ts`, `fetch-estimates.ts`) and `src/components/tech/equipment/`
  (`equipment-card.tsx`, `equipment-sheet.tsx`) · writers `src/lib/tech/estimate-writes.ts`,
  `src/lib/tech/equipment-writes.ts`, `billSoldEstimate` in
  `src/lib/admin/invoice-field-writes.ts` · billed(eid) SQL `src/lib/admin/estimate-billing-sql.ts`
  · read models `src/lib/tech/estimate-queries.ts`, `src/lib/tech/equipment-queries.ts` · pure
  `estimate-input.ts`, `estimate-builder.ts`, `estimate-display.ts`, `estimate-page-copy.ts`,
  `customer-view-state.ts`, `estimate-intents.ts`, `equipment-input.ts`, `equipment-display.ts`,
  `material-overlap.ts`, `field-sale-statuses.ts`, `add-item-done.ts` (all `src/lib/tech/`).
- **Routes:** `GET/POST /api/tech/jobs/[id]/estimates`, `POST …/estimates/[eid]/{sell,bill,decline}`,
  `GET/POST /api/tech/jobs/[id]/equipment`. Preambles: estimate create/sell/decline =
  lead + arrived/in_progress/on_hold ("Arrive at the job first." / "This job is closed.");
  bill = lead + invoicing statuses, same copy; equipment = any technician with a
  non-cancelled assignment (403 `NOT_ASSIGNED`) + arrived…completed. Invoice routes: a
  cancelled request now answers 409 `JOB_CLOSED` (copy unchanged).
- **Billing once:** billed(eid) = a non-void invoice with `estimate_id = eid` (office) OR a
  linked line (`invoice_line_items.estimate_line_item_id`) on a non-void native invoice
  with `estimate_id IS NULL` (job). The bill pre-checks, drafts through
  `createInvoiceFromJob` (seeds materials), then inserts under L_req → L_inv with
  `NOT billed(eid)` (`billLinesSql`). `ALREADY_BILLED` renders as the billed state. Linked
  lines can't be removed in the field (`FROM_ESTIMATE`). Spec deviations: when this key's
  derived invoice is paid, refunded or voided the bill answers STORED `INVOICE_CHANGED`
  "The job's invoice changed. Try again." (a new key derives a new invoice; unstored STALE
  looped forever); `INVOICE_LOCKED` copy is "The job's invoice is already finalized. Ask
  the office to bill this estimate." (Generate refuses while a paid draft exists).
- **GET contract** adds `requestStatus` and `priorInvoicePaid` to spec §6; the bill success
  adds `hasMaterials`. Never cost, never the typed signature name.
- **Customer view:** `#customer` via native pushState/popstate (`layerStep`); Back closes
  onto the estimate page, never further; a reload reopens the layer only while sellable,
  else strips the hash; a reload that reopens it runs replaceState (strip) then
  pushState('#customer'), so every close is one Back (spec deviation; a reload on an
  already-pushed entry leaves one extra estimate-page entry). Customer-facing failures
  read "Something went wrong. Please hand the phone back to your technician." only.
- **Keys:** estimate/equipment intents live under `tech:estimate:<rid>:intents`
  (`useIdempotencyKey({ storageKey, rehydrate })`); the builder, the estimate page and the
  equipment card re-send stored intents on mount (`recoverEstimateIntents`) and stay
  locked with "Try again" while any is unanswered; the equipment sheet rehydrates its own
  intent and re-sends the old body with the old key before Save unlocks. The invoice
  view's `pendingWrite` counts only `/invoice%` and `/signature` keys.
- **Equipment:** location rule `(r.location_id IS NULL OR ce.location_id IS NULL OR
  ce.location_id = r.location_id)` in the GET and every write; replace = lock old →
  insert while old is live → retire old only when this transaction wrote the new row.
  Install date stored as noon Eastern.
- **Verify:** `npx vitest run src/lib/tech/estimate-*.test.ts src/lib/tech/equipment-*.test.ts src/lib/tech/customer-view-state.test.ts "src/app/api/tech/jobs/[id]/estimates" "src/app/api/tech/jobs/[id]/equipment"`;
  dev DB: `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-estimate.test.ts`.
```

  - `.claude/skills/page-estimates/SKILL.md` — add: "**Field estimates (M3c):** title 'Field estimate', no approval token, 30-day expiry, sold on the technician's phone. `estimates.sold_via` ('portal' | 'office' | 'field', NULL before M3c) and `sold_by` (technician for field, admin for office). Detail Approval card (names in bold as before): field → 'Signed by <name>.' + 'Signed on site with <technician> · <time>'; office → 'Marked sold by <admin>'; old rows unchanged (`approvalLines`, `src/lib/admin/estimate-approval-copy.ts`). `Sold, not invoiced` tab (`bucket=not_invoiced`): native sold, no invoice of any state with this `estimate_id`, not on the job's invoice. Generate (`createInvoiceFromSoldEstimate`) refuses while the field bill holds the lines and returns that invoice; both insert paths write `estimate_line_item_id` with v7 ids in line order. A voided office invoice ends office billing (Generate returns it)."
  - `.claude/skills/page-customers/SKILL.md` — add: "**Retired units (M3c):** a unit replaced in the field has `retired_at` + `replaced_by_equipment_id`; the profile lists it last, muted, 'Replaced <date> · See the replacement' (link only while the replacement exists, `equipmentRecords`); the equipment count (profile and directory) counts live units only; chat-intake dedupe (`recordCustomerEquipment`) ignores retired units."
  - `.claude/skills/page-invoices/SKILL.md` — add: "**Estimate-linked lines (M3c):** `invoice_line_items.estimate_line_item_id` marks lines copied from a sold estimate (field bill and office Generate); the field can't remove them (409 `FROM_ESTIMATE` 'This item came from the approved estimate. Ask the office to change it.'); the tech view marks them `fromEstimate` ('From the estimate')."
  - Run `node scripts/agent/verify-skills.mjs` → 0 missing.
  - `replica/features.csv`: line 129 `Equipment add / replace from field,tech-app,must,yes,yes,ST; job page Equipment card: add or replace at the job's address (location rule), old unit retired and linked; no photos/barcode/warranty`; line 132 `Present estimate with options on site,tech-app,must,yes,yes,FP+ST; builder (1-3 pricebook options) + #customer layer: pick, typed-name signature, approve on the lead's phone`; line 133 `Sold items onto invoice now or later,tech-app,must,yes,yes,ST; now = the job's invoice (once per estimate); later = office Generate invoice + Sold, not invoiced filter`.
  - `replica/parity.md`: regenerate with the `replica-diff` skill (it rewrites the file from `features.csv`); report the old → new score.
  - `replica/build-log.md` — append two rows:

```text
S38 | 2026-11-06 | done | estimate templates, groupings, add-ons, deposits, discounts, edit/un-sell after save (M4); drawn signature on the estimate (deferred, no object storage on dev); sold-not-booked (M4) | M3c Sell on site: migration 0057 (invoice_line_items.estimate_line_item_id NO ACTION FK + index, estimates.sold_by/sold_via); field estimate builder (1-3 pricebook options, Good/Better/Best naming, undo, sessionStorage draft) and #customer layer (pushState/popstate; reload reopens only while sellable); sell = typed full name (portal rule) + sold_via field + sold_by; billed(eid) office half OR job half; bill drafts through createInvoiceFromJob and inserts under L_req with NOT billed(eid), ALREADY_BILLED shown as billed; office Generate guard + line links; Sold, not invoiced filter; decline; materials-overlap warning; rulings: GET adds requestStatus/priorInvoicePaid, bill adds hasMaterials, invoice preamble answers cancelled with JOB_CLOSED, FK named invoice_line_items_estimate_line_fk (63-char limit), equipment NOT_ASSIGNED, INVOICE_CHANGED stored (derived invoice paid/voided), INVOICE_LOCKED copy "Ask the office to bill this estimate.", customer-layer reload re-pushes #customer, equipment intents rehydrate before unlock; integration suite tests/integration/field-estimate.test.ts (a)-(t) + in-batch guard, INVOICE_CHANGED and same-org cases
S39 | 2026-11-06 | done | equipment photos, barcode scan, warranty fields; location-info tab (M3d) | equipment add/replace from the field: any technician on the job, location rule shared by the GET and every write, replace retires + links in one batch (lock old, insert while live, xmin-gated retire), FieldPulse units refused, install date stored as noon Eastern; office lists retired units last and counts live units only; intake dedupe ignores retired units
```

  - `replica/architecture.md` — in the "M3c Sell on site" paragraph replace "present + sign (`markEstimateSold` variant, signer + signature)" with "present + sign (field writer `sellFieldEstimate`; typed full name + `sold_by`/`sold_via='field'` — drawn signature deferred, accepted downgrade: weaker evidence than the portal's remote e-sign, the office view says 'Signed on site with <technician>')" and append "Shipped 2026-11-06 (plan `docs/superpowers/plans/2026-11-06-replica-m3c-sell-on-site.md`)."
  - Memory: update `/Users/sizbei/.claude/projects/-Users-sizbei-Documents-GitHub-ai-hvac-agent/memory/replica-program-fp-st.md` with "M3c Sell on site built (commits listed, pushed or not, NOT deployed by this plan), parity <old> → <new>; next M3d" and the rulings list above; update its `MEMORY.md` index line accordingly. (Memory lives outside the repo: not part of the commit.)

- [ ] **Step 6: Gates and commit the docs**

```bash
node scripts/agent/verify-skills.mjs && npx vitest run
git add .claude/skills/page-tech/SKILL.md .claude/skills/page-estimates/SKILL.md .claude/skills/page-customers/SKILL.md .claude/skills/page-invoices/SKILL.md replica/features.csv replica/parity.md replica/build-log.md replica/architecture.md
git commit -m "$(cat <<'EOF'
docs(m3c): skills, feature matrix, parity, build log, architecture annotation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

## Self-review

**1. Spec coverage**

| spec | where |
| --- | --- |
| §1 goal, done-when (two options, sign on device, lines once even when signed and added twice, replaced unit retired + linked) | Tasks 3 (create/sell), 2 (bill once), 4 (replace); proven by Task 11 (a)(b)(c)(d)(i) and the lead's §8 walk |
| §1 signature downgrade stated | Task 7 (office copy), Task 11 docs (architecture annotation) |
| §2 Estimates card (label, chips, price, billing line, lead link / New estimate / reason, helpers read-only, refetch on status tap) | Task 5 (`estimateLabel`, `STATUS_CHIP`, `priceSummary`, `BILLING_LINE`, `createBlockedReason`), Task 8 (card), Task 10 (placement + `refreshKey`) |
| §2 builder / estimate page / customer view / helpers' "Only the lead technician can open this." | Tasks 8, 9 |
| §2 Equipment card | Task 10 |
| §2 office detail ("Signed on site with …", "Marked sold by …") | Task 7 |
| §2 office `Sold, not invoiced` filter | Task 7 (+ Task 11 (c)(f)(r)) |
| §2 office customer equipment (retired last, muted, Replaced <date>, null-safe link, live count) | Task 4 (data), Task 10 (UI) |
| §3 migration 0057 (FK NO ACTION + index; sold_by/sold_via + check; journal/snapshot; No schema changes) | Task 1 (+ Task 11 re-apply test) |
| §3 sold_via written by portal / office / field | Task 7 (`approveEstimate`, `markEstimateSold`), Task 3 (`sellFieldEstimate`) |
| §4 ids (derivedId estimate/invoice/equipment, v7 option/line ids, xmin gate), stored / not-stored codes | Tasks 3, 2, 4 (writers), Task 3 (`STORED_CODES`, `estimate-errors.test.ts` storability) |
| §5 money INT32 checks, 22003 | Task 3 (`buildFieldEstimate`), Task 2 (`exceedsInt32`, `isNumericOverflow`) |
| §5.1 create | Task 3 |
| §5.2 sell (replay rule, expired, decided, option, lead, status; never bills) | Task 3 |
| §5.3 bill (billed(eid), pre-check order, draft mapping — paid/refunded/voided → stored INVOICE_CHANGED per ruling 11, plain stale → STALE —, batch, result, 22003 in step 2 and step 3, materials in the int4 pre-check), FROM_ESTIMATE, fromEstimate, pendingWrite narrowing | Task 1 (builders), Task 2; in-batch guard proven on the DB by Task 11 (d2), INVOICE_CHANGED by (d3) |
| §5.4 office Generate guard + line links + v7 order | Task 2 |
| §5.5 decline | Task 3 (+ Task 9 UI, approval-link note) |
| §5.6 equipment (input rules, preamble, location rule, replace CAS, FieldPulse, NO_CUSTOMER, intake dedupe ignores retired, erase unchanged) | Task 4, Task 6 (preamble) |
| §6 preamble options, all routes, GET contracts, 201/200, audits only on change | Task 6 |
| §7 keys (intent ids, own storage key, reload re-send, refetch triggers) | Task 8 (`ESTIMATE_INTENT`, `useEstimateWrite`, `recoverEstimateIntents`), Tasks 8–10 (mount / visibility / after write / layer close refetches) |
| §7.1 builder (naming, remove + undo, line undo, Add item Done-adds-pending, footer, save reasons, hasOtherSold line, draft + discard) | Task 8 |
| §7.2 customer view (layer, history, header, radiogroup + pre-select, Show all outside label, name + consent + hint in flow, sticky footer hidden while typing, confirm, Approving…, success / unknown → Checking… / customer-safe failure, hand-back) | Task 9 |
| §7.3 estimate page (open / sold / billing branches incl. new-invoice note, after-add hints, expired / declined) | Task 9 |
| §7.4 materials overlap | Task 10 |
| §7.5 equipment UI | Task 10 |
| §8 pure tests, SQL renders, route tests, integration (a)–(t), browser walk | Tasks 1–10 (pure/render/route; all five route test files written out in Task 6), Task 11 (integration (a)–(t) plus (d2) in-batch guard, (d3) INVOICE_CHANGED, (j2) same-org other request/customer; (q) in Task 2), the lead's walk after Task 11 (incl. reload → Back) |
| §9 docs | Task 11 |

**2. Placeholder scan:** no TBD / "add appropriate" / "similar to Task N"; every code step carries code, including the v1 gaps the reviews listed (the sell / bill / decline / equipment route tests, the `approveEstimate` test, `getEstimateDetailById`, `createRequestEstimateInvoice`, the estimates-page tab code). One place names a mechanical edit instead of reprinting test files: Task 2 Step 7, `fromEstimate: false` on every `lineTotalCents` literal in two named test files.

**v2 changes after review round 1:** sequential execution (ruling 1); reload re-pushes `#customer` (ruling 2); `INVOICE_CHANGED` stored (ruling 3); exported `billLinesSql` + DB proof (d2) and a deadlock retry in (d) (ruling 4); equipment intents rehydrate and the card/page stay locked while unanswered (ruling 5); `INVOICE_LOCKED` copy (ruling 6); TS2352 in `isStoredWrite`, the three manual-memoization errors (setters in deps), the four existing tests now owned (invoice-queries admin ~468, tech invoice-queries "cost" + "pendingWrite", estimate-detail via `soldVia == null` + new cases), hex-letter uuid tests, the add-item sheet's double close, `JOB_CLOSED` in the invoice client's message set (ruling 7); everything "described, not shown" written out (ruling 8); minors applied or rejected in the header (ruling 9).

**3. Type consistency:** `BillReason` / `BillResult` (Task 2, incl. `invoice_changed`) ⊂ `EstimateRouteReason` (Task 3, spelled locally); `EstimateWriteReason` uses `estimate_not_found` everywhere (writers, errors, tests); `TechEstimatesView` fields (`requestStatus`, `priorInvoicePaid`, `jobInvoice`) match Task 5 producer and Tasks 8–10 consumers; `useEstimateWrite(requestId, intentId, rehydrate = false)` returns `{ phase, send, settle }` (Tasks 8, 9, 10); `LayerState = { open: boolean }` with `LAYER_OPEN` / `LAYER_CLOSED` (Task 9); `EquipmentInput.replacesId` is lower case (Task 4) and the route audits it as such (Task 6); `INVOICE_PREAMBLE` keeps `techWritePreamble(request, id)` callers unchanged.

**4. Review Focus:** five lines above, each pinned by a named test in the owning task (Tasks 2, 3, 4, 9).

**Accepted gaps (stated, not built):** the browser walk's keyboard-open layout needs a real phone (spec §8); `deleteCustomer` leaves estimates and the typed name (spec §5.6 known gap).
