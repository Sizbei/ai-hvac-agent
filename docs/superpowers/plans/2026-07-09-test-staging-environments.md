# Test + Staging Environments (with super-admin switching)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans, one phase at a time.

**Goal:** Three environments — **test** (local dev), **staging** (deployed pre-prod), **production** — each with its own database, plus an in-app, super-admin-visible environment badge and switcher so moving between them is one click.

**Architecture:** Databases are **Neon branches** of the prod DB (`test`, `staging`) — copy-on-write, instant, and born with all imported FieldPulse data; schema migrations apply per-branch. Locally, `.env.test` / `.env.staging` / `.env.local`(prod) select the target via `npm run dev:test` / `dev:staging` / `dev` (dotenv-cli). Deployed staging = a long-lived `staging` git branch on the existing Vercel project with **branch-scoped Preview env vars** (staging DATABASE_URL + env name). In-app, `NEXT_PUBLIC_ENV_NAME` drives a colored badge for everyone and a super_admin-only "Environments" switcher (links from `NEXT_PUBLIC_ENV_LINKS`); each env keeps its own login session (separate domains/DBs — expected).

## Ground truth (2026-07-09)
- One Neon DB today (prod, `ep-withered-hill-aq6bh0t4`); one Vercel project `ai-hvac-agent` (CLI authed as raycxn, project linked). `neonctl` 2.30.1 via npx but **unauthenticated** — needs `npx neonctl auth` (browser) or a `NEON_API_KEY`.
- Vercel **crons run only on production deployments** — staging previews won't double-run the FieldPulse syncs. Webhooks point only at the prod URL. The FP API key row copies into branches (fine — read paths only fire when code runs there).
- Admin sidebar: `src/components/admin/sidebar.tsx`; roles: `super_admin > admin > technician` via `getAdminSession`/authz.

## Global Constraints
- Secrets stay in gitignored env files / Vercel env vars — never committed. The switcher exposes only URLs.
- Env badge must be UNMISSABLE on prod (red "PRODUCTION") — the point is never mistaking which env you're writing to.
- The switcher renders for `super_admin` only; badge renders for all admin users.
- No new deps except `dotenv-cli` (dev-only) if needed for `dev:*` scripts.
- Base UI primitives (`render` prop, not Radix `asChild`); pure display helpers get node-env tests; `next build` in the final gate.

## Phase A — Neon auth + branches (USER ACTION then me)
1. USER: run `! npx neonctl auth` (browser OAuth) **or** provide a `NEON_API_KEY` for `.env.local`.
2. Me: `neonctl branches create --name staging` + `--name test` (off main), capture pooled connection strings; write `.env.staging` / `.env.test` (copies of `.env.local` with DATABASE_URL + `NEXT_PUBLIC_ENV_NAME` + `NEXT_PUBLIC_APP_URL` swapped; same AUTH_SECRET/ENCRYPTION_KEY so encrypted data + sessions decrypt identically on branch copies).
3. Verify: `db:migrate` no-op per branch; row counts match prod snapshot.

## Phase B — Local env switching
- Add dev-dep `dotenv-cli`; npm scripts: `dev:test` / `dev:staging` (`dotenv -e .env.test -- next dev` etc.), `db:migrate:test` / `db:migrate:staging`, and `fp:import` gains `--env test|staging` (loads the matching file; DEFAULTS to `.env.local`/prod only with the existing typed confirmation).
- `.gitignore`: ensure `.env.staging` / `.env.test` covered (verify `.env*` pattern).

## Phase C — In-app badge + super-admin switcher
- `NEXT_PUBLIC_ENV_NAME` (`production` default when unset) + `NEXT_PUBLIC_ENV_LINKS` (JSON `{name: adminUrl}`).
- Pure helper `src/lib/admin/environment.ts`: `envName()`, `envTone()` (production→red, staging→amber, test→green), `parseEnvLinks(json)` (safe-parse, drop self). Node-env tests.
- Sidebar: badge chip (all admins) + "Environments" section (super_admin only) listing other envs as links (Base UI, opens same tab). Session role already available where the sidebar renders — verify how sidebar gets role and follow it.
- Login page: same badge so you know where you're signing in.

## Phase D — Vercel staging + docs
- Create long-lived `staging` git branch (from main), push.
- Vercel: add Preview-scoped env vars for the `staging` branch (`vercel env add DATABASE_URL preview staging` etc.): staging DATABASE_URL, `NEXT_PUBLIC_ENV_NAME=staging`, `NEXT_PUBLIC_ENV_LINKS`, `NEXT_PUBLIC_APP_URL`= the stable branch alias (`https://ai-hvac-agent-git-staging-<team>.vercel.app` — confirm exact alias from the first deploy). Add prod's `NEXT_PUBLIC_ENV_NAME=production` + links too.
- `docs/ENVIRONMENTS.md`: the three envs, URLs, how to run against each locally, how staging deploys (push to `staging`), branch-refresh recipe (`neonctl branches reset test --parent` to re-clone from prod), and the cron/webhook safety notes. Link from README.

## Out of scope / decisions
- No deployed **test** app — test is the local-dev target (deployed previews of feature branches already exist via Vercel).
- No cross-env SSO (separate DBs by design; per-env login is the safety feature).
- Staging data refresh is manual (`branches reset`) — no auto-sync.
