# Task 1.1 Report — Tokens + display font

**Status:** DONE  
**Commit SHA:** (see below — committed after this file)

## Tokens added
- `--primary-deep: oklch(0.62 0.13 222)` (light) / `oklch(0.55 0.13 222)` (dark)
- `--background-admin: oklch(0.97 0.006 240)` (light) / `oklch(0.22 0.05 258)` (dark)
- `--info: oklch(0.62 0.10 222)` (light) / `oklch(0.70 0.10 222)` (dark)
- `--info-light: oklch(0.95 0.03 220)` (light) / `oklch(0.28 0.06 222)` (dark)
- `--info-foreground: oklch(0.27 0.06 258)` (light) / `oklch(0.95 0.03 220)` (dark)
- All five exposed as `--color-*` aliases in `@theme inline`

## Tokens removed
- `--hvac-accent-light` (light + dark) — zero src/ references confirmed via grep
- `--hvac-primary-light` (light + dark) — zero src/ references confirmed via grep
- `--color-hvac-accent-light` and `--color-hvac-primary-light` from `@theme inline`

## Other changes
- `layout.tsx`: `Bricolage_Grotesque` loaded with weights 600/700/800, variable `--font-display`, applied to `<html>` as `bricolage.variable`
- `globals.css` `@theme inline`: `--font-heading` remapped from `var(--font-sans)` → `var(--font-display)`
- `dashboard-shell.tsx`: `bg-[oklch(0.97_0.006_240)]` → `bg-background-admin`

## Verification
- `npx tsc --noEmit`: 0 errors
- `npm run lint`: 0 errors (98 pre-existing warnings, none new)
- `npx vitest run`: 293 files passed, 3981 tests passed, 1 skipped
- Playwright desktop (1440px) + mobile (390px) screenshots of /admin: no horizontal scroll
- Computed `font-family` on `h1` confirmed as `"Bricolage Grotesque"` via `page.evaluate()`
- `--background-admin`, `--primary-deep`, `--info` all resolve in devtools
- `--hvac-accent-light` resolves to empty string (deleted)

## Concerns
None. The `auth-shell.tsx` also loads Bricolage locally — this is now redundant but harmless (Next.js dedupes the font request). A follow-up could remove it from auth-shell, but that's out of scope for 1.1.
