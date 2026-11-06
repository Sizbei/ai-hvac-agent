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
