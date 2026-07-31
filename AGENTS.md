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

`git push` does NOT reliably trigger Vercel builds. Deploy with
`vercel deploy --prod --yes`, then `bash scripts/agent/prod-smoke.sh`.
Migrations auto-run in the build. Vercel Hobby caps crons at daily.

## Agent scripts (`scripts/agent/`)

- `mint-admin-session.mjs` — dev admin JWT (payload requires `name`).
- `screenshot-page.mjs <path> [width]` — screenshot with minted session
  (dev server must already be running). Look at the image yourself.
- `prod-smoke.sh` — post-deploy probe pack (pages, demo guards, streaming).
- `verify-skills.mjs` — every path cited in `.claude/skills` must exist.

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
