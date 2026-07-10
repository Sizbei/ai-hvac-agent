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
| `invoices` | `due_date` timestamptz NULL | `due_date` via parseFpDate |
| `estimates` | `due_date` timestamptz NULL, `title` text NULL | `due_date`; `title` |
| `customers` | `account_type` text NULL, `is_tax_exempt` bool NULL, `billing_address_encrypted` text NULL | `account_type`; `is_tax_exempt`; compose billing_address_1/2/city/state/zip ONLY when `has_different_billing_address`, sanitize+encrypt exactly like the service address |
| `service_requests` | none | tags/billing/multiday → spillover |

Native rows keep NULLs everywhere; nothing native changes shape.

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

**Display:** a collapsible "FieldPulse details" key/value block on each detail
surface (invoice detail, estimate detail, request detail sheet, customer
profile, pricebook edit dialog) rendering `fieldpulse_data` entries with
humanized labels. Absent/empty → section hidden.

## 3. Overdue semantics

New pure helper (in `invoice-collectible.ts`):
`isPastDue(inv, now) = inv.dueDate ? now > dueDate : daysBetween(createdAt, now) > 30`.
- `isCollectible` (state gate) unchanged.
- Consumers: invoices page Overdue filter + SummaryBand, the list age-chip
  (shows **days past due** with a "due in Xd" state when a real dueDate exists;
  age-based display unchanged when null), operations AR aging (bucket by
  days-past-due where dueDate exists — mixed cohorts allowed since native rows
  fall back), invoice document (prints the real due date; drops the fabricated
  createdAt+30 for FP rows).
- **Dunning sweep: UNCHANGED** — it only processes native invoices (synced are
  never dunned) and native rows have no FP dueDate, so the fallback preserves
  today's behavior exactly.
- Expected visible shift: open synced invoices re-bucket from "age > 30d" to
  real past-due — Overdue counts and synced-AR summary will move. Intentional.

## 4. Import & sync changes

- Mappers widen per §1 + call `buildFpSpillover`; importers write columns +
  `fieldpulse_data` on create AND update (current-FP-state-wins, same as all
  fields).
- Nightly sweep keeps everything fresh; no ordering changes.
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
