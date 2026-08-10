# Round 1 — Missed-risk audit: reports / operations / staff / settings /
integrations / inventory / audit-log / fieldpulse-import / platform

Lens: not "is what the spec says true" but **what did the spec never look
at**. Method: read all nine specs in full, then independently hunted the
underlying code for the six named risk classes (privilege escalation,
cross-tenant leakage, credential exposure, audit integrity, import/data
integrity, serverless correctness) — every admin API route under
`src/app/api/admin/**` and `src/app/api/platform/**` touching these nine
pages, `src/lib/auth/authz.ts`, every `logAudit`/`db.insert(auditLog)` /
`db.insert(platformAuditLog)` call site, the integration connect/disconnect/
status routes, `src/lib/rate-limit.ts`, `export-queries.ts`, and the
FieldPulse import pipeline — independent of what each spec already flagged.

These nine specs are unusually thorough and already caught the sharp,
obvious risks a first pass would look for: the settings-integrations
super_admin gate (Gsettings-2), the platform self-purge lockout
(Gplatform-1), the platform_audit_log read gap (Gplatform-2), the two
free-text audit leaks (Gaudit-1), the deletable-audit-trail hole (Gaudit-3),
the last-admin-trigger migration gap (Gstaff-1), the FieldPulse-vs-HCP KPI
blending asymmetry (Gops-1), and the dismissed-estimate reporting gap
(Greports-1). I did not find a live, exploitable privilege-escalation or
cross-tenant-leak hole that survived independent code reading — every role
gate I traced (`canManageRole`/`canAssignRole`/`isSuperAdmin`/
`isPlatformAdmin`), every `withTenant` join, and every credential-return
shape held up. My value here is three narrower findings the nine specs'
own verification claims didn't quite reach.

## Findings

### W-R-1 — `org_provisioned` never reaches `platform_audit_log`, so platform.md's own proposed cross-tenant audit-trail fix (Rplatform-2) will not show the most routine cross-tenant action it exists to cover

**Severity:** major · **Tag:** verified

`POST /api/platform/organizations` provisions a new tenant and audits the
action with a single call:

```ts
// src/app/api/platform/organizations/route.ts:154-165
await logAudit({
  organizationId: provisioned.organizationId,   // the NEW org, not the platform's own
  userId: session.userId,                        // the platform admin
  action: "org_provisioned",
  entity: "organization",
  entityId: provisioned.organizationId,
  details: JSON.stringify({
    createdBy: session.userId,
    ownerInviteRole: provisioned.ownerInvite.role,
  }),
  ipAddress,
});
```

`logAudit` (`src/lib/admin/audit.ts:22-33`) is a hard-coded
`db.insert(auditLog)` — the **per-org** table, never `platformAuditLog`. A
repo-wide grep confirms `platformAuditLog` is written from exactly two
places: `src/app/api/platform/organizations/[id]/export/route.ts:59`
(`org_data_exported`) and `src/lib/admin/erasure-queries.ts:438`
(`org_purged`). `provisioning.ts` and the organizations `route.ts` POST
handler contain **zero** references to `platformAuditLog` (grepped both
files directly). So `org_provisioned` is recorded only inside the row of
the org that was just created — never in the platform's own cross-tenant
ledger.

The practical effect: the platform admin who ran the provisioning has **no
route in the app that will ever show it to them**. `platformAuditLog` won't
have the row (never written there). The new org's own `/admin/audit-log`
page *does* get the row, but that page is `session.organizationId`-scoped
(`audit-queries.ts:40`) — and `isPlatformAdmin` requires
`session.organizationId === PLATFORM_ORG_ID` (`authz.ts:57`), so the
platform admin's own session can never authenticate into the newly
provisioned org to view it either. The action is technically "audited," but
in a place structurally unreachable by the only actor with authority to
have performed it.

**Which spec should have caught it:** `platform.md`. Gplatform-2's own
evidence line asserts all three cross-tenant actions land in the table its
fix will read from:

> "Every write path exists and is correct (`route.ts:154-165` org_provisioned,
> `export/route.ts:58-65` org_data_exported, `erasure-queries.ts:437-…`
> org_purged), but a repo-wide grep for `platformAuditLog`
> (`grep -rln platformAuditLog src`) finds it referenced only in the three
> write sites, `schema.ts` and their own tests…" (`platform.md:157`)

The spec cites `route.ts:154-165` — the exact `logAudit(...)` block quoted
above — as one of "the three write sites" for `platformAuditLog`, but that
block calls `logAudit`, not `db.insert(platformAuditLog)`; it is a per-org
`audit_log` write. The spec's own grep for `platformAuditLog` (which it ran
and reported) would have shown only two real hits outside schema/tests, not
three — the citation doesn't match the grep it describes running. Because
of this, Rplatform-2's acceptance criterion ("a new `GET` route… returns
recent `platform_audit_log` rows," `platform.md:178-184`) will ship a
viewer that is silently incomplete on day one for the single most routine
platform action (every tenant this platform ever provisions), with no test
in the spec's own verification plan that would catch the omission (the
new route's tests only need "200s with shaped rows for a platform admin" —
they don't assert `org_provisioned` rows are among them, because per this
code path none ever will be).

---

### W-R-2 — The audit-log viewer's actor-name join is not tenant-scoped, so every provisioned org's own `/admin/audit-log` page discloses the real name of a user outside that organization

**Severity:** minor · **Tag:** verified

`getAuditLog`'s row query joins the acting user's name in globally, with no
organization predicate on the join itself:

```ts
// src/lib/admin/audit-queries.ts:58-67
.select({ ... actorName: users.name })
.from(auditLog)
.leftJoin(users, eq(auditLog.userId, users.id))   // no users.organizationId check
.where(whereClause)                                // whereClause scopes auditLog.organizationId only
```

For every ordinary audit row this is harmless — `logAudit`'s `userId` is
always `session.userId`, and a session's `organizationId` always matches
the row it's writing, so `userId` and `organizationId` are same-org by
construction everywhere except one place: `org_provisioned` (see W-R-1),
where `organizationId` is deliberately the **new** org while `userId` is
the **platform admin**, a user who belongs to `PLATFORM_ORG_ID`, a
different org entirely. That row is real, lands in the new org's own
`audit_log` (per W-R-1), and every admin of that new org who opens
`/admin/audit-log` will see an `org_provisioned` entry whose `actorName`
resolves — via this unscoped join — to the platform operator's real
display name, a person who is not, and has never been, a member of their
organization.

This is a narrow, low-impact disclosure (a name, not a secret or
customer PII, and arguably defensible as "who set this account up"), but
`audit-log.md`'s own PII sweep never considered it, because it graded the
join surface differently than the payload surface.

**Which spec should have caught it:** `audit-log.md`. Its "PII/secret audit
of every writer" section is exhaustive about the `details` column —
"every `logAudit` call site and every direct `insert(auditLog)` site was
read in full" (`audit-log.md:85-86`) — and its Invariants section states
the tenancy contract as if it covers the whole row:

> "Tenancy: every audit-log query is scoped by `organizationId` via
> `withTenant` (`audit-queries.ts:40`)." (`audit-log.md:217-218`)

True for the `WHERE` clause on `auditLog` itself, but the spec never
examined the `leftJoin(users, ...)` that produces `actorName` — the one
other table this page's query touches — for the same tenancy boundary, and
so never noticed it's the one place a cross-org identity is deliberately
(if only in this one case) surfaced to a session that owns none of that
identity's organization.

---

### W-R-3 — The rate limiter is a per-serverless-instance in-memory `Map`, so every "rate-limited" claim these specs make about integration-credential and staff-mutation routes is weaker than stated, with only one spec disclosing the limitation

**Severity:** minor · **Tag:** inferred

`slidingWindow` (`src/lib/rate-limit.ts:5,44-52`) keys off a module-level
`const store = new Map<...>()`. On Vercel, each warm serverless instance
has its own module scope — there is no shared store (no Redis/KV
backing). `platform.md` is the only one of the nine specs that discloses
this weakness, and only for one route:

> "A DB-backed org-count cap (`resolveMaxOrgs`, default 100,
> `provisioning.ts:57-64`) is the real ceiling — **the route's in-memory
> rate limiter can't throttle across serverless instances** (comment,
> `provisioning.ts:62`)." (`platform.md:104-106`)

`staff.md`, `settings.md`, `integrations.md`, and `inventory.md` all cite
`slidingWindow`/`RATE_LIMITS.adminMutation` as part of their security
narrative for staff creation, password reset, invite creation, and
FieldPulse/Housecall Pro/Google credential connect — without the same
caveat, and without checking whether a DB-backed backstop exists the way
`platform.md` found one for org provisioning. Concretely: `fieldpulse
/connect` and `housecall/connect` each perform one live outbound call to
the real vendor API per attempt to validate a submitted key
(`fieldpulse/connect/route.ts:69-87`, `housecall/connect/route.ts:67-82`)
before the `slidingWindow` check would meaningfully throttle a burst spread
across concurrently-cold instances — the only backstop is the vendor's own
rate limiting, not this app's. This is a real weakness in the code (the
`Map` fact is verified), but its materiality is speculative: the actor
must already hold an authenticated admin session (not a pre-auth attacker),
and the worst case is extra outbound probe traffic to a vendor API, not a
direct security compromise — hence `inferred`, not `verified`, on
exploitability.

**Which spec should have caught it:** `integrations.md`, whose Current
State section documents the connect-time live probe in detail (module
doc quoted: "connect routes build a client from the *submitted* key and
call `getAccountInfo()` before any DB write," `integrations.md:108-111`)
but never asks how many times an admin session can trigger that outbound
call per minute in production, where `platform.md`'s adjacent analysis of
the identical `slidingWindow` primitive already surfaced the answer for a
sibling route.

## Not flagged (checked, found solid)

Every `canManageRole`/`canAssignRole` call site and the full
`create/update/reset-password/invite/revoke` staff surface (no
privilege-escalation path found: `super_admin` is unreachable via any
assign/invite path, exactly as `authz.ts:100` and staff.md claim); every
`isPlatformAdmin` gate on the three `/api/platform/*` routes (independently
re-derived, all three correctly repeat the two-line gate); the
`exportOrganization` query set (`export-queries.ts:16-35`) — verified it
imports no credential/secret table at all (no `fieldpulseConnections`,
`housecallProConnections`, `googleCalendarConnections`, `widgetKeys`, or
`users` in its import list), so platform.md's "excludes secrets" claim
holds structurally, not just by convention; every integration
status/connect/disconnect route's response shape (no key/token ever
returned, `listStaff`'s `passwordHash` used only to derive a boolean,
`listWidgetKeys` never selects `keyHash`); the `requestStatusEvents`
join underlying operations.md's response-time/first-response KPIs (has its
own `organizationId` column, correctly `withTenant`-scoped, not a
join-only tenancy boundary); `getTechnicianScorecards`'s `users` join
(explicitly org-scoped on both sides of the `innerJoin` condition, unlike
the audit-log join in W-R-2); the inventory/purchase-order write paths'
atomicity (CAS-guarded, `db.batch`, no `db.transaction()` anywhere in
scope); and every `vercel.json` cron in this program's blast radius (all
daily, none violate the Hobby-plan cap; the FieldPulse nightly sweep
correctly runs via GitHub Actions, not a Vercel cron, exactly as
fieldpulse-import.md documents).

## Per-spec verdict

- **reports.md** — sign-off (no missed risk found in this pass)
- **operations.md** — sign-off (no missed risk found in this pass)
- **staff.md** — sign-off (no missed risk found in this pass)
- **settings.md** — sign-off (no missed risk found in this pass)
- **integrations.md** — blocked (W-R-3: the connect-route rate-limit
  narrative doesn't disclose the in-memory/per-instance limitation that a
  sibling spec already found for the identical primitive)
- **inventory.md** — sign-off (no missed risk found in this pass)
- **audit-log.md** — blocked (W-R-2: the actor-name join backing every row
  this page renders was never checked against the same tenancy invariant
  the spec asserts for the row itself)
- **fieldpulse-import.md** — sign-off (no missed risk found in this pass)
- **platform.md** — blocked (W-R-1: Gplatform-2's own evidence miscites
  `org_provisioned` as landing in `platform_audit_log`; it doesn't, and
  Rplatform-2's planned fix will ship with that exact gap)

## Summary

3 findings: 0 blocker, 1 major, 2 minor. W-R-1 and W-R-2 are `verified`
(traced end-to-end through currently-shipped code, no speculation);
W-R-3 is `inferred` (the code fact is verified — the rate limiter is a
bare in-memory `Map` — but real-world exploitability is a judgment call,
flagged honestly as such).

The single most dangerous thing the specs missed: **W-R-1**. It's not an
attacker-exploitable hole — nothing here lets anyone escalate privilege or
read another tenant's data — but it means the accountability fix
`platform.md` is about to build for its own most-consequential action
class (cross-tenant deletes and exports) will ship with a blind spot for
the *other* cross-tenant action in the same table's job description
(provisioning), and the spec's own cited evidence for "every write path
exists and is correct" doesn't actually support that claim for the one
action it names first.
