# Technician getting-started guide — adversarial review log

Artifact: `docs/superpowers/specs/2026-11-05-tech-getting-started.md`.

## Round 1 (v1 → v2), 2026-11-05 — 3 critics (data/SQL, mobile UX + copy, scope/API/security)

Applied:
- `Working` is not a button: `TECH_STATUS_LABELS` lacks `in_progress`, so the tap reads "In
  progress" while two sheet strings and the page-tech skill say Working → the spec adds the
  label (one-line test change) rather than rewording the guide (UX B1).
- Invoice how lines named buttons that do not exist (`Approve`, `Text pay link`) and skipped
  `Open invoice` / `Create invoice` → rewritten against the real labels (UX M1).
- "job, never request" contradicted the copy canon and the close-out sheet → dropped; the
  guide follows the sheet it points at (UX M2).
- Clock in and Share my location happen on the card's own screen and nothing refreshed it →
  explicit `tech:guide:refresh` window event from both success paths; `visibilitychange`
  dropped as redundant (UX M3, scope M2).
- Progress counted nine steps while "finished" meant two → office model: progress = the two
  required steps ("Run a job"), the seven optional steps under "Go further · N of 7"; no
  `Optional` chips, `Lead only` chips on the three lead-only steps (UX M4, M5).
- Skeleton flash and layout jump for technicians who hid the guide → the jobs page reads
  `hiddenAt` server-side and the card never mounts (UX M6).
- A failed refetch made the card vanish → keep the last good payload (UX M7).
- The card's CTA linked to the page it was on → no button for steps done on that screen;
  `Open the job` only for on-job steps when the Today list has a row (UX M8).
- Unlabelled icon beside Sign out → `Guide` text link with a gap; a one-line hint after ×
  and focus moved to the segmented control (UX M10, mi9).
- `jobHref` / `invoiceHref` subqueries were ill-defined (two scalar subqueries with ties),
  picked stale office-completed and FieldPulse-managed rows, and the invoice link's "can act"
  claim was false against the active-lead gate → both cut from the payload; the card uses the
  Today rows it already has and page rows link to the list (data M1–M3, scope m1).
- PATCH with a guarded UPDATE could match zero rows and still audit → ungated old-wins
  statement with RETURNING, 404 on zero rows, no audit (data M4, scope m3).
- Integration step (b) had an `UPDATE … SET en_route_at = NULL` without WHERE → every suite
  UPDATE carries id + org (data M5).
- Snapshot must carry the new column with a new id/prevId chain (data m1).
- `finish_job` credited a hold on a row that only reached On my way → rule requires
  `started_at IS NOT NULL` too; the Working-then-held case is stated as lenient (data m2,
  scope m12).
- Lead/assignment EXISTS clauses ignored cancelled visits and rows → `LEAD_ON_LIVE` /
  `ASSIGNED_ON_LIVE` predicates (data m5).
- Erasure wording ("a deleted technician cascades") was wrong → technicians are deactivated
  (data m6, scope m9).
- Tenancy test was circular → literal param counts (data m7).
- The §9 walk tapped `Done` after `On my way` (refused without `started_at`), and a solo lead
  gets `Close out`, whose completion queues a review text through real Twilio → two
  technicians, the minted one not the lead, a customer without a phone, queue guard before and
  a zero-jobs assertion after (scope B1).
- `DEMO_ORG_ID` equals `PLATFORM_ORG_ID` in production, so a demo rule keyed on the org id
  would strip the real business's technicians of their progress → no demo rule; the state is
  per user and harmless (scope M1). Grandfathering + `firstSeenAt`, the audit, `estimateLabel`
  and the second flag cut (scope m2–m5); `dismissed`/`completedSeen` collapsed to `hiddenAt`.
- Rate-limit keys and presets spelled out; the same-origin guard denies an absent Origin, so
  probes send one and the route test covers it (scope m7, m8).
- Pure seams named for the no-DOM test rule (scope m14); `aria-valuetext`, 180 ms glyph
  fade, `Back` link copy, no period in the finished title, how line suppressed on the up-next
  row (UX mi1–mi11).

Rejected (with reason):
- Put the card below the job list (UX M9): a new technician's Today list is usually empty and
  the card is the only content; it is compact by design and leaves after the first finished job.
- Two `h1`s on the page (UX mi8): the invoice page already does this; accepted pattern.
- Replace the header link with a bottom-of-list link (scope m6): one tap from every page is
  the point of the link; it carries a text label now.
- Drop the same-origin guard as redundant with SameSite=lax (scope m7): kept, belt and braces,
  cost is one test case.
- Add indexes on `request_notes.author_id` etc. (data m8): EXISTS over one org's rows for one
  technician is fine at current sizes; stated in §5.

Established facts (do not re-litigate): every column, enum value and `role='technician'`
named in §3 exists; the `?&`-guarded single UPDATE is concurrency safe and handles a NULL
column; no cross-org or cross-technician leak was found; the GET payload exposes only the
technician's own derived booleans and copy; the cleanup cron prunes nothing the rules read.

## Round 2 (v2 → v3), 2026-11-05 — 2 critics (data/API/security, mobile UX + copy + walk)

Applied:
- The finished card never left without × → it leaves on its own 24 hours after the
  `finish_job` stamp (`cardState` rule; no new state) (UX M1).
- The no-job note promised "under Today" and a tomorrow job was a dead end → "in your jobs"
  copy plus a card-only "Your next job is under Upcoming." when the Today fetch is empty (UX M2).
- `todayJobHref` was ill-defined across tab switches and popped in after the card → the list
  keeps `todayFirst` from the first successful Today fetch only (preferring an in-progress /
  arrived / en-route row), and the card renders only once both fetches settled (UX M3, m9).
- The three-line skeleton shifted the list → the skeleton has the card's layout and `min-h`
  (UX M4).
- The mint script picks an arbitrary active technician → the lead is inserted inactive and
  the walk asserts the token's `userId` (UX M5, data M1).
- `bg-surface-raised` track is white on the card → `bg-surface-sunken` (UX M6).
- Clock-in refresh event and the `onJob` field were dead (the card only ever shows the two
  required steps) → removed; only the location toggle dispatches (UX m1, m2).
- How-line fixes: `share_location` "at the top of the screen", `clock_in` "not the one on a
  job", `start_job` split into two sentences, `Save signature`, the real invoice sequence with
  `Approve and finalize`, the auto-opening payment sheet (UX m3–m8).
- Focus target named (`[role=radio][aria-checked=true]` via a wrapper ref), hint `role="status"`
  and reworded, error `role="alert"`, `See all steps` kept on the finished card, `aria-current`
  on the header link via a small client component, name truncation, ring
  `border-border-strong`, `Loading…` on Try again, a 375×667 shot (UX m10–m16).
- Tenancy case (e) was unseedable (global email unique index) → a second throwaway org
  (data M2).
- The server-side `readGuideHidden` could 500 the jobs list → catch, log ids, return false;
  null session renders nothing; the client also hides on the payload's `hiddenAt` (data M3, m2).
- Seeding collides with the 0050 sync trigger → insert the request with `assigned_to` and
  today's date and let the trigger make visit #1 + the lead row (data m1).
- Office uploads matched `note_or_photo` → excluded by the `_admin_` storage-key segment
  (data m3).
- Stamp statement lacked the `jsonb_typeof` guard on `firstCompleted` → both CASEs (data m4).
- Journal entry needs `version` and a fresh `when`; migrate dev first (data m5); PATCH gate
  order matches the signature route (session → origin) and the 401 test sends an Origin
  (data m6); `collect_payment` counts `status = 'succeeded'` payments only (data m7).
- Walk: scheduled today, `Go to my jobs` → row, `Done` inside the dialog, the location toggle
  on `/tech/guide` as the live-refresh proof, geolocation granted (UX walk notes).

Rejected: none.

Established (round 2): the `finish_job` rule matches every writer of `completed_at`; a
non-lead `Done` sends no text, pushes nothing to FieldPulse and emits no status event;
`createOrgCore` only writes to the database; the `Working` label change touches no other
"In progress" display; a second session read per request is cached for 30 s.

## Round 3 (v3 → v4 FINAL), 2026-11-05 — 1 combined critic

Applied:
- The 24-hour auto-leave reintroduced the skeleton flash: the server read only looked at
  `hiddenAt` → `cardHiddenFor(state, now)` (hidden OR finish stamp older than 24 h) shared by
  `readGuideHidden` and the GET (`cardHidden` in the payload, server clock) (M1).
- `todaySettled` also on an aborted Today fetch; the walk's "reload → 2 of 7" is read on the
  guide page; the header needs a wrapper for the two right-hand controls and `min-w-0` on the
  title block; integration (a) runs before the request is seeded, (e) asserts every boolean
  column, (g) backdates a finish stamp; `has_open_job` excludes completed/cancelled requests;
  a finish stamp that never lands keeps the card (accepted, logged) (minors).

Verdict: converged — round 3 surfaced one major that was a consequence of a round-2 edit and
only minors otherwise. v4 is FINAL.
