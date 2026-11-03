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
