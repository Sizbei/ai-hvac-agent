# Setup guide spec — adversarial review log

## Round 1 — 2026-11-04 (v1 → v2)

Three blind critics (feasibility vs code; UX/product/copy; data/concurrency/security).
6 blockers, 21 majors, 27 minors, heavily overlapping.

Established and applied:
- Company name lives on the Branding tab, phone/hours on Business → steps split into
  `company_name` (branding) and `phone_hours` (business, both fields).
- `job_types` is seeded at provisioning → step dropped. `first_customer` folded into
  `first_request` (the dialog creates the customer inline). `brand` = logo only (the
  color has a default).
- `add_technician` requires an active technician WITH a password (invites, admin
  invites, revoked invites and FieldPulse-imported password-less technicians never
  count; a note explains the FieldPulse case). Solo-owner guidance in the why line.
- `tech_sign_in` becomes REQUIRED (it is the proof of the goal); the signal is written
  in `createTechSession` (covers password and Google sign-in) via `after()`; no manual
  tick anywhere. `pricebook` becomes optional ("Optional, but recommended").
- `first_schedule` requires a non-cancelled appointment with a time or date AND an
  assignment (or `assigned_to`): a schedule that reaches a phone.
- Progress, bar and sidebar count all use the 6 required steps; optional steps have
  their own "Go further" line.
- Two live steps (`add_technician`, `first_schedule`) can re-open as "Needs attention";
  the rest stay done via stamps.
- Grandfathering on the first GET: all required already done → `completedSeenAt`
  (no finishing moment on launch day); org > 14 days with a completed request and
  steps still open → `dismissedAt`. Demo sessions never write.
- Exact NULL-safe merge SQL for stamps (INSERT … ON CONFLICT, existing stamps win,
  `?&` guard) and for flags (nested merge); JS read-modify-write removed; data
  migration 0051 rewrites legacy keys; `seed-org.mjs` updated.
- `useOpenFromParam` reads in a `useState` initializer and is declared before
  `useUrlFilterSync`; whitelist of param values; `new` and `from` stripped.
- A shared client store (module cache, in-flight dedupe, subscribers, refresh on
  mount / route change / visibility / PATCH, no polling, keep-last-good on error)
  replaces the claimed "SWR cache with focus revalidation".
- Sidebar count follows DIRECTION (bare muted mono digit); hidden after dismiss; the
  Setup item moves to the end of Integrations once finished/dismissed.
- No row stagger (DIRECTION forbids it); only the flipped row transitions.
- Copy canon: "request" everywhere; why lines corrected; "color".
- The 7-day rule dropped (finished state shows until ×). Per-org state stated.
- PATCH strict zod literals via `readJsonBody`; audit keys only; derived stamps not
  audited (stated); `techAppDone` removed.
- Primitives: `SectionCard.meta`, new `StepGlyph`, badge map in the sidebar.
- Acceptance rewritten (provisioned fresh org, concurrency in the integration suite,
  tenancy with a seeded other org, upgrade cases, deep-link stripping).

Rejected:
- "Make the home card poll with the dashboard's 30 s overview" — the sidebar must work
  on every page; the store refreshes on route change instead.
- "Partial index on pricebook_items(active)" — not needed; single probe is fine.
- "ProgressBar should animate scaleX" — keep the shared primitive unchanged in this
  change (presentation-only guardrail); noted for the design backlog.

## Round 2 — 2026-11-04 (v2 → v3)

Three fresh critics. 0 blockers, 20 majors, 29 minors; strongly converging.

Established and applied:
- The signup business name only lands in `organizations.name` (live bug: messages fall
  back to a default) → provisioning seeds `company_name`, 0051 backfills, the step is
  dropped. `first_request` + `first_schedule` merged into `book_first_request` (the dialog
  opens with the schedule panel expanded under `from=setup`). `tech_sign_in` moves last,
  "varies", primary action "Copy sign-in link" (absolute `/tech-login`, email prefilled),
  instruction about password vs Google for a second-email owner; secondary "Invite by link".
  Required = 4 (`phone_hours`, `add_technician`, `book_first_request`, `tech_sign_in`).
- `add_technician` counts `password_hash OR google_id` or the sign-in flag; the FieldPulse
  note only without Google OIDC. `book_first_request` requires a non-cancelled assignment
  by an active technician (or `assigned_to` an active technician).
- `tech_sign_in` has historical evidence (time entries, location rows, technicians with
  `google_id`) so grandfathering can reach `completedSeenAt`.
- Needs-attention: verbatim definitions; the digit shows needs-attention steps after
  `completedSeenAt`, never after `dismissedAt`; home card never returns.
- Nav pre-load position fixed (end of Integrations; promoted to Operations second after
  Dashboard once loaded; `localStorage` cache); `navGroupsFor(state)` shared by sidebar,
  shell and ⌘K.
- GET = two round trips (SELECT; stamp statement iff `$keys` non-empty); response built
  from the SELECT copy, never `RETURNING`. Both statements are INSERT … ON CONFLICT upserts
  that carry `$top`, old-wins (`$top` and old on the left of `||` where they must win),
  `jsonb_typeof` guards, `sql.param` arrays, text params for jsonb.
- Per-field `.catch(undefined)` parsing; lenient date parsing; 0051 writes ISO via
  `to_char`, is ADDITIVE (legacy keys kept one release), idempotent guard.
- `useOpenFromParam` reads the URL in an effect declared before `useUrlFilterSync` (no
  hydration mismatch); dialog pages call `store.refresh()` on create success when
  `from=setup`; whitelist incl. `new=invite`; banner on Staff/Pricebook/Requests/Settings.
- Integration test named and allow-listed; manual run; statements tested via the module.
- Demo: skip grandfathering; in-memory × for the session.
- Copy: "Add your business phone and hours", "Add the chat widget to your website", why
  lines drop "Optional…" (badge only), banner "Setup guide: <title> · Back to guide".
- `embedCopied` set by the revealed-key copy only.

Rejected:
- "Read dismissed/completedSeenAt server-side in the layout for first paint" — the
  localStorage cache + default position avoids the jump without a server fetch on every
  admin page.
- "Exclude appointment_assignments stamps from historical evidence" — accepted in effect:
  evidence uses tech-only tables (time entries, locations) and `google_id`.
