# Adversarial review log

## Spec round 1 — 2026-11-01 (architecture.md + schema.sql)

Four blind critics (feasibility vs codebase, database/migration, edge
cases/races/security, scope/simplicity). Verdict: no sign-off; 3 shared
blockers, ~25 majors. Revised the same day.

### Established (verified, carried forward)
- The status enum is `request_status` (`schema.ts:55`), values
  pending/assigned/scheduled/in_progress/on_hold/completed/cancelled.
- The neon-http migrator runs statements one by one with autocommit and
  records files only after all pending files succeed; ADD VALUE works
  (precedent 0001/0008/0013); DDL must be idempotent (precedent 0042, 0044).
- `scheduledDate`, `arrivalWindowStart/End` are timestamptz; the FP import
  can produce window end == start.
- 25 `update(serviceRequests)` sites in 17 files, ~11 schedule/assignee
  write sites, 22 hard-coded status lists → appointment #1 is mirrored by
  a trigger, not by hand; status lists move to shared constants.
- `withTenant` is a WHERE helper, not a gate; body ids must be re-read
  under the org (the slice already does this for customer/technician).
- `reserveCapacitySlot` is a CAS loop and cannot run inside a batch; the
  "placed + reserved can exceed capacity" gap is pre-existing.
- `customers.is_tax_exempt`, `invoices.service_request_id`, `invoices.due_date`
  (timestamptz), `invoices.state`, `pricebook_items.hours`,
  `purchase_orders.received_at` already exist; `users.role` is text.
- Existing calendar day view (dnd-kit DayLane) already covers rows 88/90/92/95.
- Status workflows / guided flows close no must row (57, 128 are should).

### Applied
Enum name; forward FKs removed (zones, tax zones deferred); trigger +
idempotent backfill; one status vocabulary (assignments reuse
`request_status`, no `appointments.status`, no workflow tables in M0);
M0 split into M0b (config) and M0a (schedule); speculative
service_requests columns moved to the milestone that writes them; shifts
without RRULE; capacity adjustments deferred; composite FK on entity_tags;
organization_id everywhere; named idempotent DDL; CAS on `version`;
idempotency-key protocol; stripe_events + refund unique; invoice draft
index predicate; membership_visits index replacement + NULLS NOT DISTINCT;
recurring-billing ordering + Stripe idempotency key; leads encrypted;
contacts in erase batch in M0b; merge hash rules; M2 retargeted to calendar
deltas; build order M0b → M0a → M3 → M2 → M4 → M1 → M5+; done-when per
milestone; business-hours claim dropped; trigram-on-ciphertext removed.

### Rejected (with reason)
- "Make request columns derived from appointment #1" — inverted ownership
  would require rewriting 25 write sites and the FP/HCP sync; the trigger
  direction keeps CAS guards intact. Appointment #1 moves go through the
  existing request update paths.
- "Make session_id nullable" — larger change than the stand-in rule it
  replaces; documented the stand-in token prefixes instead.
- "Count assigned jobs as reservation ordinals" — a redesign of capacity
  holds; recorded as the M2 known gap, not an M0 change.
- "Add appointment_id to capacity_reservations in M0" — visits #2+ do not
  hold band capacity until M2.
- Build-order proposal "M4 money before M2 calendar" — kept M2 (small
  calendar deltas) before M4 because the reassign guard and multi-tech UI
  are needed as soon as M0a's assignments exist.

## Spec round 2 — 2026-11-01 (revised M0 only)

Two blind critics (DDL/trigger/backfill; runtime/feasibility/security).
Verdict: no sign-off on the round-1 text; 2 blockers, ~15 majors, all
applied the same day.

### Established
- Postgres `UPDATE OF` fires on unchanged values; the FP sync rewrites
  every row nightly → separate INSERT and UPDATE triggers, the UPDATE one
  with a `WHEN (OLD.x IS DISTINCT FROM NEW.x …)` clause; the function bumps
  `version` only on real changes, so CAS stays honest.
- Reassign A → B → A would hit the (appointment, technician) unique key
  if the old lead row is kept → new lead is an upsert; old lead deleted
  when it has no progress timestamps, else demoted with status
  `cancelled`.
- Date-only bookings (membership visits, `scheduleRequest` without a
  window) are "unscheduled" today → appointment #1 gets `starts_at` only
  from the arrival window; `scheduled_date` is mirrored as its own column.
- Unschedule nulls all columns → delete appointment #1 (no progress) or
  null its times.
- The existing lists differ (some include `pending`, ops-insights drops
  `scheduled`/`on_hold`) → six constants, no merging, byte-identical output.
- `findCustomerMatchByContact` feeds AI, voice caller-ID and SMS consent →
  contacts never join it.
- FKs need Drizzle names; `drizzle-orm` 0.45.2 supports `check`, composite
  `foreignKey`, partial `uniqueIndex().where()`.
- `deleteCustomer` hard-deletes; users are never deleted (`is_active`).
- The calendar renders requests keyed by request id → visits #2+ on the
  calendar is M2 work; M0a's done-when is API + detail sheet.
- Shifts must be subtracted in five places, not one; HCP-sourced orgs use
  HCP tech ids, so shifts apply to the DB scheduling source only.

### Rejected
- "Ownership = assigned_to OR assignment row" (my own round-1 text) —
  withdrawn for M0a: a visit-#2 tech would be able to complete the whole
  job through the request-status route. Ownership stays `assigned_to`
  until M3 defines per-visit status.
- "Fire en-route / arrived texts from the status tap" — M3 (needs the
  idempotency ledger key and copy review).
- "Fix the ops-insights status drift" — pre-existing; not in M0a.

Convergence: round 2 surfaced new blockers in text round 1 had added
(trigger rules, ownership), both now resolved by narrowing M0a. Round 3
on the spec is folded into the implementation-plan review, whose critics
read the spec and the plan together.

## Plan round 1 — 2026-11-01 (M0b + M0a implementation plans)

Three blind critics (M0b vs codebase; M0a SQL/trigger; plan quality for
both). Verdict: no sign-off; 5 blockers, ~30 majors; all applied the same
day in a full rewrite of both plans.

### Established
- Drizzle wraps driver errors: only `@/lib/db/unique-violation` matches a
  23505 (a local `.code` check never does).
- `readJsonBody` returns `{ ok, data }`; `logAudit` takes `details: string`.
- `parseCreateRequestBody(raw, todayIso)` is the create-request API; zod 4
  `z.uuid()` rejects non-v4-shaped ids in tests.
- Nothing exposed customer locations before M0b → `GET …/[id]/locations`
  + a Locations section are in scope.
- Existing tests with fixed schema mocks / statement counts
  (erasure, crm deleteCustomer, conversation delete, location-queries,
  provisioning, delay-detection, scheduling-queries, account-tools,
  operations-metrics, HCP webhook-events, FP jobs) must change in the
  same task.
- Three classes implement `SchedulingSource` (DB, HCP, FieldPulse).
- `signals.ts` only knows the day → the time-off filter lives in
  `autoAssignBookedRequest` / `suggestTechnicians`.
- Trigger: cancel cascade must run before the "nothing to mirror" early
  return; `cancelled_at` on #1 follows the request (FP can reopen).
- Time off is never overridable; the guard is independent of `override`.
- Visit updates: CAS + assignment replace in ONE batch gated on
  `version = v + 1`; number allocation retries once on 23505.
- Admin status route is `PATCH /api/admin/requests/<id>`; dispatch is
  `GET /api/admin/dispatch?date=`; tech sessions via `mint-tech-session.mjs`.

### Rejected
- "The attribution trailer should be Opus" — this session's attribution
  is Fable 5.1 (system instruction); kept.
- "Don't add `contact_id`" — added to 0047 instead so row 49 can close.

### Changes of note
- M0b: `*-types.ts` client-safe modules; `contactPatchSchema` without the
  undefined→null transform; tags validated before the insert; dialog binds
  `jobTypeId`; `?active=1`; `persistJobLocation` no longer overwrites a
  chosen location; Task 7 split into 7a/7b; drizzle recipe simplified.
- M0a: prerequisite on M0b; Task 2 explicit file + test lists and a
  dashboard-bucket decision; "before" captures moved ahead of the
  migration with the real URLs; Tasks 5 and 6 split (5a/5b, 6a/6b/6c);
  trigger names from the spec; `tech-status-confirm.ts` reused.

## Plan round 2 — 2026-11-01

One blind critic on both rewritten plans. 1 blocker (M0a visit update:
a bare `${array}` expands to `($1, $2)`; use `sql.param`), 6 majors (xmin
gate instead of version+1 for the batched assignment replace; lead from
caller order; time off bypassable via /assign and the PATCH schedule path;
mint-tech-session takes no args; persist-job-location path; `raw` vs `b`;
multiple primary contacts), ~10 minors — all applied. Convergence: round
2 found no new design-level defects in M0b; the M0a findings are confined
to Task 5a/6b code blocks. Further plan rounds are folded into the
per-task reviews of subagent-driven development.

## Spec round 3 — 2026-11-01 (M3 tech close-out loop, before planning)

Three blind critics (status/roll-up/timesheets; money/idempotency/
offline/security; scope/sequencing). Verdict: no sign-off; 7 blockers
across lenses, ~25 majors. Revised the same day.

### Established
- The trigger's lead-status mirror would rewind per-tech progress; it must
  mirror only while the lead row has no progress timestamp; request cancel
  must close open assignments on every visit; a demoted completed lead
  keeps `completed`.
- Close-out must be ONE guarded UPDATE (no transactions on neon-http);
  helpers never write request status; `cancelled`/`scheduled` are not tech
  targets; the request id alone cannot identify the assignment (needs the
  appointment id); "paused" is not an enum value (pause = own row on_hold).
- Seven `assigned_to = me` ownership sites; reads + own-row writes open to
  assignment rows; money stays with the active lead.
- `MockPaymentProvider` always succeeds and marks invoices paid; the
  portal pay button/route run through it today → no card payments in M3,
  manual cash/check with `payments.method`, portal pay refuses on mock.
- The only native invoice creator is from a sold estimate → M3b adds
  invoice-from-job; the one-native-draft index moves from M4 into M3b.
- `takePayment` mints a random payment id → derive from the idempotency
  key; stuck `in_progress` keys need a 2-minute CAS takeover; TTL 7 days;
  multipart routes claim before upload; status taps need no key.
- The FieldPulse nightly sync overwrites status/assignee on synced rows →
  M3 is native-jobs-only.
- Three of the "14 must rows" had no scope (115, 122, 131); tech book-a-job
  depends on M1 `leads` and is a should; S29 is guided flows, not forms.
- General time entries need a partial unique index and `kind='job'` filters
  in the on-site KPI, labor export and reporting; 4 of 6 proposed
  time-entry columns serve a should row.
- No client data layer exists (plain fetch); offline is a separate project.

### Applied
M3 split into M3a Run the day / M3b Collect / M3c Sell on site / M3d
Forms + site view, each with a done-when; ownership rule + action→enum
mapping + trigger changes written into F04; idempotency state machine
rewritten; `payments.method`/`check_number` + draft index into M3b;
time-entry columns trimmed to kind/appointment_id/clock_in_method with
checks + index; forms flattened with encrypted values and a unique key;
offline, video, card, tech book-a-job, templates/deposit/lock, required
forms, GPS, en-route texts deferred with rows named.

### Rejected
- "Derive job time from request_status_events alone" — per-request, not
  per-tech; cannot represent pauses; labor cost reads time entries.
- "Record cash through takePayment with provider=mock" — indistinguishable
  from fake card payments.

## Spec round 4 — 2026-11-01 (revised M3 sections)

One blind critic. 3 blockers (no active lead once every row is completed;
a hold pinned the active visit; manual-payment re-run after a takeover
double-credits), 9 majors (updateRequestStatus cannot sit in a batch →
inline guarded request UPDATE with the xmin pattern; close-out side
effects; no-op ambiguity; step-3 ON CONFLICT rewind; admin hold/complete
no longer mirrored; visit-#1 edit path; cancel leaves time entries open;
manual refunds through the mock; mock gate only on the portal). Applied as
the critic's exact rules: open-assignment definition; active visit falls
back to the latest; the active lead stays authorised after done; hold ends
the visit (progressed rows complete, untouched rows cancel, entries close;
resume = new visit); fixed batch order with xmin gating; close-out batch +
blockers incl. request_not_started; admin paths; trigger (a)–(d) extended
incl. closing time entries on cancel; auto-entry ON CONFLICT adoption;
visit-#1 helpers through an admin assignments endpoint (so a two-tech
scenario is reachable before M2); the checkable before/after done-when;
M3b: claim conditioned on the payment row not existing, manual refunds,
mock gate everywhere, FP payments backfill method='other'.

## M3a plan review — 2026-11-01

Round 1 (two critics: feasibility vs code; logic/concurrency/authz): the
plan predated spec round 4 → full rewrite (fixed batch order with xmin
gating, active-lead fallback, hold ends the visit, admin paths, visit-#1
helpers, ?visit= plumbing, mock strategy, task order). Round 2 (two fresh
critics): 4 blockers + 17 majors, mostly overlapping — trigger step 4
re-mirrored onto a hold-cancelled row (fixed: open rows only, never to
terminal values); hold gated on the lead's xmin was impossible after the
lead's done (fixed: post-condition NOT EXISTS open row; visit cancelled
when nobody started); "whichever is behind" was unreachable through the
noop rule (fixed: noop requires the stamp; request_only write); hold on a
paused lead was a noop (fixed); bare OR in techCanReadSql (fixed:
parentheses + render test); untyped CASE → text vs request_status (fixed:
casts + live probes); time off / completed request / ended visit on helper
add; admin completed now one batch that cancels untouched rows; list
classification (overdue → today; past by completed_at/visit cancelled_at);
reschedule/unschedule live in scheduling-queries.ts; lock order
request→rows; labor formula unified; after() stays in the route. Rejected:
none material. Round 3 (one critic, combined lens on the changed rules): 1
blocker (request_only also fired for completed/pause → limited to
en_route/arrived/in_progress), 2 majors (trigger step 2 cleared a visit's
cancelled_at on any status change → kept unless leaving 'cancelled', plus
VISIT_ENDED on request-level writes to an ended #1; step 3's ON CONFLICT
revived a hold-cancelled row → cancelled stays cancelled, probes (a)/(b)
rewritten), 8 minors applied (hold locks the visit row, statement 1 gated
on a holdable native request and no stale $from, helper add as a locked
batch, exports from appointment-queries, admin complete records the event
and returns currentStatus, interface name fixes, FOR NO KEY UPDATE).
Verdict: converged-enough — each round narrower; the SDD task reviews are
the net for what implementation surfaces.

## Spec round 5 — 2026-11-04 (M3b Collect spec, `docs/superpowers/specs/2026-11-04-replica-m3b-collect.md`)

Three blind critics (money/concurrency/idempotency; feasibility vs code;
scope/security/field UX). Verdict: no sign-off; 2 blockers, 27 majors, ~30
minors. Revised to v2 the same day.

### Established
- A refund that leaves the invoice `refunded` strands the job (void refuses
  non-open, the adopt rule refused to create) → manual refunds return the
  invoice to `open` while a balance remains; adopt only draft/open.
- Line edits on a draft race an office cash payment that silently flips
  draft → open → manual payments require `open` everywhere; line writers lock
  the invoice row after the request row.
- A stale-key takeover with a different body replays the first body's
  result as if it were the new one → different hash is 422, always.
- Attempts need ownership (`attempt_id`) or a slow original overwrites the
  takeover's `done`; STALE/5xx results must not be stored as `done`.
- Office manual payments with random ids double-record on a double-click →
  client-minted `paymentId`/`refundId`.
- `reconcilePayment` auto-succeeds pending mock charges and writes a stale JS
  invoice state; `createInvoiceFromSoldEstimate` can create a second
  collectable invoice on a request → both fixed in M3b.
- `takePayment`'s default parameter makes a "provider undefined" gate dead
  code → gates live at the routes only.
- $0 finalized to `paid` could never be voided → `open` with zero balance.
- Receipts/pay links only queue; the admin route drains with
  `processPendingJobs()` in `after()` → required for the tech routes.
- `invoice_sent` needs the enum (own file), six registries, `seeds.ts` for new
  orgs and a backfill file for existing orgs; the neon-http migrator runs
  statements individually.
- FieldPulse import must write `method='other'` or new mirrored payments
  default to `card`.
- The signature route uploads before writing and has no `signed_at` guard;
  the architecture's multipart key claim was dropped → restored, plus the
  finalized-lock rule and the native guard.
- Non-leads reached customer name, signature URL and check numbers through
  `findReadableJob` → reduced projection; cost fields explicitly excluded.
- Happy path was ~17 taps → merged approval sheet (sign + finalize), auto-open
  record sheet, remembered method: 6 taps.

### Applied
All of the above; tenant predicates on every subquery; `jobMaterialId` branch
scoped to the request; `COALESCE` names; `still_lead` final SELECT; re-claim on
a vanished key row; pay-link cooldown column + demo block + `no_template`;
portal phone line; key on finalize + same-origin guard on money writes;
separate read/write rate keys; pricebook search rate-limited; service items
rejected in `addJobMaterial`; `mint-tech-session --user`; email subject
literal; `invoice_line_items.created_at`; `randomUUID` fallback; memoised
`cardPaymentsEnabled`; erase reads keys before the scrub.

### Rejected (with reason)
- "Admin clear-signature action" — void the unpaid invoice instead (scope).
- "Reuse an unexpired portal token on resend" — token rotation per send is
  the established reminder behaviour; a 2-minute cooldown bounds the churn.
- "Store a per-row salt so the request hash cannot leak a check number" —
  the plaintext is in `payments.check_number` by design; no claim is made.
- "Keep `cardPaymentsEnabled` in the GET/`allowed`" — constant-false
  scaffolding until M4; routes gate, UI omits Card.

## Spec round 6 — 2026-11-04 (M3b spec v2 → v3)

Two fresh critics (money/idempotency; feasibility/scope/UX). Verdict: no
sign-off; 2 blockers (same root: ids a client can choose collide across
invoices/orgs and report success with nothing recorded; the approval sheet
discarded the customer's signature when the job was signed earlier), 13
majors.

### Established
- Office entity ids are derived server-side from a client token
  (`uuidv5(org|invoice|payment|token)`); the NOT EXISTS guard is global by id
  (documented exception to the tenant rule); the state UPDATE is gated on the
  NEW row's xmin; a replay must match invoice/amount/method or it is
  `ID_CONFLICT`.
- The signature lock rules contradicted the re-bill rulings → the invoice
  snapshots the request's signature at finalize (immutable evidence); the
  job-level signature is always re-capturable; the sheet signs first, then
  finalizes.
- A second invoice re-seeded every material → `invoice_line_items.job_material_id`
  and "unbilled" seeding.
- An adopted estimate-born open invoice cannot take lines → the field
  presents/pays it; materials on sold-estimate jobs are billed by the office;
  other open invoices are listed (`otherOpen`).
- The office had no finalize → admin finalize route + button.
- Writes did not name their invoice → `invoiceId` in every body, 409 STALE
  when it is not the newest live one.
- Re-keying a changed body while the first request may still be running
  double-records → the client resolves the old key first (`nextKeyState`
  reducer); the GET exposes `pendingWrite`.
- Stored state-dependent 4xx replayed stale refusals → only 2xx and
  deterministic 4xx are stored; `IDEMPOTENCY_KEY_REUSED` carries `storedStatus`.
- The pay-link token was minted before the cooldown claim → claim first.
- Pending mock payments as `noop` left a phantom credit → treated as failed.
- The card refund path wrote a stale JS state → SQL CASE.
- Estimate creator refuses only on a field DRAFT; estimate-id early return
  stays first.
- `isDemoAccount` is an admin-email check → `DEMO_ORG_ID` for the tech route.

### Applied
All of the above plus: tenant predicate on `appointment_assignments` in
`stillLead`; `T` and line removal require `amount_paid_cents = 0`; `isDeposit`
false on the tech path; `invoice_paid` history outcome on create retry;
receipt sent by the attempt that observed `created: true`; signature Blob
captured once per intent; `signatureState`; `taxBps` only on drafts; casts in
the 0053 INSERT; `customer_id` guard on receipts; test budget listed.

### Rejected (with reason)
- Email pay-link channel, `mint-tech-session --user`, membership-form card
  control: cut as scope (SMS meets row 135; probes set the lead by SQL; no
  form control exists).
- "Adopt drafts only and let a native draft sit beside an estimate-born open
  invoice" — re-opens double billing; the office bills materials on
  sold-estimate jobs instead.

## Spec round 7 — 2026-11-04 (M3b spec v3 → v4 FINAL)

One fresh critic, combined lens on the v3 changes. Verdict: no sign-off; 0
blockers, 5 majors, 7 minors — each round narrower (2+27 → 2+13 → 0+5).

### Established
- A finalize snapshot of a signature older than the invoice's last change is
  not evidence → snapshot only when `signed_at >= invoices.updated_at`, else
  NULL ("No signature"); the sheet shows the pad unless `signature.fresh`.
- The admin document must render the invoice's snapshot, not the request's.
- Reconcile's failed branch was two statements and never touched state → one
  batch with the SQL CASE, for every provider; mock branch before `getCharge`.
- A STALE check before replay defeats the retry it exists for → lines and
  finalize require the newest live invoice, payments and pay-link accept any
  non-void native invoice of the request; both run inside `run` after replay.
- Invoice-scoped office ids could not catch a token reused on another
  invoice → `uuidv5(org|payment|token)`; replay match includes check number
  and deposit flag.

### Applied
All of the above plus `already_billed`; one shared `STORED_CODES` module;
pay-link claim with a JS `$now` (same as the reminder) and release `WHERE
pay_link_sent_at = $now`; `recordSignature` returns the previous URL
atomically; estimate-born invoices show the estimate's acceptance; admin
finalize route details (rate key, map, `$rid`); `pendingWrite` covers the
signature route; `unknown` intents persist in `sessionStorage`; "Email"
removed from the pay-link sheet.

### Verdict
Converged-enough: no blockers in round 3, the remaining majors were
refinements of rules introduced in v3 and are applied; the plan review and
the SDD task reviews are the net for what implementation surfaces.

## M3b plan review — 2026-11-04

Round 1 (two critics: spec coverage/feasibility; decomposition/tests/probes):
no sign-off — 2 blockers (both: `mint-tech-session.mjs` ignores
`MINT_ORG_ID`, so every throwaway-org probe and `--tech` screenshot would
have minted a technician from another org — the FieldPulse-connected one; a
Task 4 test mandated STALE on payments, contrary to spec ruling 10), 20
majors. Plan rewritten as v2: eleven tasks with exclusive file ownership
(Task 3 field-queries, Task 4 writers, Task 5 invoice-queries fixes, Task 6
GET/view, Task 7 write routes, Task 8 pay link + signature, Task 9 office,
Task 10 S40, Task 11 erase/integration/docs); Task 2 precedes Task 3/4
(`materialLineId`, `cardPaymentsEnabled`); the stored idempotency value is
the full response envelope with `toResponse`; pay-link failures after the
queue insert are `SEND_FAILED` (stored, client re-keys); the reducer gains a
`definitive_unstored` event; `recordSignature` sets `signed_at = now()` in
SQL (app/DB clock skew would break the freshness compare); the by-id
exception set is spelled out; the office path takes `L_req` from the
invoice's request; `refundPayment` carries `refundId` in `params` (14 call
sites pass `provider` 4th); the admin invoice GET route signs the snapshot
URL; `invoiceAllowedActions` gains `native`/`externalInvoice`/`sign`;
probes guard the communication queue (global drain) and write phones with
`encrypt`; the drizzle-kit `generate` → overwrite → `generate --custom`
recipe replaces the garbled snapshot step; tests assert load-bearing
fragments and golden uuid vectors instead of verbatim statements; Review
Focus #2 gets its integration case. Rejected: "attribution is Opus 5.5"
(the critic's own model; this session is Fable 5.1).
Round 2 (one fresh critic, combined): 2 blockers (Task 8 consumed Task 7's
guards a wave early; the queue drain ran on every payment and the probe
guard was keyed to "has a phone"), 7 majors (Task 3 before Task 4; replays
return the stored status; pay-link `send_failed` is a return value from the
queue call, not a flag; reducer gaps for `sent`/`unknown` + edit/open, a
`dropped` event and an outcome→event table, persistence at `sent`;
signature intents never persisted (Blob); Tasks 9 and 10 split). Plan v3:
thirteen tasks, order 1 → 2 → 3 → 4 → (5 ∥ 6) → 7 → (8 ∥ 9 ∥ 10) → 11 → 12
→ 13; guards moved to Task 6; the drain only inside the customer branch;
every probe that could queue a message guards `pending AND scheduled_for <=
now()`; `mintKey` fallback; `derivedIdInput` pinned as a string; office
writers pre-read for `synced_read_only`; `materialsNotOnInvoice` filter;
audit skipped on replay.
Round 3 (one fresh critic, convergence): 0 blockers, 5 majors (a
`stateAdvanced` heuristic that dropped the tech's own in-flight payment when
the office recorded one — replaced by intent-specific `intentLanded`, never
while `pendingWrite`; the body sent while an intent is `unknown` was
unspecified — inputs read-only, every send dispatches `edit(currentBody)`;
the payment writer's pre-reads refused a full-balance replay before the
by-id match — by-id read first; Task 10 consumed Task 9's unpinned
contracts in parallel — ordered after, Interfaces block added; Task 12 too
big with untested flow logic — split, `approvalStep`/`persistOps` pure).
Plan v4: fifteen tasks (writers split into A/B; S40 split into page +
sheets), order 1 → 2 → 3 → 4 → 5 → (6 ∥ 7) → 8 → (9 ∥ 10) → 11 → 12 → 13 →
14 → 15; `parseIntents` maps `sent` → `unknown`; the detail pad holds
`{blob, key}`; `SEND_FAILED` copy and the `STORED_CODES` deviation recorded;
15-minute queue-guard window; `reasonResult`; winners return their own
result. Verdict: converged-enough — each round narrower (2+20 → 2+7 →
0+5), the remaining majors were refinements of v3 rules and are applied;
the SDD task reviews are the net for what implementation surfaces.

## M3b final review — 2026-11-05

Three blind lenses (money/concurrency; security/tenancy/privacy; UX/client/
copy) over a3c2b23..84b5ff3. Verdicts: money "Ready to push" (0 blockers, 2
live minors, 5 latent card-path items for M4); security "Needs a fix wave"
(1 major: Drizzle query errors carry SQL params into logs via
`logger.error({ error })` — signature names, the portal pay link); UX
"Needs a fix wave" (4 majors: a late-landing signature left a stuck banner;
the paid-view ruling needed client work; the office form could double-record
after a network error; the approval pad's "Save signature" label). ONE fix
wave in three parallel commits (a2f59c6 admin/docs, c5aedad tech client,
54fe27a server), then a combined re-review (two small new defects: docs
described `history` wrongly; the clients did not pre-validate the new
check-number pattern) fixed by the controller. Final: tsc 0, eslint 0
errors, 5556 passed / 1 skipped, `next build` OK, drizzle "No schema
changes", verify-skills 0 missing. Parked for M4 (card paths, inactive
while `cardPaymentsEnabled()` is false): `takePayment` un-claim state CASE,
card on draft, card refund token, card/manual refund-state divergence;
accepted: takeover re-run loses the receipt/audit; pay-link ≤ 1 per 5 min
per invoice; the shared-file erase edge.
