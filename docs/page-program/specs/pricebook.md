# Spec: pricebook (`/admin/pricebook`)

## 1. Purpose

The org's single priced catalog of services, materials, and equipment, plus
its tax rates. Admin/super_admin operators create/edit/deactivate priced
line items and manage tax rates that estimates and invoices draw from. Not a
customer- or technician-facing surface.

## 2. Brainstorm

- **Server-side pagination + search that never full-scans 17.5k rows.**
  ALREADY BUILT — verified in current state.
- **Surface FieldPulse stock/vendor data (`quantityAvailable`, `vendorType`)
  already imported but invisible.** ACCEPTED → Rpricebook-1.
- **Cap/replace the 20,000-row "fetch everything" mode the estimate picker
  uses against this page's own API.** ACCEPTED → Rpricebook-2 — the API's own
  cap, combined with a 17.5k-row prod catalog, is a full-table dump in
  practice, contradicting the page's documented pagination gotcha.
- **Category tree browsing/assignment UI** for `pricebook_categories`
  (table + `categoryId` API support already exist). ACCEPTED → Rpricebook-3
  — schema/API-complete, only the UI is missing.
- **Bulk CSV import/export.** REJECTED — FieldPulse sync is already the bulk
  ingestion path for FP-integrated orgs; no demonstrated need for a second one.
- **Spreadsheet-style bulk price edit.** REJECTED — no evidence of demand;
  real complexity (undo, per-row audit, concurrent edits) unjustified at
  today's edit-one-item-at-a-time volume.
- **`pg_trgm`/GIN search index.** REJECTED for this pass — at ~17.5k rows,
  org-scoped `ilike '%term%'` after the org-id bitmap filter is not a
  measured slow query; premature optimization, P2 watch-item if the catalog
  grows an order of magnitude (`inferred`, no `EXPLAIN` run).
- **Role-gate cost/margin away from non-admin roles.** REJECTED — no evidence
  technician sessions can reach `/admin/pricebook`; `session.role` gating in
  this repo is used narrowly (e.g. staff management), not on data pages.
- **Unconditional "member price ≤ standard price" enforcement on every
  PATCH**, not just when both fields are present together. ACCEPTED →
  Rpricebook-4 — small, defense-in-depth; not exploitable via the shipped
  form today, but the API doesn't actually guarantee what it error-messages.
- **"No default tax rate configured" warning banner.** REJECTED —
  `getDefaultTaxBps` already degrades gracefully to 0%; not a broken state,
  no evidence of complaints. P2 polish idea, not required.

## 3. Current state

All claims `verified` by reading cited files unless tagged `inferred`.

**Files** (per `.claude/skills/page-pricebook/SKILL.md:11-18`, confirmed to
match): page `src/app/admin/(dashboard)/pricebook/page.tsx`; table
`pricebook-table.tsx`; form `pricebook-form-dialog.tsx`; tax panel
`tax-rates-panel.tsx` (all under `src/components/admin/pricebook/`); hook
`src/hooks/use-pricebook.ts`; APIs `src/app/api/admin/pricebook/route.ts`,
`.../pricebook/[id]/route.ts`, `.../pricebook/tax-rates/route.ts`,
`.../pricebook/tax-rates/[id]/route.ts`; queries
`src/lib/admin/pricebook-queries.ts`; schema `src/lib/db/schema.ts:2213-2337`.

**Scale/pagination (lens a):**
- Admin list is server-paginated: SQL `LIMIT`/`OFFSET`
  (`pricebook-queries.ts:225-231`), default page size 50 (`:135`); count/rows/
  types-facet run in parallel via one `Promise.all` (`:233-237`). Search is
  server-side `ilike` with escaped LIKE metacharacters (`:178-190`) —
  filtering never happens in JS. Type filter is pre-validated against an
  allowlist before reaching a raw `sql` template (`route.ts:68-77`), so no
  injection risk.
- GET route caps `limit` at `Math.min(20000, ...)` (`route.ts:64`).
- **`estimate-create-dialog.tsx:81`** calls `usePricebook({ limit: 20000 })`
  — every "New estimate" open fetches up to the API's max cap, effectively
  the entire ~17.5k-row prod catalog, unpaginated, into the browser. Directly
  contradicts `.claude/skills/page-pricebook/SKILL.md:44-45` ("never bypass
  the page/limit params").
- Indexes: `pricebook_items_org_idx`, `pricebook_items_category_idx`, two
  partial unique indexes (org+SKU, org+FP-id) (`drizzle/0000_baseline.sql:
  806-810`, `0038_fp_item_id.sql:2`). No compound `(org, active, name)`
  index backing the default list shape — `inferred` low-impact at this row
  count, not verified via `EXPLAIN`.

**Money correctness (lens b):**
- Integer cents throughout (`costCents`/`priceCents`/`memberPriceCents`,
  `schema.ts:2249-2252`); tax in integer basis points. No float math found.
- Matching business cap `MAX_PRICE_CENTS = 99_999_999` client
  (`money-format.ts:19-20`) and server (`route.ts:19`, `[id]/route.ts:20`) —
  well inside Postgres `integer` bounds. `Math.round(dollars*100)` avoids
  float drift (`money-format.ts:28-34`).
- POST/PATCH both `.refine()` `memberPriceCents <= priceCents`, but **PATCH
  only enforces it when both fields are present in the same request body**
  (`[id]/route.ts:36-43`) — not reachable via the shipped form (which always
  sends both together) but not a guaranteed API invariant.
- Tax single-default invariant maintained via ordered `db.batch()`
  (unset-then-set, since neon-http batch is sequential, not transactional) —
  `pricebook-queries.ts:356-362`, `390-402`.
- Soft-delete only (`active=false`, `:261-272`); `estimate_line_items`,
  `job_materials`, `po_line_items`, `inventory_items` all reference
  `pricebook_items.id` and would orphan on a hard delete.

**Feeds estimates/invoices — not an island (lens c):**
- `estimate_line_items` (`schema.ts:2716-2739`) SNAPSHOTS
  `pricebookItemId`/`name`/`unitPriceCents`/`costCents` at quote time so
  later catalog edits never mutate a sent quote.
- `POST /api/admin/estimates` re-resolves every catalog line server-side
  from the tenant-scoped item — a client-sent price can never override a
  catalog price (`estimates/route.ts:126-158`); inactive/deleted item at
  submit returns a clean 400 (`:139-147`). Invoice tax resolves from
  `getDefaultTaxBps`, also server-derived (`:181`).
- Also linked from `inventory_items` (`schema.ts:2549-2551`) and
  `po_line_items` (`:2611-2612`) — shared spine for estimating, inventory,
  and purchasing, not just this page.
- **FieldPulse-imported fields never surface anywhere.** `quantityAvailable`/
  `vendorType` are typed columns (`schema.ts:2262-2265`) populated on every FP
  sync (`fieldpulse/import/items.ts:130-152`), deliberately excluded from the
  `fieldpulseData` spillover as promoted columns (`spillover.ts:96`) — but
  also omitted from `ADMIN_ITEM_PROJECTION` (`pricebook-queries.ts:102-120`)
  and `PricebookItem` (`use-pricebook.ts:7-24`). Real imported stock/vendor
  data is invisible on every admin surface.
- Category tree exists (`pricebookCategories`, `schema.ts:2219-2234`) and
  both item APIs accept `categoryId` (`route.ts:23`, `[id]/route.ts:24`) —
  but `pricebook-form-dialog.tsx`'s `FormState` (`:39-51`) has no category
  field and `page.tsx` has no category filter (grep confirmed). `categoryId`
  is permanently `null` for every item created through this UI.

**UX/other, verified:**
- Filters persist to the URL (page number intentionally does not),
  `/`-focuses-search, resets to page 1 on filter change — all confirmed at
  `page.tsx:52-109`, matching the page skill.
- 60s client SWR cache keyed on the full param tuple (`use-pricebook.ts:41,
  78`); tax rates fetch independently, `handleRefetchAll` refreshes both
  (`page.tsx:146-149`).
- Composes `PageShell`/`PageHeader`/`Pager` — no hand-rolled chrome.
- `pricebook-list-helpers.test.ts` (filename doesn't match: it actually
  imports/tests `listPricebookItemsForAdmin` from `pricebook-queries.ts`; no
  `pricebook-list-helpers.ts` source file exists, confirmed via `find`)
  covers pagination, tenant-scoping, default active filter, search escaping,
  type filter, shared count/rows `WHERE`. `pricebook-queries.test.ts` also
  exists (not read in full this pass).

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| `quantityAvailable`/`vendorType` written on every FP sync but never selected/rendered anywhere in the admin UI | P1 | `schema.ts:2262-2265`; written `fieldpulse/import/items.ts:130-152`; omitted from `ADMIN_ITEM_PROJECTION` (`pricebook-queries.ts:102-120`) and `PricebookItem` (`use-pricebook.ts:7-24`); denylisted from spillover (`spillover.ts:96`) |
| Estimate-creation dialog fetches up to the API's 20,000-row cap on every open — effectively the full ~17.5k-row catalog, unpaginated | P1 | `estimate-create-dialog.tsx:81`; cap `route.ts:64`; contradicts `.claude/skills/page-pricebook/SKILL.md:44-45` |
| Category tree fully modeled + API-accepted but no UI to create/assign/filter by category; `categoryId` is permanently `null` in practice | P1 | schema `schema.ts:2219-2234`; API `route.ts:23`, `[id]/route.ts:24`; absent from `FormState` `pricebook-form-dialog.tsx:39-51`; no filter UI in `page.tsx` |
| PATCH's member/standard price `.refine()` only fires when both fields are in the same request — API doesn't actually guarantee the invariant it error-messages | P2 | `[id]/route.ts:36-43` |
| No compound `(org, active, name)` index for the default list query shape | P2 (inferred, unmeasured) | `drizzle/0000_baseline.sql:806-810` |
| No `pg_trgm`/GIN index backing `ilike '%term%'` search | P2 (inferred, unmeasured — see Brainstorm) | `pricebook-queries.ts:178-190` |
| Types-facet `selectDistinct` re-runs every list request though the enum has 3 fixed values | P2 | `pricebook-queries.ts:194-204,233-237` |
| Test filename `pricebook-list-helpers.test.ts` doesn't match what it tests; no such source module exists | P2 (naming only) | file content + `find` confirms no source file |

No P0s — core read/write/pagination/money paths are correct and match their
documented invariants.

## 5. Requirements

- **Rpricebook-1**: Admin read paths return `quantityAvailable`/`vendorType`
  for FP-synced items; the expanded row/FieldPulse-details panel displays
  them when present. **Acceptance:** `ADMIN_ITEM_PROJECTION` and
  `PricebookItem` include both (nullable) fields; a screenshot of an
  expanded FP-synced row with non-null `quantityAvailable` shows a stock
  value; `npx vitest run src/lib/admin/pricebook-queries.test.ts
  src/lib/admin/pricebook-list-helpers.test.ts` stays green.

- **Rpricebook-2**: The estimate-creation item picker no longer requires a
  full-catalog client fetch. **Acceptance:** opening "New estimate" issues a
  bounded/paginated or search-driven pricebook request, not a flat
  `limit: 20000` dump — verified via network inspection while the dialog is
  open, and by confirming `estimate-create-dialog.tsx` no longer passes
  `limit: 20000`. Implementation may choose typeahead, a smaller default page
  + search, or a slim endpoint; the bar is "no effectively-all-rows request."

- **Rpricebook-3**: An admin can create/rename a category, assign it to an
  item, and filter the list by category. **Acceptance:** `FormState` gains a
  wired `categoryId` select; `page.tsx` gains a category filter; an item
  created with a category set re-fetches with the correct `categoryId`.

- **Rpricebook-4**: PATCH `/api/admin/pricebook/[id]` enforces
  `memberPriceCents <= priceCents` against the resulting row (existing +
  patched), not only when both appear in the same body. **Acceptance:** a
  test asserts PATCHing only `memberPriceCents` above the item's existing
  `priceCents` is rejected 400 `VALIDATION_ERROR`.

P2 gaps (index tuning, distinct-query caching, test filename) are backlog per
the severity gate.

## 6. Non-goals

- No bulk CSV import/export, no spreadsheet-style bulk price edit — no
  demonstrated need beyond existing FieldPulse sync (see Brainstorm).
- No `pg_trgm`/GIN index or compound `(org, active, name)` index this pass —
  unmeasured at 17.5k rows; P2 backlog, revisit at 10x growth or a measured
  slow query.
- No role-based cost/margin visibility restriction — no evidence non-admin
  sessions reach this page. No "missing default tax rate" banner —
  `getDefaultTaxBps` already degrades gracefully to 0%.
- Rpricebook-2 does not prescribe redesigning the estimate item-picker's
  interaction model — that's `page-estimates` scope if pursued; here it's
  only "stop dumping the full catalog." No fix to the
  `pricebook-list-helpers.test.ts` filename mismatch — cosmetic only.

## 7. Invariants

- Items are soft-deleted only; never hard-delete (line items/job materials/
  PO lines/inventory reference by id). Source: page skill `:27-28`;
  `deactivatePricebookItem` (`pricebook-queries.ts:261-272`).
- `fieldpulseItemId` marks FP-synced items; local edits never push back to
  FieldPulse. `memberPriceCents` uses `null` (not `0`) for "no member rate" —
  distinct throughout read/write/display. Source: page skill `:29-33`;
  `pricebook-table.tsx:139-143`; `route.ts:31`.
- Page resets to 1 on filter/search change; pager page not persisted to URL;
  `/` focuses search unless already in a text field. Source: page skill
  `:33-35`; `page.tsx:79-109`.
- Compose `PageShell`/`PageHeader`/`Pager`; status colors only via
  `src/lib/admin/status-colors.ts`. Source: `admin-pages/SKILL.md:42-46`.
- Estimate line items SNAPSHOT catalog price/name/cost at quote time — a
  later pricebook edit must never retroactively mutate a sent estimate.
  Server never trusts a client-sent price for a catalog line — always
  re-resolved from the tenant-scoped row. Source: `schema.ts:2727-2728`;
  `estimates/route.ts:126-158`.
- Money stays integer cents; tax stays integer basis points; no float math
  anywhere in this path. Source: `pricebook-queries.ts:1-3`.
- Tenancy: every query scoped by `organizationId` via `withTenant`. neon-http:
  never `db.transaction()`; use ordered `db.batch()` for the tax-rate
  single-default invariant (unset before set). Source: `AGENTS.md:39-42`;
  `pricebook-queries.ts:356-362`.
- 17.5k items means the server must always paginate — any fix (including
  Rpricebook-2) must not bypass `page`/`limit` on the admin list route.
  `types` from the server drives the type filter; never hardcode values
  client-side. Source: page skill `:40-45`.
- This page makes no AI calls and touches no FROZEN safety text/guardrail
  regexes — keep it that way. Source: `AGENTS.md:36-37`.

## 8. Verification

1. `npx tsc --noEmit` → 0. `npx eslint <changed files>` → 0.
2. `npx vitest run` → must not drop below the captured baseline (297 files ·
   4022 passed · 1 skipped, `docs/page-program/README.md`); in particular
   `npx vitest run src/lib/admin/pricebook-list-helpers.test.ts
   src/lib/admin/pricebook-queries.test.ts` green, including new
   Rpricebook-1/4 cases.
3. Visual: `npm run dev` (background) → mint session
   (`npx tsx scripts/agent/mint-admin-session.mjs`) →
   `node scripts/agent/screenshot-page.mjs /admin/pricebook 1440` and `... 390`
   — confirm category filter (Rpricebook-3) and stock/vendor display
   (Rpricebook-1) render, including an expanded FP-synced row.
4. Network check for Rpricebook-2: open "New estimate" from
   `/admin/estimates`, inspect the pricebook request (devtools or
   `mcp__claude-in-chrome__read_network_requests`), confirm no `limit=20000`.
5. `node scripts/agent/verify-skills.mjs` → 0 missing (update
   `.claude/skills/page-pricebook/SKILL.md` in the same commit if
   Rpricebook-1/3 change files/flows, then re-run).
6. Money regression: PATCH an item's `memberPriceCents` above its existing
   `priceCents` via `curl`/`fetch` against `/api/admin/pricebook/[id]` (dev
   session cookie) — confirm 400 `VALIDATION_ERROR` (Rpricebook-4).
