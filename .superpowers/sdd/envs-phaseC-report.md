# Phase C — Environment Badge + Super-Admin Env Switcher

## Role prop path

`layout.tsx` (server component, has session) → `DashboardShell` (client, added `role: AdminRole`) → `Sidebar` (client, added `role: AdminRole`). The env-links array is computed inside `Sidebar` using `role` so no extra prop is needed.

## Chip / tone design

`EnvBadge` (`src/components/admin/env-badge.tsx`) is a pure client component. It reads `envName()` at render time and maps the tone via `envTone()`:

| env        | tone        | classes                                                       |
|------------|-------------|---------------------------------------------------------------|
| production | destructive | `bg-destructive/10 text-destructive border-destructive/30`    |
| staging    | warning     | `bg-amber-500/10 text-amber-600 border border-amber-500/30`   |
| anything else | positive | `bg-emerald-500/10 text-emerald-600 border border-emerald-500/30` |

The chip is a single `<span>` with `uppercase tracking-widest text-[10px] font-semibold`. It appears:
- **Sidebar (desktop expanded + mobile):** below `BrandMark` in the logo zone.
- **Login page:** centred below the `CardDescription` heading.
- **Sidebar (desktop collapsed):** hidden (width constraint; badge collapses gracefully).

## Helper behaviours (`src/lib/admin/environment.ts`)

- `envName()` → `NEXT_PUBLIC_ENV_NAME.toLowerCase()` or `'production'`.
- `envTone(name)` → `'destructive' | 'warning' | 'positive'`.
- `parseEnvLinks(json, self)` → parses `{name: url}` JSON; drops self entry (case-insensitive); drops non-http(s) URLs; returns [] on malformed input; stable order: production > staging > test > alphabetical others.

## Env switcher

Rendered only when `role === 'super_admin'` AND `parseEnvLinks(...)` returns ≥ 1 link. Appears as an "Environments" group (group heading + `<a href>` links) in the bottom section of the sidebar, above the user block. Hidden in the collapsed desktop rail. Uses the same group/item styling as the nav.

## Test / build results

- `vitest run environment.test.ts`: 23/23 passed
- `tsc --noEmit`: 0 errors
- `eslint` on changed files: 0 errors (4 pre-existing warnings in unrelated files)
- `next build`: compiled successfully (123 pages)
