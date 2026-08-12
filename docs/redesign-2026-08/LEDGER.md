# Redesign 2026-08 — program ledger

Overnight autonomous run (2026-08-13, branch `redesign/shop-floor`). Owner brief:
*"everything looks outdated and old… it looks too much like AI."*

## Pipeline

1. **Directions workflow** — 4 independent design manifestos (Industrial Utility /
   Blueprint Swiss / Ledger editorial / Ironclad navy) judged by a 3-lens panel
   (anti-AI taste, ops usability, feasibility+brand). Unanimous winner:
   **Industrial Utility — "Shop floor instrument"** (8.5/9/9), with grafts and two
   overrules (Archivo over IBM Plex Sans; navy primary + teal marker + cyan signal
   over teal-primary). Dossier: `DIRECTION.md`.
2. **Spec** (`SPEC.md` v1 → v2) — hardened by a 3-critic adversarial workflow
   against the real codebase: 59 findings, 12 verified blockers (missing link
   color under navy, hardcoded sidebar, 3 font loaders, badge pill surviving the
   radius ceiling, unregistered @theme tokens, unimplementable console bar,
   color-mix hue trap…). All resolved or descoped in v2.
3. **Commit 1 — foundation** (3 parallel agents): tokens wholesale + @theme
   enumeration, Archivo/Plex Mono across all loaders, sidebar full rewrite,
   BrandMark pinned to brand tokens, status-colors repoint + NEW contrast vitest
   (parses globals.css, all pairings measured ≥4.5:1, signal 3.84:1 ≥3:1).
4. **Commit 2 — primitives** (3 parallel agents): 39 shared components — recessed
   inputs, pop-shadow popovers, fused segmented controls, marker tab rule, square
   mono avatars, breathing skeletons, Panel/KPI-cell/StatStrip, de-pilled
   badges/pager/context chips, ruled section rows.
5. **Commit 3 — sweep** (5 parallel agents + lead fixes): 81 files — urgency
   system on semantic families, rainbow avatars deleted, StatStrip adoption
   (10 sites), definition-list detail blocks, chat on tokens w/ three-square
   typing indicator + 44px targets, touch carve-out on tech/portal/token pages,
   auth + landing on tokens (marketing atmosphere kept), signal-cyan confined to
   the two AI panels.
6. **Verification** — per-agent screenshot iteration, lead eyes at every commit
   gate, full-route 19-screenshot final set + independent adversarial visual
   audit, gates: tsc 0 · eslint 0 errors · vitest 326 files 4,428 pass / 1 skip /
   0 fail · verify-skills 398/0.

## Incidents

- A sweep agent ran `git stash` mid-run in the shared worktree, sweeping every
  group's uncommitted work; recovered via path-scoped checkouts + a 3-way merge
  on two contested files; verified all five groups' signature changes present
  before commit 3. Rule for future parallel waves: **no `git stash` in a shared
  worktree.**
- A zombie `next start` on :3000 plus a Turbopack panic on `.ndemo/`'s UNIX
  socket had the dev server serving stale CSS — screenshots looked unchanged
  until both were cleared. `.ndemo/` is now gitignored.

## Deliberately out of scope (follow-ups)

- `widget.js` / `/embed` styling; map pin/marker assets; HTML email templates.
- Dark mode: tokens shipped complete but the app has no dark toggle — unverified.
- Density toggle UI + persistence (`data-density` CSS hook ships inert);
  high-contrast setting UI (baked into touch/media-query carve-out instead).
- Console bar (net-new feature; needs a scroll-container redesign).
- `section-list-item.tsx` now unreferenced (kept; candidate for removal).
- Invoice detail renders two near-identical "Paid" chips (pre-existing
  duplication made obvious by de-pilling).
- Chat `ExtractionField` labels render Title Case vs the sentence-case canon
  (copy strings, deliberately untouched by the presentation-only rule).

## Not done (owner's call)

- Merge timing was the program's only unilateral call: merged to main after all
  gates + the final audit passed, per the plan's completion rule.
- **No production deploy** — the redesign is on main but NOT deployed. Deploy
  with `vercel deploy --prod --yes` + `bash scripts/agent/prod-smoke.sh` when
  approved.

## Final visual audit (independent, 19 screenshots)

Verdict after fixes: merge. Blockers fixed in the audit-fix commit: violet
sync/FieldPulse surfaces → neutral tokens (the last rainbow survivor), the
full-width-stretched estimates SyncPill, settings tab rail (mask removed,
wrap), desktop chat shell (surface column, wider), tech header chrome, chat
send disabled state (slate → muted), staff role-chip hierarchy inversion.

Audit backlog (minors, not blocking): operations AR aging ramp reads
blue→green→brown→red (categorical rainbow; green on overdue money);
chips are body-size rather than the specced 11px micro chip; mobile KPI
strip collapses tall (needs a compact 390 layout); customers filter selects
unlabeled + card-grid density outlier; conversations page lacks a page
header; segmented-control style split (joined navy vs detached buttons);
title weights at 700 vs the 400-600 law; round-capped progress bars;
requests/calendar/dispatch horizontal scroll has no affordance at the clip
edge; staff "Pending invites" empty section needs an EmptyState; chat brand
tile status dot overlaps; audit also notes the app now reads "blue app"
(navy+info+medium urgency in one band) — consider splitting urgency-medium
off blue if it grates.
