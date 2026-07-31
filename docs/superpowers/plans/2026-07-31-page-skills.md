# Per-page repo skills + agent enablement plan

**Goal:** a `.claude/skills/` layer checked into the repo so any agent session
starts with distilled, *verified* knowledge of every page — plus shared
recipes/scripts that stop agents re-deriving the same session-mint/screenshot/
gate machinery every session.

## Why skills (not more docs)

Skills are auto-surfaced to Claude Code by name+description at the moment an
agent touches the matching page; a doc has to be found. Each skill is small
(≤80 lines), factual, and cites real file paths — the description line is the
retrieval key ("use when working on the dispatch map page").

## The page-skill template (every skill follows it)

```markdown
---
name: page-<slug>
description: Use when working on the <route> page — <one-line what it is>.
---

# <Page title> (<route>)

**Purpose:** <1-2 sentences — what an operator does here.>

**Files:** page `src/app/...page.tsx` · components `src/components/...`
· hooks `src/hooks/...` · API `src/app/api/...` · queries `src/lib/admin/...`
· tables <drizzle tables touched>

**Data flow:** <2-4 lines: where the numbers come from, caching/pagination
model, polling cadence.>

**Invariants (violate = bug):** <the page's hard rules — money guards,
tenancy scoping, terminology canon items specific to it, design-system
primitives it must compose, known deliberate behaviors that look like bugs.>

**Gotchas:** <the non-obvious traps past sessions hit on THIS page.>

**Verify changes:** <exact test files + `npx vitest run <path>`; visual =
see the admin-pages skill recipe; page-specific probes if any.>
```

Rules for authors: every path must exist (verified by script); no speculation;
invariants come from the shipped review waves + memory canon, not invention;
≤80 lines; sentence case.

## Skill inventory (31)

- `admin-pages` (shared): session-mint recipe (**signToken payload requires
  `name`**), screenshot recipe (dev server detached, warm-with-cookie, repo
  root scripts), gate commands + live baseline capture, deploy recipe
  (push + `vercel deploy --prod --yes`), terminology canon, design-system
  primitives list, demo-account restrictions, dev-DB quirks (test jobs
  geocoded to Manhattan; .env.local = DEV Neon branch, never prod).
- 25 admin page skills: dashboard, accounting, audit-log, calendar,
  communications, conversations, customers, dispatch, estimates,
  fieldpulse-import, insights, integrations, inventory, invoices, map,
  membership-plans, operations, platform, pricebook, reports, requests,
  reviews, settings, staff, technicians (detail pages fold into parents).
- 5 non-admin skills: `page-home` (marketing), `page-chat` (chat + success +
  /embed widget — incl. streaming guarded-flush invariants), `page-auth`
  (login/signup/forgot/invite), `page-portal` (customer token pages:
  portal/estimates/review by token), `page-tech` (tech-login + tech/jobs).

## Agent-enablement layer (built alongside)

1. `scripts/agent/mint-admin-session.mjs` — the session mint as a real
   script (env-load, super_admin lookup, `name` claim) printing the JWT.
2. `scripts/agent/screenshot-page.mjs <path> [width]` — mints, warms,
   screenshots to stdout-named file; kills nothing it didn't start.
3. `scripts/agent/prod-smoke.sh` — the standing prod probe pack: key pages
   200, demo login works, demo erase 403, mapkit-token 503-unconfigured,
   chat streaming ttfb<total probe.
4. `scripts/agent/verify-skills.mjs` — extracts every `src/...` path cited
   in `.claude/skills/**/SKILL.md` and fails if any doesn't exist (also run
   in the skills build to gate generation).
5. `AGENTS.md` enrichment — the repo-level operating manual agents actually
   read: gates + baseline, deploy gotcha, scripts above, canon pointer,
   frozen-safety-text + guardrail-regex invariants, no-jsdom test rule.

## Build order

1. Infrastructure: scripts 1-4 + AGENTS.md + `admin-pages` shared skill +
   exemplar `page-map` (this session's freshest knowledge). Verify scripts run.
2. Fan out 5 parallel skill-writers (disjoint page clusters), each reading
   the REAL source of its pages + the exemplar; template compliance mandatory.
3. Gate: run verify-skills (all paths exist), spot-review 3 random skills
   against source, commit, push.
