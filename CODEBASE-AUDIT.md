# Codebase Quality Audit — ai-hvac-agent

_Date: 2026-06-09 · Scope: whole-codebase quality (security, types, error handling, tests, dead code, tooling)_

## Summary

The codebase is in strong shape. Static checks are clean (`tsc` 0 errors across 382 files; ESLint 0 errors), security posture is solid (all admin routes authenticated, webhooks signature-verified and fail-closed, no secrets or unsafe sinks), and test coverage is broad (95 test files). The findings below are improvements, not defects — the only items above "minor" are a missing route-level test for the most complex file and the absence of `test`/`typecheck` npm scripts.

Overall grade: **A‑**.

## What was verified clean

**Security — no issues found.**
- No hardcoded secrets. `.env*` is gitignored; only `.env.example` is tracked.
- No `dangerouslySetInnerHTML`, `eval`, or `new Function` anywhere in `src`.
- All 32 `api/admin/*` routes enforce `getAdminSession()` and return 401 when absent — none unguarded.
- Webhooks fail closed with signature verification: Housecall Pro (HMAC-SHA256, `x-housecallpro-signature`), Twilio voice + SMS (`parseAndVerifyTwilioRequest`). Cron uses a `Bearer CRON_SECRET`.
- Customer-facing `session/*` routes combine a session token, a same-origin (CSRF) check, and rate limiting.
- All DB access goes through Drizzle ORM (parameterized) — no string-built SQL.

**Type safety & error handling — strong.**
- `tsc --noEmit`: 0 errors.
- Zero real `any` in application code (the 6 grep hits are the word "any" in prose/comments).
- No `@ts-ignore` / `@ts-expect-error`. Two `eslint-disable` lines, both justified (async fetch-on-mount).
- Only 8 non-null assertions across the app.
- Degrade-safe error handling is used consistently (CRM/config lookups fall back to safe defaults rather than failing the user's turn).

**Lint — now clean.** Fixed in this session: 45 warnings → 0 unused-var warnings. The 22 remaining warnings are exclusively the `react-hooks/set-state-in-effect` cases the config intentionally downgrades to "warn", plus 1 pre-existing `no-unused-expressions`.

**Repo hygiene.** No build artifacts tracked (`out/`, `coverage/`, `.next/`, `tsconfig.tsbuildinfo` all ignored).

## Findings & recommendations

### Medium

**M1 — `chat/route.ts` has no route-level test.** It's the largest and most complex file in the repo (~65 KB) and was the locus of both bugs fixed earlier this session (address truncation, system_type mis-gating). Its branching is currently covered only indirectly, through unit tests of its helpers (`slot-extract`, `triage`, `intent-router`, etc.) and a single e2e smoke test. A focused integration test that drives a few full intake transcripts (including a non-US address and a non-HVAC service line) would have caught both bugs directly. _Recommend: add `tests/api/chat.test.ts` with a mocked model + DB._

**M2 — No `test` or `typecheck` npm scripts.** `package.json` defines `lint` but neither `test` nor `typecheck`, so contributors and CI can't run the 95-file Vitest suite or the type-check via a standard command. _Recommend adding:_
```jsonc
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc --noEmit",
"coverage": "vitest run --coverage"
```

### Minor

**Mi1 — `webhooks/housecall` route lacks a route-level test** (the signature helper is tested in isolation, but the route handler is not).

**Mi2 — `src/lib/ai/text-normalize.ts` is untested.** It's small but logic-bearing and feeds the intent router; the other 4 untested `lib/ai` files are types/constants/data/provider wiring and don't need tests.

**Mi3 — `console.*` usage (35 sites).** Confined to React error boundaries (`error.tsx` — standard Next.js), CLI/DB scripts (`migrate`, `backfill`, `seed`), and the widget loader. Acceptable, but the project style rule says no `console` in production code; optionally route the error-boundary calls through the `pino` logger.

**Mi4 — Two empty `catch {}` blocks in `app/widget.js/route.ts`.** These guard `localStorage` read/write in the embedded widget and are idiomatic (storage can throw in private mode / on quota). Fine as-is; an inline comment would document intent.

### Housekeeping (environment)

- A stray `repro.mjs` (from this session's debugging) sits untracked in the repo root and should be deleted — it couldn't be removed from the sandbox. `rm -f repro.mjs`.
- Stale `.git/HEAD.lock` and `.git/index.lock` are blocking commits from the assistant's sandbox (it can't unlink files under `.git`). Clear with `rm -f .git/HEAD.lock .git/index.lock` before committing.

## Suggested next steps, in priority order

1. Clear the git locks and commit the pending lint cleanup.
2. Add the `test` / `typecheck` npm scripts (M2) — fast, unblocks CI.
3. Add a `chat/route.ts` integration test (M1) — highest defect-prevention value.
4. Backfill the smaller test gaps (Mi1, Mi2) opportunistically.
