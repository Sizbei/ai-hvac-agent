# M3c Sell on site — adversarial review log

## Spec round 1 (v1 → v2), 2026-11-06 — 3 critics (money/data/concurrency, API/security/integration, UX/scope)

Applied:
- Migration renumbered to 0057 (0055/0056 taken) (api B1).
- Legacy office estimate-born invoices have no line link → billed(eid) also counts `invoices.estimate_id = $eid`; no backfill needed (data B1, api M2).
- Bill sequencing: pre-check billed(eid) BEFORE touching/creating an invoice; an unseeded draft only; adopt draft, refuse open (INVOICE_LOCKED); one batch with stillLead + status + NOT billed(eid); totals under LINE_GATE; tail SELECTs and a 0-row re-map (data M1–M3/M5/m1, api M1/M3).
- Sell no longer bills inline; billing is a separate technician step after hand-back with "Add to today's invoice" / "Leave for the office" (api M4, ux M5/M12).
- Office generate guard moved inside the INSERT under L_req; office paths write the line link (data M4, api m11).
- Sell replay only when sold_via='field' AND sold_by=me AND same name+option; else ALREADY_DECIDED (office/public vocabulary) (data M6, api M5/m6).
- Field estimates set total_cents = max option total; option/line ids uuidv7 in build order (api M6/M7, data m2).
- Equipment: list includes NULL-location units; writes need a non-cancelled assignment on a live visit; in-batch re-check; replace predicate adds location + refuses FieldPulse units; office customer view and intake dedupe handle retired units (ux B1, api M8–M10, data m9).
- Field estimates require a customer (erasure scrubs by customer) (api M11).
- sold_via/sold_by surfaced in the office detail ("Signed on site with <tech>"); "(admin)" rejected as a typed name (api M12).
- Customer view: full-screen layer without technician chrome, radiogroup with the portal's pre-select rule, subtotal/tax/total, confirm, ≥ 2-letter name with the portal's consent sentence, Not now, customer-safe errors, Hand back; signature downgrade stated explicitly (ux M1–M4, M11, M12).
- Exits: Customer declined (→ dismissed) (ux M7). Builder: Remove option, values not placeholders, inline save reasons, taxBps from GET, quantity stepper, undo remove, draft cleared on save / discard, add-item adapter (ux M9/M10, m1–m4). Materials-overlap warning (ux M6).
- Status rules per surface (create/sell before completion; bill per the invoicing rule; equipment late record allowed) and per-surface preamble copy and rate bucket (ux M8, api m4).
- approval_token_hash NULL; derived Expired; GET 409 on FieldPulse jobs + read limit; audit gated on created; 201/200; label "Estimate · Nov 6 · 2 options"; billing tri-state; NO ACTION FK; stored-code list corrected; overflow precheck; tests for concurrency, two sold estimates, NULL-location equipment, no-seed; walk made runnable (api m1–m14, data m4–m8, ux M13).

Rejected / deferred:
- Drawn signature on the estimate (ux M3 option): deferred with the downgrade stated; dev has no object storage.
- Carry the estimate's tax onto the invoice (data m3): rejected — the invoice owns its tax; the difference is surfaced ("Tax is recalculated on the invoice.").
- Cut sold_via/sold_by on portal/office paths (ux m12): kept — it is what lets the office distinguish a field sale and retires the "(admin)" sentinel.
- One sold estimate per request (data m8/ux m11): warn only; two sales on one job are legitimate.

## Spec round 2 (v2 → v3), 2026-11-06 — 2 critics (money/data/API, UX/flow/tests)

Applied:
- Customer view leaves via back/reload → `#customer` history entry; back closes to the estimate page only; reload reopens the layer; Not now → hand-back screen (ux B1).
- Unseeded draft stranded materials → the bill drafts through the normal M3b create (seeded); overlap handled by the material-form warning and a post-add hint (ux B2; reverses v2's "unseeded" ruling — M1 of round 1 is now handled at entry, not by skipping materials).
- Billing tri-state defined from billed(eid)'s halves with void excluded and precedence office → job → none; the job half requires `i.estimate_id IS NULL` (data M1, ux M6).
- Equipment location rule shared by GET and every write predicate; request without location → any unit (data M2).
- "Leave for the office" states what it does; office gets a "Sold, not invoiced" filter; no Add when the job's invoice is finalized (ux M1, m10).
- GET carries companyName, customerDisplayName, signedAt, line pricebookItemId, hasApprovalLink, canCreate/createBlockedReason; equipment managedExternally (ux M2, M7, data notes).
- Add-item sheet: Done adds the pending pick (fixes the open M3b P2 too) (ux M3).
- Keyboard: name field + consent in scroll flow, sticky footer only summary+Approve and hidden while typing; real-phone check noted (ux M4).
- Unknown sell result → "Checking…" + refetch; sell replay = same option + field + same tech, name ignored; refetch on layer close / visibility (ux M5).
- Builder naming rule table with edited flags, unique names, Undo on remove option (ux M8).
- Walk: second estimate built and sold; elementFromPoint, history.back and reload assertions; integration (l) materials-before-bill, (m), (n) (ux M9).
- Bill lives in invoice-field-writes.ts (LINE_GATE); full createInvoiceFromJob result mapping; INVOICE_LOCKED stored and neutral copy; ALREADY_BILLED rendered as billed state (takeover downgrade stated); decline replay; NO_LINES; linked lines can't be removed (FROM_ESTIMATE); overflow pre-check includes the draft; office copies ordered with v7 ids; customer re-check inside batches; preamble options carry statuses + copy (data m1–m12, ux m1).
- Copy: portal 2-character rule; "Approved. Thank you."; expander outside the label; approveBlockedHint; Approving… lock; lower-case type label; company name null → omitted (ux m2–m8).

Rejected:
- Restrict Show to customer / decline to field-created estimates (ux m12): rejected; a note shows when an approval link exists.
- Helper "Ask <lead name>" (ux m11): rejected as scope; helpers see sold rows read-only.

## Spec round 3 (v3 → v4 FINAL), 2026-11-06 — 1 combined critic

Applied (4 majors, no blockers): createInvoiceFromJob stale/void/history results map to STALE (not stored), only open or a draft with a payment map to stored INVOICE_LOCKED; a draft with a payment is locked (no STALE loop); the GET carries `jobInvoice { id, state, hasPayment }` and §7.3 branches on it, and billing after a paid earlier invoice deliberately creates a new invoice; the "Sold, not invoiced" filter and Generate agree that a voided office invoice ends office billing. Minors: soldByMe, fromEstimate lines + FROM_ESTIMATE copy, create re-run first in the zero-row map, void → STALE in step 4, managed_externally mapped, pendingWrite narrowed to invoice/signature routes, 22003 caught → 400, preamble copy per status, named intent ids in their own storage key, copy unified, tests (o)–(t), the `#customer` approach stated (pushState/popstate work with Next 16; reload reopens only while sellable; replaceState when there is no earlier entry).

Verdict: converged at the round cap — round 3 found no blocker; its majors were mapping/consistency gaps now closed. v4 is FINAL; the plan and the code get their own reviews.
