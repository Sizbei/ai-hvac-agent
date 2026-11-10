---
name: verify-page
description: Use to verify a page end-to-end after changes — chains the gate, a real screenshot you must look at, and (post-deploy) the prod smoke pack. Usage /verify-page <route>.
---

# Verify a page

Run these in order for the page under change (route like `/admin/map`):

1. **Gate:** `npx tsc --noEmit` (0) · `npx eslint <changed files>` (0 errors)
   · `npx vitest run <the page skill's listed test files>` then the full
   suite — baseline must not drop.
2. **Visual:** dev server running (`npm run dev`, detached, kill after) →
   `node scripts/agent/screenshot-page.mjs <route> 1440` and
   `node scripts/agent/screenshot-page.mjs <route> 390` → READ both images
   yourself; claiming visual success without looking is a report violation.
   Mobile: no clipped tables/filters, overlays stack per the page skill.
3. **Skill sync:** if the change altered files, flows, or invariants the
   page's skill describes, update `.claude/skills/page-<slug>/SKILL.md` in
   the same commit, then `node scripts/agent/verify-skills.mjs` (0 missing).
4. **Post-deploy:** `vercel deploy --prod --yes` then
   `BASE=https://ai-hvac-agent-lovat.vercel.app bash scripts/agent/prod-smoke.sh`; for visual pages, screenshot prod via
   View as (platform owner) — see docs/spears-handover.md — and look at it.
