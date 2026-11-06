---
name: page-accounting
description: Use when working on the /admin/accounting page — QuickBooks-compatible CSV export of invoices, payments, refunds, and labor cost.
---

# Accounting (/admin/accounting)

**Purpose:** super_admins download a date-ranged CSV journal for import into
QuickBooks (or any ledger). Regular admins see a blank page — the panel
self-hides on 403.

**Files:** page `src/app/admin/(dashboard)/accounting/page.tsx` (server
component, `narrow` PageShell) · export panel
`src/components/admin/accounting/accounting-export-panel.tsx` (client) · export
API `src/app/api/admin/accounting/export/route.ts` · export logic
`src/lib/admin/accounting-export.ts` · tables `invoices` `payments`
(schema `src/lib/db/schema.ts`).

**Data flow:** on mount the panel probes `GET /api/admin/accounting/export`
without params. 403/401 → renders nothing. 400 VALIDATION_ERROR → authorized,
shows the form. On download: sends `?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv`
(plain business days). The server reads the org's time zone
(`getOrgTimeZone`, after-hours settings) and covers whole business days with
`zonedDayRange` (`src/lib/admin/zoned-date.ts`, DST-correct). A full ISO
timestamp is still accepted; only its date part is used. The server streams a
CSV blob; the client triggers a synthetic `<a download>` click.

**Invariants (violate = bug):**
- The export endpoint is super_admin-gated on the server; the client probe
  pattern is UI hygiene only — never rely on the probe result as the real gate.
- Dates are BUSINESS days: the period bounds and every row's Date are in the
  org's time zone (`dateInZone`), never UTC — an 8 pm Eastern payment on Nov 5
  is a Nov 5 row (UTC made it Nov 6, and month-end work landed in the wrong
  month).
- The probe fires without date params — the server returns 400 VALIDATION_ERROR
  (not 403) for authorized callers with missing params. Only 401/403 means
  unauthorized. Do not break this probe/gate handshake.
- Export file name pattern: `accounting-export-${from}_to_${to}.csv` using the
  YYYY-MM-DD strings, not the full ISO.
- Synced invoice rows (FP/HCP-mirrored) are filtered AND dated by
  `coalesce(issuedAt, createdAt)`, never raw `createdAt` — `issuedAt` is the
  real source-system invoice date, `createdAt` is only when we imported the
  row. Matches `/admin/invoices` and `/admin/operations`.
- CSV shape is QuickBooks-importable: header
  `Date,Type,Account,Reference,Memo,Amount,Import`, one row per transaction,
  NO `#` comment rows and NO subtotal rows. Reference = full row id; memo uses
  the app's `#XXXXXXXX` refs (never customer names — ids-only PII stance).
  Refunds are negative; $0 labor rows are dropped. An invoice posts its
  SUBTOTAL to Sales Revenue and its tax on a separate `tax` row to Sales Tax
  Payable (tax is owed, not earned). Rows are sorted by date within each
  section (native first, then mirrored). Refund memos name the invoice
  ("Refund on invoice #X", payment ref only when the payment has no invoice).
  The `Import` column is the
  double-count guard: native "Yes", mirrored "No — already in FieldPulse" /
  "No — already in HCP" (source-accurate; payment mirrors are always
  FieldPulse since HCP has no payment mirror).

**Gotchas:**
- `authorized === null` (loading) and `authorized === false` (unauthorized) both
  render null — don't add a loading spinner; the blank state is intentional for
  non-super_admins.
- The page uses `<PageShell narrow>` — the `narrow` prop keeps the form
  readable at a single-column width; don't widen it.
- Error messages come from `json.error?.message`; non-JSON error bodies fall
  back to "Could not generate the export." — preserve this fallback.

**Verify changes:** `npx vitest run src/lib/admin/accounting-export.test.ts src/lib/admin/zoned-date.test.ts src/app/api/admin/accounting/export/route.test.ts`
· visual via admin-pages recipe (log in as super_admin to see the panel).
