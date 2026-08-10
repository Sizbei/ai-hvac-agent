# Specs review — round 1 — lens: severity calibration & scope discipline

Reviewer: adversarial critic (severity/scope lens only — not fact-checking).
Scope: `docs/page-program/specs/{conversations,customers,reviews,communications,insights-ai}.md`.
Method: read each spec in full against `docs/page-program/METHOD.md`'s P0/P1/P2
definitions and the repo-wide invariants in `AGENTS.md` /
`.claude/skills/admin-pages/SKILL.md`; spot-verified the underlying code for
every finding below (booking-recovery.ts, triggers.ts, seeds.ts,
customers/[id]/route.ts, customers/[id]/erase/route.ts) rather than trusting
the spec's own framing.

`communications.md` was scrutinized hardest per instructions, being the
heaviest requirement list in the program (3 P0 + 4 P1 = 7).

---

## Findings

### C-S-1 — `communications.md` — Rcommunications-3 silently requires a hand-authored migration
**severity:** blocker **tag:** verified

> `templateId` still exist (FK off `cascade`, e.g. `restrict`/`set null`);

Rcommunications-3's acceptance criterion requires changing
`communication_jobs.template_id`'s FK from `onDelete: "cascade"`
(`schema.ts:1835-1837`) to `restrict`/`set null`. That is unambiguously a
schema/migration change, not a query-layer fix. `AGENTS.md`'s hard invariant
says exactly this kind of change needs a hand-authored `drizzle/00XX.sql`
with `--> statement-breakpoint` separators, a `_journal.json` entry, a
snapshot copy, and `drizzle-kit generate` must then report "No schema
changes." Section 8 (Verification) for this spec lists `tsc`, `eslint`,
`vitest`, a manual API check, a visual check, and `verify-skills.mjs` — the
word "migration" appears nowhere in the spec. An implementer following this
spec verbatim has no signal that a migration file is required at all, which
risks either skipping it (schema drift on next `drizzle-kit generate`) or
improvising it without following the mandatory process.

Contrast with `conversations.md`'s Rconv-4, which explicitly names and
defers the same class of risk: *"If a cheap fix needs a schema change (e.g.
a maintained `lastMessageAt` column instead of a live join), document the
tradeoff and prefer the query-side fix first."* That is the bar this
program can clearly hit; R3 doesn't clear it.

**Fix:** add a migration step to R3's acceptance criterion and section 8,
or explicitly note the FK-constraint decision needs a `drizzle/00XX.sql`
per `AGENTS.md`.

---

### C-S-2 — `communications.md` — Rcommunications-1 severity inconsistent with Rcommunications-4 for the same root cause
**severity:** major **tag:** verified

> Templates CRUD (POST/PATCH) rejects `estimate_sent`, `payment_receipt`, `invoice_overdue`, `warranty_expiring` — 4 of 15 live trigger types are unmanageable from this page | P0 | `templates/route.ts:26-38`, `[id]/route.ts:26-38` vs `schema.ts:1732-1752` |

> Editor `TRIGGER_TYPES` dropdown offers only 10 of 15 trigger types | P1 | `template-editor-dialog.tsx:40-51` |

These are the same underlying gap (incomplete trigger-type coverage across
the template-management surface) sliced across two layers — API validation
vs. UI dropdown — yet rated two different severities with no stated reason
for the split. I checked `src/lib/communication/seeds.ts:203-240`: default
SMS templates for `estimate_sent`, `payment_receipt`, and `invoice_overdue`
are already seeded and active, so these automations are firing correctly in
production today — the CRUD gap doesn't cause *wrong* behavior, it removes
an admin's ability to edit/deactivate copy that already sends. That fits
METHOD.md's P1 definition ("workflow hole") far better than P0 ("broken/
wrong"), and is materially the same category of gap as R4, which the spec
itself rates P1. If R1 is genuinely more severe than R4 (e.g. because it
blocks all editing rather than just visibility of new options in the
dropdown), the spec should say so; as written it reads as the same finding
counted twice at different severities.

**Fix:** rate R1 P1 to match R4 (or state explicitly why the API-layer
manifestation is categorically worse than the UI-layer one).

---

### C-S-3 — `communications.md` — Rcommunications-7 is manufactured work rated above its true severity
**severity:** blocker **tag:** verified

> `booking-recovery.ts` sends bypass templates + the comms queue entirely (hardcoded copy, no retry, invisible to observability) | P1 | `booking-recovery.ts:21-22,102` |

I read `src/lib/communication/booking-recovery.ts` in full.
`recoverAbandonedBookings`/`recoverAbandonedWebSessions` already: claim the
outbound ledger *first* (`claimOutboundOnce`, dedupe-safe against cron
retries), call `checkSendAllowed` (consent-gated), and are best-effort
(`try/catch` around `sendSms`, one failure doesn't abort the batch). Nothing
here is broken, unsafe, or blocking an operator workflow — the module's own
doc comment calls it "Conservative by design." The gap R7 fixes is purely
that the message text isn't editable via the templates UI and isn't counted
in `getCommsOutcomeSummary`. That is a nice-to-have (P2 polish), not a P1
"workflow hole" — the recovery flow works today exactly as designed.

The requirement also has real, unacknowledged blast radius: it asks to
route a currently-safe, self-contained, already-deduped/consent-checked
direct send through the shared `queueCommunicationJob` chokepoint used by
every other trigger in the system. That would require either (a) picking an
existing `triggerType`/template `key` to look up (the spec doesn't say
which — reusing `follow_up`, the only value already used for this flow's
ledger `periodKey`, risks colliding with an org's own follow_up template
semantics), or (b) adding a new trigger type (a schema/migration change,
per C-S-1's finding), and either way means removing or duplicating the
inline `checkSendAllowed`/`claimOutboundOnce` calls this module already
gets right on its own. That's disproportionate surface-area change for an
editability/observability nicety on a flow nothing else in the spec claims
is broken.

**Fix:** downgrade to P2/backlog per METHOD.md's severity gate (only P0/P1
become implementation work this round), or — if kept — specify the
trigger-type/key it routes through and account for the resulting schema and
duplicate-consent-check surface area explicitly.

---

### C-S-4 — `communications.md` vs `reviews.md` — inconsistent severity for structurally identical demo-SMS-bypass gaps
**severity:** minor **tag:** inferred

> `/api/communications/send` has no `isDemoAccount` check — a demo session can trigger a real SMS/email to an arbitrary recipient | P0 | `src/app/api/admin/communications/send/route.ts` (no import) vs `send-reminder/route.ts:3,31` |

> The automated review-request send path has no demo-account guard, unlike the two other manually-triggered outbound routes | P1 | `authz.ts:19-26` + only 2 call sites (`send-reminder/route.ts:31`, `conversations/[id]/message/route.ts:37`); `tech/jobs/[id]/status/route.ts:94-105` calls `createReviewRequest` with no demo check; `consent.ts:120-171` (`checkSendAllowed`, the documented send chokepoint) checks only per-customer prefs; `prod-smoke.sh:26-27` only probes the conversations route |

Both are "the demo org's outbound-SMS block, an established repo-wide
invariant, doesn't cover this send path" gaps, yet one is P0 and the other
P1. There is a real distinguishing fact I can point to — the communications
gap lets a demo session pick an *arbitrary* recipient phone number
(explicit abuse vector), while the reviews gap only fires automatically to
a job's own (demo-org-seeded) customer — so the different severities are
defensible, not clearly wrong. Flagging as minor/inferred rather than
major: worth a one-line note in `reviews.md` acknowledging why R3 sits at
P1 and not P0 given the shared invariant, so a future reader doesn't assume
an oversight.

---

### C-S-5 — `insights-ai.md` — Rinsights-ai-2 is a P2 perf tweak labeled P1
**severity:** major **tag:** verified

> Ginsights-ai-2: `getBotAnalytics` costs 3 HTTP round-trips per page load where its two sibling query modules cost 1 | P1 | `bot-analytics-queries.ts:93` uses `Promise.all` over 3 independent queries; `ai-insights-queries.ts:52` and `ops-insights-queries.ts:46` use `db.batch` for the same shape of problem, each with an explicit comment about cutting round-trips (`ai-insights-queries.ts:40-41`, `ops-insights-queries.ts:36-37`). Repo-wide invariant (AGENTS.md, admin-pages skill) calls out `db.batch` as the neon-http pattern for independent queries.

> data (no behavior change, pure round-trip optimization).

The requirement's own acceptance criterion states there is "no behavior
change" — nothing is broken, no operator workflow is blocked, and this is
an admin-only, low-traffic page (manual refresh, no polling, per this same
spec's Non-goals). This is textbook P2 polish/tech-debt-parity, not a P1
"workflow hole." It's also the one requirement in this round that most
looks like it exists to pad a thin (2-requirement) spec up to something
that reads as "real work," rather than because an operator is blocked by
it. `AGENTS.md`'s `db.batch()`-over-`Promise.all` guidance is a *style/cost*
rule for neon-http, not a correctness invariant like the
`db.transaction()`-throws rule it sits next to — conflating "not following
the preferred idiom" with "workflow hole" overstates it.

**Fix:** rate P2 and leave in the backlog table per METHOD.md's severity
gate, unless there's a load-bearing reason (e.g. a measured latency
regression) not present in the current-state evidence.

---

### C-S-6 — `customers.md` — Rcustomers-1 (hard-delete privilege gap) is an authorization defect, not merely a workflow hole
**severity:** major **tag:** verified

> Hard delete (`DELETE /api/admin/customers/[id]`) requires only a plain admin session, while the softer GDPR erase requires `super_admin` — yet hard delete is *more* destructive to money data (orphans `invoices.customerId`/`estimates.customerId` permanently, no FK, no de-identification) than erase (which keeps those links de-identified). | P1 | `src/app/api/admin/customers/[id]/route.ts:439-475` (no role check) vs. `src/app/api/admin/customers/[id]/erase/route.ts:35-37` (`isSuperAdmin`); `src/lib/db/schema.ts:2750` (no FK on `invoices.customerId`); `src/lib/admin/erasure-queries.ts:218-237` (erase keeps links) |

I read `src/app/api/admin/customers/[id]/route.ts`'s `DELETE` handler
directly: it checks only `getAdminSession()` and a rate limit — zero
role/`isSuperAdmin` check, confirming the spec's evidence exactly. This
isn't a missing feature an operator is blocked on (METHOD.md's P1); it's a
live authorization control gap: any plain-admin session can today trigger
an irreversible action that (per the same spec's own current-state section)
permanently orphans money-table foreign keys with none of `anonymizeCustomer`'s
de-identification care — strictly worse data-integrity outcome than the
action gated one privilege tier higher. Elsewhere in this same review round,
both `communications.md` (R2: missing demo check on a real-SMS send route)
and this same `customers.md` spec's own R2 (demo check on erase) treat
"missing/incorrect authorization gate on a destructive action" as
security-grade findings; a privilege-inversion bug that's provably *more*
destructive than the erase route it should mirror deserves the same
treatment rather than the generic P1 used for e.g. UI-visibility gaps
elsewhere in this program.

Note: since P1 already clears METHOD.md's P0/P1 implementation bar, this
does not change *whether* the fix ships this round — only how it's labeled
and prioritized within the round, and whether stakeholders reading the gap
table understand its real severity.

---

## Summary

- **Blocker:** 2 (C-S-1, C-S-3) — both in `communications.md`.
- **Major:** 4 (C-S-2 in `communications.md`; C-S-5 in `insights-ai.md`;
  C-S-6 in `customers.md`; plus C-S-3/C-S-1 already counted above).
  Corrected tally: **major = 3** (C-S-2, C-S-5, C-S-6).
- **Minor:** 1 (C-S-4, cross-spec `communications.md`/`reviews.md`).

Total findings: 6 (2 blocker, 3 major, 1 minor).

**Worst calibration error:** C-S-3 — `communications.md`'s Rcommunications-7
takes an already-safe, already-ledger-deduped, already-consent-checked,
best-effort send path (`booking-recovery.ts`) and proposes rewriting it to
route through the shared `queueCommunicationJob` chokepoint purely for
copy-editability and observability — a P2-grade nicety rated P1 and given
enough unacknowledged blast radius (undetermined trigger-type/key, possible
new enum value, duplicate consent-check surface) that building it this
round is the single clearest instance of manufactured work in the five
specs reviewed.

## Per-spec verdicts

- `conversations.md` — **sign-off** (no findings against this spec; P0/P1
  severities and scope hold up under this lens).
- `customers.md` — **blocked** (C-S-6).
- `reviews.md` — **sign-off** (only a minor, non-gating note: C-S-4).
- `communications.md` — **blocked** (C-S-1, C-S-2, C-S-3).
- `insights-ai.md` — **blocked** (C-S-5).
