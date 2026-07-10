# FieldPulse Field Parity — design spec

**Problem.** Imports capture a narrow slice of each FieldPulse record. Live field
census (2026-07-10) shows FP populates data we drop: items carry
`default_unit_cost` on 40/40 rows (our pricebook margin column renders "—"
everywhere), invoices/estimates carry a REAL `due_date` (collections fabricates
createdAt+30), estimates have real `title`s, customers have `account_type` /
`is_tax_exempt` / billing addresses, jobs have tags/billing/multiday.

**User decisions (locked).** ① Full field parity across all entities.
② Schema shape: curated typed columns for high-value fields + a per-row
`fieldpulse_data` jsonb spillover for the populated long tail. ③ Real `due_date`
drives "overdue" (age-based fallback when null).

## 1. Field promotions (typed columns; one drizzle migration per table batch)

| Table | New columns | Source → mapping |
|---|---|---|
| `pricebook_items` | `is_labor_item` bool, `quantity_available` int NULL, `vendor_type` text NULL — (`cost_cents` and `description` columns ALREADY EXIST natively; they need mapping only, no migration) | `default_unit_cost`→dollarsToCents; `default_description`; `is_labor_item`; `quantity_available`; `vendor_type`. Also map `automatic_markup_percentage`→existing `markup_pct` (round to int). |
| `estimates` | `due_date` timestamptz NULL, `title` text NULL | `due_date`; `title` |
| `customers` | `account_type` text NULL, `is_tax_exempt` bool NULL, `billing_address_encrypted` text NULL | `account_type`; `is_tax_exempt`; compose billing_address_1/2/city/state/zip ONLY when `has_different_billing_address`, sanitize+encrypt exactly like the service address |
| `service_requests` | none | tags/billing/multiday → spillover |

Native rows keep NULLs everywhere; nothing native changes shape.

**Already-shipped (do NOT rebuild):** `invoices.due_date` + `issued_at` exist
(migration 0037, commit db23720) and the importer maps them.

**Client-layer widening (where the raw fields actually die — review I1):** the
promotions require widening `FieldpulseItem` (types.ts) and `mapFieldpulseItem`
(client.ts) to surface `default_unit_cost`→costCents, `default_description`→
description, `is_labor_item`, `quantity_available`, `vendor_type`,
`automatic_markup_percentage`→markupPct — then mapping them in
`import/items.ts` (deleting its stale "not available from FP" hardcode ~line 120).

**customerType vs account_type (review I2):** map FP `account_type` INTO the
existing `customers.customerType` enum (residential|commercial) where it aligns;
add a separate `account_type text` column ONLY if the live data carries values
the enum can't express (verify at implementation; document the decision).

## 2. Spillover — `fieldpulse_data` jsonb on every synced table

Shared helper `buildFpSpillover(raw, entityPolicy)`:
- **Noise denylist (global):** integration ids (`qbo_*`,`qbd_*`,`xero_*`,`mongo_id`,
  `cuid`,`uuid`,`nicejob*`,`pipedrive*`,`mailchimp*`,`stripe_*`,`tsheets*`,
  `service_titan*`,`companycam*`,`hazardco*`,`azuga*`,`zyra*`,`import_id`,
  `sort_key`,`search*`,`sync_version`,`failed_sync`,`franchise*`), FP PDF
  display-config (`invoice_show_*`,`invoice_use_*`,`invoice_contract_*`,
  `*_display_settings`), and fields already promoted to columns.
- **Per-entity policy:**
  - `customers`: **strict ALLOWLIST** — only known-safe non-PII fields
    (`status`, `booking_portal_consent`, `is_phone_notification_subscribed`,
    `is_email_notification_subscribed`, `pipeline_status_updated_at`,
    `account_type` pre-promotion parity). Names/emails/phones/addresses can
    NEVER enter plaintext jsonb — enforced by a test that feeds a full raw
    customer and asserts zero PII keys survive.
  - other entities: denylist mode; ambiguous object-valued fields (e.g. jobs
    `billing`) are inspected at implementation time and either classified safe,
    promoted, or added to the denylist — never passed through unexamined.
- Only POPULATED values stored (null/empty/[]/{} dropped). Values stringified
  conservatively (numbers/bools/strings; objects only if explicitly classified).
- **Default = DENY when uncertain** (review M5): any field that can't be
  classified safe at implementation goes to the denylist, never passed through.
- Items: after the §1 promotions, spillover is expected empty/near-empty — no
  material jsonb growth across the 17.5k rows (review M2).
- Verify `has_different_billing_address` exists in the raw customer payload at
  implementation before gating on it (review M3).
- Exports: audit the accounting-export columns once during P2 — due_date is not
  currently exported; adding it is optional and out of scope (review M4).

**Display:** a collapsible "FieldPulse details" key/value block on each detail
surface (invoice detail, estimate detail, request detail sheet, customer
profile, pricebook edit dialog) rendering `fieldpulse_data` entries with
humanized labels. Absent/empty → section hidden.

## 3. Overdue semantics — MOSTLY SHIPPED (commit db23720); one gap remains

Real-due-date overdue ALREADY LIVE: `overdueByDates`/`daysPastDue` in
`age-chip.tsx` drive the invoices page filter, SummaryBand, the age chip
("Xd overdue"), the invoice document (real due date; fabrication dropped for FP
rows), and `collectionsStats`. **Do NOT add a new `isPastDue` helper — a second
overdue source of truth is the drift trap.**

**The one remaining correctness gap (P2's only §3 item):** operations AR aging
(`operations-metrics-queries.ts:237-239`) still buckets native AR by
`createdAt`. Fix: bucket by `coalesce(issued_at, created_at)` — dueDate is
irrelevant there (native rows have none; synced rows are a separate single-line
aggregate).

**Dunning sweep: UNCHANGED** — synced rows are never dunned; native rows have
no FP dueDate, so the age fallback preserves today's behavior exactly.

## 4. Import & sync changes

- Mappers widen per §1 + call `buildFpSpillover`; importers write columns +
  `fieldpulse_data` on create AND update (current-FP-state-wins, same as all
  fields).
- Nightly sweep keeps everything fresh; no ordering changes.
- **FP-owned fields on mirrored rows (review I3):** for items with
  `fieldpulseItemId` set, cost/markup/description are FP-owned and overwritten
  nightly — native edits to those fields on synced rows are NOT preserved (same
  read-only posture as synced invoices/estimates). The upsert's set-clause is
  gated on the fp-id conflict target, so native items (fp id NULL) are never
  touched. State this in the pricebook UI (provenance pill exists; add a hint
  in the edit dialog for synced rows).
- Re-population: after merge+migrate, one CI sweep run (all phases) repopulates
  ~25k rows.

## 5. Testing

- Mapper tests per promoted field (real-shape fixtures, defensive coercion).
- **PII-exclusion guard** (customers allowlist) — the highest-stakes test.
- Noise-filter tests (qbo/invoice_show_* dropped; populated-only).
- `isPastDue` pure tests (past/future/null dueDate; fallback boundary).
- Aggregate where-clause tests for AR changes.
- All the usual gates per phase: vitest, tsc, eslint, `next build`.

## 6. Rollout (3 reviewed+squashed phases)

- **P1 — capture**: migrations (5 tables) + spillover helper + mappers +
  importers + tests → merge, migrate, CI sweep re-run, verify field population
  counts in prod.
- **P2 — correctness**: `isPastDue` + consumers (filter/summary/chip/AR/document)
  + pricebook display columns (cost, margin now computable, description).
- **P3 — detail polish**: "FieldPulse details" sections on the five detail
  surfaces; customer account-type/tax-exempt badges + billing address display;
  estimate titles in lists/search.

## Out of scope
- Promoting inventory management features (reorder levels, replenishment) —
  quantities display only.
- FP files/photos (no API surface — separate effort if FieldPulse enables it).
- Two-way sync of any new field (import remains read-only for them).
