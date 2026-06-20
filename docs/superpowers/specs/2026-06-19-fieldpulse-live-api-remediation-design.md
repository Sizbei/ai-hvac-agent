# FieldPulse Live API — Real Contract & Integration Remediation

**Date:** 2026-06-19
**Status:** Discovery complete (probed against a live FieldPulse account) → remediation spec for sign-off
**How this was found:** read-only GET probing of the live FieldPulse API with a real account key. The integration was built against *inferred* shapes; this documents the *actual* contract and the (many) places our code is wrong. **No live key or customer data is stored in this repo** — the key was used only for probing and must be rotated (it was shared in chat).

## TL;DR — the FieldPulse read integration is currently non-functional against the real API

Every read method fails against the real API for at least one reason: wrong response envelope key, wrong id type, wrong money type/scale, or a 404 endpoint. The integration "passed" unit tests because the tests mock the client with our *inferred* shapes. None of it was validated against the live API until now.

## Verified real API contract

- **Base URL:** `https://ywe3crmpll.execute-api.us-east-2.amazonaws.com/stage` (our `FIELDPULSE_BASE_URL` is **correct** — it's a real AWS API Gateway in front of FieldPulse).
- **Auth:** `x-api-key: <key>` header (**correct**).
- **Response envelope (ALL endpoints, list AND single):** `{ "error": boolean, "response": <array|object>, "total_count"?: number }`. The payload is under **`.response`** — never `.customers` / `.jobs` / `.invoices` / `.users`.
- **Working endpoints (HTTP 200):** `/customers`, `/jobs`, `/jobs/{id}`, `/invoices`, `/invoices/{id}`, `/users`, `/estimates`, `/payments`, `/teams`.
- **404 / "Missing Authentication Token" (route does not exist):** `/company`, `/companies`, `/me`, `/account`, `/files`. ⚠️ Our `getAccountInfo` and `listAvailability` both hit `/company*` — so **connect-time key validation and availability both fail**.
- **IDs are NUMBERS** (e.g. customer `17192901`, job `18793655`, invoice `20269705`), not strings.
- **Money is DECIMAL STRINGS in DOLLARS:** invoice `total: "200.00"`, `subtotal: "200.000000"`, `amount_paid: "0.00"`, `amount_unpaid: "200.00"`; line component `unit_price: "200.0000"`, `unit_cost: "80.0000"`. Convert with `Math.round(parseFloat(x) * 100)` → cents.
- **Status is an INTEGER:** invoice `status` ∈ observed {−1, 2, 3} plus a separate large `status_id`. Jobs carry `invoice_status` (ints "", 1, 2, 3) and `status` (ints 1–6). Not the strings `"sent"/"paid"/"void"` our mappers switch on.
- **Dates** are `"YYYY-MM-DD HH:MM:SS"` (space, not ISO-T): `created_at`, `due_date`, `invoiced_date`, `last_payment_date`, `first_payment_date`.
- **`/invoices?job_id=` does NOT filter server-side** — it returned invoices across many job ids (and nulls). Filtering must be client-side, or use a documented filter param (unknown; the query param is ignored).
- **Pagination:** `total_count` present on at least `/customers` (27) and `/jobs` (29); the small test account returned all rows, so the page size/param is unconfirmed. Must be handled before trusting list completeness on larger accounts.

### Real invoice shape (the fields that matter for the mirror)

`id`(num), `job_id`(num), `customer_id`(num), `status`(int), `status_id`(num), `total`("$str"), `subtotal`, `tax`, **`amount_paid`("$str")**, **`amount_unpaid`("$str")**, `due_date`, `invoiced_date`, **`last_payment_date`** (paid timestamp; our code wrongly reads `paid_at`), `created_at`, **`line_items`** (array; each has `line_components[]` with `title`, `description`, `quantity`, `unit_price`, `unit_cost`), and a **`payments`** array. (Full field list captured during probing; ~150 fields per invoice.)

→ Two assumptions in the shipped invoice-mirror spec are now **disproven**: FieldPulse invoices DO expose a paid amount (`amount_paid`) and DO have line items (`line_items[].line_components[]` with unit cost for margin).

## Bugs in the current integration (file:line → impact)

`src/lib/integrations/fieldpulse/client.ts`:
- **`toCustomer` (165), `toJob` (190), `toUser` (217), `toInvoice` (267)** all do `typeof obj.id !== "string"` → **reject every real record** (ids are numbers). *Showstopper — the entire read path returns null/empty.*
- **List extraction** reads `.customers` (384), `.jobs` (457), `.users` (487), `.invoices` (559) → real key is **`.response`** → always `[]`.
- **Single-resource** `getJob`/`getInvoice` pass the raw envelope to the narrower → must read **`.response`** (the object is wrapped too) → currently the narrower sees `{error, response}`, `obj.id` is undefined → null.
- **`getAccountInfo` (522–523)** GETs `/company` → **403** → the connect route's key-validation probe throws → **an org can never connect FieldPulse via the UI.**
- **`listAvailability` (507)** GETs `/company/availability` → **403** → availability sync broken.
- **`toInvoice` money:** `total: num(obj.total)` — `obj.total` is a string → `num()` returns null → `total=0`; and even parsed it's **dollars, not cents** (100× error). Same for any amount.
- **`toInvoice` paid date:** reads `obj.paid_at` → real field is `last_payment_date` → always null.

`src/lib/integrations/fieldpulse/invoice-sync.ts`:
- **`mapFieldpulseStatusToInvoiceState` / `mapInvoiceStatus`** switch on string statuses (`"sent"/"paid"/"void"`) → real `status` is an int → **everything falls through to `draft`/`none`.** Should derive paid state from `amount_unpaid == 0` (authoritative) and only fall back to status codes once their meanings are confirmed.
- **`pullInvoicesForJob`** relies on `client.listJobInvoices(jobId)` → `/invoices?job_id=` doesn't filter → would mirror unrelated invoices. Must filter client-side by `invoice.job_id === jobId`.

`src/lib/admin/invoice-queries.ts` (downstream): once `amount_paid` flows through, `amountPaidCents` can be **accurate** (the shipped mirror's "binary amountPaidCents" caveat is no longer necessary for FieldPulse).

**HCP note:** the Housecall Pro mirror was built on the *same* inferred assumptions (string ids, `.invoices` key, `total` as cents). It's key-blocked so unverified, but it almost certainly has analogous bugs — re-run this discovery against a live HCP key before trusting it. (FieldPulse and HCP are different APIs; do not assume the fixes transfer verbatim.)

## Remediation plan

**P0 — make reads work at all:**
1. Narrowers: accept numeric ids — coerce `id`/`job_id`/`customer_id` to string via `String(...)` when `number|string`, reject only when absent.
2. Unwrap `.response` for every list AND single endpoint (a shared `unwrap(raw)` helper: returns `raw.response ?? raw`).
3. Fix `getAccountInfo` — replace `/company` with a working probe. `/users` returns the authenticated company's users (carries `company_id`); use it (or a confirmed account endpoint) so connect-time validation succeeds.
4. Money: add `dollarsToCents(s)` = `Math.round(parseFloat(s) * 100)`; map `total`/`subtotal`/`tax`/`amount_paid`/`amount_unpaid` through it. Update `FieldpulseInvoice` to carry `amountPaidCents`.

**P1 — correctness of the mirror:**
5. Paid state: derive from `amount_unpaid === 0 && amount_paid > 0` → `paid`; map the numeric `status` codes once confirmed (probe more invoices in known states, or FieldPulse docs). Set `amountPaidCents` from `amount_paid` (accurate, not binary).
6. Paid date: read `last_payment_date` (fallback `first_payment_date`), not `paid_at`.
7. `listJobInvoices`: filter `.response` client-side by `job_id`.

**P2 — completeness:**
8. Mirror `line_items` (flatten `line_components` → name/qty/unit_price/unit_cost) into `invoice_line_items` — now possible and valuable for margin.
9. Pagination: discover + honor the page param; loop until `total_count` is covered.
10. Fix `listAvailability` endpoint (find the real one; `/company/availability` 404s).

**Tooling:** add a **manual, key-gated live smoke harness** (`tsx`, reads `FIELDPULSE_API_KEY` from env, never committed with a key) that hits each endpoint and asserts the narrowers parse ≥1 real record — so the integration is validated against reality, not just mocks. This is the gap that let all of the above ship.

## Verification

After P0+P1: run the live smoke harness (with a freshly-rotated key) and confirm: connect validates; `pullInvoiceFromFieldpulse` against a real invoice id creates a native row with the correct cents `totalCents`/`amountPaidCents` and `state`; `pullInvoicesForJob` mirrors only that job's invoices. Then `tsc`, `test:unit`, `npm run eval` 30/30, `build`. Update the unit-test mocks to use the REAL shapes (numeric ids, `.response`, dollar-strings) so they stop hiding these bugs.

## Security (do this first)
The probing key was shared in chat and used against a live account that returned customer PII. **Rotate it now.** Never commit the key or any probed PII; the live smoke harness must read the key from env only.

## Non-goals
Writes (create/update/cancel) — not re-validated here (probing was read-only); validate separately before trusting the push paths. Confirming the exact integer `status` code meanings (needs invoices in known states or vendor docs) — P1 derives paid-state from amounts instead, which is authoritative.
