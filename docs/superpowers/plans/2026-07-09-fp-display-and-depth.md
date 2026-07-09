# FieldPulse Data — Display Everything Properly + API Depth (10 phases)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans, ONE PHASE AT A TIME.

**Goal:** Every imported FieldPulse record displays properly across the admin console — findable, correctly labeled, read-only where FP owns it, and never distorting native metrics — plus pull the additional per-record depth the API exposes.

**Evidence base (2026-07-09):** a 10-surface UI audit (4 CRITICAL findings) + a live API-depth probe. Walk completeness CONFIRMED (binary-searched last pages: invoices 2,849, payments 2,364, estimates 36 — the totals are real, not truncation). Depth NOT yet imported: estimate `line_items` (4/probe) + `custom_status` names ("Sent"); job per-id extras (`status_log` per-stage second-counts, `total_price`, `schedule_details`, `map` coords, `customfields`); customer `customfields` (2/probe). Job `status_log` keys reveal the canonical FP pipeline — `pending → on_the_way → in_progress → completed` — giving evidence-based int mappings: **1=pending, 2=on_the_way, 3=in_progress, 4=completed (proven), 6=custom/unknown**.

## Global Constraints
- **Synced = read-only everywhere**: any mutation path reachable on an FP-synced record is a data-corruption bug (the invoice surfaces got this right — mirror their gates/banner pattern).
- **Native metrics stay native**: money/ops aggregates either exclude synced records or display them as a separately-labeled series — never silently blended.
- Established conventions: client-side search + paginated display (invoices-v2 pattern) at these volumes; theme tokens; single-text-node chips; Base UI `render` prop; pure display helpers with node tests; `next build` in every gate; conventional commits, no Co-Authored-By; migrations via drizzle-kit then `npm run db:migrate` (deploys DO run migrate now, but verify).

---

## Phase 1 — CRITICAL: stop estimate corruption + badge the estimates surface
Audit #1/#2/#9. `estimates/[id]/page.tsx:327-358` "Mark as Sold" and `:286-308` "Generate Invoice" have NO synced gate — clicking them on an FP estimate mutates FP-owned records / double-bills. Fix: `listEstimates`/detail queries select `fieldpulseEstimateId` → derive syncedSource; gate BOTH actions (server-side in their actions/routes too, not just UI — defense in depth like `voidInvoice`); FieldPulse pill on rows + the read-only banner (copy the invoice-detail pattern). Tests: server-action gates refuse synced estimates.

## Phase 2 — CRITICAL: accounting + operations metric integrity
Audit #4/#5/#10. `accounting-export.ts:97-114` blends 2,363 FP payments + 2,849 FP invoices into Cash Received / Sales Revenue (double-counting money FieldPulse already books). Decision: **export defaults to native-only, with synced rows in a separate clearly-headed section** (accountants get both, never blended). Operations: AR aging (`operations-metrics-queries.ts:231-244`) splits into native + synced series (or excludes synced with a caption — match the `timeToPaidSeconds` precedent which already excludes + captions); `jobsBooked` + dashboard Pending count get source-aware labeling (Phase 4 handles the queue itself). Tests on every changed aggregate's where-clause.

## Phase 3 — CRITICAL: CRM at 2,226 customers
Audit #3. `CUSTOMER_LIST_LIMIT = 500` hides 1,726 customers from list AND search. Adopt the invoices-v2 model: remove the cap (load slim rows, decrypt names server-side once), paginate the DISPLAY at 50/page, keep instant client search, add an "Archived" toggle (surfaces the 6 placeholders when wanted). Verify the one-shot 2.2k decrypt request stays acceptable (<2s; if not, split name-decryption to a follow-up). Pure helpers + tests; perf memoization per invoices-v2.

## Phase 4 — Requests queue: names, badges, honest stats
Audit #7/#10. Every FP job shows customer "Unknown" (`request-table.tsx`) because import left session contact PII null — resolve display names via the linked `customers` row (join in `getRequests`, decrypt like `listInvoices` does) rather than duplicating PII onto requests. Select `fieldpulseJobId` → violet FieldPulse pill on rows (match invoices). Stat cards: pending-count splits "X native (+Y imported)" or excludes FP-historical with a caption — pick with the user eyeballing it. Detail sheet: synthetic-session banner ("Imported from FieldPulse — no conversation transcript").

## Phase 5 — Status map + job operational depth (status_log, total_price)
Apply the evidence-based map in `FP_JOB_STATUS_MAP`: `"1"→pending, "2"→<native for en-route>, "3"→in_progress` (verify native enum values; 2 maps to the closest native state — likely `assigned`), keep 6 → pending+tally until the user names it. Re-run jobs import to promote statuses. NEW per-id enrichment pass (jobs importer opt-in `--deep` or a dedicated phase): `GET /jobs/{id}` for imported jobs → store `status_log` seconds (real travel/work durations!), `total_price`, `map` coords into a new `fp_job_metrics` jsonb-carrying table OR nullable columns on service_requests (decide small: one `fieldpulseMetrics` jsonb column, migration). These durations feed ops metrics later (actual on-the-way/in-progress time per job — better than event-derived for imported history).

## Phase 6 — Estimate line items + status names
Estimates currently import header-only. List rows carry `line_items` — map into native `estimate_line_items` (idempotent replace-on-resync like the invoice mirror). Per-id `custom_status` ("Sent") → display the FP status name on the estimates surface (store on the estimate row or derive; small migration if needed). Money stays cents; synced gates from Phase 1 hold.

## Phase 7 — Calendar completeness (display side)
Audit #2-surface. The dispatch board/calendar only shows OPEN scheduled jobs — most FP history (completed June jobs) is invisible by design. Add a **"Show completed" toggle** (calendar layer renders completed jobs muted/ghosted) so the imported history is visible in place; surface the 1 unscheduled FP job in the unscheduled-jobs panel; FieldPulse pill on event cards + detail popover. No scheduling-logic changes — display only.

## Phase 8 — Customer custom fields + profile provenance
Import customer `customfields` (probe: 2/customer — first inspect what they hold on ~20 samples; map generically into a `customFields` jsonb on customers or customer_notes as labeled entries — decide from real content) + `lead_source` → the CRM lead-source field if present. Profile cards: FP-origin badges on equipment/notes; equipment edit dialog gets a "synced from FieldPulse" notice (edit allowed — FP assets aren't money — but attributed). Staff page (audit #8): "FieldPulse" badge + "no local login" indicator on passwordless synced techs; deactivate the 3 demo technicians (user approved cleanup pending — confirm at execution).

## Phase 9 — Global search (command palette)
Audit #6: no cross-entity search exists at 10k records. Build `⌘K` command palette: searches customers (name/phone/email), invoices (ref), requests/jobs (ref/title), estimates — server endpoint per entity reusing existing list queries' decrypted outputs with a shared slim-index cache, OR client-side over prefetched slim indexes (decide by payload math: ~10k slim rows ≈ fine client-side, matches repo precedent). Keyboard-first, links straight to detail pages. This is the single biggest findability win.

## Phase 10 — Verification sweep + docs + review
End-to-end walkthrough of every surface with prod data (screenshot evidence in docs/images/): queue, calendar+toggle, CRM page/profile, invoices, estimates, accounting export, operations, staff, search. Whole-program Opus review (money-display integrity as the lens). Update docs/INTEGRATIONS.md + a new docs/FIELDPULSE-DATA.md (what's imported, where it displays, what's read-only, metric semantics). Memory update.

## Deferred (explicit)
- Timesheets/teams/tags/subtasks import (thin value — unchanged).
- FP job `map` coords → dispatch travel scoring integration (separate program; Phase 5 just stores them).
- Native/synced revenue BLENDED reporting view (product decision — only if the user asks).

## Open with the user
1. Status 6's name (only remaining unknown — everything else evidence-mapped).
2. Phase 2 export default (native-only + separate synced section) — confirm.
3. Phase 8 demo-tech deactivation — final OK.

---

## PROGRAM CLOSE-OUT (2026-07-09)

- Phases 1–9: merged + deployed individually, each live-verified against prod.
- Phase 10: delta-audit = ALL 10 original findings FIXED (file:line evidence);
  whole-program Opus review = SOUND WITH FOLLOW-UPS (0 Critical). Follow-ups
  (HCP-synced metric asymmetry, nightly on_hold stomp, stale option totals,
  approveEstimate gate) fixed in `feat/fp-display-p10-fixes`.
- Docs: `docs/FIELDPULSE-DATA.md` (entity/display/read-only map).

### Committed follow-up (next session): seam-guard tests
Root cause of all three probe-vs-mapper misses (status_log whitelist,
custom_status object, nameless custom fields): FP's LIST and DETAIL endpoint
shapes differ, and mappers were written against one but fed the other. Guards to
add: (a) per-entity sanitized fixtures for BOTH list and per-id payloads,
asserted against the mapper each endpoint actually feeds
(extend `client-real-shapes.test.ts`); (b) "no silent drop" assertions — a
valued-but-unnamed / object-wrapped field must survive mapping, never null out.
