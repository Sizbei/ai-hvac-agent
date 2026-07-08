# FP Phase 3 — Customers inbound pull

## Mapper rules (`mapFpCustomer`)

- **Name priority**: `display_name` (present on ALL Phase-0.5-verified rows) → `first_name + last_name` → `company_name`. Returns `unnamed` skip if none yield a non-empty string.
- **Skip classification**: `deleted_at` non-null → `deleted`; `merged_customer_id` non-null → `merged`; no name → `unnamed`.
- **Phone priority**: `phone_e164` (already normalized E.164) → `phone` raw field. Passed through `normalizePhone` (digits-only) from crm-queries.
- **Email**: lowercase-trimmed via `normalizeEmail` from crm-queries; null when absent.
- **Address**: composed from `address.street`, `address.streetLine2`, then `city, state zip` segment; empty parts skipped; null if nothing remains. The `toCustomer` mapper in client.ts already flattens `address_1`/`address_2`/`city`/`state`/`zip_code` into `FieldpulseCustomer.address`, so `mapFpCustomer` reads from the normalized shape.

## Type extensions

`FieldpulseCustomer` in `types.ts` extended additively with `phoneE164`, `displayName`, `deletedAt`, `mergedCustomerId` (all optional/nullable — no breaking change to existing consumers). `toCustomer` in `client.ts` now maps these fields from raw payload keys `phone_e164`, `display_name`, `deleted_at`, `merged_customer_id`.

## Importer path decisions

### Path (a) — fpId match
`SELECT WHERE org + fieldpulseCustomerId` → row exists → `UPDATE` all contact fields (re-encrypted with fresh IV, hashes recomputed). `counts.updated++`.

### Path (b) — email or phone present
`upsertCustomerByContact(orgId, {...})` → returns native id (HMAC-dedupe; un-archives on match — existing decided behavior). Then `UPDATE ... WHERE id = returned AND (fieldpulseCustomerId IS NULL OR = fpId)` as a guard: if the row already owns a *different* fpId, the UPDATE returns 0 rows → `counts.skipped++` + warn log. Otherwise `counts.created++`.

**Created/updated counting honesty**: `upsertCustomerByContact` returns only the id — it cannot tell us whether it created or matched an existing row. For the backfill (most records will be new) everything from path (b) counts as `created`. A pre-existing native row matched by contact hash is also counted as `created`, slightly over-reporting. This is documented in the module header and in this report rather than fabricating a false split.

### Path (c) — contactless (no email, no phone)
`INSERT ... ON CONFLICT (organizationId, fieldpulseCustomerId) DO NOTHING`. A returned row → `counts.created++`; no rows (re-run) → `counts.skipped++`.

### Encryption reuse
Used `encrypt` from `@/lib/crypto` and `computeContactHashes` / `normalizeEmail` / `normalizePhone` / `upsertCustomerByContact` from `@/lib/admin/crm-queries` — the same helpers the rest of the CRM write path uses. No reimplementation.

### Error containment
Per-record try/catch: `counts.errors++`, `logger.error` with `fpId`, continue. Systemic failures (e.g. auth at the walk level) propagate — `importCustomersFromFieldpulse` itself throws and the run-import runner catches it and writes `status: failed` to the ledger.

## Fixture sanitization

`fixtures/fp-customers-page1-sanitized.json` — 6 representative shapes:
1. Full-contact (name + email + phone + address) — with `address_2` present
2. Email-only (phone null)
3. Phone-only (email null, no address)
4. Contactless (company-only display_name, no contact, no merged/deleted)
5. Deleted (`deleted_at` set)
6. Merged (`merged_customer_id` set)

All PII is invented (`example.invalid` email domain, `555-010-XXXX` phone, fictitious addresses). The real capture at the scratchpad path was used as shape reference only — no real values entered the repo.

## Wire-up

`run-import.ts` customers stub replaced with a real call to `importCustomersFromFieldpulse(ctx.orgId, counts, ctx.fpClient)`. Guard: throws if `ctx.fpClient` is null (the run-import main path already exits before this if fpClient is null, but the guard is explicit).

## Test evidence

```
Tests  238 passed (238)  [13 test files — full fieldpulse suite]
```

New test file `import/customers.test.ts`: 26 tests covering:
- All mapper skip cases (deleted, merged, unnamed)
- Name fallback chain
- Phone E.164 preference vs raw-phone fallback
- Address composition (empty parts, null address)
- Importer path (a): update on fpId match
- Importer path (b): upsert + stamp success, stamp guard rejection
- Importer path (c): contactless insert, no-op re-run
- Per-record error containment (continues to next record)
- Partial-walk warning (fetched < totalCount)
- No warning when fetched == totalCount or totalCount is null

## Verify results

- `npx vitest run src/lib/integrations/fieldpulse` → 238 passed, 0 failed
- `npx tsc --noEmit` → 0 errors
- `npx eslint [changed files]` → 0 errors, 0 warnings

---

## Review Fixes: I-1 + I-2 (2026-07-09)

### Changes Made

**customers.ts**
- Added import of `sanitizeName`, `sanitizePhone`, `sanitizeEmail`, `sanitizeAddress` from `@/lib/ai/sanitize-fields`.
- `updateCustomerFields` (path a): wrapped all four `encrypt()` calls with the corresponding sanitize helper before encrypting.
- Path (c) contactless insert: wrapped `nameEncrypted` with `sanitizeName` and `addressEncrypted` (when non-null) with `sanitizeAddress`. Phone and email remain `null` (no sanitize call needed).

**customers.test.ts**
- Changed `computeContactHashes` mock from always-null to derivable fake hashes: `emailHash: email ? 'h:' + email : null`, same for phone.
- Added `vi.mock("@/lib/ai/sanitize-fields", ...)` with pass-through identity fns so the new source import resolves cleanly.
- Added hash assertions in path (a) test: `expect(set).toHaveBeenCalledWith(expect.objectContaining({ emailHash: 'h:test@example.invalid', phoneHash: 'h:15550109999' }))`.
- Added hash assertions in path (c) test: `expect(values).toHaveBeenCalledWith(expect.objectContaining({ emailHash: null, phoneHash: null }))`.
- Ripple check: no other tests relied on null hashes — path (b) tests don't assert on set payload, and warning/skip tests have no hash assertions.

### Test Results
- All 238 tests pass across 13 test files (`npx vitest run src/lib/integrations/fieldpulse`).

### TypeScript
- `npx tsc --noEmit`: 0 errors.

### ESLint
- `npx eslint src/lib/integrations/fieldpulse/import/customers.ts src/lib/integrations/fieldpulse/import/customers.test.ts`: 0 errors, 0 warnings.
