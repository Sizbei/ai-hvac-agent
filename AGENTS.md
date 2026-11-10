<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent operating manual

Per-page knowledge lives in `.claude/skills/` (`page-<slug>` per page +
`admin-pages` shared recipes) — invoke the matching skill before editing a
page. This file holds only the repo-wide facts every session needs.

## Gates (before any commit)

`npx tsc --noEmit` → 0 · `npx eslint <changed>` → 0 errors · `npx vitest run`
→ capture the live baseline FIRST and don't let it drop. No jsdom/RTL —
pure-helper vitest only; test component logic by extracting pure functions.

## Deploy

`git push` does NOT reliably trigger Vercel builds. First
`npx tsx scripts/agent/predeploy-check.mjs` (must exit 0), deploy with
`vercel deploy --prod --yes`, then
`BASE=https://ai-hvac-agent-lovat.vercel.app bash scripts/agent/prod-smoke.sh`
(read-only; `SMOKE_WRITES=1` adds the chat probe, and off localhost it also
needs `SMOKE_PROD_WRITES=1`). Migrations auto-run in the build; the migrator refuses the prod host
outside `VERCEL_ENV=production`. Vercel Hobby caps crons at daily.

## Agent scripts (`scripts/agent/`)

- `mint-admin-session.mjs` — dev admin JWT (payload requires `name`).
- `screenshot-page.mjs <path> [width]` — screenshot with minted session
  (dev server must already be running). Look at the image yourself.
- `prod-smoke.sh` — post-deploy probe pack (pages, demo guards; streaming
  only with `SMOKE_WRITES=1`). `BASE` is required.
- `predeploy-check.mjs [--env production|preview]` — env var names, migration
  journal, and (production) clean `main` at `origin/main`. Never prints values.
- `verify-skills.mjs` — every path cited in `.claude/skills` must exist.
- `seed-org.mjs --name "…" [--customers N] [--invoices N]` — seed a fictional
  demo org (dev only; `--force` reseeds that org).

## Multiple demo orgs

The dev branch carries several fictional tenants; `seed-org.mjs` adds another
(customers, invoices, pricebook, technicians, requests). `mint-admin-session.mjs`
honors `MINT_ORG_ID=<org id>` to scope the session to one of them instead of
"whichever super_admin comes first" — `screenshot-page.mjs` passes it through.

## Hard invariants

- `.env.local` = DEV Neon branch. NEVER point it at prod (ep-withered-hill).
- FROZEN safety text in `src/lib/ai` prompts and the guardrail regexes in
  `src/lib/ai/output-guardrail.ts` are untouchable (the chat-streaming
  safety proof depends on the regex shape).
- neon-http: `db.transaction()` throws at runtime — use `db.batch()`.
- Background work on Vercel: `after()` from next/server, never detached
  promises.
- Tenancy: every admin query scopes by session organizationId.
- Copy canon: request / technician / sign in / cancelled / Unicode … /
  sentence case / human error copy (no err.message in UI).
- Hand-authored migrations: `drizzle/00XX.sql` needs `--> statement-breakpoint`
  separators + `_journal.json` entry + snapshot copy; `drizzle-kit generate`
  must then report "No schema changes".
