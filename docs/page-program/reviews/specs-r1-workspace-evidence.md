# Workspace-cluster specs — Round 1 evidence audit

Reviewer: adversarial evidence-audit lens only (does not check design quality,
completeness, or scope — only "is the cited code actually what the spec says
it is"). Scope: `reports.md`, `operations.md`, `staff.md`, `settings.md`,
`integrations.md`, `inventory.md`, `audit-log.md`, `fieldpulse-import.md`,
`platform.md` in `docs/page-program/specs/`.

Method: every `verified`-tagged, load-bearing claim (justifies a P0/P1 gap, a
requirement, or a "this is solid, no gap here" conclusion) was checked by
opening the cited file at the cited lines in the live repo — either directly
(the five mandated high-stakes claims) or via a dedicated fact-check agent per
spec, each running independent greps and reads with no access to the others'
conclusions.

## Five mandated high-stakes claims — verdicts

1. **staff.md — last-admin trigger deleted from the migration chain.**
   **CONFIRMED TRUE.** `git show 0cea181 --stat` / `git diff-tree` confirm
   commit `0cea181` deletes `drizzle/0008_last_admin_guard.sql` and
   `drizzle/0027_last_admin_guard_super_admin.sql`; `grep -rn "CREATE TRIGGER"
   drizzle/*.sql` returns zero hits repo-wide; `drizzle/0000_baseline.sql` has
   no `CREATE FUNCTION`/`CREATE TRIGGER` anywhere. `drizzle/meta/_journal.json`
   confirms the baseline entry's `when: 1700000000000` is the **minimum**
   value in the entire 44-entry journal (max `1784700000000`) — i.e. the
   baseline is dated chronologically *before* every real migration, the exact
   mechanism the spec describes for why a migrator would treat it as
   already-applied and skip re-running it. `staff-queries.ts:18-28`'s
   "NOT race-proof on its own" characterization is accurate: `updateStaff`
   does a `SELECT` (current row) → authorization checks → a **separate**
   `countActiveAdmins` read → then `UPDATE`, with no transaction (neon-http)
   — two concurrent demotions of two different admins can both pass the
   `otherActiveAdmins === 0` check before either write commits. Confirmed
   genuinely race-prone, not a defensive overstatement.
2. **platform.md — purge can delete the platform's own operating org.**
   **CONFIRMED TRUE.** Read `src/app/api/platform/organizations/[id]/route.ts`
   in full: the `DELETE` handler never compares `id` to `PLATFORM_ORG_ID` or
   `session.organizationId` — the only checks are auth, rate limit, and UUID
   shape. Read `src/app/api/platform/organizations/route.ts`'s `GET`: it
   selects `id, name, status, createdAt FROM organizations` with zero
   filtering, so the platform's own org is a normal orderable row. Confirmed
   `users.organizationId` is `.references(() => organizations.id, {onDelete:
   "cascade"})` (`schema.ts`), and `isPlatformAdmin`
   (`src/lib/auth/authz.ts:56-57`) requires `session.organizationId ===
   platformOrgId` — so purging that org deletes every platform-admin user row
   and permanently makes the check unsatisfiable. Lockout is real and
   irrecoverable as described.
3. **integrations.md — "Connected" badge is write-once; sync-health columns
   are written but read by no route/component.** **CONFIRMED TRUE**, with one
   citation-completeness nuance (see W-E-5). `grep -rn "connected: false\|
   connected = false"` across `src/lib/integrations` and
   `src/app/api/admin/integrations` returns matches only inside the three
   save/disconnect pairs (fieldpulse, housecall-pro, google-calendar
   `connection-queries.ts`) plus the disconnect routes' HTTP response bodies —
   nothing in webhook or availability-sync failure paths ever flips it false.
   `availabilitySyncStatus`/`lastSyncError` are read outside `schema.ts` and
   their writer (`availability-sync.ts`) only by the cron trigger route and
   one more admin-facing manual-trigger route that is itself unwired to any
   UI (see W-E-5) — so no component ever renders them today. Gint-1/Gint-2
   both hold.
4. **reports.md — `dismissed` estimates excluded from every `getSalesReport`
   bucket while `/admin/estimates` treats them as "lost".** **CONFIRMED
   TRUE**, exact line match. `reporting-queries.ts:156-172`'s estimate-bucket
   query branches only on `'sold'` (159), `'expired'` (160-166, including
   lazy-expired `open`), and undecided-`open` (167-172) — no `dismissed`
   branch; `estimatesCreated` (158) is a plain `count()` that includes
   dismissed rows. `closeRatePct`'s denominator
   (`estimatesOpen+estimatesSold+estimatesExpired`) is exactly at lines
   232-236. `estimate-queries.ts:239-245`'s `BUCKET_CASE_SQL` (the file's own
   "Single source of truth" comment, at line 238/239) explicitly groups
   `status IN ('dismissed','expired')` as `'lost'`. Both citations verified
   character-for-character.
5. **operations.md — FieldPulse webhook writes `assigned`/`in_progress`
   events that contaminate two KPIs lacking a native-only filter.**
   **CONFIRMED TRUE**, exact line match. `fieldpulse/webhook/route.ts`'s
   `mapFieldpulseStatusToRequestStatus` maps `"assigned"`/`"dispatched"` →
   `"assigned"`; `recordStatusEvent({..., actorType:"system"})` is called at
   line 407 for every mapped status change. In
   `operations-metrics-queries.ts`, `inProgressRows` (137-161) and
   `assignedRows` (169-193) have no `isNull(fieldpulseJobId)`/
   `isNull(hcpJobId)` filter, while `paidRows` (201-220, guard at 213-214) and
   `jobsCurrentRow`/`jobsPreviousRow` (286-314, guards at 294-295/309-310) do.
   The HCP webhook (`housecall-pro/webhook-sync.ts`) has zero
   `recordStatusEvent` calls (independently grepped) — confirming the
   FP-vs-HCP asymmetry Gops-2 describes. Test-coverage asymmetry also
   confirmed: the native-only-scoping test at
   `operations-metrics-queries.test.ts:296-336` asserts on `captured[2]`
   (paid) and `captured[4..8]` (AR/jobs) but never `captured[0]`/`captured[1]`
   (in-progress/assigned).

## Findings

| id | spec | severity | tag | spec line (verbatim) | what's actually true |
|---|---|---|---|---|---|
| W-E-1 | reports.md | minor | verified | `All four render under an identical unqualified column header "Revenue" in the UI (`page.tsx:95` "Net revenue (period)", `:242` lead-source table, `:287` location table, `:332` technician table)` | `page.tsx:95` is the value binding under the headline `StatCard` labeled **"Net revenue (period)"** (`page.tsx:94`) — not a bare "Revenue" header. Only `:242`/`:287`/`:332` are genuinely unqualified "Revenue" column headers. The "identical...header" framing overstates uniformity across all four surfaces; the spec's own parenthetical even names the differing label right next to the claim. Does not change Rreports-2, which only requires disclosure on the location/technician `SectionCard`s and explicitly never touches the headline KPI. |
| W-E-2 | staff.md | minor | verified | `staff-form-dialog.tsx:226,230` renders "Add Staff Member", "Edit Staff Member" (Gstaff-4 evidence) | Both Title Case strings are on **line 226** (a ternary). Line 230 is `'Update name, role, and status.'` — an unrelated, already-sentence-case description string, not a second Title Case instance. Gstaff-4's underlying claim (Title Case drift exists in this dialog) is still true at line 226; the dual-line citation is imprecise. |
| W-E-3 | settings.md | minor | verified | `list query selects keyPrefix, never keyHash, key-queries.ts` | `listWidgetKeys`'s DB call is a full-row `.select()` (pulls `keyHash` into the intermediate row), and `keyHash` is dropped only when mapping to the returned `WidgetKeyRecord` shape — a post-query field omission, not a narrowed SQL `SELECT`. The security property (client never receives the hash) holds; the "selects...never" phrasing implies a stricter SQL-level guarantee than what's actually implemented. |
| W-E-4 | integrations.md | minor | verified | `A repo-wide grep for these field names outside schema.ts and their writer file finds only the cron route that triggers the sync` (Gint-2 evidence) | The grep also finds `src/app/api/admin/integrations/fieldpulse/sync-availability/route.ts` — an admin-facing `GET`/`POST` route whose own docstring says it's "Used by the admin UI to display sync status and last sync time," and whose `GET` handler does select+return `status`/`lastSyncAt`/`lastError` via `getAvailabilitySyncStatus()`. Independently grepped `src/hooks`, `src/components`, `src/app/admin` for `sync-availability` — zero hits, confirming no UI component or hook ever calls this route. The Gint-2 conclusion ("never surfaced to any operator UI") still holds because nothing renders the response, but "finds only the cron route" undercounts — it's two non-writer files, not one, and one of them was purpose-built to expose exactly this data to an admin surface that was never wired up. |
| W-E-5 | integrations.md | minor | verified | `integration-meta.ts:44-51`, default `{ icon: Plug, intent: 'neutral' }`; `connection-queries.ts:78,83` two `encrypt()` calls; `GET /api/admin/integrations` is admin-session-gated (`:19-22`) | Three small line-drifts: the literal `{icon: Plug, intent:'neutral'}` object is declared at `integration-meta.ts:38` (`DEFAULT_META`), referenced by name inside the cited 44-51 range, not itself inside it. `saveFieldpulseConnection`'s second `encrypt()` call (`webhookSecret`) is at line **81**, not 83 (line 83 is blank). The session-gate/rate-limit citation `:19-22`/`:24-30` is listed under the "`src/lib/admin/integrations-status.ts`" section header but actually belongs to `src/app/api/admin/integrations/route.ts` (the aggregator file has no session/rate-limit code at all) — content is correct, file attribution via the section header is ambiguous. |
| W-E-6 | audit-log.md | minor | verified | `21 writers build details as a template-literal string instead of JSON.stringify(...)` — e.g. `pricebook/[id]/route.ts:93`, `membership-plans/[id]/route.ts:67`, `inventory/route.ts:104` | These three of the six cited example sites are actually `Object.keys(...).sort().join(",")` calls, not template literals (the other three cited sites, e.g. `payments/[id]/refund/route.ts:92`, genuinely are template literals). Both patterns produce non-JSON `details`, so the functional consequence (JSON.parse throws, viewer shows "(details unavailable)") and Raudit-log-2's fix requirement are unaffected — but "template-literal" mischaracterizes the mechanism for half the cited evidence. |
| W-E-7 | audit-log.md | minor | verified | `conversation-queries.ts:461-464` deletes audit_log rows | The `.delete(auditLog)` statement's `withTenant(...)` scoping (line 463) is correctly cited, but the statement itself starts at line **460**, not 461. Trivial one-line offset, content and severity unaffected. |
| W-E-8 | audit-log.md | minor (informational) | verified | `logAudit()`...called from 61 files...A further 16 call sites insert directly` | Independent recount: `grep -rl "logAudit(" src/app/api/admin src/app/api/auth src/app/api/platform src/lib/admin/crm-queries.ts` → 68 files (not 61); `grep -rn "db.insert(auditLog)" src` outside the definition file → 13 sites (not 16). Both within ~20% of the cited figures — same order of magnitude, not wildly wrong — but the exact counts don't reproduce precisely, likely repo drift since the audit was written. Does not affect any gap or requirement (no requirement depends on the exact count). |
| W-E-9 | fieldpulse-import.md | minor | verified | `.github/workflows/fp-nightly-sync.yml` with `timeout-minutes: 150` (`:41`) and `cancel-in-progress: false` (`:48`); "runs all 11 phases nightly at 08:30 UTC (`:35,66`)" | Content fully present and correct, but line numbers drift: `timeout-minutes: 150` is actually at line **49**; `cancel-in-progress: false` is at line **44**; the cron schedule string is at line **33** and the full 11-phase list is at line **72**. All off by 4-8 lines, same file, same content — doesn't affect Gfieldpulse-import-2's P1 severity or evidence substance. |
| W-E-10 | platform.md | major | verified | `Every write path exists and is correct (`route.ts:154-165` org_provisioned, `export/route.ts:58-65` org_data_exported, `erasure-queries.ts:437-…` org_purged)` (Gplatform-2 evidence) | `route.ts:154-165`'s audit call is `logAudit(...)` (`src/lib/admin/audit.ts`), which inserts into the **per-org `audit_log`** table, not `platform_audit_log` — confirmed by reading the import (`auditLog` from `@/lib/db/schema`) and by an independent `grep -rln platformAuditLog src`, which returns only `export/route.ts`, `erasure-queries.ts`, `schema.ts`, and their own tests — `organizations/route.ts` is absent from that grep. Only **two** real `platform_audit_log` write sites exist (export, purge), not three. This is a wrong-file citation on one of three supporting facts for a P1 gap. The gap's core conclusion — `platform_audit_log` has no read surface anywhere in the app — is independently confirmed true regardless (nothing selects from it outside its two writers, `schema.ts`, and tests), and Rplatform-2's fix (add a read route) is unaffected. Downgraded from what would otherwise be a blocker because the miscite doesn't change the gap's validity or the required fix — but it should be corrected (drop or recharacterize the `route.ts:154-165` reference) before this spec is treated as fully ground-truthed. |

No findings for **inventory.md** (dedicated agent: all citations for Ginventory-1/2/3 and the Invariants-section tenancy/CAS line list matched exactly, including a full read of `removeJobMaterial`'s body confirming no restock call exists anywhere in it) or **operations.md** (dedicated agent, beyond the already-confirmed Gops-1: zero blockers, zero drift across all six assignment-path citations, AR reconciliation, timezone, null-safety, and the test-coverage-asymmetry claim).

## Per-spec verdict

- **reports.md** — sign-off. Central claim (Greports-1) confirmed exactly; one minor evidentiary overstatement (W-E-1) in Greports-2 that doesn't change the requirement.
- **operations.md** — sign-off. Zero findings beyond the confirmed central claim.
- **staff.md** — sign-off. Central claim (Gstaff-1) confirmed exactly, including live git archaeology and journal-timestamp ordering; one minor citation-precision issue (W-E-2).
- **settings.md** — sign-off. Every P0/P1 claim (Gsettings-1, -1b, -2, -3) matched exactly, including independent checks of routes the spec didn't cite (to hunt for a stricter gate the author might have missed — none found); one minor mechanism-description nuance (W-E-3).
- **integrations.md** — sign-off. Central claims (Gint-1, Gint-2) confirmed true; two minor citation-completeness/drift issues (W-E-4, W-E-5), neither changing the gap conclusions.
- **inventory.md** — sign-off. No findings.
- **audit-log.md** — sign-off. Gaudit-1, -3, -4 confirmed exact; Gaudit-2's core finding confirmed (21 writers produce non-JSON `details`) with a mechanism-labeling error on 3 of 6 examples (W-E-6) and a trivial line offset (W-E-7); the "61/16" site counts are approximate, not exact (W-E-8, informational).
- **fieldpulse-import.md** — sign-off. Both P1 gaps (Gfieldpulse-import-1, -2) confirmed exactly, including an exact 11-phase count against the real `PHASES` array; only cosmetic line drift in three GH Actions workflow citations (W-E-9).
- **platform.md** — sign-off, with one correction needed before final. Central claim (Gplatform-1) confirmed exactly by direct route/schema reads. Gplatform-2's conclusion is independently confirmed true, but one of its three supporting citations names the wrong table (W-E-10, major) and should be fixed.

## Severity counts

- blocker: 0
- major: 1 (W-E-10)
- minor: 9 (W-E-1 through W-E-9)

## Five high-stakes claims — summary answer

1. staff.md last-admin trigger deleted + app-check race-prone: **YES, confirmed.**
2. platform.md self-purge lockout: **YES, confirmed.**
3. integrations.md write-once badge + unread sync-health columns: **YES, confirmed** (minor citation-completeness gap on the second half — one more unwired route exists than the spec counted).
4. reports.md dismissed estimates excluded vs. estimates page "lost" grouping: **YES, confirmed.**
5. operations.md FieldPulse webhook contaminating two KPIs: **YES, confirmed.**
