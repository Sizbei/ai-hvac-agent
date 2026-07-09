# FieldPulse Items (~17.5k) + walk-completeness hardening

**User report:** "we have exactly 10k articles and we might be limited… fix all the
database items to make sure we captured all the data."

## Findings (live-probed 2026-07-10)
- The "articles" are the FieldPulse **pricebook catalog** at `GET /items` —
  **~17,536 rows** (877 pages × 20; ends naturally, distinct data end-to-end;
  the API does NOT cap at 10k).
- Never imported: `/items` wasn't in the original endpoint sweep's OK-list
  (it was never probed — the sweep tried /products,/pricebook,… all 403).
- **Latent truncation bug (ours):** most client list methods default
  `maxPages=200` → 4,000-row ceiling at 20/page. Invoices (2,849) and payments
  (2,364) are already near it, `/invoices`+`/payments` report NO total_count, and
  the walk treats a cap-stop as a natural end → **future growth would truncate
  silently**. Locations already hit this once (fixed to 1000 pages ad hoc).

## Plan
### Phase 1 — completeness hardening (the "make sure we captured everything" ask)
- Raise every backfill list method's `maxPages` to 1000 (items: 2000).
- Structural guard in `fetchAllPages`: return `cappedByMaxPages: boolean`
  (walk ended at page==maxPages with a full page); every importer treats it as a
  loud WARNING + `counts` note — truncation becomes visible even where
  total_count is null. Unit tests for the flag.
### Phase 2 — items import
- Migration: `fieldpulse_item_id` text on `pricebook_items` + per-org partial
  unique index (established pattern).
- Client `listItems(maxPages=2000)` + `toItem` (dollar-strings→cents via
  dollarsToCents; `type` → `pricebookItemTypeEnum` best-effort with tally;
  `is_active`; name/description/sku). Sanitized fixture + real-shape tests.
- Importer `import/items.ts` on the established skeleton (pre-select Set for
  exact created/updated, per-record containment, cap warning) + phase registry +
  dry-run + nightly sweep list.
- Read-only semantics: FP-synced pricebook rows get the provenance treatment
  (pill in any pricebook UI list; native edit allowed but attributed — catalog
  isn't money-ledger data).
### Phase 3 — live run + verify + docs
- `fp:import --phase items` (877 pages ≈ 10-15 min) targeting PROD
  (ep-withered-hill — NOT .env.local if it still points at patient-surf; run
  with the prod URL explicitly).
- Verify count ≈ 17,536; status page shows the phase; FIELDPULSE-DATA.md +
  entity table updated.

## Review gate
Implementation reviewed before merge (independence: mapper honesty on type
enum, cap-flag correctness, tenancy); squash-merge; deploy.
