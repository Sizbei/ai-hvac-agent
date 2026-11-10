# First-run onboarding: welcome, checklist and tutorial (design v3)

Date: 2026-11-10 · Status: v3 FINAL, after adversarial rounds 1–3 (round 3 majors folded in; converged). Lenses were feasibility, UX and security; findings are in `.superpowers/sdd/2026-11-10-spears-go-live/onboarding/critic-*.md`.

This spec extends `2026-11-10-spears-go-live-design.md` ("go-live"). The tasks cited by number belong to the plan, `docs/superpowers/plans/2026-11-10-spears-go-live.md`. Inputs: `onboarding/inventory.md`, `research.md` and `assumptions.md`.

**Tier: Must** (the user asked for it explicitly). It builds after plan Task 15 and before Task 18, the P8 walk.

## Why
The user wants Chick to have **setup, a checklist and a tutorial**, and wants **setup to be easy before he uses the system**. Today:
- The admin has an 8-step auto-completing setup checklist, but **no welcome and no tutorial**.
- Most empty states don't point to a next action.
- After go-live hides the history, most of Spears' checklist is already done: there are real technicians, an imported pricebook and a FieldPulse connection. So the tutorial must carry the "learn the system" half.

What the research (`research.md`) shows:
- Products split account setup from learning the workflow.
- A tour the user starts finishes about 69% of the time; one that starts itself, about 23%.
- Short tours finish; tours of 9 steps or more mostly don't.
- Blocking wizards and fake sample data are anti-patterns.

Chick comes from FieldPulse. He needs to know where things live here, and he needs to be told honestly that his old records are hidden, not lost.

## Goals
1. **Welcome:** a welcome row inside the dashboard's Setup guide card. It is shown once per admin user and offers the tour.
2. **Quick tour:** five short lessons. Each has a "Show me" link that opens the real page, where a strip leads back to the same lesson. The tour resumes where he left off, can be replayed from anywhere, and tracks progress per user.
3. **Checklist:** the existing setup guide, kept honest. Task 13 makes its signals count visible rows only, and the runbook resets it.
4. **Easy setup:** every open step stays one click from its dialog (existing behaviour), and each day-one empty state has one primary action. Task 18 records which steps are actually open for Spears on the DEV mirror, and the handover lists them as "before you start".
5. **Faithful preview:** View as Chick shows the welcome, tour and checklist exactly as Chick sees them, and writes nothing.

## Non-goals and anti-goals
- **No gate** on any page, API, webhook, `/tech/*` or invite flow. Spears is live.
- No coach-mark overlay, no video, no auto-started tour, and no sample rows.
- No second technician first-run: `/tech/guide` exists. No change to the admin `STEP_DEFS` copy in `onboarding-steps.ts`.
- No change to where password sign-in lands.
- The UI never says "demo". Guide code never branches on demo mode.

## Design

### D1. Per-user state and API
- **Migration 0060:**
  - `ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_guide_state jsonb;` — nullable, no default, metadata-only, with a brief lock.
  - `schema.ts` declares the column. The 0060 snapshot is the final 0059 snapshot plus that column, with a journal entry, and `drizzle-kit generate` must report "No schema changes".
  - The migrator runs each statement as its own HTTP request and records history only at the end. So a failed deploy re-runs 0059, which is re-run-safe (`7089d1c`), and 0060 must be too (`IF NOT EXISTS`).
- **State:** a tolerant zod parser that drops unknown keys, never throws, and treats a non-object as `{}`. Shape: `{ welcomeDismissedAt?, tourStartedAt?, tourCompletedAt?: iso; lastLesson?: LessonId }`.
- **Read:** `GET /api/admin/onboarding` adds `guide`, computed on the server by a **separate** SELECT. It is not a change to `onboardingSelectSql`, which Task 13 owns.
  - If that SELECT fails, the route logs a code and returns `guide: null`. The checklist is never failed by it.
  - The viewer user is the session user, or the preview target from the go-live P7 viewer resolver. It never comes from client input.
  - The query is scoped by `id = <viewer user> AND organization_id = session.organizationId`. Payload:
    ```
    guide: { welcomeDue, lastLesson, tourStartedAt, tourCompletedAt, readOnly,
             payLinks, hasFieldPulse, historyHidden, historyContact }
    ```
  - Field rules:
    - `readOnly` = previewing.
    - `historyHidden` = `!viewer.showHidden`, which already folds in preview (plan Task 10).
    - `hasFieldPulse` = a FieldPulse connection exists for the org.
    - `payLinks` = `getFeatures(org).payLinks`, or `false` when `getFeatures` throws.
    - `historyContact` = the display name of the first active user in the org whose email is in `PLATFORM_ADMIN_EMAILS`, or "your account administrator" if there is none. Name only, never the email.
  - A stale preview (no target) gives `{ welcomeDue:false, readOnly:true, … }`.
  - The read never writes.
- **Write:** `PATCH /api/admin/guide`.
  - Body: a strict object with at least one of `dismissWelcome?: true`, `lesson?: LessonId`, `tourCompleted?: true`.
  - One UPDATE on `id = session.userId AND organization_id = session.organizationId AND role IN ('admin','super_admin') AND is_active`.
  - Merge: `(CASE WHEN jsonb_typeof(s)='object' THEN s ELSE '{}' END) || <lastLesson>`, with the write-once keys (`welcomeDismissedAt`, `tourStartedAt`, `tourCompletedAt`) merged so that existing values win. `lesson` also sets `tourStartedAt` if it is absent.
  - Response: `204`. It always returns 204, even when no row matched, so it reveals nothing.
  - Same-origin check.
  - Rate limit: `slidingWindow` with key `admin:guide-patch:${userId}`, using `adminMutation`.
  - The handler refuses with 403 `PREVIEW_READ_ONLY` while previewing, in addition to the proxy check. There is no audit row; the precedent is the tech guide.
- **`welcomeDue`** = admin-tier, no `welcomeDismissedAt`, no `tourCompletedAt`, and not a stale preview.

### D2. Welcome row in the Setup guide card (`/admin`)
- A new pure `cardView({ data, error, slow, placement, demoFlags })` (`guide` is part of `data`) replaces the decisions currently spread across `cardLoadingView` and `cardHidden`. It returns `'nothing' | 'skeleton' | 'welcome-only' | 'full' | 'finished'`, plus `welcome: boolean`. The `setup-card-view` tests it affects are updated.

| welcomeDue | checklist placement / state | view |
|---|---|---|
| no | as today | as today (unchanged) |
| yes | `operations`, active | `full` + welcome row on top |
| yes | `operations`, finished | `finished` + welcome row on top |
| yes | `integrations` (org dismissed or completed) | `welcome-only`, card title "Getting started" |
| unknown (`guide` loading) | — | as today; the welcome row appears when it arrives and is reserved by the existing skeleton when placement is `operations` |

- **Welcome row:**
  - Title: `Welcome to {orgName}`.
  - Body by case:
    - `historyHidden && hasFieldPulse`: "Your upcoming work, customers and team carried over from FieldPulse. Older records are hidden for a clean start; ask {historyContact} if you need them back. Here's a quick tour of where things live."
    - `hasFieldPulse` only: "Your FieldPulse jobs, customers and team, in one place. Here's a quick tour of where things live."
    - Otherwise: "Your jobs, customers and team, in one place. Here's a quick tour of where things live."
  - Primary button:
    - "Take the tour", linking to `/admin/setup?lesson=requests#learn`.
    - Once `tourStartedAt` is set, it reads "Continue the tour" with the meta line "Stop {n} of 5", linking to `?lesson=<lastLesson>`.
  - "Not now":
    - Hides the row optimistically.
    - Sends a PATCH with `dismissWelcome`, then forces an onboarding refresh. A failed PATCH leaves the row hidden until the next load.
    - Moves focus to the next focusable element in the card, or to the dashboard `h1`.
- **While the welcome shows:**
  - The card's header X is hidden. "Not now" is the only dismiss, so the org-wide dismissal can't be triggered by accident.
  - The "Up next" button renders `variant="outline"`, so the card has one primary button.
- **Replay from anywhere:** a "Quick tour" link in **both** sidebar footers (the mobile drawer, and the desktop rail as an icon with `aria-label` and a tooltip when collapsed), linking to `/admin/setup#learn` so the default stop rule resumes at `lastLesson`. It is always present for admin-tier users.

### D3. Quick tour on `/admin/setup`
- **Section:** `id="learn"`. It mounts once, in one stable place that every branch of `SetupPageClient` renders: loading, error and data. It never remounts when the checklist data arrives.
  - It shows its own small skeleton until the first onboarding response.
  - If `guide` is `null`, **or the onboarding GET failed with no data**, the tour still renders with conservative copy (no FieldPulse or pay-link claims, history-hidden note on), at the stop the URL names, and makes no writes.
- **Position:** decided once at mount from the URL, then held. Changing stops never moves the section.
- **Display state:** the stepper holds its own `stop` and `completed` state, seeded once from `guide`. Display reads that local state, not `guide`.
- **Which stop shows, and where:**
  - `?lesson` present: that stop, rendered above the hero. After mount, the section scrolls into view and focus goes to the section heading.
  - No `?lesson` and the tour started but not completed: `lastLesson`, below the hero.
  - Not started: stop 1, below the hero.
  - Completed: collapsed to "You've seen the basics · Replay tour". This beats `?lesson` unless the user pressed Replay (Replay links to `?lesson=requests&replay=1`).
- **Stepper:**
  - Section heading "Quick tour".
  - Per stop: the stop title, "Stop {n} of 5", and a labelled progress bar ("Quick tour progress").
  - Buttons: Back (ghost); "Show me" (outline); Next, labelled "Finish" on stop 5, the only primary. While the tour is expanded above the hero, `SetupHero`'s action renders `outline`.
  - Finish also removes `?lesson` from the URL with `replaceState`.
  - On each change, `window.history.replaceState` sets `?lesson=<id>`. This is the repo's pattern (`use-url-filter-sync.ts:43`): no navigation, no scroll and no remount. The phone's back gesture then returns to the right stop.
  - Focus stays on the pressed button, and a polite live region announces "Stop {n} of 5: {title}". There are no page-level key handlers.
- **Writes** (skipped when `readOnly` or `guide` is null; fire-and-forget; failures ignored):
  - `lesson` on mount when `?lesson` is present, and on every change.
  - `tourCompleted` on Finish. Local state collapses the tour at once. After the write settles, `refreshOnboarding({ force: true })` runs so the dashboard's "Continue" and welcome states are current.
  - In preview, local state still drives the whole click-through. Nothing is written or refetched.
- **Header line:** the setup page header gains "New here? Take the quick tour", linking to `#learn`. It is hidden once the tour is completed and while `?lesson` is present.
- **Lessons:** `src/lib/admin/tour-lessons.ts` exports `buildLessons(ctx: { payLinks; hasFieldPulse; historyHidden })`. "Show me" opens `<page>?from=tour&lesson=<id>`.

| id | title | copy | Show me |
|---|---|---|---|
| `requests` | Requests come to you | Calls, texts and website chat arrive as requests with the problem and contact already filled in. | `/admin/requests` |
| `schedule` | Book and assign | Give a request a time and a technician in one dialog. The calendar shows everyone's day. | `/admin/calendar` |
| `technicians` | Your team works from their phones | Technicians see their requests, notes and photos on their phone, and their own guide walks them through it. | `/admin/staff` |
| `customers` | Every customer in one place | Each customer's requests, equipment, estimates and invoices live on their page. | `/admin/customers` |
| `paid` | Getting paid | See what's owed at a glance, and turn an accepted estimate into an invoice. | `/admin/invoices` |

- **Variants** (a pure test pins every one):
  - `requests`:
    - With `hasFieldPulse && historyHidden`, prepend "Your upcoming FieldPulse work carried over as requests."
    - With `hasFieldPulse` and history not hidden, prepend "Your FieldPulse jobs are requests here."
  - `customers` with `historyHidden`: append "Older records are hidden for a clean start. Ask {historyContact} if you need them back." It uses "Older FieldPulse records" only with `hasFieldPulse`.
  - `paid` with `payLinks`: append "Text a pay link so customers can pay by phone."
  - No lesson mentions the map or review texts.

### D4. Back-to-tour strip
- `BackToTourStrip` (built on `InfoBanner`): "Quick tour · Stop {n} of 5 · Back to tour", linking to `/admin/setup?lesson=<id>#learn`.
- It reads `window.location` **once on mount**, as `useOpenFromParam` does, because `useUrlFilterSync` on requests, customers and invoices rewrites the query string right after mount. The strip is gone after a refresh or a drill-in; that is accepted.
- It renders only for `from=tour` with a valid `LessonId`. It is mounted on requests, calendar, staff, customers and invoices. It has no side effects, makes no fetch, and doesn't touch `BackToGuideBanner`.

### D5. Day-one empty states
Each empty state gets one primary action, wired to the page's existing open callback (passed down where needed, e.g. a new `onCreate` prop on `request-table.tsx`) or to a cross-page link:
- Requests "No requests yet": "New request".
- Pricebook, as an `EmptyState`: "Add item", matching the header button.
- Estimates: "New estimate".
- Invoices: "Open estimates" (link).
- Dispatch "No active technicians": "Open staff" (link).

This is presentation only.

### D6. Technician guide copy (independent of Task 19)
- Both pay-link clauses at `src/lib/tech/guide-steps.ts:67` show only when pay links are on:
  - why: "A pay link lets the customer pay by phone."
  - how: ", or tap Send pay link."
- `deriveGuide` takes `features: { payLinks: boolean }`. The module constant stays as it is; the clause is applied in derivation.
- `getGuide` and `/api/tech/guide` pass `getFeatures(org)`, falling back to `payLinks:false` if it throws.
- The pinned tests at `guide-steps.test.ts:31,43` are updated.
- Task 19 later adds its `write` option on top of this.

## Acceptance
- **First run.** Run all steps as a fresh admin on DEV. Via View as, run steps 1–3 and the Finish collapse, which is local state; steps 4–5 depend on stored progress and are real-admin only. Check at 1440 and 390 px:
  1. `/admin` shows the welcome row with the correct history copy and a single primary button.
  2. "Take the tour" focuses stop 1.
  3. Each "Show me" lands on a page with the strip, and "Back to tour" returns to the same stop. The phone back gesture also returns to the same stop.
  4. Quitting at stop 3 gives "Continue the tour · Stop 3 of 5".
  5. Finish collapses the tour. On the next load there is no welcome, and the sidebar "Quick tour" link replays it.
- **Preview writes nothing.** An integration test on a throwaway org (not `DEMO_ORG_ID`) runs a full preview GET of onboarding plus the guide, and checks that the target's `users.admin_guide_state` and `organization_settings.onboarding_state` are unchanged. The guide PATCH returns 403 while previewing.
- **Pure tests:** `buildLessons` variants (switches off: no pay links, map or review texts); the guide parser (non-object → `{}`); `welcomeDue`; `cardView` table rows; strip lesson validation; `deriveGuide` with pay links off.
- **Integration test:** the PATCH merge keeps write-once keys, overwrites `lastLesson`, and matches no row in another org or for another user.
- Gates are green.

## Rollout
- 0060 ships with 0059. It is additive and nullable, and needs no prod SQL.
- Handover (plan Task 22): rchen sees his own welcome once; technicians may see the existing tech-guide card; the sidebar "Quick tour" link replays the tour; and the list of open setup steps for Spears that Task 18 found.

## Left to the builder
File layout, the component split, and an icon chip per lesson.
