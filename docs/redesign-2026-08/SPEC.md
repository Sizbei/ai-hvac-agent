# Redesign 2026-08 — "Shop floor instrument" (v2, post-adversarial-review)

Owner's brief: *"everything looks outdated and old… it looks too much like AI."*
v1 was synthesized from a 4-direction × 3-judge workflow (unanimous winner:
Industrial Utility). v2 folds in a 3-critic adversarial review of v1 against the
real codebase (59 findings; every blocker/major resolved or explicitly descoped
below). This file is the single implementation authority; the raw direction dossier
is `DIRECTION.md`, the raw findings are in the workflow journals.

## Thesis

Instrument-panel software: warm-graphite shell, hairline structure instead of
floating shadowed cards, dense chrome, every number in tabular mono. Deletes all
four AI-template tells at once: blue-gray slate canvas, white-card-with-soft-shadow
grid, pill badges, neutral-body+trendy-display font pairing.

**The one law:** every neutral is hue 95 (warm graphite), chroma ≤ 0.010.
No neutral may use hue 220–265. Clamp any out-of-sRGB-gamut value by reducing
chroma (audit on sRGB, not P3).

## Scope rulings (from review)

- **BRANCH STRATEGY:** all work on branch `redesign/shop-floor`. Merge to main only
  when the full program (commits 1–3) is complete and gates are green. If the night
  runs out mid-sweep, the branch stays pushed and main stays untouched —
  half-migrated must never reach main.
- **DESCOPED (not presentation-only or not implementable tonight):** the console
  bar (net-new feature; admin shell never scrolls the window so its sticky trigger
  can't work); the density SETTING UI + persistence (the `data-density` CSS hooks
  ship inert); the contrast SETTING UI (high-contrast ships via media query for
  <768px and a `.touch-surface` wrapper for /tech, no toggle).
- **EXEMPT tonight (follow-ups, listed in LEDGER):** `widget.js` + `/embed` embed
  styles, map pin/marker colors inside the map libraries, HTML email/SMS template
  styling, dark mode verification (the `.dark` block is re-pointed to the graphite
  ramp for completeness but the app has no dark toggle — dead code, not verified).
- **EXEMPT from the austerity laws (but IN scope for fonts + palette):** the public
  landing page `/`, `/signup`, and the auth screens keep their gradients/mesh/
  atmosphere (marketing surfaces); they move to Archivo and the new accent tokens.
- **The paper invoice document** (`invoice-document.tsx`) pins its sheet to
  `--surface-raised` (pure white) — the paper look must survive the warm canvas.
- **No file renames** (card→panel etc. are restyles in place; `verify-skills.mjs`
  must stay green).
- **Circular exemptions:** technician photos, switch knobs, radio buttons, spinner
  glyphs stay round. Everything else: no `rounded-full`, no `rounded-4xl`.

## Tokens (globals.css `:root` — replace wholesale; keep every legacy name)

```css
:root {
  --radius: 0.375rem;                    /* 6px */
  /* pin the ceiling literally; sm–xl stay on the calc ladder */
  /* @theme: --radius-2xl: 0.625rem; --radius-3xl: 0.625rem; --radius-4xl: 0.625rem; */

  /* surfaces: lightness stacks UP; white = "you can type in it" */
  --canvas:          oklch(0.955 0.004 95);
  --surface:         oklch(0.982 0.003 95);
  --surface-raised:  oklch(1 0 0);
  --surface-sunken:  oklch(0.930 0.005 95);
  --background: var(--surface);
  --background-admin: var(--canvas);
  --card: var(--surface);
  --popover: var(--surface-raised);

  /* text */
  --foreground:       oklch(0.245 0.010 95);
  --muted-foreground: oklch(0.460 0.009 95);   /* 4.65:1 floor for text */
  --foreground-faint: oklch(0.620 0.008 95);   /* icons/dividers/disabled ONLY, never text */

  /* structure */
  --border:        oklch(0.885 0.006 95);
  --border-strong: oklch(0.795 0.008 95);
  --border-input:  oklch(0.600 0.010 95);
  --input: var(--border-input);

  /* primary = Spears navy (buttons/fills). teal = working marker. cyan = signal. */
  --primary:            oklch(0.270 0.058 258);   /* white text 14.9:1 */
  --primary-foreground: oklch(0.99 0 0);
  --primary-deep:       oklch(0.34 0.065 258);    /* hover: one visible step lighter */
  --marker:             oklch(0.45 0.10 207);     /* active-nav bar, sort underline, chart-1 */
  --marker-strong:      oklch(0.38 0.09 207);     /* chip text on marker-light */
  --marker-light:       oklch(0.945 0.030 207);   /* in-motion status chip bg */
  --marker-border:      oklch(0.850 0.055 207);
  --primary-soft:       oklch(0.950 0.024 207);   /* selected-row fill + active nav fill */
  --primary-border:     oklch(0.860 0.045 207);
  --row-hover:          oklch(0.965 0.010 207);   /* literal tint — NOT color-mix (oklch
                                                     hue interpolation lands on warm gray) */
  --ring:               oklch(0.55 0.12 207);
  --link:               var(--marker);            /* text-primary link sites repoint here */
  --hvac-accent:        var(--marker);
  --signal:             oklch(0.58 0.12 220);     /* live dot + AI-panel border; must
                                                     measure ≥3:1 on --surface — verify in test */

  /* semantic families (distinct L for CVD) */
  --success: oklch(0.50 0.115 152);  --success-foreground: oklch(0.99 0 0);
  --success-strong: oklch(0.40 0.100 152); --success-light: oklch(0.945 0.035 152);
  --success-border: oklch(0.850 0.060 152);
  --warning: oklch(0.66 0.145 62);   --warning-foreground: oklch(0.45 0.110 55);
  --warning-strong: oklch(0.45 0.110 55); --warning-light: oklch(0.955 0.045 75);
  --warning-border: oklch(0.860 0.080 70);
  --danger: oklch(0.505 0.185 27);   --danger-foreground: oklch(0.99 0 0);
  --danger-strong: oklch(0.44 0.170 27); --danger-light: oklch(0.955 0.030 27);
  --danger-border: oklch(0.870 0.060 25);
  --destructive: var(--danger);
  --info: oklch(0.505 0.105 258);    --info-foreground: oklch(0.43 0.105 258);
  --info-strong: oklch(0.43 0.105 258); --info-light: oklch(0.950 0.030 258);
  --info-border: oklch(0.860 0.050 258);

  /* neutrals */
  --secondary: oklch(0.930 0.005 95); --secondary-foreground: var(--foreground);
  --muted: oklch(0.930 0.005 95);
  --accent: oklch(0.945 0.004 95);    --accent-foreground: var(--foreground);

  /* charts — defined for the future; NOTHING consumes them today (no chart lib) */
  --chart-1: oklch(0.45 0.100 207); --chart-2: oklch(0.505 0.105 258);
  --chart-3: oklch(0.62 0.130 62);  --chart-4: oklch(0.50 0.115 152);
  --chart-5: oklch(0.46 0.090 320); --chart-6: oklch(0.58 0.020 95);

  /* sidebar: light sunken rail (the dark navy rail is deleted) */
  --sidebar: var(--surface-sunken);
  --sidebar-foreground: oklch(0.330 0.008 95);
  --sidebar-primary: var(--primary);
  --sidebar-primary-foreground: oklch(0.99 0 0);
  --sidebar-accent: oklch(0.905 0.005 95);
  --sidebar-accent-foreground: var(--foreground);
  --sidebar-border: oklch(0.870 0.006 95);
  --sidebar-ring: var(--ring);

  /* brand (BrandMark + marketing only) */
  --brand-cyan: oklch(0.72 0.13 220);
  --brand-navy: oklch(0.27 0.06 258);

  /* elevation: exactly three shadows */
  --shadow-pop: 0 1px 2px oklch(0.245 0.010 95 / 0.10),
                0 8px 24px -8px oklch(0.245 0.010 95 / 0.18);
  --shadow-sticky: 0 6px 10px -10px oklch(0.245 0.010 95 / 0.35);
  --keyline-top: inset 0 1px 0 oklch(1 0 0 / 0.65);

  /* motion */
  --dur-press: 60ms; --dur-hover: 80ms; --dur-exit: 140ms;
  --dur-enter: 180ms; --dur-sheet: 240ms;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-move: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-sheet: cubic-bezier(0.32, 0.72, 0, 1);

  /* density: COMFORTABLE is the default. dense hooks ship inert (no UI tonight). */
  --text-body: 14px; --row-h: 44px;
  --cell-px: 12px; --cell-py: 8px; --panel-p: 16px;
  --page-gutter: 24px; --sidebar-w: 232px;

  /* ink ramp: hue-95 migration targets for raw grays */
  --ink-975: oklch(0.155 0.004 95); --ink-950: oklch(0.185 0.004 95);
  --ink-900: oklch(0.245 0.010 95); --ink-800: oklch(0.330 0.008 95);
  --ink-700: oklch(0.460 0.009 95); --ink-600: oklch(0.620 0.008 95);
  --ink-500: oklch(0.795 0.008 95); --ink-400: oklch(0.885 0.006 95);
  --ink-300: oklch(0.905 0.005 95); --ink-200: oklch(0.930 0.005 95);
  --ink-100: oklch(0.955 0.004 95); --ink-50:  oklch(0.982 0.003 95);
}
html[data-density="dense"] { --text-body: 13px; --row-h: 36px; }  /* inert hook */
```

**`@theme inline` — enumerate EVERY new token or its utility never exists**
(a verified blocker in v1): `--color-canvas`, `--color-surface`,
`--color-surface-raised`, `--color-surface-sunken`, `--color-border-strong`,
`--color-border-input`, `--color-primary-soft`, `--color-primary-border`,
`--color-primary-deep`, `--color-marker`, `--color-marker-strong`,
`--color-marker-light`, `--color-marker-border`, `--color-row-hover`,
`--color-link`, `--color-signal`, `--color-warning-strong`,
`--color-success-border`, `--color-warning-border`, `--color-danger-border`,
`--color-info-border`, `--color-foreground-faint`, `--color-brand-cyan`,
`--color-brand-navy`, all twelve `--color-ink-*`, plus
`--font-sans: var(--font-archivo)`, `--font-heading: var(--font-archivo)`,
`--font-display: var(--font-archivo)` (legacy consumers), 
`--font-mono: var(--font-plex-mono)`, and the literal radius pins
`--radius-2xl/3xl/4xl: 0.625rem`. Shadow/motion/density vars stay raw CSS
(consumed via `var()` / arbitrary values), stated deliberately.

**Dark `.dark` block:** re-point to the graphite ramp per DIRECTION.md's dark
values with `--primary: oklch(0.70 0.105 207)` + dark text (navy unusable on
graphite), `--marker: var(--primary)`, `--signal: oklch(0.68 0.12 220)`, ink ramp
mirrored downward from 0.945. Complete values, no prose deltas — but NOT verified
(no dark toggle exists).

## Typography

Loaders exist in THREE files — all must change: `src/app/layout.tsx`,
`src/app/page.tsx`, `src/components/auth/auth-shell.tsx`. Delete Inter and all
`Bricolage_Grotesque` loaders.

```ts
import { Archivo, IBM_Plex_Mono } from "next/font/google";
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400","500","600"], variable: "--font-plex-mono", display: "swap" });
// <html className={`${archivo.variable} ${plexMono.variable} …`}>  ← .variable, NOT .className
```

The 13 `font-[family-name:var(--font-display)]` sites (page.tsx, auth-shell.tsx)
become `font-heading`; `--font-display` also aliases Archivo in @theme as a belt.
Fallback if `axes:["wdth"]` fails the build: **Roboto Flex or Encode Sans** (both
have a real wdth axis; Schibsted Grotesk does NOT) — or drop `font-stretch` and
compensate with `letter-spacing: 0.08em` + weight 600.

Scale: micro 11/14 (600, +0.04em) · caption 12/16 · body `var(--text-body)`
(14 default) · body-lg 14–15 for prose (chat/portal/insights) · title-sm 15/20/600 ·
title 20/26/600/-0.02em · display 26/30 mono 500 tabular (KPI) · display-lg 34/38
mono (hero metric). Weights 400/500/600 only (700 = BrandMark; the two live 700
sites in auth/landing headings are allowed — marketing exemption).

`.u-label` (uppercase micro): CSS-only transform, `font-stretch: 82%`,
+0.07em — used ONLY for sidebar group labels and status chips. Table headers and
KPI labels: sentence case, 11px/600/+0.04em `--muted-foreground`.

**Mono mandatory** (`font-mono tabular-nums`, 0.92em) for money, ids, phones,
dates/times, durations, counts, percentages. Money: right-aligned; `$0.00` in
`--muted-foreground` (NOT faint — faint fails AA and is banned for text);
negative uses U+2212; symbol AND cents at 0.82em `--muted-foreground`.

## Surfaces (as v1, with review fixes)

- Panels: `bg --surface; 1px --border-strong; radius 6px; no shadow`. 40px sunken
  header band + keyline. Fused strips for KPI bands/filter rows (one container,
  internal hairlines, zero gap). KPI cell: sentence-case label / 26px mono value /
  ▲▼ delta — no pills, no tinted icon chips.
- Tables: sticky 32px sunken header (`inset 0 -1px 0 var(--border-strong)`
  box-shadow, not border), 44px rows (36px dense hook), hairline dividers, no
  zebra. Hover `--row-hover`; selected `--primary-soft` + `inset 2px 0 0
  var(--marker)`; sort = 2px marker underline. Numeric columns right mono.
  Full-bleed row rules (leading/trailing cells `padding-inline: 0`). Exception
  rows: 2px status left edge, body stays `--surface`. <640px: stacked records.
- Status chips: 3px radius, 20px, `--<sem>-light` bg + `--<sem>-border` +
  `--<sem>-strong` text, 11px/500 `.u-label` style. **Neutral chips use
  `--surface-raised` bg** (muted bg vanishes on sunken bands). Shape glyphs
  (7px: circle/square/triangle/diamond) ship as REDUNDANT reinforcement inside
  the shared badge components only — label text remains the primary
  disambiguator; shapes attach per semantic family, statuses within a family
  are distinguished by their label.
- **status-colors.ts reality** (enum-keyed maps, six of them): re-point class
  strings in place. In-motion request statuses (`scheduled`, `assigned`,
  `in_progress`) move to the **marker family** (`bg-marker-light
  text-marker-strong border-marker-border`) — distinct from info-blue banners and
  from navy primary. `REQUEST_STATUS_DOT` re-points the same way. Neutral entries
  keep muted tokens (+ raised bg in chip context). Add a pure-helper vitest that
  PARSES globals.css for the oklch values (single source of truth), converts to
  sRGB, and asserts every chip text/bg pairing ≥4.5:1 and `--signal`/`--marker`
  on `--surface` ≥3:1 — computed from the file, never from prose numbers.
- Buttons 30px (sm 26, lg 34), radius 4.8px: primary navy (hover `--primary-deep`),
  secondary raised+border-input, ghost, destructive. No gradients/hover-scale/
  hover-shadow. **Links: `text-link`** (teal) — `text-primary` as a link color is
  dead (1.07:1 vs body text under navy).
- Inputs 30px on `--surface-raised`, 1px `--border-input`, recessed inset
  `inset 0 1px 2px oklch(0.245 0.010 95 / 0.05)`; focus = `outline: 2px solid
  var(--ring); outline-offset: 1px` (the two-ring shadow conflicted with the
  recessed inset and fused-strip overflow — reverted). All six input states.
- Detail pages: ruled definition lists (140px label / value right / hairline per
  pair). Chat bubbles keep `--radius-xl`. Avatars square 4px mono initials
  (technician photos stay round).
- **badge.tsx: `rounded-4xl` → `rounded-[3px]` in COMMIT 1** (the radius ceiling
  alone leaves a 20px-tall pill perfectly round — verified).

## Chrome

Sidebar = **component rewrite, not a token repoint** (it is 452 lines of
hardcoded white-on-navy with a literal gradient; both the mobile AND desktop
trees). Replace every `text-white*`, `bg-white/*`, `border-white/*`,
`bg-amber-500`, `from-[oklch(…)]` literal with `--sidebar-*` tokens per the v1
spec (light sunken rail, `.u-label` group labels, 30px items, active =
`--primary-soft` + 2px `--marker` inset bar, bare mono counts). BrandMark:
re-point its fills from `--primary` to `--brand-cyan`/`--brand-navy` explicitly
(it currently paints from `--primary` and would silently go navy); keep its
existing dimensions. Mobile sheet + collapse behavior unchanged.
Page header: title 20px + description + action; tabs on a `--border-strong` rule
with a sliding 2px `--marker` indicator. Alignment covenant: one 24px gutter
shared by title, panel headers, and first-cell text; rules on 4px multiples.

## Density & touch

4px base; legal steps 4/8/12/16/20/24/32/40/56. Comfortable defaults everywhere
(14px/44px). Airy carve-outs: empty states, insights narrative (68ch), auth,
modals. **Touch carve-out via CSS media queries + `.touch-surface` wrapper**
(no JS): `/tech`, `/portal/*`, `/estimates/[token]`, `/review/[token]`, and
<768px admin get base 14–15px, ≥44px targets, 40px controls, `--radius-xl`
controls, and the darker border pair (high-contrast baked in via the same
media query — no toggle). Drag targets ≥32px; 44px hit areas via `::before`.

## Motion

As v1: crisp, mechanical, nothing bounces; menus 140ms from trigger origin,
modals 180ms centered, tab underline 160ms, toasts (restyle the ONE existing
hand-rolled toast — no new system), dnd ghost `--shadow-pop` + 1px `--marker`
border with instant drop-target affordance. Never: row stagger, count-ups, chart
draw-ins, route transitions, keyboard-initiated animation, hover scale/shadow/
glow, layout-property animation. Skeletons: opacity breathe 0.55↔0.9 ~1.5s
(REPLACE the existing shimmer util if present). Value-change flash
`--primary-soft` 600ms + 400ms fade. `prefers-reduced-motion`: keep opacity/color
at 100ms, zero transforms (replace the blanket 0.01ms rule). Hover rules behind
`@media (hover:hover) and (pointer:fine)`. Landing-page `lp-*` atmosphere
keyframes stay (marketing exemption).

## Migration plan (branch `redesign/shop-floor`, 3 commits)

1. **Foundation** — globals.css wholesale (tokens + @theme enumeration + radius
   pins + reduced-motion fix + `.u-label` + hover gating), fonts in all THREE
   loader files + 13 display-font consumers, `badge.tsx` de-pill, BrandMark
   repoint, **sidebar rewrite**, status-colors.ts repoint (+ dot map) + contrast
   vitest, invoice-document paper pin, `--link` repoints of the ~8 bare
   `text-primary` link sites (button.tsx/badge.tsx link variants included).
   GATE: screenshots of dashboard/dispatch/invoices/chat/login must be coherent.
2. **Primitives** — all 39 files across `src/components/ui/` (21) and
   `src/components/admin/ui/` (18): button, card, table, input, dialog, tabs,
   select, dropdown, sheet, tooltip, skeleton(breathe), stat-card→KPI cell,
   section-card→panel header band, data-table-shell, tab-group, page-header,
   empty/error states, chip shapes in the badge components. Restyle in place, no
   renames.
3. **Sweep** — expanded grep gate (all verified-missing patterns):
   `rounded-full|rounded-4xl|shadow-(sm|md|lg|xl|2xl)|bg-white|text-white|
   text-gray-|bg-slate-|text-slate-|bg-amber-|text-amber-|bg-blue-|text-blue-|
   bg-red-|text-red-|bg-emerald-|text-emerald-|bg-orange-|text-orange-|
   bg-green-|text-green-|bg-yellow-|text-yellow-|text-primary|oklch\(`
   in `src/` tsx (~81+ files, ~200 raw-color sites incl. the calendar urgency
   system and dispatch-map hues) → migrate to tokens per this spec, with
   per-site judgment (semantic → family tokens; link → `--link`; decorative →
   ink ramp). Page-level compositions: fused KPI strips, definition-list detail
   pages, exception rows, stacked mobile tables, touch carve-out.
   **Abort rule:** commits 1+2 constitute a shippable stopping point; if the
   sweep can't finish, the branch holds and main is untouched.

## Verification

- Screenshot EVERY route at 1440 + 390: the ~29 admin pages, `/`, `/signup`,
  `/admin/login`, `/chat`, `/chat/success`, `/tech-login`, `/tech/jobs`,
  portal + estimate + review token pages (mint a portal token via
  `POST /api/admin/customers/{id}/portal-token` with the dev admin cookie; pull
  estimate/review tokens from the dev DB), error pages. Review with eyes.
- Teal-scarcity audit: marker-teal elements countable per screen.
- Gates: `npx tsc --noEmit` 0 · eslint 0 errors · vitest **no NEW failures vs the
  live baseline captured at run start** (known pre-existing flake:
  `src/lib/crypto.test.ts` "should throw on tampered ciphertext" — re-run once
  before treating as regression) · `verify-skills.mjs` green.
- Guardrails: presentation-only; FROZEN safety text + guardrail regexes
  untouched; sentence-case canon (uppercase is CSS-only); page skills invoked
  before editing pages; **no production deploy**.
