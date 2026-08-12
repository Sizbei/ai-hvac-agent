# Customer identity — one native row per FieldPulse customer

**Status:** spec, ready to implement. **Decision is settled** (see
`docs/deploy-money-program/MONEY-FINDINGS.md`, "OPEN → 1"): contact dedupe over
the HMAC blind indexes collapses unrelated commercial customers onto one native
`customers` row, because one accounts-payable email/phone covers many
businesses. This document specifies *how* to give every FieldPulse (FP) customer
its own row, not whether to.

Every claim about current behaviour below was read from the code in this repo at
the cited `file:line`.

---

## 0. What changes, in one paragraph

`customers` stops being "one row per contact" and becomes **one row per real
customer**, where "real customer" means: one row per FP customer id, plus one
row per natively-created (chat / voice / admin) contact that FP does not know
about. Per-org uniqueness on `email_hash` / `phone_hash` is kept **only for the
native population** (`fieldpulse_customer_id IS NULL`), which is the population
that actually needs a race-safe find-or-create. FP-linked rows are unique on
`fieldpulse_customer_id` and are allowed to share contact hashes freely. Because
several rows can then answer one email or phone, every identity lookup needs a
**documented, deterministic pick order** instead of today's bare `.limit(1)`.

### Current-state facts this builds on

| Fact | Source |
|---|---|
| 2,280 FP-linked rows + 9 native rows (both hashes set) + 0 anonymized, on dev | measured on the dev branch |
| 6 of those 2,280 are hard-delete placeholders — archived, contactless, fp id 404s upstream, so they are **not** in the 2,631 list. They are also **all 6** of the archived FP-linked rows on dev: the deleted/merged `archivedImported` population is currently **0** | `import/customers.ts:611-637` (`createDeletedPlaceholderCustomer`), measured on dev |
| 2,631 customers upstream in FP → ~357 FP customers own no row (2,631 − (2,280 − 6)) | live FP API |
| 501 FP-synced invoices have `customer_id IS NULL` (94 unpaid). The older 506 / 440 figures are pre-rebuild: the 2026-08-11 full-column rebuild cleared and re-derived `invoices.customer_id` with the strict healer, resetting dev to 501 | dev branch; `MONEY-FINDINGS.md` § "Dev-mirror rebuild" |
| 9 deterministic customers-phase per-record errors, all unique-violations on the hash indexes | `MONEY-FINDINGS.md` § "The 9 customers-phase per-record errors" |
| Invoices carry **no** FP customer id column, and the spillover jsonb does not retain it | `src/lib/db/schema.ts` (invoices), `src/lib/integrations/fieldpulse/import/spillover.ts` |

That last row is the reason relinking is "re-run the invoices phase", not "run a
SQL UPDATE": the fp-invoice → fp-customer mapping exists only in the FP payload
at sync time (`src/lib/integrations/fieldpulse/invoice-sync.ts:437-461`).

---

## 1. Constraint redesign

### 1.1 Today

`src/lib/db/schema.ts:813-818`

```ts
uniqueIndex("customers_org_email_hash_unique")
  .on(table.organizationId, table.emailHash)
  .where(sql`${table.emailHash} IS NOT NULL`),
uniqueIndex("customers_org_phone_hash_unique")
  .on(table.organizationId, table.phoneHash)
  .where(sql`${table.phoneHash} IS NOT NULL`),
```

plus `customers_org_fieldpulse_customer_id_unique` (`:822-824`),
`customers_org_hcp_customer_id_unique` (`:826-828`) and
`customers_portal_token_hash_unique` (`:833-835`).

### 1.2 Target

Replace the two contact indexes with **native-only** partial uniques, and add
partial non-unique indexes so the lookup stays indexed for every row.
`customers_org_fieldpulse_customer_id_unique` and every other index are
**unchanged**.

```ts
// Per-org uniqueness for the NATIVE population only. FP-linked rows are
// identified by fieldpulse_customer_id and may legitimately share a contact:
// one accounts-payable email/phone covers many unrelated businesses.
uniqueIndex("customers_org_email_hash_native_unique")
  .on(table.organizationId, table.emailHash)
  .where(
    sql`${table.emailHash} IS NOT NULL AND ${table.fieldpulseCustomerId} IS NULL`,
  ),
uniqueIndex("customers_org_phone_hash_native_unique")
  .on(table.organizationId, table.phoneHash)
  .where(
    sql`${table.phoneHash} IS NOT NULL AND ${table.fieldpulseCustomerId} IS NULL`,
  ),
// Lookup indexes over the WHOLE population (the uniques above no longer cover
// FP-linked rows, and findCustomerIdByContact must stay an indexed equality).
index("customers_org_email_hash_idx")
  .on(table.organizationId, table.emailHash)
  .where(sql`${table.emailHash} IS NOT NULL`),
index("customers_org_phone_hash_idx")
  .on(table.organizationId, table.phoneHash)
  .where(sql`${table.phoneHash} IS NOT NULL`),
```

New index names (rather than reusing the old ones) so the `ON CONFLICT` target
in code reads unambiguously and the migration diff is legible.

### 1.3 Generate the migrations with drizzle-kit — do not hand-author

There is **no in-repo precedent** for a multi-condition partial index
round-tripping through drizzle-kit: `schema.ts:651-653` is a *single*-condition
partial `uniqueIndex()`, and `schema.ts:665-669`
(`requests_dispatch_exceptions_idx`, three clauses) reached the database through
a **hand-authored** migration (`drizzle/0042_perf_indexes.sql`). So the claim
was checked directly: against this schema, drizzle-kit 0.31.10 generates the
correct multi-condition predicates and a second `generate` reports **"No schema
changes"**. But bound what that probe proved: **it ran against the combined
final schema** (old uniques deleted and four new indexes added in one edit),
producing `DROP INDEX` ×2 plus 4 `CREATE`s. This program does **not** ship that
combined edit — §7-dev generates **two** migrations from **two sequential
`schema.ts` states**, and *that* sequence is what implementation must verify:

1. Edit 1 — **keep** both old uniques in `schema.ts`, **add** the four new
   indexes → `npm run db:generate` → `drizzle/0045_*.sql`, expected to contain
   4 `CREATE`s and **no** `DROP`. Re-run `generate` → **"No schema changes"**.
2. Edit 2 — **delete** the two old uniques → `npm run db:generate` →
   `drizzle/0046_*.sql`, expected to contain exactly 2 `DROP INDEX`. Re-run
   `generate` → **"No schema changes"**.

If either generate emits something other than the shape above, stop and
reconcile before applying — do not hand-edit the generated SQL. Hand-authoring
is only required when drizzle-kit cannot express the change (triggers — see
`drizzle/0044_last_admin_guard.sql`); that is not the case here.

### 1.4 Why race-safety for native intake survives

`upsertCustomerByContact` (`src/lib/admin/crm-queries.ts:741-830`) is race-safe
today because a losing concurrent insert hits the unique index and
`onConflictDoUpdate` returns the surviving row's id
(`crm-queries.ts:804-822`). That mechanism is preserved **exactly** for native
intake, because every row this function inserts has
`fieldpulse_customer_id = NULL` (`crm-queries.ts:752-766` sets no FP column) —
so both racers are inside the new partial index's population and one must lose.

One required code change here is the arbiter predicate (the un-archive gate at
`:785-796` / `:818-819` is the other — §3.5). Postgres infers a partial index
only when the `ON CONFLICT ... WHERE` clause implies the index predicate — the
repo has already been bitten by this twice
(`crm-queries.ts:800-803`, `import/customers.ts:410-412`). Make `targetWhere`
textually identical to the new index predicate:

```ts
const conflictPredicate = onEmail
  ? sql`${customers.emailHash} IS NOT NULL AND ${customers.fieldpulseCustomerId} IS NULL`
  : sql`${customers.phoneHash} IS NOT NULL AND ${customers.fieldpulseCustomerId} IS NULL`;
```

The documented single-arbiter edge case (`crm-queries.ts:729-735`: racing on the
same phone with different emails raises an uncaught unique violation → a
retryable 500) is unchanged, neither better nor worse.

### 1.5 Is it sound that a claimed native row leaves the protected population?

Yes. `upsertCustomerByContact` runs `findCustomerIdByContact` first
(`crm-queries.ts:780-783`), which reads the *whole* population, so a claimed row
is still resolved and never re-created. The exit is monotone: every writer of
`fieldpulse_customer_id` is set-once and `IS NULL`-guarded
(`import/customers.ts:357`, `fieldpulse/customer-sync.ts:239-249`,
`housecall-pro/customer-sync.ts:215-225`), so there is no oscillation.

---

## 2. Import changes (customers phase)

File: `src/lib/integrations/fieldpulse/import/customers.ts`.

### 2.0 The split is opt-in per run — `--split-shared-contacts`

**The customers phase is not a manual command someone types.** It runs
**unattended, nightly, against production**: `.github/workflows/fp-nightly-sync.yml`
(`cron: "30 8 * * *"`) checks out `main` and runs the full sweep with `--yes`
and `--allow-prod` against `secrets.DATABASE_URL`. Any behaviour added here runs
on prod the morning after this branch merges, backfill or no backfill. Parking
the schedule is **not** the answer — prod's mirror would go stale. Gating is.

So the behaviour that **creates duplicate-hash rows** — step 3's email claim and
step 4's unconditional INSERT — lives behind a new `run-import` flag,
`--split-shared-contacts`, parsed alongside `--yes` / `--allow-prod` /
`--dry-run` in `parseArgs` (`run-import.ts:179-221`) and threaded to the phase
through `PhaseContext` (`:72-77`).

- **Without the flag** (the default, and what the nightly sweep always gets):
  the phase runs **today's path byte-for-byte in this file** — shared callees
  still change underneath it per §3.5 (`upsertCustomerByContact` no longer
  un-archives an ambiguous or blocked match, and can write an audit row), so
  nightly *behaviour* shifts exactly as §3.5 intends — including the
  `upsertCustomerByContact` resolution (email *and* phone, `crm-queries.ts:668-681`)
  and the fp-id-guard branch that resolves to the existing row and returns its
  id so the jobs self-heal can still attach dependent records
  (`jobs.ts:389` → `:424-428` skips the whole job on `null`, so the return
  value must stay non-null exactly as today). The only addition: when the
  fp-id guard fires, increment a new `PhaseResult` counter
  `sharedContactSkipped`, so the nightly run *counts* the customers awaiting a
  split without changing a single outcome. Because the default IS the current
  code, it is trivially safe against the old indexes and the new ones, before
  and after either migration. (The 9 update-path errors are **not** removed by
  the flag — they disappear only once `0046` drops the old uniques, §2.2; until
  then the unflagged nightly keeps reporting them, as today.)
- **With the flag:** the full §2.1 order. Only a deliberate backfill passes it.
- **Steady state after the backfill:** the flag is a mis-ordering safety, not a
  permanent skip. Once `0046` is applied and the flagged backfill has completed
  on a given database, add `--split-shared-contacts` to that environment's
  nightly invocation (`fp-nightly-sync.yml` args for prod; the operator's
  manual habit for dev), so *future* shared-contact FP customers keep getting
  their own rows. The `pg_indexes` probe below makes a premature flip fail
  loudly instead of corrupting anything.

**Belt-and-braces.** When the flag is set, the phase first probes `pg_indexes`
for **both** old uniques — `customers_org_email_hash_unique` and
`customers_org_phone_hash_unique` (`db.execute(sql\`...\`)` — precedent
`ai/dispatch/signals.ts:553`, `api/health/route.ts:28`) — and **aborts the
phase with a throw** (caught at `run-import.ts:539-557` → run `failed`,
exit 1 — loud, not a skip) if either is still present: running flagged against
the pre-`0046` schema is exactly the error storm §7 warns about. Extract the
decision as a pure predicate over the probe result so it is testable (§6).
The probe runs at phase level, before the walk — never inside
`importOneFpCustomer`'s per-record try/catch, where a throw would be absorbed
into `counts.errors` and the walk would continue.

### 2.1 New resolution order for `importOneFpCustomer` (`:242-438`) — flagged path

Per FP customer, in order:

1. **By fp id** — `findByFpId` (`:682-697`). Unchanged, including the erasure
   guard at `:264-279` (`anonymizedAt` set → skip, never re-import PII). Then
   `updateCustomerFields` (`:699-729`).
2. **Deleted / merged FP record** (`archivedImport`, `mapFpCustomer:87`) —
   archived, contactless insert keyed on the fp id (`:289-327`), with **one
   repair**: today its `onConflictDoNothing` miss falls into
   `counts.skipped++; return null` (`:323-326`), so `null` means both "no row"
   and "a row already exists for this fp id" — and `jobs.ts:389` reads `null` as
   unresolved and **skips the whole job** (`jobs.ts:424-428` — not merely the
   link). Give this path the same **re-select by fp id** step 4 uses, so `null`
   means only one thing.
3. **Claim a native row — on `email_hash` only.** *New, replaces the
   `upsertCustomerByContact` call at `:331-336`.* A single SELECT for candidate
   rows in this org with
   `email_hash = $h AND fieldpulse_customer_id IS NULL AND anonymized_at IS NULL AND archived_at IS NULL AND do_not_service = false`.

   **The claim pick is NOT `pickCustomerMatch`.** §3.2's rule 2 puts
   do-not-service *first* so a refusal cannot be bypassed; reusing that ordering
   here would preferentially stamp an FP identity onto a blocked row — the
   opposite of what is wanted. So the candidate set excludes
   `do_not_service = true` in the `WHERE` (above) and picks **oldest first
   (`created_at ASC`, `id ASC` as the determinism backstop)**. A do-not-service
   native row is **never** claimed; if it is the only candidate the FP customer
   gets a fresh INSERT (step 4). Extract the candidate predicate as an exported
   constant so it is testable (§6).

   **Why email only, and never phone.** The claim writes a *permanent* fp id
   onto a pre-existing row and carries that row's `portal_token_hash` with it
   (`portal-queries.ts:60-84` mints per `customers.id`, so the holder of the old
   link would start seeing this FP customer's invoices). That is an
   authorization boundary, and it is exactly the rule the healer already
   enforces for the same reason: phone numbers collide between unrelated people
   — an office line, a property manager, a dispatcher's placeholder
   (`import/customers.ts:522-529`). A phone-only candidate is therefore **not**
   claimed; it falls through to step 4's unconditional INSERT, which is the
   honest outcome (two rows, no false merge).

   **Contested candidates are never claimed.** If more than one FP customer in
   the run resolves to the same native candidate id, do not award it to
   whichever arrives first in FP list order — that ordering carries no identity
   meaning. Track claimed/contested candidate ids in a per-run `Map`; on the
   second FP customer to select an already-claimed-this-run candidate, skip the
   claim and INSERT a fresh row for it. (The already-completed claim stands; the
   alternative — unwinding it — would mean nulling an fp id, which §1.5 relies
   on never happening.)

   Then a guarded claim:

   ```sql
   -- SET is the FULL FP mirror — updateCustomerFields' SET plus the fp id
   -- (anything less leaves the claimed row holding stale native contact data
   -- until the next nightly refresh):
   UPDATE customers SET fieldpulse_customer_id = $fpId, ... , updated_at = now()
   WHERE id = $candidate AND organization_id = $org
     AND email_hash = $h  -- the hash the candidate was selected BY: closes the
                          -- SELECT->UPDATE window against a concurrent contact
                          -- edit (a claim is permanent and carries the portal
                          -- token)
     AND fieldpulse_customer_id IS NULL AND anonymized_at IS NULL
     AND archived_at IS NULL AND do_not_service = false
   RETURNING id;
   ```

   **The UPDATE predicate must match the SELECT's, term for term.** The last two
   terms are not decoration: the SELECT filters on both, so without them a row
   archived or blocked by an operator between SELECT and UPDATE would still be
   claimed — a real TOCTOU, since the phase takes ~20 minutes
   (`fp-nightly-sync.yml` header) and an operator is not paused while it runs.

   Zero rows returned → fall through to 4. See §2.3 for what zero rows means.
4. **INSERT unconditionally** — a brand-new row carrying `fieldpulse_customer_id`,
   both hashes, encrypted contact fields and the spillover, with
   `onConflictDoNothing` on `customers_org_fieldpulse_customer_id_unique` (the
   same shape as `:391-415`, including the `where: isNotNull(...)` predicate
   that path (c) already needs). On conflict (a concurrent run created it),
   re-select by fp id and return that.

Path 4 subsumes today's path (c) "contactless": with the contact uniques
relaxed there is no longer any reason to branch on "has email/phone" — the same
INSERT serves both, writing whatever hashes exist. Collapse them.

**Where the flag actually bites.** The flag selects between two whole paths,
not two outcomes inside one path: unflagged runs the **legacy code unchanged**
(including its `upsertCustomerByContact` resolution — email and phone — and its
fp-id-guard branch, now counting `sharedContactSkipped`, §2.0); flagged runs
this §2.1 order. An FP customer whose contact collides with nothing gets its
row created either way — that is ordinary import on both paths.

**The flagged path must not route through `upsertCustomerByContact`.** Two
reasons, both already documented in this file: it un-archives a matched row
(`:286-288`), and it creates a row on a miss, which the claim path must not do
(it needs to know whether a native row existed so it can decide claim vs
insert).

**New signature.** `importOneFpCustomer(orgId, customer, counts?, opts?)`, where
`opts?: { splitSharedContacts?: boolean; claimedThisRun?: Map<string, string> }`
carries the flag and the per-run claimed map. **Optional** because of the second
caller: the jobs-phase self-heal at `jobs.ts:389` passes two arguments and no
map, and must keep working unchanged — it heals one customer at a time, so it
correctly gets the default, non-splitting behaviour. Watch `jobs.test.ts:641`:
`toHaveBeenCalledWith(ORG, fpCust)` is an **exact-arity** assertion, so passing
an extra argument from `jobs.ts` breaks it. Leave that call site at two
arguments (§6).

### 2.2 Updates can now always write hashes

`updateCustomerFields` (`:699-729`) writes `emailHash`/`phoneHash` in the same
`SET` as name/address/spillover. That single statement is what fails today for
the 9 records: the hash collides with a *different* FP customer's row, and the
unique violation rejects the whole refresh, so those 9 rows keep first-import
contact data forever (`MONEY-FINDINGS.md`). Under the new indexes an FP-linked
row is not in the unique population, so the write cannot collide.
`updateCustomerFields` needs **no change**; the 9 errors disappear as a
consequence, and the "split the statement so a colliding hash skips only the
hash columns" contingency in MONEY-FINDINGS is explicitly **not** implemented.

### 2.3 The fp-id-guard branch: alive unflagged, dead flagged

`:342-374` sets the fp id only when the row does not already own a different one
and, on zero rows updated, logs *"fpId guard prevented overwrite — linking
skipped, resolved to existing row"* and returns the merged row's id so the jobs
self-heal can still attach dependents. **On the unflagged (legacy) path this
branch stays exactly as-is** — it is where `sharedContactSkipped` increments
(§2.0), and its non-null return is what keeps nightly jobs attached. On the
**flagged** §2.1 path it cannot fire: the claim is guarded on
`fieldpulse_customer_id IS NULL`, and a failed claim falls through to an INSERT.

**Repurpose, do not merely delete.** The guarded `UPDATE` in step 3 keeps its
`fieldpulse_customer_id IS NULL AND anonymized_at IS NULL` predicate (it is the
claim's concurrency control). Its zero-row branch stops meaning "merged group"
and gets **one** rule, which is the only lost-race rule in this spec:

> **Zero rows from the guarded claim → fall through to step 4's unconditional
> INSERT.** It does not matter *why* the claim missed — a concurrent run took
> the candidate, or the candidate was erased or archived in between. All three
> mean "that row is not available to me", and the correct response is the same:
> insert this FP customer's own row. Step 4's `onConflictDoNothing` on
> (org, fp id) + re-select-by-fp-id already handles the case where the concurrent
> run was importing *this same* FP customer.

There is deliberately **no** `counts.errors++ / return null` path here: an FP
customer must never end a run with no row because of a race. The old
`logger.warn` copy and the `counts.skipped++` on that path go away — under the
new model a skip there would be a lie.

### 2.4 The healer stays as-is

`makeFpCustomerHealer` / `resolveNativeCustomerByEmail` (`:451-602`) are
unchanged — §4.3 covers what they do while the phase runs.

---

## 3. Ambiguous contact lookup — one deterministic pick order

### 3.1 Today

`findCustomerIdByContact` (`crm-queries.ts:643-720`) runs an email-hash
`.limit(1)` (`:652-666`), then a phone-hash `.limit(1)` (`:668-681`), then a
legacy decrypt-and-compare scan over rows where both hashes are NULL
(`:683-716`). The `.limit(1)`s are unambiguous **by constraint** today. After
§1 they are not, and an unordered `LIMIT 1` in Postgres is not stable.

### 3.2 Target

Replace the two queries with **one** query returning all candidates for
`email_hash = $e OR phone_hash = $p` (org-scoped), selecting:

`id`, `matchedOn` (`'email'` / `'phone'`, computed in SQL), `anonymizedAt`,
`archivedAt`, `doNotService`, `createdAt`, and
`lastActivityAt = (SELECT max(created_at) FROM service_requests WHERE customer_id = customers.id)`
— index-supported by `requests_customer_id_idx` (`schema.ts:642`).

**Put rule 1 in the `WHERE`, and the ordering plus a `LIMIT` in the SQL** — not
only in the helper. Concretely: `anonymized_at IS NULL` joins the `WHERE`
clause; the `ORDER BY` mirrors rules 2-7 (do-not-service, email-before-phone,
live-before-archived, activity, created, id); `LIMIT 50`. Post-split fan-out per
contact is not bounded by anything in the schema, so an unbounded candidate
SELECT on a shared AP contact is a latency risk on the intake path. (The "one AP
address covers up to 21 businesses" line at `import/customers.ts:472-476` is a
prose observation about the *merged* state, not a measurement of post-split
fan-out — do not treat it as a bound.)

That arrangement is what makes the `LIMIT` safe, stated carefully: **the `LIMIT`
can drop only rows the helper would have filtered out or ranked below the
winner, because the SQL `ORDER BY` mirrors rules 2-7 and rule 1's filter is in
the `WHERE` clause.** Rule 1 is a *filter*, not an ordering key, so "the ordering
mirrors the helper" alone would not make that sentence true. The helper keeps
rule 1 too — it must not depend on the caller's SQL being right.

Keep the legacy NULL-hash fallback scan (`:683-716`), which only fires when the
indexed path finds nothing, with one change: add
`fieldpulse_customer_id IS NULL` to its `WHERE`. Today 1,119 contactless
FP-linked rows on dev satisfy its `both hashes NULL` predicate, and none of them
carry encrypted contact either (contactless imports write `null` for both —
`import/customers.ts:289-327`, `:382-386`), so the scan is currently unreachable
in practice; excluding them keeps it that way by construction as the FP
population grows. Note also that this scan **bypasses `pickCustomerMatch` by
design** — it is a first-match decrypt loop over pre-migration rows, and
rewriting it is not worth it for a population that is empty here.

Ordering is then decided by a **pure, exported helper** —
`pickCustomerMatch(candidates)` in a new `src/lib/admin/customer-match.ts` — so
it is unit-testable under the repo's no-jsdom rule (§6). It returns
`{ id, ambiguous, doNotService } | null` — `null` for empty input, and otherwise
a winner whose `doNotService` is carried out so callers do not have to re-read
it to make a *local* decision (they still re-read from the id for the refusal
itself — §3.3). `ambiguous` is true when **more than one live** (not anonymized,
not archived) candidate survived. `findCustomerIdByContact` keeps its
`string | null` signature (retained for API stability — it has no production
callers today, tests only); the full match
is exposed through a sibling `findCustomerMatchByContact` returning
`{ id, ambiguous, doNotService } | null`, which the identity surfaces in §3.3
and the un-archive gate in §3.5 call instead.

**`pickCustomerMatch`'s ordering — rule 2 in particular — is for identity and
refusal surfaces only.** Two other places resolve a contact to a row and must
*not* use it, because do-not-service-first has the wrong polarity for what they
do: the import's claim pick (§2.1 step 3) and SMS START (§3.5). Each states its
own rule.

| # | Rule | Why |
|---|---|---|
| 1 | drop `anonymizedAt IS NOT NULL` | an erased row must never be resolved. Erasure already NULLs both hashes (`erasure-queries.ts:182-197`) so this is belt-and-braces, but it costs nothing and it is the invariant that must not depend on another module's behaviour |
| 2 | `doNotService = true` wins | **fail-closed.** See 3.3 |
| 3 | `matchedOn = 'email'` beats `'phone'` | preserves today's email-first order (`:652-681`) and the reasoning already written at `import/customers.ts:521-529`: phone numbers collide between unrelated people (office lines, property managers, dispatcher placeholders); a shared email is far stronger evidence of a shared billing identity |
| 4 | `archivedAt IS NULL` beats archived | archived rows are reachable candidates in two real ways: a native customer archived by an operator (`crm-queries.ts:943-956`) and an FP-linked row archived on import then refreshed with live contact hashes by `updateCustomerFields`, which writes both hashes and never clears `archivedAt` (`import/customers.ts:699-729`). (The archived *tombstone* populations — deleted/merged imports `:289-327` and hard-delete placeholders `:611-637` — write NULL hashes and can never be candidates at all; they are not the justification.) A dormant row must not outrank a live business |
| 5 | `lastActivityAt DESC`, NULLs last | "the business we most recently worked with" is the best available prior for who is on the phone |
| 6 | `createdAt DESC` | newest identity when there is no activity to separate them |
| 7 | `id ASC` | absolute determinism backstop — the answer must not change between two identical calls |

### 3.3 Rule 2 is a safety rule — and what `ambiguous` may and may not soften

`doNotService` is enforced downstream by re-reading the flag **from the picked
row's id**: `submit-session-request.ts:188-202` and the chat route's load gate
(`chat/route.ts:415-428`).
So if two rows share an AP phone and only one is marked do-not-service, picking
the other would silently bypass a ServiceTitan-style refusal that today's
one-row-per-contact constraint made unbypassable. Ranking do-not-service first
makes the flag propagate through the existing by-id reads with **no change to
any consumer**. The cost is that a do-not-service *archived* row outranks a live
active one — a wrong refusal, which a human can undo, in exchange for never
booking a blocked account, which they cannot.

**Ambiguity does not soften this.** When the pick is ambiguous, consumers split:

1. **The do-not-service refusal keeps using the fail-closed winner.** Treating
   an ambiguous cluster as "unknown caller" would let a blocked business book by
   sharing a phone with an unblocked one — the exact bypass rule 2 exists to
   prevent. The refusal reads `doNotService` off the picked id exactly as today
   (`submit-session-request.ts:188-202`, `chat/route.ts:418-428`, `:730`,
   `voice-turn.ts:274-278`) — no change.
2. **Identity consumers treat ambiguous as NO context.** Greeting by name,
   account tier, membership and history facts are suppressed: an ambiguous
   cluster is not a confident identity, and a confident-sounding wrong name is
   worse than no name. `lookupCustomerContext`
   (`ai/customer-context.ts:92-104`) returns the id (so the refusal above and
   the session FK still work) with the personalization fields blanked when
   ambiguous.
3. **An ambiguous block is surfaced to a human — and the resolver writes it.**
   The three consumers that actually refuse (`submit-session-request.ts:188-202`,
   the chat gate `chat/route.ts:415-428`, `voice-turn.ts:274-278`) are pinned
   "no change" above and none of them receives the ambiguity flag — verified. So
   rather than thread a flag through three refusal sites,
   **`findCustomerMatchByContact` writes the row itself** when the pick is
   `ambiguous && winner.doNotService`: a system-actor `audit_log` insert —
   `actorType: "system"` (as the FP webhook already writes at
   `app/api/admin/integrations/fieldpulse/webhook/route.ts:383-397`),
   `action: "ambiguous_do_not_service_refusal"` (snake_case, like
   `customer_erased`), `entity: "customer"`, `entityId` = the picked row id,
   `details` = candidate count + candidate ids only (ids/enums, never PII —
   `AGENTS.md`). Best-effort in a silent `try/catch` — `crm-queries.ts` has no
   logger import (pure-helper suites would all have to mock it), so a
   persistently failing audit insert is invisible; accepted. Note the nightly
   unflagged import resolves ~2,650 contacts through this path, so a blocked
   ambiguous cluster re-emits its audit row nightly — accepted noise. Visible on
   `/admin/audit-log`.

   **Honestly: this fires on lookup, not on refusal** — a lookup that resolves
   ambiguous+blocked and never proceeds to book still logs. Accepted;
   over-logging beats invisibility. And the **dispatch exceptions rail cannot
   carry this**: `getDispatchExceptions`
   (`admin/dispatch-exceptions-queries.ts:26-50`) selects `service_requests`,
   and a refusal returns before any request is inserted
   (`submit-session-request.ts:198-202`).
4. **The pick persists for the session.** Chat writes the resolved id onto the
   session FK (`chat/route.ts:720`, async pass `:1985`), and the next turn's
   load gate reads do-not-service from it (`:418-428`). So one ambiguous pick
   governs the rest of the conversation; it is not re-rolled per turn. This is
   deliberate (it is what makes the early gate possible) and it is why rule 7's
   determinism matters less than it looks and the fail-closed winner matters
   more.

**Accepted cost, and the operator's remedy.** The ZIP challenge that backstops a
wrong pick (§3.4) reads the ZIPs of the *picked row* only
(`ai/account-zips.ts:21-66`), and only ~54% of customer rows on dev carry an
`address_encrypted` at all — so an ambiguous pick landing on an address-less row
issues a challenge the legitimate caller cannot pass, locking them out of
self-service account answers. That is the intended direction of failure (no
disclosure), and the remedy is human: an operator corrects the row's contact
fields or clears the wrong flag from `/admin/customers/[id]` — the directory
shows every matching business (§5), so the right row is findable. Also worth
saying once, honestly: the verify budget is **per session** —
`MAX_VERIFY_ATTEMPTS = 2` (`ai/account-verify.ts:46-47,140-154`) with no cap on
the number of sessions. Pre-existing, unchanged here, and hardening it is out of
scope.

### 3.4 Justification per surface

- **Chat repeat-customer greeting** (`app/api/chat/route.ts:704-720`, and the
  async pass at `:1985`): a wrong pick greets the caller with another business's
  first name — suppressed outright when the pick is ambiguous (§3.3 rule 2).
  When it is *unambiguous but still wrong*, it is embarrassing, not a leak —
  every account intent is gated behind
  the ZIP challenge (`ai/account-verify.ts:24-44`: *"there is no 'none' tier"*),
  and `loadOnFileZips` (`ai/account-zips.ts:21-66`) reads the ZIPs of **the same
  row** whose data would be disclosed. A wrong pick therefore issues a challenge
  the caller cannot answer, and `advanceVerify` defers
  (`account-verify.ts:107-155`). The gate is unchanged by this program and
  remains the safety net; `metadata.verify` handling
  (`parseVerifyState:203-221`, `preserveVerifyKey:181-194`) is untouched.
- **Voice ANI identity** (`voice/resolve-voice-identity.ts:17-28`): phone-only,
  so rules 2/4/5 do the work and ambiguity is commonest here. Same suppression,
  same ZIP-gate backstop, same reasoning.
- **Admin manual lookup**: does **not** use this function. The directory
  (`crm-queries.ts:251-270`) and global search (`admin/search-queries.ts:45-80`)
  decrypt and substring-match, returning *all* matches — the operator picks the
  right business themselves, which is the correct human-in-the-loop behaviour
  and needs no change.

### 3.5 Other consumers of "one row per contact" that must change

- **`setDoNotContactByPhone`** (`communication/consent.ts:231-262`) resolves a
  phone to a single row via `.limit(1)`. It serves **both** SMS STOP and START
  (`app/api/sms/incoming/route.ts:81` and `:86`), and the two directions must
  **not** be symmetric:

  - **STOP fans out to every row matching the phone hash** — fail-closed,
    and **unbounded**: the resolver's default LIMIT is a winner-selection guard
    and must be lifted for the fan-out (`findCustomerMatchCandidates(...,
    { limit: null })`) — a capped STOP would silence 50 businesses and keep
    texting the 51st. Upsert `communication_preferences` for each in
    a single `db.batch()` (neon-http: `db.transaction()` throws — `AGENTS.md`).
    Return true if any row matched. Today a STOP from a shared number would
    silence one business and keep texting the others, which is a compliance
    defect, not a UX one.
  - **START applies to exactly one row**, and never touches siblings.
    Un-suppressing on a shared number must not let one texter revoke third
    parties' opt-outs; that is the same class of harm STOP's fan-out exists to
    prevent, in the direction that cannot be undone by the person who is now
    being texted again.

    **Which row: not `pickCustomerMatch`'s winner.** Rule 2 would hand START the
    *blocked* row and re-open it — the exact inversion of what do-not-service is
    for. START picks the **most recently active live, non-blocked** candidate:
    skip rule 2, drop blocked and archived rows, then rules 5-7
    (`lastActivityAt DESC`, `createdAt DESC`, `id ASC`). No such row → no-op,
    returns false.

  Both directions take candidates from the **same resolver**: `consent.ts` calls
  the exported candidate query behind `findCustomerMatchByContact` instead of
  re-implementing the phone-hash SELECT it has today at `consent.ts:241-245`.
  The *ordering* differs per direction; the *candidate set* must not.

  Two residuals, stated plainly because they follow from the asymmetry rather
  than from a bug. (1) A sibling that texted STOP stays stopped even after
  another party texts START from the same number — deterministic, and
  fail-closed for everyone except the sender. (2) An AP desk re-opting-in on
  behalf of one specific business may re-open the *picked* row rather than the
  intended one; the operator fixes it from the customer page. And STOP's new
  blast radius is real and accepted: `checkSendAllowed` applies `doNotContact`
  to every trigger type including transactional (`consent.ts:180`), so one STOP
  from a shared AP line silences appointment and invoice messaging for every
  business on that number.
- **`updateCustomerContact`** (`crm-queries.ts:1014-1060`) pre-checks for a
  clashing `email_hash` / `phone_hash` on *any* other row in the org and returns
  `contact_conflict`. Post-split that would forbid an operator from recording
  the AP email on a second business — a legitimate state. Narrow both clash
  queries with `isNull(customers.fieldpulseCustomerId)` **and** apply the same
  predicate to the edited row: refuse only when the edit would actually violate
  the new index (i.e. the edited row is itself native). Editing an FP-linked
  row's contact never conflicts.

  **Also wrap the `SET` and map the unique violation to `contact_conflict`.** The
  clash check is a pre-existing check-then-set TOCTOU (`:1020-1033`, `:1043-1056`
  select; the `SET` follows outside any transaction — neon-http has none anyway,
  `AGENTS.md`), so two concurrent edits can both pass and the index decides.
  Today that is a **500**: the route's catch-all returns `INTERNAL_ERROR`
  (`app/api/admin/customers/[id]/route.ts:434-437`). Catch the error, test it
  with the existing `isUniqueViolation` (`src/lib/db/unique-violation.ts:14`,
  used this way at `api/admin/customers/route.ts:123`) and return the same
  `{ ok: false, reason: "contact_conflict" }` the pre-check returns. Closes the
  documented TOCTOU **and** the deploy-window case where new code narrows the
  pre-check while the *old* uniques still bite (§7-prod).
- **`upsertCustomerByContact`'s un-archive** (`crm-queries.ts:785-796` on the
  find path, `:818-819` on the conflict path) clears `archivedAt` on whatever
  row it resolves. Today that is a returning customer rebooking. Post-split it
  interacts badly with pick rules 2 and 4: rule 4 deprioritizes archived rows,
  but rule 2 is stronger, so a **blocked, archived** row still wins the pick —
  and then every refused intake attempt resurrects it into the active customer
  list, giving an attacker (or a confused caller) a one-click way to keep a
  tombstone permanently un-archived. Gate the un-archive: clear `archivedAt`
  only when the pick was **unambiguous AND `doNotService = false`**. Otherwise
  resolve to the row without touching `archivedAt` — the id is still returned,
  so the do-not-service re-read downstream is unaffected.

  **Two sites, two mechanisms — both are needed.** (1) **The find path
  (`:785-796`), gated in JS:** switch it to `findCustomerMatchByContact` (§3.2)
  and issue the `UPDATE ... SET archivedAt = null` only when
  `!ambiguous && !doNotService`. (2) **The conflict path (`:818-819`), gated in
  SQL:** it is reached *only* when the find returned nothing and the INSERT then
  lost a race, so the conflicting row appeared concurrently and is by
  construction the single row on that hash — **unambiguous**. One term left to
  enforce, and no JS in that path to enforce it in, so put it in the `SET`:
  `archivedAt: sql\`CASE WHEN ${customers.doNotService} THEN ${customers.archivedAt} ELSE NULL END\``.
  Drizzle takes a `sql` expression as a `set` value inside `onConflictDoUpdate` —
  precedent at `src/lib/context/thread.ts:87-89`
  (`lastChannel: channel ?? sql\`...\``, `lastEventAt: sql\`now()\``). Verify the
  emitted SQL once during implementation rather than trusting the shape.

---

## 4. Relink / backfill on dev ("import as backfill")

Prerequisites: `.env.local` points at the **dev** Neon branch (`AGENTS.md` hard
invariant); `FIELDPULSE_API_KEY` set; **both migrations applied on dev**
(§7-dev) — the old contact uniques must be gone before the flagged import runs,
or every duplicate-hash FP insert violates them (§7.2). The phase's own
`pg_indexes` probe (§2.0) enforces this and aborts if they are still there, so
the ordering is checked, not merely written down.

Every command below carries `--yes`: `run-import` otherwise blocks on an
interactive `Type "import" and press Enter` prompt (`run-import.ts:469-483`),
which is fine at a terminal and hangs anything else. This matches how the
nightly workflow invokes it.

1. **Migrate dev** — `npm run db:migrate` (both migrations, back to back).
   Verify without assuming psql:
   `SELECT indexname FROM pg_indexes WHERE tablename = 'customers' AND indexname LIKE '%hash%'`
   (a one-line node script against `.env.local`, same pattern as the §2.0
   probe) — the two `*_native_unique` indexes and the two lookup indexes exist,
   the two old `customers_org_{email,phone}_hash_unique` are gone.
2. **Customers phase** —
   `npm run fp:import -- --org <uuid> --phase customers --yes --split-shared-contacts`.
   **The flag is what makes this a backfill rather than a no-op**; without it
   the phase runs its conservative default (§2.0) and the split does not happen.
   Expected: `fetched ≈ 2,631`; created ≈ **357** (2,631 upstream − the 2,274
   already-linked non-placeholder rows), less `unnamed` skips from
   `mapFpCustomer:91-93`; **`errors = 0`** — the 9 deterministic
   unique-violations are gone by construction (§2.2); the 9 previously-blocked
   rows also finally receive their name/address/spillover refresh;
   `sharedContactSkipped = 0` (it counts only the unflagged path).
3. **Jobs phase (recommended, idempotent)** — `--phase jobs --yes`. Its customer
   self-heal (`counts.customersSelfHealed`) and `service_requests.customerId`
   links improve for the same reason invoices do. Optional; skipping it does not
   affect the invoice result.
4. **Invoices phase** — `--phase invoices --yes`. `upsertInvoiceRecord`'s strict fp-id
   lookup (`invoice-sync.ts:438-448`) now resolves the customers created in
   step 2, and the update branch re-links without ever un-linking
   (`invoice-sync.ts:507`, `...(customerId ? { customerId } : {})`).
   Expected: the 501 orphans collapse to the upstream-deleted residual.
5. **Estimates phase — required, not optional** (`--phase estimates --yes`).
   `import/estimates.ts` has **no healer**. It builds a static
   `fieldpulse_customer_id → native id` map **once**, before the loop
   (`estimates.ts:87-92`), and resolves every estimate against that snapshot
   (`:122`), so any estimate whose FP customer had no row at map-build time gets
   `customerId = null` and stays null until the phase is run again. Those
   orphans feed the sales-pipeline workspace, which `LEFT JOIN`s customers
   (`admin/estimate-queries.ts:483-487`, `:523-527`) and therefore shows them
   with no customer at all. Running it **after** the customers phase is the
   whole fix: the conflict branch re-writes the link on re-run and cannot
   un-link, because `customerId: customerId ?? undefined` omits the column from
   the `SET` when unresolved (`estimates.ts:161-174`) — the same never-un-link
   discipline as invoices.

   No incremental estimate sync exists outside `run-import` (the FP webhooks and
   both FP crons handle jobs, availability and invoices only —
   `src/app/api/admin/integrations/fieldpulse/{webhook,invoice-webhook}/`,
   `src/app/api/cron/sync-fieldpulse-{availability,invoices}/`; note there is no
   FieldPulse handler under `src/app/api/webhooks/`, which holds only
   housecall / resend / saas-billing / twilio), so the static-map
   gap has exactly one entry point and ordering closes it. If an estimate
   webhook is ever added, it must not copy this pattern.

### 4.1 Verification

- Orphan count, before and after:
  `SELECT count(*) FILTER (WHERE customer_id IS NULL) AS orphans,
   count(*) FILTER (WHERE customer_id IS NULL AND state <> 'paid') AS unpaid_orphans
   FROM invoices WHERE organization_id = $org AND fieldpulse_invoice_id IS NOT NULL;`
  → from 501 / 94 to the residual below.
- `node scripts/agent/reconcile-fieldpulse-money.mjs --org <uuid>` — read-only,
  refuses to run against a non-dev host (`reconcile-fieldpulse-money.mjs:20,39-44`).
  Must still report **0 mismatches**; this program touches identity, not money,
  so any movement in invoice totals is a bug in the change.
- **There is no email-only mislink cohort left on dev to check.** The 66
  email-only links a withdrawn repair pass once wrote were removed by the
  2026-08-11 rebuild, which cleared the whole `invoices.customer_id` column and
  re-derived it with the strict healer (`MONEY-FINDINGS.md` § "Dev-mirror
  rebuild", "61 links removed"). The reconcile script plus the orphan counts
  above are the ongoing check; no before/after snapshot of that cohort is owed.
- Estimate orphans, before and after:
  `SELECT count(*) FILTER (WHERE customer_id IS NULL) FROM estimates
   WHERE organization_id = $org AND fieldpulse_estimate_id IS NOT NULL;`
  (`fieldpulse_estimate_id` is the FP-sourced discriminator — `estimates.ts:76-84`.)
  Before, on dev: **2 orphaned of 36** FP estimates. → must fall to zero apart
  from estimates of hard-deleted FP customers.
- Customer census, as an **identity, not a headcount** — and as an
  **inequality**:
  `FP-linked rows ≥ upstream customers − unnamed skips + hard-delete placeholders`
  (the 6 placeholders are FP-linked but absent from the upstream list — §0).
  `≥`, not `=`: placeholders are not the only rows in that position. A **full**
  row whose FP customer is hard-deleted upstream *after* import stays FP-linked
  here and vanishes from the list walk — like a placeholder, but not archived,
  so it is not counted by the placeholder term. On dev today all 6 archived
  FP-linked rows are placeholders and `archivedImported` is 0 (§0), so the extra
  term is small — but it only grows, and an equality would start failing for a
  reason that is not a defect. Native rows (fp id NULL) should be 9 minus
  however many were claimed in step 2, again an **upper bound**: live intake
  during the run legitimately adds native rows.

### 4.2 Quantifying the residual honestly — requires new instrumentation

The residual is "invoices whose FP customer is hard-deleted upstream (per-id GET
404s)". **You cannot count these from the database**: `invoices` has no FP
customer id column and the spillover does not retain one, so an unlinked mirrored
invoice carries no evidence of *which* FP customer it belonged to.

So the invoices phase must report it. Add to
`src/lib/integrations/fieldpulse/import/invoices.ts` (around the loop at
`:71-105`), fed by the value `upsertInvoiceRecord` already has in hand: a
per-run `Set<string>` of `invoice.customerId` values that resolved to no native
row, surfaced on `PhaseResult` as `unresolvedFpCustomerIds` (count) alongside
`unlinkedInvoices` (count). **Both are new optional fields on `PhaseResult`**
(`run-import.ts:53-70` has neither today; it carries `archivedImported`,
`multiTechJobs`, `customersSelfHealed`, `enriched`, `skippedHasAddress` — add
these two the same way, and `sharedContactSkipped` from §2.0). Implement the
capture as an **optional**
`onUnlinked?: (fpCustomerId: string) => void` parameter on
`upsertInvoiceRecord`, passed only by the import loop: the return type stays
stable, and the invoice webhook and the daily cron — which call the same
function — are untouched. Keep it rather than cutting it: the residual is
observable only at sync time (the database retains no fp customer id for an
unlinked invoice), and it recurs at **every** future full sync, not just this
backfill, so the alternative to the counter is never knowing.

Expected shape of the answer: a handful of customers, tens of invoices — the
same class as the six hard-deleted customers already documented at
`import/customers.ts:604-610`. **These stay unlinked, deliberately**: you cannot
collect from a deleted customer and a fabricated link would only hide that
(`import/customers.ts:534-538`). Record the two numbers in this directory after
the run; do not fold them into "done".

### 4.3 Partial failure, and what the healer does while the phase is running

The customers phase is not atomic and nothing pauses the rest of the system
while it runs. The invoice webhook
(`app/api/admin/integrations/fieldpulse/invoice-webhook/route.ts`) and the daily
cron (`app/api/cron/sync-fieldpulse-invoices`) both construct
`makeFpCustomerHealer` continuously, and there is **no pause switch** — Vercel
Hobby has no such control, and inventing one for a manual backfill would be more
risk than it removes. So state the contract instead:

- **During the phase (or after one that failed part-way), an invoice whose FP
  customer has no row yet can transiently adopt a hash-matching *native* row.**
  The healer (`makeFpCustomerHealer` / `resolveNativeCustomerByEmail`,
  `import/customers.ts:451-602`) keeps its current shape — the email-only rule,
  the ownership clause `(fieldpulse_customer_id IS NULL OR = this fpId)` at
  `:491`, the `isNull(anonymizedAt)` guard at `:490`. Its ownership clause
  permits rows with a NULL fp id — that is its create-before-claim case and it
  is correct in general; it is only *premature* here, because the row this FP
  customer will own is about to be created a few seconds later.
- **These links self-heal.** The next invoice re-sync resolves the customer
  strictly by fp id and overwrites the FK (`invoice-sync.ts:507`, which writes
  `customerId` whenever it resolved one and never nulls it). The window is
  bounded by the length of the customers phase plus one sync cycle.
- **Therefore: re-running the customers phase to completion is safe and is a
  precondition for trusting §4.1's counts.** A partially-failed run leaves no
  corrupt state, only under-linked state; do not interpret §4.1 numbers from an
  aborted run, and do not "fix" transient adoptions by hand.

### 4.4 State that must be reviewed on prod BEFORE the prod backfill

Per-customer state does **not** follow invoices across the split. When the
import gives an FP customer its own row, that row's invoices move to it, but
everything attached to the old merged row stays where it is:

- `communication_preferences.customer_id` — a recorded STOP stays on the old
  row, so a business that opted out could be messaged again from its new row.
- `customers.portal_token_hash` — the existing portal link keeps resolving to
  the old row (`portal-queries.ts:60-84`), which now holds fewer invoices.
- `customers.do_not_service` — a block recorded against the merged row does not
  follow the businesses that split away from it.

**Dev verification cannot catch any of this**: dev holds 0 preference rows, 0
minted portal tokens and 0 do-not-service flags for the affected population, so
every one of these paths is trivially green there. This is a **production
prerequisite, not a dev step**: before running the prod backfill, list the
prod rows that carry any of the three, decide per row which split sibling should
inherit it, and record the decision. Do not automate the transfer — which
sibling a STOP or a portal token belongs to is a judgement about a real person.

### 4.5 Follow-up gated on the result

If step 4 leaves ~0 orphans beyond the deleted residual, the healer's email
fallback (§2.4) has become almost pure cost — the "re-fetches merged customers
on every run and can never persist a result" note in MONEY-FINDINGS. Decide then
whether to narrow it. Not part of this program.

---

## 5. UI / product consequences

Every surface that reads the hash columns or assumed one-row-per-contact:

| File:line | What it is | Effect |
|---|---|---|
| `src/lib/admin/crm-queries.ts:643-720` | `findCustomerIdByContact` (body ends `:717`, closing brace `:720`) | **Changes** — single candidate query + `pickCustomerMatch`, plus the new `findCustomerMatchByContact` sibling that also writes the ambiguous-block audit row (§3.2, §3.3) |
| `src/lib/admin/crm-queries.ts:741-830` | `upsertCustomerByContact` | **Changes** — `targetWhere` predicate (§1.4) + the un-archive gate at `:785-796`, `:818-819` (§3.5) |
| `src/lib/admin/crm-queries.ts:1014-1060` | `updateCustomerContact` clash check | **Changes** — narrow to the native population (§3.5) |
| `src/lib/communication/consent.ts:231-262` | `setDoNotContactByPhone` (SMS STOP **and** START — `api/sms/incoming/route.ts:81,86`) | **Changes** — STOP fans out to all matching rows, START stays on the picked row only (§3.5) |
| `src/lib/integrations/fieldpulse/import/customers.ts:242-438` | `importOneFpCustomer` | **Changes** — §2 |
| `src/lib/integrations/fieldpulse/import/invoices.ts:71-105` | invoices phase | **Changes** — residual instrumentation (§4.2) |
| `src/lib/integrations/fieldpulse/invoice-sync.ts:437-461` | `upsertInvoiceRecord` customer resolution | **Changes** — gains the optional `onUnlinked?: (fpCustomerId: string) => void` callback parameter (§4.2). Passed only by the import loop; the invoice webhook and the daily cron call it unchanged |
| `src/lib/integrations/fieldpulse/import/run-import.ts:53-70`, `:179-221`, `:72-77` | `PhaseResult`, `parseArgs`, `PhaseContext` | **Changes** — `parseArgs` gains `--split-shared-contacts` (§2.0), threaded via `PhaseContext` (module-private today — extend it in place, no export needed); `PhaseResult` gains three new optional counters, all of which it lacks today: `sharedContactSkipped` (§2.0), `unresolvedFpCustomerIds` and `unlinkedInvoices` (§4.2) |
| `src/lib/integrations/fieldpulse/customer-sync.ts:227-261` | **second, background writer of `fieldpulse_customer_id`** — push-side sync, reached via `after()` from `job-sync.ts:174` | **Changes.** It finds an FP customer by email/phone (`:229-232`) and stamps that fp id onto *our* row under an `IS NULL` guard (`:239-249`). Post-split, FP's find-by-email far more often returns an fp id **another** of our rows already owns, so the UPDATE trips `customers_org_fieldpulse_customer_id_unique` — and the degrade catch at `:255-261` swallows it whole, so the sync retries and fails identically forever, silently. Prescribe: **pre-check whether that fp id is already claimed** (a `SELECT` before the UPDATE) and skip the adoption with an explicit log. The set-once guard is unaffected, so §1.5's monotonicity conclusion survives. HCP twin, same shape, no data: `housecall-pro/customer-sync.ts:205-225` |
| `src/lib/db/schema.ts:813-818` | the two contact uniques | **Changes** — §1.2 |
| `src/lib/admin/crm-queries.ts:69-270` | customers directory list + search | **Behaviour shift, no code change.** Several businesses sharing one AP email/phone now appear as separate rows; the search path decrypts and substring-filters (`:251-270`) so a search for that email returns all of them. Correct and intended. The 5,000-row search scan cap (`:259`) still clears the ~2,640-row corpus |
| `src/lib/admin/search-queries.ts:28,45-80` | global command search | **Pre-existing defect, worsened.** `SCAN_LIMIT_CUSTOMERS = 1500` already truncates a 2,289-row corpus; +357 rows makes more customers unreachable from global search. Out of scope to fix here — record it |
| `src/app/api/admin/customers/route.ts:119-129` | `POST` 409 `CUSTOMER_ALREADY_EXISTS` | **No code change, but the behaviour flips for one case.** `createCustomer` (`crm-queries.ts:471-518`) inserts with a NULL fp id, so **native↔native** duplicates still 409 — and an admin creating a customer whose email or phone matches an **FP-linked** row now **succeeds** instead of 409ing. That is intended: it is how an operator records the second business on a shared AP contact. Two consequences, recorded not fixed: manually force-creating a *second native* row on a shared contact stays blocked (the native unique is what makes race-safe intake work — §1.4 — so relaxing it is a scope-out, §8), and the 409 copy "already exists" now reads misleadingly in that case (backlog, not this program) |
| `src/lib/portal/portal-queries.ts:60-84`, `:127-145` | portal token mint / resolve, per `customers.id` | **No change — this is the payoff.** Each business gets its own token and sees only its own invoices (`invoices.customer_id`) instead of a shared row's pooled AR |
| `src/lib/ai/customer-context.ts:20-52`, `:92-104` | `CustomerContext` shape + `lookupCustomerContext` | **Changes** — resolve via `findCustomerMatchByContact` and blank the personalization fields when `ambiguous`. **The blanking, defined exactly:** keep `customerId`, `doNotService`, `customerType`; set `isReturning = false`, `priorRequestCount = 0`, `membershipStatus = null`, `firstName = null`, `fullName = null`, `hcpCustomerId = null`. `priorServiceNote` is already optional and stays absent. Note `membershipStatus` is currently typed `string` (`:26`), so this widens it to `string \| null` — see the §6 note |
| `src/lib/ai/customer-context.ts:113-158` | `loadCustomerContextById` | **No change** — id already resolved |
| `src/lib/voice/resolve-voice-identity.ts:17-28` | ANI identity | **No change — it inherits `lookupCustomerContext`.** It is a pure delegate: `return await lookupCustomerContext(organizationId, { phone: trimmed })` at `:24`, with no field handling of its own. The ambiguity blanking lands in `customer-context.ts` and voice gets it for free. (Voice is still where ambiguity is likeliest — phone-only — which is why the blanking matters, not why this file changes) |
| `src/app/api/chat/route.ts:704-720`, `:1985` | chat identity resolution + session FK persist | **No code change**, but note the pick is persisted onto the session and governs every later turn's do-not-service gate (`:418-428`) — §3.3 rule 4 |
| `src/lib/integrations/fieldpulse/import/estimates.ts:87-92`, `:122` | estimates phase static customer map | **No code change, runbook change.** No healer here; run `--phase estimates` after the customers phase or estimates stay customer-less in the sales pipeline (§4 step 5) |
| `src/lib/requests/submit-session-request.ts:176-200` | intake submit + do-not-service re-read | **No change** — protected by pick rule 2 (§3.3) |
| `src/lib/ai/account-verify.ts`, `src/lib/ai/account-zips.ts` | ZIP-verify gate, `metadata.verify` | **Untouched, explicitly.** Per-row ZIPs keep the gate sound under an ambiguous pick (§3.4) |
| `src/lib/admin/erasure-queries.ts:182-197` | GDPR erasure | **No change to the erase itself** — still per-row, still NULLs both hashes; §2.1 step 3 refuses to claim `anonymized_at IS NOT NULL`, and `import/customers.ts:264-279` still refuses to re-import over an erasure. **Do not overstate that protection:** it is keyed on the *row*. An erased **native** row carries no fp id and NULL hashes, so nothing links it to FieldPulse — a later import of the same person as a *fresh* FP customer creates a new row with their PII pulled from FieldPulse, and the erasure guard never sees it. Pre-existing (the guard has always been per-row) and unchanged here, but it means erasure is only durable for data this system owns. See the sibling-disclosure requirement below |
| `src/app/api/admin/customers/[id]/erase/route.ts`, `src/app/admin/(dashboard)/customers/[id]/page.tsx` | erase route + confirm UI | **Changes — disclosure, not fan-out.** See §5.1 |
| `src/lib/db/backfill-customer-hashes.ts:73-113` | one-shot legacy hash backfill | **No change.** Its "duplicate → leave the hash NULL, resolve manually" skip exists only to respect the old uniques. It is a historical one-shot; leave it, note that re-running it post-migration would now be over-cautious |
| `.claude/skills/page-customers/SKILL.md:36-40` | page skill "Blind-index dedupe" invariant | **Must be rewritten** — it currently instructs future agents to treat contact dedupe as the rule. Update to the new model; `scripts/agent/verify-skills.mjs` gates the cited paths |

Release-note material, not build material: the directory headline jumps ~2,289 →
~2,64x (the split, not new business), and split siblings show identical contact
sub-labels on the people-cards.

### 5.1 Erasure spans siblings: disclose, never auto-fan-out

After the split, one natural person can own N rows (FP-side duplicates of the
same human), so a per-row erase leaves N−1 copies of their PII. Auto-erasing
every hash-sibling is **not** the fix and must not be built: siblings that share
a contact are usually *different data subjects* — that is the premise of this
entire program — so a fan-out erase would destroy a third party's records on one
person's request, turning a compliance feature into a compliance incident.

So: **erase stays strictly per row**, and the erase route/UI gains a
**disclosure**. Before confirming, it lists the other rows in the org sharing
either hash with the target — id plus decrypted name, resolved **server-side**
(the hashes never reach the client) — so the operator can see "this contact
appears on 4 rows" and deliberately erase each row that is genuinely the same
person. The confirm copy names the count. Erasure remains super_admin-only,
demo-blocked and audited exactly as today (`erase/route.ts:27-58`).

Also record, unchanged: `upsertInvoiceRecord`'s strict fp-id customer lookup
(`invoice-sync.ts:437-448`) has **no `anonymizedAt` guard**, so a re-sync can
attach an invoice to an already-erased row. That is a *link to a tombstone*, not
a PII rewrite — the row still holds `[deleted]` and NULL hashes
(`erasure-queries.ts:182-197`), and the re-import guard at
`import/customers.ts:264-279` is what prevents PII coming back. Pre-existing,
acceptable, not changed here.

HCP's `hcpCustomerId` and `customers_org_hcp_customer_id_unique`
(`schema.ts:826-828`) are structurally identical to the FP case but hold no data
— see §8.

---

## 6. Testing strategy

Repo rule (`AGENTS.md`): **no jsdom/RTL**; pure-helper vitest only. Capture the
live `npx vitest run` baseline *before* touching anything and do not let it drop.

Index behaviour itself is not unit-testable — no test process talks to Postgres.
It is verified by §4 steps 1-2 (migration applies; the customers phase reports
`errors = 0` where it deterministically reported 9). Say so in the PR rather
than faking coverage with a mock that cannot fail.

**But "not unit-testable" stops at the index.** `crm-queries.test.ts` already
mocks `@/lib/db` with a chainable thenable proxy (`:4-39`) and drives async DB
functions directly by queueing their row results — no jsdom, no Postgres. So
everything here that lives *inside* a DB function is testable in that harness
(items 4-6). One nicety: `db.update` returns `chain(updateQueue.shift())` but is
not a `vi.fn`, so asserting *no* UPDATE was issued needs a one-line wrapper
mirroring `insertMock` at `:31-35`.

What **is** extracted and tested, each with at least one test that fails when the
fix is reverted:

1. **`pickCustomerMatch(candidates)`** — new `src/lib/admin/customer-match.ts`.
   One test per rule in the §3.2 table, plus:
   - a do-not-service row loses on every other axis (archived, oldest, phone
     match) and still wins → fails if rule 2 is reverted;
   - an anonymized candidate is never returned even when it is the only match;
   - two candidates identical on every axis return the same id across repeated
     calls (rule 7);
   - empty or all-erased input → `null` (the only `null` returns; every other input yields
     a `{ id, ambiguous, doNotService }` — assert the shape, so the §3.2 return
     type and the tests cannot drift apart);
   - `ambiguous` is true for 2+ live candidates and false for one live candidate
     plus any number of archived/anonymized ones;
   - `doNotService` on the result matches the winning candidate's flag;
   - **an ambiguous result still returns the do-not-service row's id** → fails
     if someone "fixes" ambiguity by returning null (§3.3 rule 1).
2. **`resolveFpCustomerAction(input)`** — a pure decision function extracted from
   `importOneFpCustomer`, mapping **four** fields —
   `{ existingByFpId, archivedImport, candidateNativeRow, candidateClaimedEarlierThisRun }`
   — to
   `{ kind: 'skip-anonymized' | 'update' | 'insert-archived' | 'claim' | 'insert' }`.
   The fourth input is what makes contested→insert expressible at all (§2.1).
   The function models the **flagged path only** — the unflagged default is
   today's code, untouched, and is pinned by the existing customers-phase
   suites plus one new assertion: the fp-id-guard branch increments
   `sharedContactSkipped` (§2.0) while still returning the resolved id (the
   `jobs.ts:424-428` contract — fails if anyone makes the default return null).
   So drop `skip-shared-contact` from the union; it is not a flagged-path
   outcome. Cases: fp-id hit → `update`; fp-id hit + anonymized →
   `skip-anonymized`; deleted/merged → `insert-archived`; native candidate
   matched **on email** → `claim`; **candidate matched on phone only →
   `insert`** (§2.1); **candidate already claimed earlier in this run →
   `insert`** (contested); no candidate → `insert`.
   One case needs relabelling: **"candidate already owned by a different fp id →
   `insert`"** is *unreachable* through the real candidate query, which filters
   `fieldpulse_customer_id IS NULL` in the `WHERE` (§2.1 step 3). Keep the test,
   but extract that predicate as an exported constant, assert the constant
   contains the term, and label the case a **guard against future widening** —
   not "the whole program", which would be testing a branch that cannot fire.
3. **Consent fan-out asymmetry** — extract the "which ids get a preferences
   upsert" step so tests assert: STOP with N matching ids → N upserts; START
   with N matching ids → exactly 1 upsert, on the picked id; single-match STOP
   still returns true. A START that writes N rows fails the suite. Plus the
   **polarity** test (§3.5): given a blocked row and a live unblocked row on one
   phone, START picks the **unblocked** one → fails the moment someone reuses
   `pickCustomerMatch` here.
4. **The un-archive gate** (§3.5), in the `crm-queries.test.ts` harness: one
   archived non-blocked match → UPDATE issued; two live matches (ambiguous) →
   **no** UPDATE; one archived do-not-service match → **no** UPDATE. Reverting
   the gate fails two of the three.
5. **`lookupCustomerContext` ambiguity blanking** (§5), same harness: an
   ambiguous resolution keeps `customerId` / `doNotService` / `customerType` and
   blanks the rest per the definition. Reverting it fails on `firstName`.
6. **The legacy-scan narrowing** (§3.2) — assert the fallback scan's `WHERE`
   gains `fieldpulse_customer_id IS NULL`, in the style the suite already uses
   for query shapes.
7. **The `pg_indexes` abort predicate** (§2.0) — pure, no harness: old unique
   present → abort; absent or empty result → proceed.
8. **The claim-pick rule** (§2.1 step 3) — oldest-first, and a `do_not_service`
   row is absent from the candidate set even as the only email match. Fails if
   someone swaps in `pickCustomerMatch`.

Existing suites to update, not delete:
`src/lib/admin/crm-queries.test.ts` (the two-query → one-query shape; the
`contact_conflict` case at `:278-286` must gain a "no conflict when the other
row is FP-linked" sibling and a "unique violation on the SET maps to
`contact_conflict`, not a throw" sibling — §3.5),
`src/lib/integrations/fieldpulse/import/customers.test.ts` (path (b) assertions
become claim/insert assertions), `src/lib/admin/erasure-queries.test.ts`, and
**`src/lib/integrations/fieldpulse/import/jobs.test.ts:641`** — its
`toHaveBeenCalledWith(ORG, fpCust)` is an exact-arity assertion on
`importOneFpCustomer`, so it breaks the moment the jobs self-heal passes the new
options argument (§2.1) — keeping that call site at two arguments keeps it
green, which is the preferred outcome. **Not**
`src/lib/admin/export-queries.test.ts` — it only asserts the hash columns are
absent from exports, which this program does not touch.

Type note from §5: widening `CustomerContext.membershipStatus` to
`string | null` is a public-type change, and `npx tsc --noEmit` is what finds
every consumer that assumed non-null.

Gates before commit: `npx tsc --noEmit` → 0, `npx eslint <changed>` → 0 errors,
`npx vitest run` ≥ baseline, and **`node scripts/agent/verify-skills.mjs`** —
this program rewrites `.claude/skills/page-customers/SKILL.md` (§5), and that
script is what proves every path the rewritten skill cites still exists
(`AGENTS.md`).

---

## 7. Rollout order and rollback

This program is **dev-only** (§8). §7-dev is what it executes. §7-prod is a
runbook for a later, separate decision that is the user's to make — written now
because the sequencing constraints are discovered now, not because anything here
is authorised to run against production.

### 7.1 §7-dev — what this program actually does

**Two migrations, authored from two sequential `schema.ts` states** (the
generation mechanics and the expected diff shapes are in §1.3):

- `0045` — adds the two native-partial uniques and the two lookup indexes.
  Drops nothing.
- `0046` — drops `customers_org_email_hash_unique` and
  `customers_org_phone_hash_unique`.

Both land in this branch with all of the §1-§3 code, and **on dev they apply
back to back** in one `npm run db:migrate`. No expand/contract choreography is
needed on dev: nothing serves traffic there, so the 42P10 window §7.3 describes
has no victims. Then, separately, run the **flagged** backfill (§4) — never
chained to the migration step, and blocked by the `pg_indexes` probe if `0046`
has not landed (§2.0).

### 7.2 The two facts that drive the ordering

**New predicates are strictly narrower than old ones.** Old code writes only
native rows (fp id NULL, `crm-queries.ts:752-766`), so adding the new indexes
while old code serves can break nothing — order only matters for the **drops**,
after which old `targetWhere` (`crm-queries.ts:808-811`, applied at `:817`)
matches no index and Postgres raises 42P10 on every new-contact submit.

**The backfill is gated on the drops, not on the code.** Ordinary intake never
violates the old uniques even under new code (`findCustomerIdByContact` runs
first, `:780-783`), but the import *deliberately* creates duplicate-hash FP rows
— run it before `0046` and every one becomes a per-record error. §2.0's flag and
`pg_indexes` probe enforce this instead of an operator remembering it.

### 7.3 §7-prod — a future runbook, gated on the user

**The constraint prod adds: Vercel applies ALL pending migrations in one build.**
Migrations run mid-build (`vercel.json` buildCommand) while the *old* code is
still serving. Because this branch contains **both** `0045` and `0046`, a single
deploy of it applies both together — so the old uniques disappear while old code
is still answering requests, and every new-contact intake 42P10s until the new
code is promoted. That window is **minutes**, not seconds (a Next.js build plus
promotion). Two honest options:

- **(a) Strict two-deploy — zero outage.** Deploy A carries the code and `0045`
  only; once live everywhere, deploy B adds `0046`. Say the mechanics plainly:
  this branch already contains both, so (a) is not "just deploy twice" — it
  means holding `0046` back (cherry-pick code+`0045` onto a deploy branch, or
  revert `0046` plus its journal entry, deploy, restore). Fiddly, and fiddling
  with migration journals has its own failure modes.
- **(b) Accepted-risk single deploy, off-hours.** New-contact intake 500s for
  the length of the build, then self-heals when the new code is live. Nothing is
  corrupted; the failures are retryable submits.

**Recommendation: (b), off-hours** — 3am traffic is trivial and (a)'s
cherry-pick mechanics add more ways to get the migration state wrong than they
remove. The user's call, not the spec's; (a) is genuinely zero-outage.

Either way, the **flagged prod backfill remains a separate manual act**, after
the deploy *and* after the §4.4 prod-state review. It is not part of any deploy,
and the nightly sweep never triggers it (§2.0).

### 7.4 Rollback reality

- A rolled-back deploy **does not un-run the migration** (see the corrected
  deploy memory and `docs/deploy-money-program/`). After a code rollback the
  index state stays wherever the last migration left it.
- **With `0045` applied but not `0046`** (only reachable under §7.3 option (a)):
  rollback is genuinely safe — the old uniques still exist, so old code's
  `targetWhere` still resolves and native intake keeps working; the new indexes
  are additive and harmless to it. This is the whole value of option (a).
- **Once `0046` is applied:** the only safe rollback target is **this branch's
  code**, which works fine against the new indexes alone. Rolling back past it
  is a **hard break** — old `targetWhere` matches no index and every
  new-contact intake 42P10s. Undoing that means a follow-up migration restoring
  `customers_org_{email,phone}_hash_unique`, which itself fails once duplicates
  exist.
- **After the import has run:** rollback is not available. Duplicate hashes
  exist, so the old uniques cannot be re-created without merging rows (data
  loss), and old code would do unordered `.limit(1)` picks over duplicates —
  nondeterministic greetings and, worse, the do-not-service bypass §3.3 exists
  to prevent. **Roll forward only.**
- No down-migration is written. Re-tightening is a data-merge problem, not a
  schema problem, and pretending otherwise in a `.sql` file would be a trap.

---

## 8. Out of scope

- **FieldPulse discounts** (`MONEY-FINDINGS.md` OPEN § 2) — line revenue
  overstatement, `rollUpMargin`, negative subtotals. Separate decision, separate
  program.
- **Housecall Pro.** `hcpCustomerId` + `customers_org_hcp_customer_id_unique`
  (`schema.ts:826-828`) have the identical structure and would need the identical
  treatment, but no HCP customer data exists. Do not pre-emptively change its
  *schema/uniqueness*; the §5 adoption pre-check twin is in scope.
- **Production deploy and the production import run.** This spec is
  dev-branch-only. Prod is a separate, gated decision with its own runbook.
- **Merging or de-duplicating native rows**, and any merge UI. The split
  deliberately creates rows that look like duplicates to an operator; a
  reconciliation/merge tool is a distinct product feature (already noted as a
  known limitation at `import/customers.ts:26-28`).
- **`SCAN_LIMIT_CUSTOMERS = 1500`** in global search — pre-existing truncation,
  recorded in §5, fixed elsewhere.
- **Letting an admin force-create a *second native* row on a contact an existing
  native row already holds.** Still blocked by the native↔native unique, and
  deliberately so: that index is the mechanism that makes concurrent chat/voice
  intake race-safe (§1.4). The FP-linked case — the one operators actually hit —
  is unblocked (§5). The 409 copy for the shared-contact case is now misleading;
  that is a backlog item, not this program.
- **`invoice 20776752`** — mirrored but 404 upstream, frozen
  (`MONEY-FINDINGS.md`). Unrelated to identity; the backfill does not touch it.
- **Transferring per-customer state across a split** (recorded STOPs, portal
  tokens, do-not-service flags). §4.4 makes it a reviewed prod prerequisite, on
  purpose: which sibling inherits a STOP is a human judgement, not a migration.
- **Force-push history scrub** of anything in this repo.

---

## Review round 1 — rejected findings

Recorded so they are not re-litigated:

- **Auto-fan-out erasure to hash-siblings** — rejected: siblings sharing a
  contact are usually *different data subjects*, so fan-out would destroy a
  third party's records. Replaced with sibling **disclosure** (§5.1).
- **Treating an ambiguous cluster as "no context" for the do-not-service refusal
  itself** — rejected: it would let a blocked business book as a new customer.
  The fail-closed winner is retained for the refusal; "no context" applies only
  to greeting/account-tier consumers (§3.3).
- **Cutting the §4.2 residual instrumentation entirely** — rejected in favour of
  the minimal optional-callback form, because the residual is observable only at
  sync time and recurs at every future full sync (§4.2).

## Review round 2 — rejected findings

- **Parking `fp-nightly-sync.yml`'s schedule for the duration** — rejected:
  prod's mirror would go stale, and the workflow is the only full sweep prod
  gets. Superseded by the `--split-shared-contacts` flag (§2.0), which is
  safe-by-default for the nightly run before *and* after the migrations,
  permanently, rather than for a window someone has to remember to end.
- **Adding spec machinery and before/after snapshots for the "66 persisting
  email-only mislinks"** — rejected: that cohort no longer exists. The ledger
  note it came from predates the same file's own rebuild section, which cleared
  and re-derived the whole `invoices.customer_id` column. The stale note has
  been corrected in `MONEY-FINDINGS.md` rather than worked around here (§4.1).

## Review round 3 — resolution

Round 3 (final verification) found two blockers in the round-2 flag design,
both fixed in place by the lead:

- **B1/B2 — the unflagged default was specified as a new skip-with-null path**,
  which would have dropped whole jobs nightly (`jobs.ts:424-428` skips the job
  on `null`) and, being email-probed only, would have introduced phone-hash
  unique violations against the pre-`0046` schema. Resolution: the unflagged
  default is now **today's code byte-for-byte plus one counter** (§2.0), which
  is trivially safe on both schemas and preserves the jobs contract; the §2.1
  machinery exists only behind the flag.
- **M1-M3 folded in**: the flag does not remove the 9 update errors (`0046`
  does); `resolveFpCustomerAction` models the flagged path only; the flag's
  steady state is explicit — flip the nightly invocation to flagged after the
  backfill, guarded by the two-index `pg_indexes` probe.

All round-3 "checked, holds" results (the §7 migration sequencing, the 42P10
window analysis in both directions, the `membershipStatus` widening's lone
null-safe consumer, count consistency) stand as recorded by the critic.
