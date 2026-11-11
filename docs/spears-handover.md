# Spears go-live handover

**Last updated:** 2026-11-11
**Branch:** `feat/spears-golive` (prod deploys are fast-forwards of `main`)
**Org:** Spears Services, id `00000000-0000-0000-0000-000000000001`
**Prod:** https://ai-hvac-agent-lovat.vercel.app
**Record of the run:** `.superpowers/sdd/2026-11-10-spears-go-live/progress.md`

Specs: `docs/superpowers/specs/2026-11-10-spears-go-live-design.md`,
`docs/superpowers/specs/2026-11-10-first-run-onboarding-design.md`,
`docs/superpowers/specs/2026-11-10-speed-design.md`.

> **A push to `main` auto-deploys prod.** It did at D1, D2 and D3. Don't push
> to `main` unless you mean to deploy.

---

## 1. Current state of prod

Done on prod, by the controller, with your go-ahead:

| What | State | When |
|---|---|---|
| Org name | "Spears Services" | D1, 2026-11-10 |
| Demo admin `admin@demo-hvac.com` | Inactive (1 row). Every `@demo-hvac.com` user is inactive. | D1 |
| `organizations.owner_email` | `chick.s@spearsservices.com` | D1 |
| Switches | `payLinks` off, `reviewRequests` off, `map` off, `showHistory` off | D1 (seeded by 0059) |
| Signup | Off. `NEXT_PUBLIC_SIGNUP_ENABLED=false`; `/signup` returns 404. | Set at Task 31, live since D3 |
| Platform env | `PLATFORM_ADMIN_EMAILS` and `PLATFORM_ORG_ID` set. `DEMO_MODE_ORG_IDS` unset. | Before D1 |
| History hidden | Mode `history`, applied twice (see below) | D2, then `--reapply` at D3 |
| Audit history cutoff | `feature_flags.historyCutoff` = 2026-11-11 03:00:13Z | D3 |
| Onboarding reset | `onboarding_state` = `{firstSeenAt}` only | D2, again at D3 |
| Migrations | 0059 and 0060 applied. **0061 pending the final deploy (D4).** | D1, D3 |

### History marking on prod

Mode `history` ("live work only") was your choice. It was applied at D2 and
re-applied with the P8-tightened rules at D3.

| Table | Total | Hidden at D2 | Hidden at D3 | Visible now |
|---|---:|---:|---:|---:|
| service_requests | 490 | 198 | 72 | 220 |
| estimates | 212 | 0 | 104 | 108 |
| customers | 2,738 | 2,461 | 59 | 218 |
| invoices | 3,271 | 3,033 | 0 | 238 |
| customer_sessions | 557 | 263 | 72 | about 222 |

What `history` keeps visible (P8 rules):

- Requests not yet completed or cancelled, created in the last 60 days.
- Requests with a visit from today on.
- Open AR: `state = 'open'`, plus native drafts (not FieldPulse or HCP drafts).
- Open estimates created or updated in the last 90 days, and any estimate an
  open invoice references.
- Resumable chats (`chatting`, `extracting`, `confirmed`) updated in the last 14 days.
- The customer, request and session of every kept row.

It always hides seeded `HVAC-DEMO…` and `HVAC-CAP…` requests and their sessions.
Prod had none of these.

Nothing is deleted. You (platform owner, not previewing) still see every row.

### What D4 adds

D4 is the final deploy (Task 23), followed by the post-deploy watch (Task 43).
It ships the final fix wave, including migration 0061. Once 0061 is applied:

- A hidden request comes back into view on a real status change, or when it is
  rescheduled to yesterday or later.
- A live visit moved to yesterday or later brings its request back.
- A hidden invoice that becomes open brings itself and its chain back.
- A new message also brings back the session's requests.
- `--reapply` never hides rows created after the history cutoff.
- `--unhide` clears the history cutoff.

---

## 2. What you still have to do

### 2.1 Check Chick's user row, then send the owner invite

The invite only works if Chick's row is **active, role `admin`, with no
password**. **Done 2026-11-11 by the controller:** the row was inactive and is now
active, `admin`, password-less (owner_email already set at D1). Until he accepts
the invite he can also sign in with Google as an admin; accepting the owner invite
makes him `super_admin`. To re-check (read-only):

```sql
SELECT id, role, is_active, password_hash IS NULL AS no_password
FROM users
WHERE organization_id = '00000000-0000-0000-0000-000000000001'
  AND lower(email) = 'chick.s@spearsservices.com';
```

If it isn't active, `admin` and password-less, run this batch. It stops if the
row is missing or `owner_email` points at someone else.

```sql
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM users WHERE organization_id='00000000-0000-0000-0000-000000000001' AND lower(email)='chick.s@spearsservices.com';
  IF n <> 1 THEN RAISE EXCEPTION 'chick row missing'; END IF;
  SELECT count(*) INTO n FROM organizations WHERE id='00000000-0000-0000-0000-000000000001' AND (owner_email IS NULL OR lower(owner_email)='chick.s@spearsservices.com');
  IF n <> 1 THEN RAISE EXCEPTION 'owner_email is set to someone else'; END IF;
  UPDATE users SET is_active=true, role='admin', password_hash=NULL, google_id=NULL, updated_at=now() WHERE organization_id='00000000-0000-0000-0000-000000000001' AND lower(email)='chick.s@spearsservices.com';
  UPDATE organizations SET owner_email='chick.s@spearsservices.com', updated_at=now() WHERE id='00000000-0000-0000-0000-000000000001';
END $$;
```

Then send the invite:

1. Sign in as yourself. Open **Platform**. Find Spears Services.
2. Click **Send owner invite**.
3. **Use the copy link.** It is always shown to you. Don't count on the email:
   `RESEND_API_KEY` is not set on prod, and the sender domain
   `spears-services.com` is not verified in Resend.
4. Copy the link right away. It is shown once. Send it to Chick yourself.
   It lasts 72 hours.
   - If it expires, click **Send owner invite** again. The expired invite is
     revoked and a new link is made.
   - While it is still live, a second click answers "invite exists". If you
     lost the link, revoke the pending invite on **Staff**, then send again.
5. When Chick accepts and sets a password, he becomes `super_admin`. The stored
   `owner_email` is then cleared.

To have invites emailed later: add `RESEND_API_KEY`, verify
`spears-services.com` in Resend, then redeploy.

### 2.2 Confirm business hours and logo with Chick

Task 30's prefill filled only facts we could verify: company name, phone
(423-854-9505), service area, website and time zone (America/New_York).
These two are left open on purpose:

- **Business hours.** This is a required setup step, and it stays open until set.
- **Logo.** Optional. We have no asset.

The ledger has no prod run of the prefill. To check what's empty on prod:

```bash
DATABASE_URL=<prod url> npx tsx scripts/agent/prefill-org-settings.mjs --org 00000000-0000-0000-0000-000000000001 --report --prod
```

### 2.3 Check Vercel compute

Open the Vercel dashboard, then **Settings → Functions**. Check whether Fluid
compute is on, and the function memory. The CLI can't show either. The region
is pinned to `iad1` in `vercel.json`. Cold starts are the biggest latency we
measured (section 7), and Fluid compute is what reduces them. This is your call.

### 2.4 Check FieldPulse sync on prod (P8 M10)

On dev, Integrations showed FieldPulse in red: "Sync failed — Connected, but
the last availability sync failed." On prod, open **Platform → View as →
Chick → Integrations** and look at the FieldPulse card.

- If it is red there too, fix the availability sync or the key before Chick sees it.
- Stripe and Wisetack show "Test mode" if they aren't live. Decide if that is fine for day one.

### 2.5 Later: turning switches on

Use **Platform → Switches**. Each change is audited.

Before you turn **review texts** on, count the jobs waiting to send. They go
out on the next queue drain.

```sql
SELECT count(*) FROM communication_jobs
WHERE organization_id = '00000000-0000-0000-0000-000000000001'
  AND status = 'pending' AND trigger_type = 'review_request';
```

---

## 3. How to use View as

View as shows the admin exactly as one person in the org sees it. It is
read-only, and nothing can be saved until you exit.

1. Sign in as yourself (platform admin).
2. Open **Platform → View as**. Pick a person, then click **View as**.
3. A banner shows on every page: "Viewing as … · read-only · Exit".
4. Click **Exit** when done. The preview also ends on sign out, or after 2 hours.

- **View as Chick:** you see Chick's role, his nav, and only visible rows.
  Platform pages return 404, as they would for him.
- **View as a technician:** pick a technician and open `/tech/jobs`. The tech
  portal renders read-only. A banner shows, the day clock and status buttons are
  disabled, and sign-out and the location tracker are off. Every technician
  write returns 403.
- If the person stops being active, the banner reads "Viewing as a user who is
  no longer available · read-only · Exit". Writes stay refused.

**Don't load authenticated prod pages as yourself** between a marking run and
the onboarding reset. A real admin page load writes onboarding stamps. The
reset is done now. But if you ever re-run the marking, re-run the reset
straight after it, before anyone opens the admin. View as never writes stamps,
so use it for prod checks.

Onboarding reset SQL (re-run only after a new marking):

```sql
UPDATE organization_settings SET onboarding_state = (COALESCE(onboarding_state,'{}'::jsonb) - 'dismissed' - 'dismissedAt' - 'completedSeenAt' - 'firstCompleted' - 'flags' - 'embedViewed') || jsonb_build_object('firstSeenAt', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE organization_id='00000000-0000-0000-0000-000000000001';
```

---

## 4. Rollback

Each deploy is an instant rollback. Use `vercel rollback <deployment url or id>`.
`vercel ls` lists the full URLs.

| Deploy | When (UTC) | Commit | Prod deployment | Roll back to |
|---|---|---|---|---|
| D1 lockdown, 0059, switches | 2026-11-10 ~15:25 | `e10d86e` | `ai-hvac-agent-elmzekrhq` | `ai-hvac-agent-7puz60po2` |
| D2 visibility filters | 2026-11-10 ~21:10 | `0ec6142` | `ai-hvac-agent-afgn5d5a7` | `ai-hvac-agent-elmzekrhq` |
| D3 onboarding, polish, P8 fixes, 0060 | 2026-11-11 ~03:00 | `e3fba8d` | `ai-hvac-agent-70g3fhs7e` | `ai-hvac-agent-afgn5d5a7` |
| D4 final fix wave, 0061 | pending (Task 23) | — | — | `ai-hvac-agent-70g3fhs7e` |

Example: `vercel rollback ai-hvac-agent-70g3fhs7e` (use the full URL from
`vercel ls` if the id alone is refused).

- **Migrations stay applied.** 0059, 0060 and 0061 are additive. 0059 adds
  columns with defaults, 0060 adds a nullable column, and 0061 adds triggers
  only. Older code runs fine on the newer schema. Don't try to undo them.
- **Rolling back below D2** means the code ignores `hidden_from_org`, so Chick
  would see all history again. Rolling back below D1 also brings back the old
  demo-only behaviour. Go that far only if prod is broken.
- Vercel stops auto-promoting new prod deploys after a rollback. When the fix
  is ready, promote it with `vercel promote <url>`.
- Env vars are not rolled back.
- Afterwards: `BASE=https://ai-hvac-agent-lovat.vercel.app bash scripts/agent/prod-smoke.sh`.

**Restore history (show everything to Chick again).** Either of these works:

- Quick and reversible: **Platform → Switches → Show history** on. The org then
  sees every row. A running instance picks it up within 30 s.
- Full: un-hide every row.

  ```bash
  DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-history.mjs --org 00000000-0000-0000-0000-000000000001 --unhide --prod          # dry run
  DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-history.mjs --org 00000000-0000-0000-0000-000000000001 --unhide --apply --prod
  ```

  After D4, `--unhide` also clears `historyCutoff`, so the full audit log comes
  back too. Before D4 it doesn't: set **Show history** on instead.

To switch modes (`history` ↔ `empty`): run `--unhide` first, then `--apply`
with the new mode.

**Show Chick his FieldPulse history (and nothing else).** Don't use `--unhide`
or Show history for this: both also bring back the pre-go-live demo chats, the
demo-era requests and customers, and the seeded rows. Follow the production
run order below.

### Production run order

Five scripts, in this order. Run each one as a dry run first (no `--apply`),
read the output, then run it again with `--apply`. Only the user passes
`--prod`.

Environment: with `--prod` the scripts never read `.env.local` (that is the
DEV branch), so export every value they use. The two `.mts` scripts also need
`ENCRYPTION_KEY` (to read the FieldPulse key stored on the prod connection
row) and `NODE_OPTIONS=--conditions=react-server`.

```bash
export DATABASE_URL=<prod url> ENCRYPTION_KEY=<prod key>
export NODE_OPTIONS=--conditions=react-server
ORG=00000000-0000-0000-0000-000000000001
```

Undo records go to `~/.hvac-golive/` on the machine that runs the script
(outside the repo, never in the OS temp dir). Keep that folder until the run
is signed off. An undo record that has been used is renamed
`*.undone-<time>.json`.

| # | Script | What it changes | Undo record |
|---|---|---|---|
| 1 | `golive-hide-history.mjs --unhide-fieldpulse` | Shows imported FieldPulse history | None. Reverse with `--mode history --apply --reapply --hide-fieldpulse` |
| 2 | `golive-hide-junk.mjs` | Hides test, demo and placeholder rows again | `~/.hvac-golive/golive-junk-<host>-<org>-<time>.json` |
| 3 | `fp-truth-backfill.mts` | Estimate status, customer type, created dates, after-hours | None. It only moves dates earlier and is idempotent. Back up first if you want a way back. |
| 4 | `fp-hide-deleted-jobs.mts` | Hides imported requests whose FieldPulse job was deleted | `~/.hvac-golive/fp-deleted-jobs-hidden-<org8>-<time>.json` |
| 5 | `golive-polish-defaults.mjs` | Demo pricebook and plan off, template names, brand color | `~/.hvac-golive/golive-polish-defaults-<host>-<org>.json` |

```bash
# 1. Show imported FieldPulse history. Restores only rows the importer created
#    (requests with the synthetic fp-import- session), FieldPulse invoices and
#    estimates, and customers with imported work or with a FieldPulse id and no
#    native request. Native requests pushed to FieldPulse, and customers whose
#    only work is native, are listed and left hidden. Rows in a
#    fp-hide-deleted-jobs undo file in ~/.hvac-golive/ stay hidden.
npx tsx scripts/agent/golive-hide-history.mjs --org $ORG --unhide-fieldpulse --prod
npx tsx scripts/agent/golive-hide-history.mjs --org $ORG --unhide-fieldpulse --apply --prod

# 2. Re-hide the FieldPulse test rows that step 1 brings back.
npx tsx scripts/agent/golive-hide-junk.mjs --org $ORG --prod
npx tsx scripts/agent/golive-hide-junk.mjs --org $ORG --apply --prod
#    Undo (exactly the rows that --apply changed):
npx tsx scripts/agent/golive-hide-junk.mjs --org $ORG --undo ~/.hvac-golive/golive-junk-<...>.json --prod
npx tsx scripts/agent/golive-hide-junk.mjs --org $ORG --undo ~/.hvac-golive/golive-junk-<...>.json --apply --prod

# 3. Correct imported data from FieldPulse (GET only). Parts: estimates,
#    customers, dates, after-hours (all four by default; --part to pick).
npx tsx scripts/agent/fp-truth-backfill.mts --org $ORG --prod
npx tsx scripts/agent/fp-truth-backfill.mts --org $ORG --apply --prod

# 4. Hide imported requests whose FieldPulse job was deleted (GET /jobs/{id} = 404).
#    Native requests whose FieldPulse copy was deleted are listed, never hidden.
npx tsx scripts/agent/fp-hide-deleted-jobs.mts --org $ORG --prod
npx tsx scripts/agent/fp-hide-deleted-jobs.mts --org $ORG --apply --prod
#    Undo:
npx tsx scripts/agent/fp-hide-deleted-jobs.mts --org $ORG --undo ~/.hvac-golive/fp-deleted-jobs-hidden-<...>.json --prod
npx tsx scripts/agent/fp-hide-deleted-jobs.mts --org $ORG --undo ~/.hvac-golive/fp-deleted-jobs-hidden-<...>.json --apply --prod

# 5. Polish the shipped defaults.
npx tsx scripts/agent/golive-polish-defaults.mjs --org $ORG --prod
npx tsx scripts/agent/golive-polish-defaults.mjs --org $ORG --apply --prod
#    Undo (fields edited since --apply are skipped):
npx tsx scripts/agent/golive-polish-defaults.mjs --org $ORG --undo --prod
npx tsx scripts/agent/golive-polish-defaults.mjs --org $ORG --undo --apply --prod

# Then: onboarding reset (section 3) and smoke.
```

Things to know:

- **Every reversal is a dry run without `--apply`**: history `--unhide`, junk
  `--undo`, polish `--undo` and deleted-jobs `--undo`.
- **Marking now protects FieldPulse history.** Any marking `--apply` (with or
  without `--reapply`) refuses if it would hide visible imported FieldPulse
  rows. This includes rows the sync or step 3 moved to before the cutoff. Pass
  `--hide-fieldpulse` only when that is what you want.
- **A later `--unhide-fieldpulse` keeps step 4's rows hidden** if their undo
  file is still in `~/.hvac-golive/` on the machine that runs it. It does
  bring back the step 2 rows, so re-run step 2 after it.
- **A later `--unhide` brings back everything**, steps 2 and 4 included. Re-run
  steps 1 to 5 after it (step 1 first re-marks with
  `--mode history --apply --reapply --hide-fieldpulse` if needed).
- **Customer type:** step 3 maps FieldPulse `account_type` "company" to
  commercial and "individual" to residential. "company" is not a FieldPulse
  default: it is set exactly when the customer has a company name (checked on
  all 2,709 live FieldPulse customers, 2026-11-11). In a random 100 "company"
  accounts, 12 looked like homeowners whose own name was typed into the
  company name field. No field tells those apart, so they stay commercial.

---

---

## 5. Rulings

These are the decisions made during the run, in plain words.

### Plan rulings 1–16

1. The setup-guide pin in the onboarding route is decided by `isDemoOrg`. The
   `DEMO_ORG_ID` constant stays, because intake still routes by it.
2. Setup-guide signals count visible rows only, whoever is looking. Onboarding
   state is per org, and each stamp is written once.
3. The View as cookie is signed with its own key, derived from `AUTH_SECRET`.
   No new env var is needed.
4. At most 20 invite emails per org per rolling 24 hours. The 21st invite is
   still created, but not emailed, and the response says so.
5. The marking script refuses `--apply` when rows are already hidden, unless
   `--reapply` is passed. Against the prod host it needs `--prod`. Agents never
   pass `--prod`.
6. On invite accept, the inviter is the actor. The inviter must be active and
   admin-tier, and their current role is used. Promotion to `super_admin` also
   needs the inviter to be a platform admin.
7. Prod smoke no longer uses a demo cookie. It checks that the demo login is
   refused (401) and that three admin endpoints refuse an unauthenticated call (401).
8. Dev keeps `DEMO_MODE_ORG_IDS` unset, so the dev default org mirrors prod.
9. If the View as target is no longer available, read-only stays on and the
   banner says so. The banner and the behaviour never disagree.
10. "Open AR" means open invoices, plus native drafts. FieldPulse and HCP
    drafts are not kept.
11. Each visibility sweep owned whole files, so no two tasks edited the same function.
12. Four reads stay unfiltered on purpose: technician timesheets, the
    accounting export, scheduled jobs for availability, and send-outcome counts.
13. Reason codes no longer say "demo". They are `review_requests_off` and
    `pay_links_off` (403 `PAY_LINKS_OFF`, "Pay links are turned off for this account.").
14. "Frame" is the first page heading or skeleton. "First row" is the first
    moment the page has a heading and no skeleton.
15. This handover is written whatever ships, and covers only what shipped.
16. Resumable chats stay visible, and new messages or visits un-hide their
    parents. Accepted gap: a hidden request whose status alone changes back to
    open stays hidden. 0061 (D4) closes this for real status changes.

### Wave-2 overrides 1–8

1. The onboarding spec v3 is the authority over the wave-2 drafts.
2. The sign-in page shows "Create an account" only when signup is on. Signup
   is set off on prod. Public metadata stays org-neutral. The admin tab
   fallback is "Service console".
3. The region is pinned to `iad1`. Fluid compute is only reported. Turning it
   on is your call.
4. The rehearsal deploys (Tasks 40–42) needed a separate Neon branch and never
   the prod DB. They were later skipped (see section 6).
5. The controller's execution order wins over the drafted order.
6. Guards from the wave-2 review:
   - Smoke never writes prod by default.
   - The migrator refuses the prod DB outside the prod build.
   - No authenticated agent request hits prod before the onboarding reset.
   - The watch prints route patterns only.
   - Git checks run only for production.
   - Tasks 33 and 34 became optional, and Task 36 was deferred.
7. Your go-ahead, "yes we want it to touch live production. no one is using it
   yet", let the controller deploy, run prod migrations and run the prod
   handover steps. Sending Chick's invite and any prod DELETE still need your yes.
8. Your go-ahead, "deploying along the way is fine", allowed checkpoint deploys
   D1–D4, fast-forwarding and pushing `main`, rollback on failed smoke, and
   setting the known platform env vars.

### Controller rulings (from progress.md)

**Process**
- Work happened on `feat/spears-golive`, not `main`.
- Implementers ran one at a time, and later in separate git worktrees. Every
  merge went through full gates.

**Security and access**
- Hidden is a tidiness view, not an access lock. A write to a hidden row by its
  known id is allowed. The data is the org's own.
- Hidden customers 404 on write paths for org users. This is stricter, and harmless.
- The marking script needs `--prod` against the prod host even for a dry run.
- A cancelled request with a future date is not a visit.
- An extra trigger name in 0059 was accepted. When a hidden request gets its
  first visit, that visit un-hides it.
- Editing platform-admin users is refused with its own code, `PLATFORM_PROTECTED`.
- The map switch fails closed.
- Preview builds that inherit the prod `DATABASE_URL` now fail on purpose.
  Smoke writes off localhost need a second flag, `SMOKE_PROD_WRITES=1`.
- A missing `RESEND_API_KEY` is a warning, not a failure, because the copy link
  covers it.
- The owner-invite response always returns the copy link to the platform admin.
- In View as, page-level `super_admin` controls still render, but writes are refused.
- Technician View as shows a banner.
- Tech writes in preview are refused by a shared gate. A source-scan test makes
  sure every tech write route calls it.
- `predeploy-check` can't read the signup value on prod (it shows as
  Encrypted). It requires the name and prints a warning.

**Visibility and money**
- Coverage is checked per read. Location children stay unfiltered, because they
  are reached only through customer detail.
- A hidden invoice still counts as billed.
- The "collected this month" sum is filtered, though it sits on the permanent list.
- History mode was your choice ("live work only").
- P8 tightened the marking rules:
  - chats are kept 14 days, in both modes;
  - open estimates are kept 90 days, aged by creation for FieldPulse;
  - open requests older than 60 days with no visit from today are hidden;
  - seeded rows are always hidden;
  - estimates referenced by visible invoices stay.
- The technician list stays unfiltered (field reality). Touching hidden work
  makes it visible to the office again (0061, D4).

**UX and copy**
- In a platform-managed org, billing reads "Billing is handled by …" with no
  plan switching.
- The review copy is "Review texts are off for this account."
- Tech-side "jobs" copy was left as is (tech canon).
- Disabling every mutating control during preview (P8 m16) was skipped.
- When the tour is expanded, the hero action is outline. "Show me" carries
  `replay=1`. Hiding the header invite at mount was an accepted deviation.
- Invoices may show an "Open estimates" link under "all caught up" for
  paid-only orgs. The link is harmless.
- FieldPulse details on invoice and estimate rows now load when the row is expanded.
- The calendar's unscheduled panel now also lists assigned, en-route, arrived
  and in-progress requests that have no window, so the badge, link and panel agree.
- Retired demo users are hidden from org viewers. They still show when
  `showHistory` is on.

**Performance and admin UI**
- The org row and switches are cached for 30 seconds per instance.
- The viewer read stays before the rate limit.

---

## 6. Known gaps and accepted behaviour

**Visibility**
- **Hidden is a tidiness view, not an access lock.** `/api/admin/export` is
  unfiltered. Writes to a hidden row by known id work.
- **Crons and dunning still message hidden customers.** Invoice dunning and
  warranty reminders run over every row, by spec.
- **The admin reminder SMS keeps its portal pay link**, even with `payLinks`
  off. Dunning is not the pay-link switch. The switch covers the technician's
  "Send pay link".
- **Technicians still see hidden work assigned to them** on Today. Their
  activity un-hides it once 0061 is live.
- Until D4, a hidden request whose status alone changes back to open stays
  hidden (ruling 16). Use Show history or `--unhide`.
- Following "View invoice" from a visible estimate can land on a hidden invoice
  (404). Marking can't produce this.
- Invoice detail shows no technician or service date when its request is hidden.
- These stay unfiltered: time entries (the on-site average), dispatch health
  (`decision_audit`) and service-history cost. They are not customer history.
- AI feedback votes from hidden chats count until D4.
- The erase dialog can name a hidden sibling contact to a `super_admin`.
- A chat whose only content is a hidden request can still be listed.
- Org users with Show history on see retired demo users. Insights technician
  totals can sum below the status totals.
- The seat count includes retired demo users. They are inactive on prod.
- Global staff search and map pins can still list retired users.

**Caching and timing**
- **The 30-second switch cache.** On another instance, a switch you turn off
  (`showHistory`, `map`) can read as on for up to 30 seconds. A new history
  cutoff takes up to 30 seconds too. Send and charge gates always read live.

**View as**
- **Cross-site GET gap during preview.** The preview cookie is SameSite=Strict
  and the session is Lax. A top-level GET from another site arrives without the
  preview cookie, so it runs as you, not as the preview. Any write that GET
  does (for example onboarding stamps) happens as you. Accepted.
- A copied preview cookie verifies until it expires (at most 2 hours). It can
  only make your own session read-only.

**Invites and email**
- The invite cap can overshoot slightly when two invites are made at the same
  moment. The rate limit bounds it.
- With Resend set but failing, the UI can still say "Invite emailed". Use the copy link.

**Platform and setup**
- The billing banner ("update billing to restore full access") is not adapted
  for platform-managed orgs.
- Plain admins in a platform-managed org see no "handled by" name.
- The session revocation check fails open during a DB outage. The demo users
  are deactivated in the DB, so this doesn't rely on code alone.
- The Task 1 signup callback has no explicit retired-demo refusal. Signup is off on prod.

**Other**
- FieldPulse details on row expand share the 60/min detail rate limit. Expanding
  more than 60 rows a minute shows "Couldn't load…" until the window resets.
- Rerunning smoke quickly can hit 429 on the login probe. Wait a minute.
- About 18 `Button render={<Link/>}` sites still announce as buttons.
- Collapsed-rail nav tooltips aren't focusable.
- Requests fetches `/api/admin/technicians` three times. Page API calls start
  about 340 ms after the click on a non-prefetched link.

**Skipped or deferred tasks**
- **Tasks 33 and 34 skipped.** These were reading the session once per render,
  and warming list data on hover. Both were optional, and there was no time
  after the required work.
- **Task 36 deferred** until after go-live. It would add partial indexes for
  visible-only reads. That would be a third one-way prod migration, for a gain
  the plan called "may be negligible". The next free migration number is 0062.
- **Tasks 40–42 skipped.** These were the migration rehearsal on a Neon branch,
  a preview deploy against it, and a rollback rehearsal. Their purpose was to
  de-risk the first prod migration. Prod already carries 0059 and 0060 from
  D1–D3, with a verified rollback target each time, so the point was moot.

**P8 items to verify on prod** (dev artefacts)
- m10: erased customers with open requests.
- m11: seeded pricebook or plan rows.
- m13: "Testy Officebook" test requests.

**Design calls left to you**
- Dropping Plex Mono 600 saves about 10 KB. Semibold mono would fall back to medium.
- Removing zod from the admin shell's onboarding store chain saves about 21 KB gz.

---

## 7. Speed

### Admin pages (ms from the sidebar click, p50)

- **Before** (Task 16): a local prod build on the DEV DB, measured from Tokyo.
- **After** (Task 18): `next dev` on the DEV DB, after all speed work.

The two runs used different servers, so read the after columns for ranking and
for the generic loading frame (Task 17), not as a precise delta. Every DB query
from the dev machine crosses the Pacific (about 130 ms each).

| Page | Frame before | Frame after | First row before | First row after (owner) | First row after (as Chick) |
|---|---:|---:|---:|---:|---:|
| /admin | 108 | 100 | 881 | 1421 | 1456 |
| /admin/setup | 74 | 109 | 74 | 111 | 116 |
| /admin/calendar | 247 | 106 | 681 | 106 | 111 |
| /admin/dispatch | 240 | 142 | 709 | 616 | 538 |
| /admin/requests | 68 | 113 | 1118 | 1819 | 1872 |
| /admin/conversations | 83 | 112 | 905 | 2119 | 2120 |
| /admin/customers | 240 | 113 | 683 | 1162 | 1399 |
| /admin/reviews | 240 | 104 | 682 | 898 | 970 |
| /admin/communications/templates | 240 | 112 | 406 | 359 | 325 |
| /admin/staff | 223 | 116 | 681 | 131 | 131 |
| /admin/pricebook | 207 | 128 | 403 | 429 | 361 |
| /admin/inventory | 207 | 123 | 420 | 677 | 562 |
| /admin/membership-plans | 78 | 103 | 323 | 113 | 101 |
| /admin/estimates | 80 | 103 | 1181 | 927 | 935 |
| /admin/invoices | 73 | 111 | 964 | 840 | 930 |
| /admin/accounting | 71 | 87 | 71 | 87 | 87 |
| /admin/operations | 68 | 98 | 546 | 1283 | 959 |
| /admin/reports | 66 | 88 | 520 | 1044 | 939 |
| /admin/insights | 71 | 92 | 735 | 128 | 130 |
| /admin/settings | 77 | 98 | 367 | 379 | 372 |
| /admin/integrations | 68 | 93 | 324 | 102 | 98 |
| /admin/fieldpulse-import | 82 | 96 | 322 | 337 | 321 |
| /admin/audit-log | 83 | 96 | 526 | 548 | 551 |

Every page now shows a frame in about 90–140 ms. Before, eight pages waited
200–250 ms with nothing on screen. The slowest first rows are conversations,
requests, the dashboard and customers. Hiding history barely changes dev times.

### List payloads, page 1 (Task 20, true before/after)

| Endpoint | Before | After |
|---|---:|---:|
| Invoices (Overdue tab) | 78.5 KB | 18.4 KB (−77%) |
| Requests | 30.8 KB | 15.8 KB (−49%) |
| Estimates (Open tab) | 82.1 KB | 22.7 KB (−72%) |
| Customers | 20.4 KB | unchanged |

### Prod, cold starts (Task 38)

Unauthenticated time to first byte on prod, from Japan:

- `/chat`: 6.28 s cold, then 0.07–0.14 s.
- `/admin/login`: 2.07 s cold, then 0.34–0.47 s.

**Cold starts are the real latency.** Warm responses are fast. Functions were
already in `iad1`, so the region pin only guards against drift. The keep-warm
workflow is unchanged, because unauthenticated pings can't warm admin pages.
Fluid compute is the lever (section 2.3).

### Bundle (Task 35)

Shared JS on `/admin` is 419 KB gz, of which about 200 KB is framework. Fonts
are 117.5 KB in 4 files. No change met the bar. The two leads are listed under
design calls above.

Task 23 adds authenticated prod numbers (as View as Chick) after D4.

---

## 8. Commands

Run from the repo root. `.env.local` is the DEV branch. Never point it at prod
(`ep-withered-hill`). For a prod run, pass `DATABASE_URL=<prod url>` inline,
and `--prod` where the script asks for it.

### Before and after a deploy

```bash
# Pre-deploy checklist. Read-only, checks env var NAMES only.
npx tsx scripts/agent/predeploy-check.mjs                  # production (default)
npx tsx scripts/agent/predeploy-check.mjs --env preview
```

Production checks:
- `vercel whoami` works.
- Every required env name is present, including `PLATFORM_ADMIN_EMAILS`,
  `PLATFORM_ORG_ID`, `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SIGNUP_ENABLED`.
- `DEMO_MODE_ORG_IDS` is absent.
- The newest migration is the last journal entry.
- You are on `main`, the tracked tree is clean, and HEAD equals `origin/main`.

Exit codes: 1 on any failure, 0 otherwise. A missing `RESEND_API_KEY` and an
unreadable signup value are only warnings.

```bash
# Smoke. BASE is required. Read-only by default.
BASE=https://ai-hvac-agent-lovat.vercel.app bash scripts/agent/prod-smoke.sh
# Adds the chat-streaming probe. It creates a chat session (a fake chat in the inbox).
BASE=http://localhost:3000 SMOKE_WRITES=1 bash scripts/agent/prod-smoke.sh
# Off localhost, writes also need SMOKE_PROD_WRITES=1. Use it once, then hide that chat.
BASE=https://ai-hvac-agent-lovat.vercel.app SMOKE_WRITES=1 SMOKE_PROD_WRITES=1 bash scripts/agent/prod-smoke.sh
```

Smoke expects these: home, chat and admin login return 200; "demo login
refused" returns 401; erase, SMS and mapkit-token return 401 without a cookie.
Any failure gives a non-zero exit.

```bash
# Post-deploy watch. Loops read-only smoke plus a log summary (route patterns only).
bash scripts/agent/postdeploy-watch.sh <deployment url> [--minutes 60] [--every 10]
```

Watch exit codes (the first that applies wins):

| Code | Meaning |
|---|---|
| 1 | A smoke pass failed |
| 5 | The logs showed a 5xx |
| 4 | Logs were unavailable |
| 3 | Fixture run |
| 0 | Clean |

It never enables smoke writes.

```bash
# Deploy (only if a push to main didn't already).
vercel deploy --prod --yes
```

### History and onboarding

```bash
# Dry run: counts for both modes, the stale-request flag, the empty-mode dunning warning.
DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-history.mjs --org 00000000-0000-0000-0000-000000000001 --prod
# Apply (refused if rows are already hidden).
DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-history.mjs --org 00000000-0000-0000-0000-000000000001 --mode history --apply --prod
# Re-apply on top. It only hides more, and never touches rows created after the cutoff (D4).
# Refused if it would hide visible imported FieldPulse rows, unless --hide-fieldpulse.
DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-history.mjs --org 00000000-0000-0000-0000-000000000001 --mode history --apply --reapply --prod
# Un-hide everything. After D4 it also clears historyCutoff. Dry run without --apply.
DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-history.mjs --org 00000000-0000-0000-0000-000000000001 --unhide --apply --prod
# Optional on a dry run or a history --apply: --stale-days <n> (default 60).
# Seeded mode: hide ONLY the fictional HVAC-DEMO / HVAC-CAP / demo-seed- / demo-cap- rows
# (plus customers whose only links are those rows); all imported history stays visible.
# Works straight after --unhide, no --reapply needed.
DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-history.mjs --org 00000000-0000-0000-0000-000000000001 --mode seeded --apply --prod
```

After any marking run, do the onboarding reset (section 3) before anyone opens the admin.

```bash
# Hide test, demo and placeholder rows (scripts/agent/golive-junk-list.json) from the org.
# Run AFTER any golive-hide-history.mjs run: its --unhide brings these back too.
# The dry run doubles as a drift check: a non-zero "visible" column means rows came back.
DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-junk.mjs --org 00000000-0000-0000-0000-000000000001 --prod           # dry run
DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-junk.mjs --org 00000000-0000-0000-0000-000000000001 --apply --prod
DATABASE_URL=<prod url> npx tsx scripts/agent/golive-hide-junk.mjs --org 00000000-0000-0000-0000-000000000001 --undo <record> --apply --prod    # show them again (record path printed by --apply)
```

```bash
# Audit-log cutoff. Org viewers see audit entries from this moment on.
DATABASE_URL=<prod url> npx tsx scripts/agent/set-history-cutoff.mjs --org 00000000-0000-0000-0000-000000000001 --prod
DATABASE_URL=<prod url> npx tsx scripts/agent/set-history-cutoff.mjs --org 00000000-0000-0000-0000-000000000001 --at 2026-11-11T03:00:13Z --prod
```

`--at` can't be in the future. The app picks up a new cutoff within 30 seconds.

```bash
# Prefill empty settings with verified Spears facts. Existing values always win.
DATABASE_URL=<prod url> npx tsx scripts/agent/prefill-org-settings.mjs --org 00000000-0000-0000-0000-000000000001 --prod            # dry run
DATABASE_URL=<prod url> npx tsx scripts/agent/prefill-org-settings.mjs --org 00000000-0000-0000-0000-000000000001 --report --prod   # empty key names only
DATABASE_URL=<prod url> npx tsx scripts/agent/prefill-org-settings.mjs --org 00000000-0000-0000-0000-000000000001 --apply --prod     # one UPDATE
```

The prefill never sets business hours or the logo.

### Measuring

```bash
# Local (dev server or next build && next start already running). Session minted from .env.local.
MINT_EMAIL=<dev non-demo admin> node scripts/agent/measure-latency.mjs --base http://localhost:3000 --runs 5 --out <file>
# Local, as another user (View as).
MINT_EMAIL=<dev admin> node scripts/agent/measure-latency.mjs --preview-as <userId>
# Prod, read-only as Chick. Both cookie values come from your browser after starting View as.
HVAC_SESSION=<hvac_admin_session> HVAC_PREVIEW=<hvac_preview> node scripts/agent/measure-latency.mjs --base https://ai-hvac-agent-lovat.vercel.app --prod --preview-as <Chick's user id>
```

- A non-local base is refused without `--prod`.
- `--prod` without `--preview-as` warns, because real page loads write onboarding stamps.
- It exits 1 when any page never measured a first row.

```bash
# 390 px phone audit (DEV only; dev server already running). Refuses the prod DB.
node scripts/agent/mobile-audit.mjs [--base http://localhost:3000] [--preview-as <userId>]
```

It exits 0 with "0 findings" when clean, and 1 otherwise.

### Other

- `npx tsx scripts/agent/mint-admin-session.mjs`, `npx tsx scripts/agent/mint-tech-session.mjs`:
  dev sessions. They refuse the prod DB.
- `npx tsx scripts/agent/mint-preview-cookie.mjs <targetUserId>`: a dev View as
  cookie. It refuses the prod DB.
- `node scripts/agent/verify-skills.mjs`: every path cited in `.claude/skills` must exist.

Gates before any commit: `npx tsc --noEmit` → 0, `npx eslint <changed>` → 0
errors, `npx vitest run` → no drop from the live baseline.

## Deploy record (final)

| Deploy | When (UTC) | Commit | Vercel deployment | Notes |
|---|---|---|---|---|
| D1 | 2026-11-10 15:25 | e10d86e | ai-hvac-agent-elmzekrhq | 0059 applied; org renamed; demo admin off; owner_email set |
| D2 | 2026-11-10 21:07 | 0ec6142 | ai-hvac-agent-afgn5d5a7 | history mode marking; onboarding reset |
| D3 | 2026-11-11 02:58 | e3fba8d | ai-hvac-agent-70g3fhs7e | 0060 applied; P8 marking re-applied; history cutoff; onboarding reset |
| D4 | 2026-11-11 04:01 | f4e831d | ai-hvac-agent-7ty85q4zg | 0061 applied (activity un-hides live work); final fix wave |

- **Rollback:** `vercel rollback ai-hvac-agent-70g3fhs7e-rchenworkmail-3397s-projects.vercel.app` goes back to D3. Migrations stay applied, and they are all additive.
- **Prod checks after D4:**
  - Smoke passed.
  - View as Chick checked the banner, welcome row, Staff (no demo users), Platform 404, setup and tour at 390, and Requests showing 220. It wrote nothing.
  - Chick's account is active and the invite is ready.
- **60-minute watch (Task 43):** 7 passes from 04:07Z to 05:08Z, every smoke check ok, exit 0.
- **Gap:** `vercel logs` returned no lines, so 5xx errors were **not** counted. Check Vercel → Logs by hand for the first day, or fix CLI log access.
- **Visible to Chick on prod:** a few FieldPulse jobs named "Test" (Oct 13). They are real FieldPulse records in Spears' account, so delete them in FieldPulse if they're unwanted.

## Deploy record: FieldPulse history shown (2026-11-11)

- D5 `cf8079b` → `ai-hvac-agent-4wn1nkwea`. FieldPulse history is shown with
  polished display, the Spears logo, the walkthrough video, a professional
  sweep and the go-live scripts. Smoke tests pass; the logo and video are served.
- Prod run, in the documented order (undo records in `~/.hvac-golive/`
  on rchen's machine). Before the run, the columns the scripts touch were
  backed up to `~/.hvac-golive/prod-backup-before-fp-show-*.json`.
  1. `--unhide-fieldpulse`: 3,033 invoices, 104 estimates, 269 requests and
     2,517 customers restored. One native-only customer was left hidden.
  2. junk: 16 requests, 6 invoices (including FieldPulse invoice 20923248,
     $27.38 open on the "Test" job), 6 estimates, 4 sessions, 8 customers and
     4 pricebook items hidden. Kept for review: the paid $110 invoice on
     "Buy a paint bucket" (FieldPulse 21372544, real money, so not hidden) and
     2 customers with priced work.
  3. backfill: 211 estimate statuses (48 sold, all with recorded acceptance;
     26 rejected or lost), 2,201 customers set to commercial, 3 requests and
     2,673 customers re-dated earlier, and 1 after-hours flag corrected.
  4. deleted jobs: 62 requests whose FieldPulse job is gone are hidden, plus 5
     sessions.
  5. polish: 12 demo pricebook items and Comfort Club turned off, 13 template
     names fixed, brand colour set to `#16264a`. `logo_url` is set to
     `/brand/spears-logo.png` on prod.
- Visible to Chick after the run: 411 requests, 2,727 customers, 3,265
  invoices and 206 estimates. Open AR reads $371,948.70 across 237 invoices,
  of which $323,515.99 is overdue (from FieldPulse); worth a sanity check with
  Chick.
- Checked as Chick on prod: dashboard, setup with video, requests, customers
  (390 px), invoices and calendar.

## Deploy record: first-look review fixes (2026-11-11)

- D6 `09cc806` → `ai-hvac-agent-ke2hfogqd`. Smoke tests pass.
- Shipped: a password sign-in link on `/admin/login` (Chick's mail is on
  Microsoft 365, not Google); the public home page no longer reads as a demo;
  invoices show their FieldPulse number; dashboard tiles count imported open
  requests; the FieldPulse card only shows "Sync failed" for an org scheduled
  from FieldPulse (prod's availability sync returns HTTP 403 and is unused);
  cancelling a FieldPulse-linked request says it also cancels the FieldPulse
  job; the daily invoice job now re-pulls every open FieldPulse invoice by its
  own id, so unlinked open invoices clear when paid.
- Prod data: the 3 non-FieldPulse chats and the one request a test chat made
  (`HVAC-2414D750`) are hidden. Undo record:
  `~/.hvac-golive/dummy-chats-hidden-2026-11-11T13-17-22-196Z.json`
  (set `hidden_from_org = false` on the listed ids).
- **Still open before Chick relies on it:**
  - `dispatch_alert_phone` and `voice_transfer_number` are not set. An inbound
    booking with a time slot auto-assigns a technician, texts the customer and
    creates a FieldPulse job, and nobody at Spears is notified.
  - No FieldPulse webhooks are registered. New FieldPulse jobs, estimates and
    customers do not arrive; only open invoices and invoices of known jobs
    refresh, once a day.
  - Editing a schedule or adding a note on a FieldPulse-linked request writes
    to the FieldPulse job with no warning.

## Deploy record: FieldPulse money corrected (2026-11-11, late)
- **GitHub had switched off the scheduled workflows** (`fp-nightly-sync`, `keep-warm`, `sub-daily-crons`) after 60 days without repo activity, so no FieldPulse sync ran from Oct 13. They were re-enabled and a full sync run (43021230602). If the numbers look stale again, check `gh workflow list` first.
- **Collected money** now counts payments by payment date, FieldPulse and native (`src/lib/admin/collected-cash.ts`). The Reports headline "Collected (last N days)" replaced "Net revenue".
- **Invoice state** now comes from FieldPulse's status workflow (`status_id` → type), not the amounts (commit b4a826f). Before this, 13 never-sent drafts ($59,261) and 14 voided invoices ($56,407) were counted as owed.
- Prod run: `fp-truth-backfill.mts --part invoices --prod --apply` updated 536 rows (a second dry run plans 0). An open-invoice re-pull (`pullOpenFieldpulseInvoices`) updated 204 rows with 0 failures. The `fp-hide-deleted-jobs.mts --invoices` dry run found 0 open invoices deleted in FieldPulse, so nothing was hidden.
- Verified: visible open AR is **$192,586.59** across 195 invoices, equal to FieldPulse's Σ `amount_unpaid` on Invoiced + Sent + Partially Paid. 0 open rows carry a Draft/Paid/Void status. Invoices, Reports and Dashboard agree when viewed as Chick.
- Lifetime FieldPulse payments on record: 2,747 payments, $2,840,773.89, May 8 2023 – Nov 9 2026. No page shows this figure.
- Open: `accounting-export.ts` has no state filter (drafts and voids appear in the export). New dev-tooling npm advisories (promptfoo, vitest, drizzle-kit) appeared today; none ship to the site, and the audit CI job is advisory.
