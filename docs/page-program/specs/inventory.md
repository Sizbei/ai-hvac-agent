# inventory — target-state spec

`/admin/inventory` — stock tracking for pricebook materials + purchase orders.

## 1. Purpose

Let an HVAC office admin see which pricebook materials are low on stock and
issue/receive purchase orders to replenish them, so field techs never show up
without the part a job needs. One job: keep an accurate on-hand count per
material, driven by real consumption (jobs) and real replenishment (POs), not
a manually-typed number nobody trusts.

## 2. Brainstorm

Considered, and what shipped or got cut:

- **Link inventory rows to pricebook items instead of a separate material
  catalog** — shipped. Rejected alternative: a standalone materials table.
  Reason: a second catalog would drift from the pricebook (name/SKU edited in
  one place, stale in the other); one canonical catalog is simpler and the
  actual requirement. verified (`.claude/skills/page-inventory/SKILL.md:9-10`,
  `src/lib/admin/inventory-queries.ts:1-12`).
- **Auto-decrement stock when a tech logs a job material, auto-increment on PO
  receive** — shipped (see Current state). Rejected alternative: purely
  manual counts, admin re-types the number after every job. Reason: manual
  counts rot within days on any real shop floor; automatic decrement is the
  entire point of tracking inventory at all. verified
  (`src/lib/tech/field-queries.ts:264-276`,
  `src/lib/admin/inventory-queries.ts:339-357`).
- **Atomic CAS-guarded stock writes (SQL `GREATEST(0, qty + delta)`, status
  `!= 'received'` claim)** — shipped. Rejected alternative: read-then-write in
  JS. Reason: two techs closing out jobs with the same material concurrently,
  or a double-clicked "Receive", would otherwise double-count or go negative.
  verified (`inventory-queries.ts:198-217`, `:289-322`).
- **Mock-first vendor seam (`getVendorProvider`)** — shipped. Rejected
  alternative: build a real vendor integration now. Reason: no vendor API
  credential exists yet (`VENDOR_PURCHASING_API_KEY` unset); a PO is a valid,
  useful internal record even before a wire exists — same pattern already
  proven for payments. verified (`src/lib/inventory/vendor-provider.ts:53-70`).
- **Restock on job-material removal** — NOT shipped; this is the spec's one
  real finding (Ginventory-1). Considered scope: should removing a
  wrongly-added material line put the decremented quantity back? Decision:
  yes, this is a correctness gap, not a nice-to-have — see Gaps/Requirements.
- **Cancel action for a draft/ordered PO** — rejected for this run. The
  `purchase_order_status` enum already has `cancelled`
  (`src/lib/db/schema.ts:2531-2536`) and the PO panel even renders a
  `destructive` badge variant for it (`purchase-orders-panel.tsx:42`), but no
  code path ever sets it — dead enum value, not a live gap. Recorded as P2
  (Ginventory-2); a stuck draft PO is inert (no stock/money effect) so it's
  clutter, not a workflow blocker.
- **PO list pager** — rejected for this run. `listPurchaseOrders` always
  fetches page 1 / 50 rows with no pager UI (`use-inventory.ts:75-78`,
  `purchase-orders-panel.tsx` has no `Pager`). Recorded as P2
  (Ginventory-3): real risk only past 50 lifetime POs, which is a lot of
  restock cycles for a single HVAC shop; not urgent.
- **Untrack (delete) an inventory row** — rejected as a requirement. No
  `DELETE` exists on `/api/admin/inventory` (verified — route only exports
  `GET`/`POST`). An admin can zero out quantity and drop the reorder point,
  functionally retiring a row without deleting it. Not worth building
  without a user asking for it. YAGNI.
- **Unit-of-measure (each / box / case) / barcode scanning** — rejected. No
  evidence of demand for either; search-by-SKU
  (`inventory-queries.ts:70-79`) already covers "find this part fast." YAGNI.

## 3. Current state

**Pages / components** (verified — read in full):
- `src/app/admin/(dashboard)/inventory/page.tsx` — owns filter state (search
  debounced 300ms `:61-64`, sort, `belowReorderOnly`, page), URL-syncs filters
  via `useUrlFilterSync` (`:47-58`), resets to page 1 on any filter change
  (`:66-70`), renders `InventoryTable`, `Pager` (only when `inventoryTotal >
  0`, `:170`), `PurchaseOrdersPanel`, `InventoryFormDialog`.
- `src/components/admin/inventory/inventory-table.tsx` — renders stock rows,
  flags `belowReorder` with a warning-tinted row + "Low" badge (`:59-69`),
  skeleton/empty states.
- `src/components/admin/inventory/inventory-form-dialog.tsx` — add/edit a
  tracked material; add mode requires picking a pricebook material
  (`:97-100`), submits to `POST /api/admin/inventory` (upsert).
- `src/components/admin/inventory/purchase-orders-panel.tsx` — PO table +
  "Mark ordered"/"Receive" actions; on a failed receive, surfaces
  `"Couldn't receive that PO — inventory was NOT updated. Try again."`
  (`:72-75`) instead of silently no-op'ing, since a swallowed failure there
  would make an admin believe stock updated when it didn't.
- `src/components/admin/inventory/purchase-order-form-dialog.tsx` — build a
  draft PO (vendor + line items), defaults a line's unit cost to the tracked
  item's latest cost (`:70-80`).
- `src/hooks/use-inventory.ts` — fetches inventory + PO lists via one
  `Promise.all` (two separate GETs, not `db.batch` — batching is a
  server-side/DB concern; verified against skill's "single round-trip"
  wording, which actually describes the *server* query, not this hook),
  60s SWR cache (`:39-40`), stale-response guard via sequence numbers
  (`:97-99, 119, 143, 160`).

**Server** (verified):
- `GET /api/admin/inventory` (`route.ts:23-62`) — session-gated, rate-limited
  (`slidingWindow`, adminRead), paginated (`limit` clamped 1-1000,
  `:44-45`), delegates to `listInventory`.
- `listInventory` (`inventory-queries.ts:54-144`) — org-scoped via
  `withTenant` on every query (`:92`), search escapes SQL LIKE
  metacharacters (`:73`), `belowReorder` filter mirrors the row-level
  computation exactly (`reorderPoint IS NOT NULL AND qty <= reorderPoint`,
  `:81-89`), inner-joins `pricebookItems` 1:1 so plain LIMIT/OFFSET is
  correct (no fan-out, `:51-52` doc comment), count query joins the same
  predicate so total matches the filtered rows (`:96-100`).
- `POST /api/admin/inventory` (`route.ts:64-117`) — validates
  `pricebookItemId` is a real, org-owned pricebook item before allowing the
  link (`:87-93`, the tenant guard prevents cross-org catalog references),
  upserts on `(organizationId, pricebookItemId)` unique index
  (`upsertInventoryItem`, `:158-191`), audit-logged (best-effort, failure
  doesn't fail the request, `:105-110`).
- `adjustStock` (`inventory-queries.ts:198-217`) — single atomic `UPDATE …
  SET quantity_on_hand = GREATEST(0, quantity_on_hand + $delta)`, tenant +
  pricebookItemId scoped, no-op for untracked items (no row matches). This is
  the **consumption write path**: called from
  `addJobMaterial` (`src/lib/tech/field-queries.ts:264-276`) with a negative
  delta whenever a technician logs a catalog material on a job at
  `/tech/jobs/[id]`. The call is deliberately best-effort — a failed
  `adjustStock` does NOT fail the job-material write, since "inventory is a
  soft side effect of usage" (`field-queries.ts:264-268` comment). **This
  page is NOT an island**: real quantities move through it from real field
  work, not just admin CRUD.
- `receivePurchaseOrder` (`inventory-queries.ts:289-381`) — the
  **replenishment write path**. Two-phase: (1) atomically CLAIM the
  not-received→received transition with a single `UPDATE … WHERE status !=
  'received'` (`:311-321`) so a double-clicked "Receive" can only win once
  — the code comment explicitly documents this replaced a prior
  read-then-write race that double-incremented stock; (2) increment
  `quantityOnHand` per cataloged line in one `db.batch` (`:340-357`,
  atomic SQL expression `qty + $line.quantity`, not JS read-modify-write).
  If step 2 throws, the PO status is reverted so it isn't stranded
  "received" without the stock actually landing (`:366-378`).
- `createPurchaseOrder` / `markPurchaseOrderOrdered` /
  `listPurchaseOrders` / `getPurchaseOrder` — standard tenant-scoped CRUD,
  `db.batch` for the multi-row PO+lines insert since ids are pre-generated
  (`:239-274`, no `.returning()` needed, per the neon-http invariant).
- `PATCH /api/admin/inventory/purchase-orders/[id]`
  (`purchase-orders/[id]/route.ts:54-161`) — `action: 'order'` submits
  through `getVendorProvider().submitOrder()` (mock, `vendor-provider.ts:40-51`)
  then flips status; `action: 'receive'` calls `receivePurchaseOrder`. UUID
  validated before any query (`isUuid(id)`, `:74-76`).
- **Downstream consumer of `jobMaterials`**: invoice actual-cost rollup
  (`src/lib/admin/invoice-queries.ts:1366-1391`) reads the same
  `jobMaterials` rows (not inventory rows directly) to compute
  `actualMaterialsCostCents` for the invoice profitability view — confirming
  job materials are load-bearing data, not a dead sink.

**Gotchas already documented** (`.claude/skills/page-inventory/SKILL.md:39-42`,
verified): `usePricebook({ limit: 20000 })` is intentionally uncapped for the
material picker and must stay that way; `materials` filter must stay a
`useMemo` in the page, not move into the hook.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Ginventory-1: Removing a job material never restocks the decremented quantity | P1 | `addJobMaterial` decrements stock by `-input.quantity` when a catalog item is logged (`src/lib/tech/field-queries.ts:270-275`). `removeJobMaterial` (`field-queries.ts:290-320`) deletes the `jobMaterials` row but never calls `adjustStock` with a positive delta to restore the quantity. Net effect: a tech who adds the wrong material (or the wrong quantity) and then removes/corrects the line leaves on-hand stock permanently low by that amount — the "Low" badge and reorder alerts on `/admin/inventory` become wrong in the pessimistic direction and never self-correct without a manual admin edit. This is a real workflow hole because job-material correction (tech taps the wrong part, fixes it) is an ordinary field occurrence, not an edge case. |
| Ginventory-2: `purchase_order_status` enum has `cancelled`, but no code path ever sets it | P2 | `src/lib/db/schema.ts:2531-2536` defines `["draft","ordered","received","cancelled"]`; `purchase-orders-panel.tsx:42` even maps `cancelled` to a `destructive` badge variant. Grep across `inventory-queries.ts` and `api/admin/inventory/**` for `cancel` returns nothing — no `cancelPurchaseOrder` function, no PATCH action, no UI button. A draft PO created by mistake can never be marked cancelled; it just sits in the list forever. No stock/money correctness impact (draft/ordered POs don't touch stock until received), so this is polish, not a hole that blocks a real task. |
| Ginventory-3: Purchase-orders panel has no pager; only the newest 50 POs are ever visible | P2 | `use-inventory.ts:75-78` hardcodes PO fetch to page 1 with no page param exposed; `purchase-orders-panel.tsx` renders a `Table` with no `Pager` component. `listPurchaseOrders` (`inventory-queries.ts:433-467`) already supports `page`/`limit` server-side — the capability exists, the UI just doesn't expose it. Once an org accumulates >50 lifetime POs, older ones become permanently inaccessible from this page (though still in the DB, reachable only via `GET /api/admin/inventory/purchase-orders/[id]` if the id is known some other way). Low current risk for a single-location HVAC shop; flagged so it isn't forgotten as the org's PO history grows. |

That's the full list. Tenancy, concurrency on the two real stock-mutating
paths (decrement-on-use, increment-on-receive), and server-side pagination of
the inventory list are all solid and evidenced above; this spec does not
invent additional work to pad it out.

## 5. Requirements

Only Ginventory-1 clears the P0/P1 bar.

- **Rinventory-1**: Removing a job material linked to a tracked catalog item
  (`pricebookItemId` set) must restore the quantity it previously
  decremented, symmetric with add.
  **Acceptance criterion**: tracked item at quantity N; tech logs quantity Q
  (stock → `max(0, N-Q)` via `adjustStock`); tech removes that line — stock
  returns to `N`. Implementation: in `removeJobMaterial`
  (`src/lib/tech/field-queries.ts:290-320`), before deleting the row, use the
  already-selected `pricebookItemId`/`quantity` and — when `pricebookItemId`
  is set — call `adjustStock(organizationId, pricebookItemId, +quantity)`,
  same best-effort/non-blocking pattern as the add path (swallow failure,
  don't fail the delete).
  **Known edge case, accepted as-is**: if the add-time decrement was clamped
  at 0 (on-hand < Q), restoring `+Q` on remove over-restocks past the true
  physical count — the same approximation the decrement side already makes
  (`inventory-queries.ts:193-197`). Fully solving it needs a new
  per-line pre-clamp-delta column, which is out of scope for this fix; call
  it out in the PR rather than silently shipping it.

## 6. Non-goals

- Not adding a `cancelPurchaseOrder` action (Ginventory-2, P2 — backlog per
  METHOD.md's severity gate).
- Not adding a PO-list pager (Ginventory-3, P2 — backlog).
- Not adding delete/untrack for inventory rows (Brainstorm, rejected —
  YAGNI, no delete endpoint exists and nothing asked for one).
- Not building unit-of-measure, barcode scanning, or a real vendor API
  integration (Brainstorm, rejected — no evidence of demand; vendor seam is
  intentionally mock-first until a credential exists).
- Not touching `usePricebook({ limit: 20000 })` — explicitly load-bearing
  per the page skill, leave as-is.
- Not solving the clamp-at-0 restock-precision edge case noted in
  Rinventory-1 — documented tradeoff, not new scope.

## 7. Invariants

- Tenancy: every inventory/PO query is scoped by `organizationId` via
  `withTenant` (`inventory-queries.ts:92, 211-215, 296, 316-320, 351-356,
  444, 499, 515, 532-538`) — Rinventory-1's added `adjustStock` call reuses
  the existing tenant-scoped function, no new query surface.
- Concurrency: stock mutations are atomic SQL expressions
  (`GREATEST(0, qty + delta)`, `qty + delta`), never JS read-then-write.
  `receivePurchaseOrder`'s received-status transition is CAS-guarded
  (`status != 'received'` in the same UPDATE). Rinventory-1 must call the
  existing `adjustStock` helper (already atomic) rather than hand-rolling a
  new read-modify-write — do not introduce a race where one didn't exist.
- Money: PO `totalCents` is always server-computed from line
  `quantity × unitCostCents`, never client-supplied
  (`inventory-queries.ts:234-235` doc comment). Unaffected by this spec.
- Inventory rows must reference a pricebook item via `pricebookItemId` — no
  second material catalog (`.claude/skills/page-inventory/SKILL.md:29-31`).
  Unaffected by this spec.
- A failed "Receive" must surface an explicit error, never a silent no-op
  (`purchase-orders-panel.tsx:71-75` — existing invariant, not touched).
- neon-http: no `db.transaction()` — multi-row writes use `db.batch()`
  (`AGENTS.md`, already followed throughout `inventory-queries.ts`).
- Copy canon: sentence case, human error copy, no `err.message` in UI —
  already followed (`inventory-form-dialog.tsx:137`,
  `purchase-orders-panel.tsx:73-78`).

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/lib/tech/field-queries.ts src/lib/admin/inventory-queries.ts` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- Targeted regression pack (must stay green — proves Rinventory-1 didn't
  break the existing decrement/receive atomicity):
  `npx vitest run src/lib/admin/inventory-queries.test.ts src/lib/tech/field-queries.test.ts`
- New pure-function/unit tests for Rinventory-1 in
  `src/lib/tech/field-queries.test.ts`: (a) removing a job material with a
  `pricebookItemId` calls `adjustStock` with the material's positive
  quantity; (b) removing a manual line (`pricebookItemId === null`) does
  NOT call `adjustStock`; (c) a thrown/rejected `adjustStock` does not
  prevent the `jobMaterials` row from being deleted (mirrors the existing
  best-effort `.catch()` pattern test already covering the add path, if one
  exists — otherwise add both).
- Manual/visual: `npm run dev` (background) → mint an admin session, seed a
  tracked inventory item, drive `/tech/jobs/[id]` (mint a tech session) to
  add then remove a catalog material, then screenshot
  `/admin/inventory` via `node scripts/agent/screenshot-page.mjs
  /admin/inventory` and confirm the quantity returned to its pre-add value.
