# WINNING DIRECTION (full)

## name
Industrial Utility — "Shop Floor Instrument"

## thesis
Instrument-panel software: a warm-graphite near-neutral shell, hairline structure instead of floating shadowed cards, 13px dense chrome, and every number set in tabular mono. It reads as a tool that dispatchers live inside eight hours a day, not a marketing page with a nav — the confidence comes from restraint and density, not from decoration. It cannot read as AI-generated because it deletes all four tells at once: the blue-gray slate canvas, the white-card-with-soft-shadow grid, the pill badges, and the Inter + trendy-display-font pairing. One type family in three cuts, one deep teal accent, borders doing all the work.

## thesis_note
n/a

## tokens
Replace the `:root` / `.dark` blocks in `src/app/globals.css` wholesale. Existing token names are kept and re-pointed so no page-level class has to change (presentation-only). New names are additive.

NEUTRAL HUE LAW: every neutral uses hue 95 (warm graphite / limestone) at chroma ≤ 0.010. No neutral may use hue 220-265. This single rule is what kills the AI look.

```css
@theme inline {
  /* ── keep every existing mapping in the current file, then ADD: ── */
  --color-canvas: var(--canvas);
  --color-surface: var(--surface);
  --color-surface-raised: var(--surface-raised);
  --color-surface-sunken: var(--surface-sunken);
  --color-border-strong: var(--border-strong);
  --color-border-input: var(--border-input);
  --color-primary-soft: var(--primary-soft);
  --color-primary-border: var(--primary-border);
  --color-success-border: var(--success-border);
  --color-warning-border: var(--warning-border);
  --color-danger-border: var(--danger-border);
  --color-info-border: var(--info-border);
  --color-foreground-faint: var(--foreground-faint);
  --color-brand-cyan: var(--brand-cyan);
  --color-brand-navy: var(--brand-navy);

  --font-sans: var(--font-plex-sans);
  --font-label: var(--font-plex-condensed);
  --font-mono: var(--font-plex-mono);
  --font-heading: var(--font-plex-sans);   /* no separate display face, on purpose */

  /* radius scale resolves to 3.6 / 4.8 / 6 / 8.4 px */
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
  --radius: 0.375rem;               /* 6px. was 10px. */

  /* ── surfaces: lightness STACKS UP. white = "you can type in it". ── */
  --canvas:          oklch(0.955 0.004 95);   /* app shell / admin background */
  --surface:         oklch(0.982 0.003 95);   /* panels, cards, table body */
  --surface-raised:  oklch(1     0     0);    /* popovers, menus, inputs, modals */
  --surface-sunken:  oklch(0.930 0.005 95);   /* table header band, toolbars, sidebar, code/log */

  --background:      var(--surface);          /* legacy alias */
  --background-admin: var(--canvas);          /* legacy alias, used across admin */
  --card:            var(--surface);
  --popover:         var(--surface-raised);

  /* ── text ── */
  --foreground:         oklch(0.245 0.010 95);  /* graphite, NOT navy. 9.9:1 on canvas */
  --card-foreground:    var(--foreground);
  --popover-foreground: var(--foreground);
  --muted-foreground:   oklch(0.460 0.009 95);  /* 4.65:1 on canvas — the floor for any text */
  --foreground-faint:   oklch(0.620 0.008 95);  /* DECORATIVE ONLY: icons, dividers, disabled glyphs. never text. */

  /* ── structure ── */
  --border:        oklch(0.885 0.006 95);  /* hairline: row dividers, card edges */
  --border-strong: oklch(0.795 0.008 95);  /* structural: panel outer edge, section splits, sticky-header underline */
  --border-input:  oklch(0.600 0.010 95);  /* 3.17:1 on white — WCAG 1.4.11 for form boundaries */
  --input:         var(--border-input);

  /* ── one accent: deep industrial teal (Spears cyan, matured) ── */
  --primary:            oklch(0.45 0.10 207);   /* 5.37:1 on white, 4.82:1 on canvas */
  --primary-foreground: oklch(0.99 0 0);
  --primary-deep:       oklch(0.40 0.10 207);   /* hover */
  --primary-soft:       oklch(0.950 0.024 207); /* selected row, active nav fill */
  --primary-border:     oklch(0.860 0.045 207);
  --ring:               oklch(0.55 0.12 207);   /* 3.76:1 on white, 3.37:1 on canvas */
  --hvac-accent:        var(--primary);

  /* ── semantic. L values deliberately differ so they survive grayscale/CVD ── */
  --success:            oklch(0.50 0.115 152);
  --success-foreground: oklch(0.99 0 0);
  --success-strong:     oklch(0.40 0.100 152);  /* 5.6:1 on success-light */
  --success-light:      oklch(0.945 0.035 152);
  --success-border:     oklch(0.850 0.060 152);

  --warning:            oklch(0.66 0.145 62);   /* safety amber — the one "hazard" colour */
  --warning-foreground: oklch(0.45 0.110 55);   /* legacy name used as text-on-light */
  --warning-strong:     oklch(0.45 0.110 55);   /* 4.82:1 on warning-light */
  --warning-light:      oklch(0.955 0.045 75);
  --warning-border:     oklch(0.860 0.080 70);

  --danger:             oklch(0.505 0.185 27);
  --danger-foreground:  oklch(0.99 0 0);
  --danger-strong:      oklch(0.44 0.170 27);   /* 5.0:1 on danger-light */
  --danger-light:       oklch(0.955 0.030 27);
  --danger-border:      oklch(0.870 0.060 25);
  --destructive:        var(--danger);

  /* info is BLUE, not the accent — info must never look like a primary action */
  --info:               oklch(0.505 0.105 258);
  --info-foreground:    oklch(0.43 0.105 258);  /* legacy name used as text-on-light */
  --info-strong:        oklch(0.43 0.105 258);  /* 5.19:1 on info-light */
  --info-light:         oklch(0.950 0.030 258);
  --info-border:        oklch(0.860 0.050 258);

  /* ── neutral / muted surfaces ── */
  --secondary:            oklch(0.930 0.005 95);
  --secondary-foreground: var(--foreground);
  --muted:                oklch(0.930 0.005 95);
  --accent:               oklch(0.945 0.004 95);  /* hover fill */
  --accent-foreground:    var(--foreground);

  /* ── charts: hue-separated, equal perceptual weight, colourblind-checked ── */
  --chart-1: oklch(0.45 0.100 207);  /* teal (primary series) */
  --chart-2: oklch(0.505 0.105 258); /* blue */
  --chart-3: oklch(0.62 0.130 62);   /* amber */
  --chart-4: oklch(0.50 0.115 152);  /* green */
  --chart-5: oklch(0.46 0.090 320);  /* plum */
  --chart-6: oklch(0.58 0.020 95);   /* graphite (baseline / "other") */

  /* ── sidebar: light sunken rail. the dark navy rail is DELETED. ── */
  --sidebar:                    var(--surface-sunken);
  --sidebar-foreground:         oklch(0.330 0.008 95);
  --sidebar-primary:            var(--primary);
  --sidebar-primary-foreground: oklch(0.99 0 0);
  --sidebar-accent:             oklch(0.905 0.005 95);  /* hover */
  --sidebar-accent-foreground:  var(--foreground);
  --sidebar-border:             oklch(0.870 0.006 95);
  --sidebar-ring:               var(--ring);

  /* ── brand escape hatch: keep the logo recognisable ── */
  --brand-cyan: oklch(0.72 0.13 220);   /* BrandMark + public marketing gradient only */
  --brand-navy: oklch(0.27 0.06 258);   /* BrandMark only */

  /* ── elevation: three shadows exist. that is all. ── */
  --shadow-pop:
    0 1px 2px oklch(0.245 0.010 95 / 0.10),
    0 8px 24px -8px oklch(0.245 0.010 95 / 0.18);   /* popovers, menus, modals, drag ghost */
  --shadow-sticky: 0 6px 10px -10px oklch(0.245 0.010 95 / 0.35);  /* sticky bars once scrolled */
  --keyline-top: inset 0 1px 0 oklch(1 0 0 / 0.65);                 /* milled edge on toolbars */

  /* ── motion ── */
  --dur-press: 60ms;
  --dur-hover: 80ms;
  --dur-exit: 140ms;
  --dur-enter: 180ms;
  --dur-sheet: 240ms;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-move: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-sheet: cubic-bezier(0.32, 0.72, 0, 1);

  /* ── density ── */
  --row-h: 36px;
  --row-h-comfortable: 44px;
  --row-h-touch: 48px;
  --cell-px: 12px;
  --cell-py: 8px;
  --panel-p: 16px;
  --page-gutter: 24px;
  --sidebar-w: 232px;
  --consolebar-h: 44px;
}

.dark {
  /* true graphite. NOT navy. same hue-95 law. */
  --canvas:          oklch(0.185 0.004 95);
  --surface:         oklch(0.225 0.005 95);
  --surface-raised:  oklch(0.265 0.006 95);
  --surface-sunken:  oklch(0.155 0.004 95);

  --background:       var(--surface);
  --background-admin: var(--canvas);
  --card:             var(--surface);
  --popover:          var(--surface-raised);

  --foreground:         oklch(0.945 0.004 95);  /* 12.1:1 on canvas */
  --card-foreground:    var(--foreground);
  --popover-foreground: var(--foreground);
  --muted-foreground:   oklch(0.685 0.008 95);  /* 5.04:1 on surface */
  --foreground-faint:   oklch(0.520 0.006 95);

  --border:        oklch(0.315 0.006 95);
  --border-strong: oklch(0.405 0.008 95);
  --border-input:  oklch(0.470 0.008 95);
  --input:         var(--border-input);

  --primary:            oklch(0.70 0.105 207);  /* 5.28:1 on surface */
  --primary-foreground: oklch(0.165 0.025 207);
  --primary-deep:       oklch(0.77 0.105 207);  /* hover = brighter in dark */
  --primary-soft:       oklch(0.300 0.045 207);
  --primary-border:     oklch(0.400 0.060 207);
  --ring:               oklch(0.72 0.110 207);
  --hvac-accent:        var(--primary);

  --success:            oklch(0.72 0.140 152);
  --success-foreground: oklch(0.165 0.030 152);
  --success-strong:     oklch(0.85 0.130 152);  /* 6.6:1 on success-light */
  --success-light:      oklch(0.290 0.055 152);
  --success-border:     oklch(0.390 0.070 152);

  --warning:            oklch(0.78 0.145 70);
  --warning-foreground: oklch(0.88 0.130 75);
  --warning-strong:     oklch(0.88 0.130 75);
  --warning-light:      oklch(0.300 0.055 65);
  --warning-border:     oklch(0.400 0.075 68);

  --danger:             oklch(0.66 0.190 27);
  --danger-foreground:  oklch(0.165 0.040 27);
  --danger-strong:      oklch(0.83 0.140 25);
  --danger-light:       oklch(0.300 0.075 27);
  --danger-border:      oklch(0.400 0.100 26);
  --destructive:        var(--danger);

  --info:               oklch(0.68 0.110 258);
  --info-foreground:    oklch(0.85 0.090 258);
  --info-strong:        oklch(0.85 0.090 258);
  --info-light:         oklch(0.290 0.055 258);
  --info-border:        oklch(0.390 0.070 258);

  --secondary:            oklch(0.290 0.006 95);
  --secondary-foreground: var(--foreground);
  --muted:                oklch(0.290 0.006 95);
  --accent:               oklch(0.275 0.006 95);
  --accent-foreground:    var(--foreground);

  --chart-1: oklch(0.70 0.105 207);
  --chart-2: oklch(0.68 0.110 258);
  --chart-3: oklch(0.78 0.140 68);
  --chart-4: oklch(0.72 0.140 152);
  --chart-5: oklch(0.68 0.100 320);
  --chart-6: oklch(0.60 0.012 95);

  --sidebar:                    var(--surface-sunken);
  --sidebar-foreground:         oklch(0.780 0.006 95);
  --sidebar-primary:            var(--primary);
  --sidebar-primary-foreground: oklch(0.165 0.025 207);
  --sidebar-accent:             oklch(0.225 0.005 95);
  --sidebar-accent-foreground:  var(--foreground);
  --sidebar-border:             oklch(0.285 0.006 95);
  --sidebar-ring:               var(--ring);

  --brand-cyan: oklch(0.75 0.13 220);
  --brand-navy: oklch(0.30 0.06 258);

  --shadow-pop:
    0 1px 2px oklch(0 0 0 / 0.45),
    0 10px 28px -10px oklch(0 0 0 / 0.65);
  --shadow-sticky: 0 6px 10px -10px oklch(0 0 0 / 0.7);
  --keyline-top: inset 0 1px 0 oklch(1 0 0 / 0.06);
}
```

Legacy-name migration table (no page edits required): `--background-admin` → canvas · `--card` → surface · `--primary` cyan→teal · `--info` cyan→blue · `--hvac-accent` navy→teal · `--warning-foreground` / `--info-foreground` now carry the `*-strong` values, which is what `status-colors.ts` already uses them for on `*-light` chips.

## typography
ONE family, three cuts. Delete Inter and Bricolage Grotesque entirely.

```ts
// src/app/layout.tsx
import { IBM_Plex_Sans, IBM_Plex_Sans_Condensed, IBM_Plex_Mono } from "next/font/google";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});
const plexCondensed = IBM_Plex_Sans_Condensed({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-plex-condensed",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

// <html className={`${plexSans.variable} ${plexCondensed.variable} ${plexMono.variable} h-full antialiased`}>
// body gets `font-sans` (do NOT use plexSans.className — we want the variable, so --font-heading can alias it)
```
Why Plex: it is the face of engineering software (IBM, Grafana-adjacent tooling), metrically consistent across Sans/Condensed/Mono, and nothing about it reads "2025 AI landing page." The absence of a display-font pairing is itself the statement.

SCALE (px, admin chrome base = 13, not 14/16):
- `micro` 11 / lh 14 / Condensed 600 / tracking +0.07em / UPPERCASE — table headers, sidebar group labels, KPI labels, form group labels, card eyebrows
- `caption` 12 / lh 16 / Sans 400 — helper text, timestamps in sans context, footnotes
- `body` 13 / lh 18 / Sans 400 — table cells, form values, sidebar items, buttons, everything in the admin
- `body-lg` 14 / lh 20 / Sans 400 — prose surfaces only: chat bubbles, portal, AI insights narrative, empty-state copy
- `title-sm` 15 / lh 20 / Sans 600 / tracking -0.006em — panel + card titles
- `title` 20 / lh 26 / Sans 600 / tracking -0.02em — page titles
- `display` 26 / lh 30 / Mono 500 / tabular-nums — KPI values
- `display-lg` 34 / lh 38 / Mono 500 / tabular-nums — the single hero metric on dashboard/operations

Hierarchy note: this scale does not obey "headline = 2× body" through size, because dense tool UI cannot afford it. Hierarchy is carried by the uppercase micro tier + the mono numeral tier + the sunken/raised surface steps. The one place the 2× rule IS honored is the KPI: 26px mono value over an 11px condensed label = 2.4×.

MONO IS MANDATORY (`font-mono tabular-nums`, rendered at `font-size: 0.92em` relative to its slot because Plex Mono runs optically large) for: money, invoice/estimate/request/job ids, phone numbers, dates and times, durations, ETAs, counts in table cells, percentages, addresses in the dispatch/map lists, API keys, webhook ids, log lines. Sans keeps: names, descriptions, notes, statuses, chat.
Money rules: always right-aligned in tables; `$0.00` renders in `--foreground-faint`; negative/owed renders in `--danger-strong` with a leading `−` (U+2212, not hyphen); currency symbol at 0.85em and `--muted-foreground`.

UPPERCASE vs THE SENTENCE-CASE CANON — this is a rule collision, resolve it in exactly one way: source strings stay sentence case ("Days to paid"). The uppercase is a CSS transform on a single utility class, never in the copy.
```css
.u-label {
  font-family: var(--font-label);
  font-size: 11px; line-height: 14px; font-weight: 600;
  letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--muted-foreground);
}
```
Never apply `.u-label` to buttons, links, body copy, status chips' first use, or any string over ~24 characters (uppercase destroys word-shape scanning past that).

Tracking law: ≥20px → -0.02em. 15-19px → -0.006em. 13-14px → 0. ≤12px sans → +0.005em. Uppercase micro → +0.07em.
Weights in use: 400, 500, 600 only. 700 is reserved for the BrandMark. Never 300, never 800.

## surfaces
BORDERS DO EVERYTHING. Shadows exist in exactly three places: popovers/menus/modals (`--shadow-pop`), sticky bars once scrolled (`--shadow-sticky`), and the dnd-kit drag ghost (`--shadow-pop`). A resting card with a shadow is a bug.

PANEL (replaces `Card` / `SectionCard` visual):
```
background: var(--surface);
border: 1px solid var(--border-strong);
border-radius: var(--radius-lg);   /* 6px */
box-shadow: none;
```
Header row: 40px tall, `padding: 0 16px`, `background: var(--surface-sunken)`, `box-shadow: var(--keyline-top)`, `border-bottom: 1px solid var(--border-strong)`, title at `title-sm`, optional count in mono `--muted-foreground`, action slot right. Body: 16px padding. Nested content (a table inside a panel) gets zero padding and its own dividers.
Nested-radius law: an inner element inside 16px panel padding uses `--radius-sm` (3.6px), never the parent 6px.

FUSED STRIPS — the single most important structural move. Related panels share edges instead of floating with gaps:
```
/* KPI band, filter bars, segmented stat rows */
display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
background: var(--surface);
border: 1px solid var(--border-strong);
border-radius: var(--radius-lg);
overflow: hidden;
> * + * { border-left: 1px solid var(--border); }
```
The four dashboard KPI cards become one bordered strip with three internal hairlines. Zero gap. This is what kills the "field of floating white rectangles" read instantly.

KPI CELL (inside the strip): padding 14px 16px. Label `.u-label` on line 1. Value `display` (26px mono 500) on line 2 with 6px top margin. Delta on line 3: 11px mono, `▲`/`▼` glyph + value, `--success-strong` / `--danger-strong`, no pill, no background. Icon: 14px lucide, absolutely positioned top-right at `--foreground-faint`, 0.9 opacity — decorative, not a tinted chip. Kill `IconChip`'s soft colored square inside KPIs (keep it in list rows where it disambiguates type).

TABLE (the app's primary surface — this is where it wins or loses):
```
table { border-collapse: separate; border-spacing: 0; font-size: 13px; }
thead th {
  position: sticky; top: 0; z-index: 2;
  height: 32px; padding: 0 12px;
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--border-strong);
  box-shadow: var(--keyline-top);
  /* .u-label styling */
}
tbody td { height: 36px; padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--accent); }          /* 80ms */
tbody tr[data-selected] td { background: var(--primary-soft); }
tbody tr[data-selected] td:first-child { box-shadow: inset 2px 0 0 var(--primary); }
```
No zebra striping (it fights the status tints). Numeric columns `text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums;`. Column dividers only on tables >7 columns, and then at `--border` on the `th` only, not the body. Row density toggle in the toolbar swaps `--row-h` 36 ↔ 44 and persists to localStorage.

STATUS CHIP (replaces pill badges — `rounded-full` is banned):
```
display: inline-flex; align-items: center; gap: 5px;
height: 20px; padding: 0 6px;
border-radius: 3px;
border: 1px solid var(--<sem>-border);
background: var(--<sem>-light);
color: var(--<sem>-strong);
font: 500 11px/1 var(--font-label); letter-spacing: 0.04em; text-transform: uppercase;
```
Every chip carries a 6px shape token before the label — and the SHAPE differs per semantic, so it survives grayscale and CVD: success = filled circle, info = filled square, warning = filled triangle, danger = filled diamond, neutral = hollow circle. Color alone is never the signal. (`status-colors.ts` gains a parallel `*_SHAPE` map; keep the existing badge maps and just re-point their tokens.)

BUTTONS: height 30px (sm 26, lg 34), padding 0 12px, radius `--radius-md` (4.8px), 13px/500.
- primary: `bg: --primary; color: --primary-foreground; border: 1px solid --primary`; hover → `--primary-deep`; active → `translateY(0.5px)`.
- secondary: `bg: --surface-raised; border: 1px solid --border-input; color: --foreground`; hover → `bg: --accent`.
- ghost: transparent, hover → `--accent`.
- destructive: `bg: --danger; color: --danger-foreground`.
Never a gradient. Never a hover scale. Never a hover shadow.

INPUTS: height 30px, `bg: --surface-raised` (white = editable, the core surface law), `border: 1px solid --border-input`, radius `--radius-md`, 13px. Focus: `outline: 2px solid var(--ring); outline-offset: 1px; border-color: var(--primary);` — a real outline, not a 4px translucent halo ring. Error: `border-color: var(--danger)` + 12px `--danger-strong` message + `AlertTriangle` 13px icon inline. Labels sit outside, `.u-label`, 6px below-gap. Placeholder `--foreground-faint`.

TOOLBAR / FILTER BAR: 40px, `bg: --surface-sunken`, `border-bottom: 1px solid --border-strong`, `--keyline-top`, controls at 26px height, 8px gaps, separated into groups by an 8px-tall 1px vertical rule at `--border`.

DASHBOARD / DISPATCH / CALENDAR: dispatch columns are `--surface` panels with `--surface-sunken` sticky headers and hairline dividers between cards; a job card is `--surface-raised` + 1px `--border` + 4px radius + a 3px left bar in its urgency semantic. Calendar grid lines at `--border`, hour labels in 11px mono `--muted-foreground`, "now" line 1px `--danger` with a 5px square cap on the left gutter.

PUBLIC CHAT + PORTAL + /tech: same tokens, relaxed density (see Density). Chat bubbles get `--radius-xl` (8.4px) and are the ONE place softer geometry is allowed — conversation is not tabular data.

## sidebar
Kill the dark navy rail. It is the loudest "2020 SaaS template" cue in the current app and it fights the new near-neutral shell.

RAIL — 232px, `background: var(--sidebar)` = `--surface-sunken` (light: oklch(0.930 0.005 95); dark: oklch(0.155 0.004 95)), `border-right: 1px solid var(--sidebar-border)`, full height, no radius, no shadow. The sidebar is *sunken* relative to content, which reads as a chassis the content sits in.

BRAND BLOCK — 44px tall (aligned to the console bar), 12px horizontal padding, `border-bottom: 1px solid var(--sidebar-border)`. BrandMark 18px using `--brand-cyan` / `--brand-navy` (the logo keeps the original Spears cyan — recognition survives), wordmark "Spears" at 14px/600 `--foreground`, then a 1px vertical rule and the org name at 11px `--muted-foreground` truncated. Collapse control is a 20px ghost `PanelLeftClose` at the far right, visible on rail hover only.

GROUP LABEL — `.u-label` at 11px condensed 600 uppercase +0.07em, `--muted-foreground`, 20px tall, 12px left padding, 16px top margin above the first item, 6px below. No divider lines between groups — the space does the grouping (Gestalt proximity beats borders).

ITEM — 30px tall, 12px left / 10px right padding, 4px radius, 8px icon-label gap, margin 0 8px.
- rest: `color: var(--sidebar-foreground)`, icon 15px lucide `stroke-width: 1.75` at `--foreground-faint`
- hover: `background: var(--sidebar-accent)`, text → `--foreground`, 80ms, no movement
- active: `background: var(--primary-soft)`, `color: var(--foreground)`, weight 600, icon → `--primary`, plus `box-shadow: inset 2px 0 0 var(--primary)` — a hard 2px marker flush to the item's left edge, full 30px height, square ends. No pill, no glow, no gradient.
- focus-visible: `outline: 2px solid var(--ring); outline-offset: -2px`
- count badge (e.g. pending requests): right-aligned, 11px mono 500, `--muted-foreground`, bare digits — no chip. If the count is urgent (overdue/emergency) it flips to `--danger-strong` and gains a 5px filled diamond before it.

COLLAPSED RAIL — 52px, icons only, 34px items, tooltip on the right after 300ms (instant for adjacent tooltips once one is open).

CONSOLE BAR — new, 44px, spans the content column (right of the rail), `background: var(--surface)`, `border-bottom: 1px solid var(--border-strong)`, sticky, `--shadow-sticky` applied only after `scrollY > 0`. Contents left→right: breadcrumb (13px, parent segments `--muted-foreground`, current `--foreground` 500, ids inside it in mono), flexible spacer, a 26px-tall search field with `Search` 14px icon and a `⌘K` hint chip in 11px mono on `--surface-sunken`, environment chip (dev/staging only — hidden on prod, 11px condensed uppercase on `--warning-light`), notification bell, then a 24px square-ish avatar with 4px radius. No page title here — the title lives in the page header below.

PAGE HEADER — below the console bar, 24px page gutter, `title` 20px/600/-0.02em, one-line 13px `--muted-foreground` description max, primary action right-aligned at the same optical baseline. Bottom margin 20px. No border under it (the console bar already provides one) unless the page has tabs, in which case tabs sit on a `border-bottom: 1px solid var(--border-strong)` with a 2px `--primary` indicator that slides.

MOBILE — the rail becomes an off-canvas sheet at 280px, translateX with `--ease-sheet` over `--dur-sheet`, backdrop `oklch(0.245 0.01 95 / 0.45)` with no blur. Item height rises to 44px inside the sheet.

## density
4px base unit. Legal spacing steps: 4, 8, 12, 16, 20, 24, 32, 40, 56. 6/10/14/18/28/48 are illegal — pick a neighbour. This constraint is what makes the grid feel machined rather than eyeballed.

ADMIN (dense — dispatcher/owner at a desktop, 8h/day):
- page gutter 24px (≥1280px), 20px (768-1279), 16px (<768)
- max content width: none on dispatch/calendar/map/tables (they earn the pixels); 1180px on settings/forms/insights so line length stays ≤75ch
- vertical rhythm between page sections: 20px. Between a section heading and its content: 12px.
- panel padding 16px. Panel header 40px. Nested inner padding 12px.
- table: header 32px, row 36px (comfortable 44px via toolbar toggle), cell padding 8px 12px, first/last cell padding 16px on the outer edge
- KPI strip cell padding 14px 16px; strip height ~86px
- toolbar 40px, controls 26px, 8px gaps, 12px between control groups
- form: field height 30px, 6px label→field, 16px between fields, 24px between fieldsets, 2-column grid at ≥900px with 20px column gap; labels above, never floating
- list row (non-table, e.g. conversations, activity): 52px with a 2-line layout, 12px horizontal padding, 1px `--border` divider, no gap between rows
- icon sizes: 14px inline-with-text, 15px sidebar/nav, 16px buttons, 18px panel headers, 20px empty states' glyph. Never 24px in the admin.
- badge/chip 20px tall. Avatar 24px (list), 28px (detail header). Both 4px radius except the account avatar which stays square-ish 4px too — no circles except technician photos on the map/dispatch, which need to read as people.

WHERE IT GOES AIRY (deliberate contrast — density everywhere is exhausting):
- empty states: 48px vertical padding, 20px lucide glyph in a 40px `--surface-sunken` square with 6px radius, 15px/500 headline, 13px `--muted-foreground` line, primary action 8px below
- the AI insights / reports narrative column: 14px body, 1.6 line-height, 24px between paragraphs, 68ch max
- auth + landing: 56px section rhythm, this is the only place `display-lg` and generous whitespace appear
- modals: 20px padding, 16px between header/body/footer, min-width 420px, max 640px

TOUCH CARVE-OUT (mandatory, not optional): `/tech`, `/portal/[token]`, `/estimates/[token]`, `/review/[token]`, and every `<768px` admin view raise base font to 14px, min interactive target to 44×44px (`--row-h-touch: 48px` for list rows), radius to `--radius-xl` (8.4px) on primary controls, and control height to 40px. The industrial density is a desktop-instrument idea; on a technician's phone in a crawlspace with gloves it becomes an accessibility failure. Enforce with a `.touch-surface` wrapper class that overrides `--row-h`, `--cell-py`, and control heights via the same variables.

CALENDAR/DISPATCH exception: drag targets never go below 32px tall regardless of density toggle, and drag handles get a 44px hit area via a transparent `::before` even when visually 20px.

## motion
Personality: crisp, fast, mechanical. Nothing bounces. Nothing overshoots. The app should feel like a switch, not a spring.

TOKENS (defined above): press 60ms · hover 80ms · exit 140ms · enter 180ms · sheet 240ms. Easings: `--ease-out: cubic-bezier(0.23,1,0.32,1)` for everything appearing; `--ease-move: cubic-bezier(0.77,0,0.175,1)` for something travelling across the screen; `--ease-sheet: cubic-bezier(0.32,0.72,0,1)` for drawers only. Built-in `ease`/`ease-in-out` is banned — it is the weak default that makes UI feel gummy.

WHAT ANIMATES (each with its stated purpose):
- row/button/nav hover fill: `background-color` 80ms linear-ish `--ease-out`. Purpose: feedback. No transform.
- button press: `transform: translateY(0.5px)` + one background step, 60ms. Purpose: physical acknowledgement.
- dropdown / popover / context menu: `opacity 0→1` + `scale(0.97)→1`, 140ms `--ease-out`, `transform-origin` set from the trigger edge (top-left for left-aligned menus, top-right for right-aligned). Purpose: spatial origin. Exit 100ms, opacity only.
- modal: backdrop opacity 140ms; panel `opacity 0→1` + `scale(0.98)→1` + `translateY(4px)→0`, 180ms `--ease-out`, centered (modals are the exception to origin-awareness). Exit 120ms. No content stagger.
- sheet/drawer (mobile nav, job detail on tablet): `translateX/Y` 240ms `--ease-sheet`. Purpose: spatial continuity.
- tab indicator: 2px underline slides 160ms `--ease-move`. Content crossfades opacity only, 120ms, with the panel min-height locked to prevent shift. Purpose: spatial consistency.
- toast: `translateY(8px)→0` + opacity, 180ms in / 140ms out, bottom-right desktop / top mobile, max 3 stacked, info 4s, warning 7s, error until dismissed.
- dnd-kit drag: while dragging, `transition: none` and `transform` only; the ghost gets `--shadow-pop` + 0.95 opacity + 1px `--primary` border. On drop, 200ms `--ease-move` settle to the final position. Drop target: 1px dashed `--primary` inset outline + `--primary-soft` fill, appearing instantly (0ms) — hesitation here reads as lag.
- skeleton → content: 120ms opacity crossfade. Skeleton bars are `--surface-sunken` with a `linear-gradient` shimmer sweeping L→R over 1.1s, amplitude ≤6% lightness. Shapes match real content (a 16px-wide mono block where an id goes, a 90px bar where a name goes).
- inline save confirmation: a 14px `Check` in `--success` fades in over 120ms, holds 1.4s, fades out 200ms. No toast for autosaves.
- optimistic mutations (assign technician, mark paid, send reminder): apply instantly; on failure, revert with a 500ms `background-color` pulse to `--danger-light` and an inline error. No shake, no wiggle.

WHAT MUST NOT ANIMATE (violating these is how it starts looking AI-generated again):
- list/table row entrance stagger. Never. Data is not a feed; a 50ms cascade over 200 invoice rows is theater and adds a second of perceived latency.
- KPI count-up / number roll. The number is the truth; animating it delays the truth.
- chart draw-in on mount. Draw the chart. Transition only on data *change*, and then only the `d`/height, 200ms.
- page/route transitions. Instant.
- sidebar navigation and command palette open/close. Keyboard-initiated and used 100+×/day → zero animation, per the frequency gate.
- any hover `scale()`, any hover `box-shadow` growth, any glow, any spring bounce, any `scale(0)` origin, any gradient shimmer on buttons, any pulsing "AI thinking" orb. The chat typing indicator is three 4px squares at 1.2s opacity cycle — squares, not dots, not a gradient wave.
- `height`/`width`/`margin`/`padding`. Transform + opacity + background-color/color only.

LOADING DISCIPLINE: under 300ms show nothing. 300ms-3s with known shape → skeleton. Unknown short wait → a 14px inline spinner *inside* the triggering button with the label kept (never a full-page spinner). Known percentage over 3s (FieldPulse/HCP imports) → a 4px progress bar at `--primary` on `--surface-sunken`, with a mono `1,284 / 17,502` counter.

REDUCED MOTION: `@media (prefers-reduced-motion: reduce)` keeps opacity and color transitions at 100ms (they aid comprehension) and drops every transform/translate to 0ms. Replace the current blanket `0.01ms !important` rule, which also kills the comprehension-carrying fades.
HOVER GATING: wrap every hover rule in `@media (hover: hover) and (pointer: fine)` so tapping on the technician's phone doesn't stick a hover state.

## antiAiMoves
1. **Kill the blue-gray, everywhere.** Every neutral in the file moves to hue 95 at chroma ≤0.010 (warm graphite/limestone), and body text becomes graphite `oklch(0.245 0.010 95)` instead of navy. The `oklch(0.97 0.006 240)` canvas + slate-500 muted text is the single most recognizable shadcn-default fingerprint; changing only the accent while keeping the slate ramp is why most "redesigns" still look generated. Dark mode gets the same treatment — true graphite, not tinted navy.

2. **Borders replace shadows, and `rounded-full` is banned.** Base radius 10px→6px; controls at 4.8px; chips at 3px. Resting cards get `border: 1px solid var(--border-strong)` and `box-shadow: none`. Shadow survives in exactly three places (popover/modal, scrolled sticky bar, drag ghost). Pill badges become square-cornered uppercase chips with a per-semantic *shape* token. The soft-shadow rounded pill is the template tell.

3. **Fuse the card grid into strips.** The `grid gap-6` field of floating white KPI cards becomes ONE bordered container with 1px internal `divide-x` hairlines — zero gap, shared edges, `overflow: hidden` on a 6px radius. Same for filter bars and segmented stat rows. Generated layouts always emit gapped card grids; a fused strip is a deliberate compositional decision that reads as engineered.

4. **One type family, three cuts, mono on every number.** IBM Plex Sans + Plex Sans Condensed + Plex Mono replaces Inter + Bricolage Grotesque. The "neutral body font + fashionable display font for headings" pairing is the house style of AI-generated UI; refusing the display face entirely and letting an 11px uppercase condensed micro-tier carry hierarchy is the opposite move. Every dollar, id, timestamp and count renders in tabular mono — the instant tell that a human who cares about data laid this out.

5. **Build an instrument, not a page.** 13px dense base (not 14/16), a light *sunken* sidebar with a hard 2px teal left marker replacing the dark-navy-rail cliché, a 44px console bar with mono breadcrumb ids and a ⌘K field, 36px table rows with a sticky `--surface-sunken` header band and a milled `inset 0 1px 0` keyline, a persisted density toggle, and info split off from primary (blue 258 vs teal 207) so status stops being one undifferentiated wash of brand cyan. Nothing here comes out of a scaffold.

## risks
- **Contrast erosion from warm gray + 13px.** A 0.955 canvas against a 0.982 surface is a 3% lightness step; on a cheap TN monitor or in a sunlit truck cab the panel edges disappear. Mitigation: structural edges use `--border-strong` (0.795) not `--border`, panel headers use the `--surface-sunken` band so the boundary is a *fill* change not only a line, and `--muted-foreground` is pinned at 4.65:1 minimum — never let a "subtle" 0.62 gray carry text. `--foreground-faint` must be lint-fenced to icons/dividers/disabled.

- **Hairline-only structure collapses at fractional scaling.** At 125%/150% Windows DPI, 1px borders round unevenly and dividers vanish or double. Mitigation: never rely on a hairline alone to separate two same-colored regions — always pair with a surface step; and use `box-shadow: inset 0 -1px 0` rather than `border-bottom` on sticky headers so it can't be clipped by the sticky compositing layer.

- **Density vs. the technician on a phone.** 36px rows, 30px controls and 11px labels are an accessibility failure for gloved hands in a crawlspace, and dnd-kit drag handles at 20px are unusable on touch. The `.touch-surface` carve-out for `/tech`, portal/estimate/review token pages and all `<768px` views is load-bearing, not a nice-to-have — if it slips, the redesign ships an unusable field app. Ship the carve-out in the same PR as the token swap.

- **Uppercase micro-labels fight the copy canon and i18n.** `text-transform: uppercase` on Spanish/French strings lengthens them ~15% and breaks the 232px sidebar and 32px header band; uppercase past ~24 chars destroys scannability. Mitigation: transform lives only in `.u-label`, never in source strings; hard cap the class to short labels; give table headers `text-overflow: ellipsis` with a `title` attribute.

- **Red/amber collision under CVD and the deuteranopia grayscale test.** Danger 27° and warning 62° are close in hue; on a dispatch board full of urgency chips this is a safety-adjacent failure. Mitigation is already in the spec and must not be dropped: differing lightness (danger 0.505 vs warning 0.66) plus a per-semantic *shape* token before every label. Any chip that renders color-only is a bug — add a lint/test over `status-colors.ts` asserting every badge entry has a shape counterpart.

- **Losing all shadow removes the depth cue dense tables need.** A menu or date picker over a 36px-row table with hairlines everywhere will visually dissolve into the grid. `--shadow-pop` on every floating layer is not optional, and popovers must sit on `--surface-raised` (pure white) with a `--border-strong` edge so they read a full step above.

- **Teal primary at oklch(0.45) is dark and can read "muted/dated" to the owner** — the exact complaint being fixed. It only works if the accent is genuinely scarce: primary buttons, active nav marker, focus ring, selection fill, chart-1. If it leaks into headings, icons, links-everywhere and banner backgrounds it becomes drab. Enforce the 10% rule literally: on any admin screenshot, teal pixels should be countable.

- **Brand-recognition regression.** Muting cyan to teal and deleting the navy rail may read to the owner as "you took my brand away." `--brand-cyan` / `--brand-navy` are preserved specifically for the BrandMark and public marketing gradient — keep the logo untouched and show the two side by side when presenting, or this direction gets rejected for the wrong reason.

- **Migration blast radius.** Roughly 30 pages consume `--primary`, `--info`, `--background-admin` and `--hvac-accent`. Re-pointing the legacy names (as specified) means the swap is one file, but three real gotchas remain: `--hvac-accent` flips navy→teal so anything using it as *text on light* changes contrast; `--info` flips cyan→blue so any surface pairing info with primary will now show two distinct hues where it previously showed one; and `--warning-foreground` / `--info-foreground` are being redefined as the strong-on-light text values, which is how `status-colors.ts` already uses them but may not be how one-off pages do. Grep those four tokens before merging.

- **IBM Plex Mono is wide.** Mono money in a 7-column invoice table can overflow at 1280px. Cap mono to numerals/ids at 0.92em, right-align, and never set free text (customer names, addresses over one line, notes) in mono — fall back to Plex Sans with `tabular-nums`.

# JUDGE GRAFT (label=None)
Build Industrial Utility, but graft seven things and overrule it on two.

OVERRULE #1 — the type family. Plex Sans + Plex Condensed escapes "AI-generated" straight into "IBM Carbon," and the whole micro-tier depends on Plex Condensed. Take Blueprint's Archivo (variable, with the `wdth` axis) as `--font-sans`, and get the condensed 11px micro-tier from Archivo's own width axis (`font-stretch: 82%`) instead of a second family. Keep IBM Plex Mono for numerals — Plex Mono is the correct measurement face and carries no Carbon association on its own. Result: one family, three cuts, better coherence than the original proposal, and no genre smell. Schibsted Grotesk (Ironclad) is the acceptable alternate if Archivo's `wdth` axis breaks the build.

OVERRULE #2 — the orphaned brand. Industrial Utility quarantines cyan to the BrandMark, so 29 of 30 screens have zero Spears color; that is how this gets rejected for the wrong reason. Take Ironclad's discipline instead: keep a single saturated `--signal` cyan with three explicit jobs — the 2px top border on AI-output panels (insights, autopilot suggestions, chat analysis), the live/streaming dot, and the active-nav left marker. Deep teal stays the working `--primary` for buttons/focus/selection. The owner sees his brand on every screen; the accent stays scarce.

GRAFT from Blueprint (highest value): (1) the alignment covenant, verbatim and enforced — one 32px content margin shared by page title, breadcrumb, panel header and first-cell text; sidebar-header height === console-bar height (make both 44px or both 56px, but identical) so their bottom rules form one unbroken line across the viewport; every horizontal rule on a 4px multiple. This is the "someone drew this" mechanism Industrial Utility is missing, and it is free. (2) The `data-contrast="high"` root override wired to a setting and defaulted ON for `/tech` and all sub-768px views — Industrial Utility's warm-gray canvas/surface delta is only ~3% lightness and needs this escape hatch, not just a `--border-strong` promise. (3) The audit rule "one primary-colored element per screen; if there are two, one is wrong" — enforce it with the screenshot pass, or the teal leaks and goes drab. (4) Cap charts at 4 series with direct end-of-line labels instead of a legend. (5) Square avatars with mono initials — Industrial Utility bans `rounded-full` then exempts avatars, which is incoherent; Blueprint's version is more disciplined and is a small unmistakably non-default choice.

GRAFT from Ledger: (6) `padding-inline: 0` on leading/trailing table cells so text aligns to the page margin while the row rule runs full-bleed. Six lines of CSS, the best craft detail anyone proposed, and it composes perfectly with hairline tables. (7) The ruled definition-list layout for all detail pages (customer, invoice, request, estimate) — 11px caps label at a fixed 140px, value right, hairline under each pair, 12px vertical padding. Industrial Utility never specifies detail pages at all, and this reclaims ~35% vertical space over the current card grids. (8) Replace Industrial Utility's skeleton shimmer sweep with Ledger's 1.8s opacity breathe — the gradient shimmer is a genuine template tell and Industrial Utility specified one by mistake. (9) The value-change wash flash (600ms hold, 400ms fade) on money/count updates, which is the correct alternative to the count-up both directions already ban. (10) Currency symbol and cents at 0.82em in `--muted-foreground` while dollars stay full ink.

GRAFT from Ironclad: (11) Lead the presentation with the AA fix — white on the current `oklch(0.72 0.13 220)` primary is ~2.2:1, a live failing button on every page today. Framing the accent change as fixing a real defect buys permission for the palette shift. (12) The `data-density="comfortable"` attribute on `<html>` (rows 36→44, body 13→14) rather than a toolbar-only toggle, so it persists per user across every surface — the 13px bet needs this and the owner may not have young eyes. (13) Cap list stagger at 8 items / 24ms (Industrial Utility bans stagger entirely, which is fine for tables but too absolute for the dashboard's first paint). (14) Its three-blues warning: with teal 207 primary + blue 258 info + brand cyan 220 in play, never place them adjacent in a legend and never let hue alone carry a status.

SCOPE WARNING for the build: I measured it — 56 of 231 tsx files use `rounded-full` and 37 use `shadow-`. The token swap is genuinely one file, but "ban pills, ban resting shadows" is ~80 file edits plus a `scripts/agent/screenshot-page.mjs` pass on all 30 pages. Half-migrated is worse than either state; budget the overnight accordingly and grep `rounded-full`, `shadow-`, `rounded-lg|xl|2xl` and raw `bg-white` before declaring done.

- Industrial Utility — "Shop Floor Instrument": 8.5 | strongest: It is the only direction that correctly names the actual fingerprint. I verified the current file: the whole neutral ramp is hue 240–264 (`--background-admin: oklch(0.97 0.006 240)`, `--muted-foreground: oklch(0.554 0.046 257)`, `--border: oklch(0.918 0.016 264)`) and only 9 of 231 tsx files touch r | weakest: The type choice is the soft spot and it undercuts the thesis. IBM Plex is not neutral ground — it is the most genre-coded typeface in enterprise software, and Plex Sans + Plex Condensed + Plex Mono reads instantly as Carbon Design System / an observability startup. It escapes "generated" and lands i
- Blueprint — Swiss grid for trade software: 7 | strongest: The alignment covenant is the best single idea produced by any of the four, and it is the thing no template and no scaffold ever does: one 32px left margin shared by page title, breadcrumb, panel header and first table cell text across all ~30 pages; sidebar-header height === topbar height so their  | weakest: It trades one recognizable genre for another. Paper-white + 0px radius + hairlines + no shadows + squares-for-status is the 2024–26 Swiss-revival dashboard look — Linear/Vercel-adjacent — and by 2026 it is arguably more template-coded than what it replaces. It is also structurally fragile in a way t
- Ledger — warm editorial craft: 6 | strongest: It has the highest ceiling on pure "someone designed this," and two of its details are the best craft in the whole set. First: leading/trailing table cells get `padding-inline: 0` so cell text aligns to the page margin while the row rule runs full-bleed to the container edge. Six lines of CSS, and i | weakest: The premise doesn't survive contact with the app. Fraunces with SOFT/WONK axes is the house serif of 2022–24 indie-SaaS marketing — it is exactly as trend-coded as the Bricolage Grotesque being removed, so the boldest-looking direction is actually the most lateral: fashionable display face out, fash
- Ironclad — navy chrome, cyan signal: 4.5 | strongest: It is the most professionally engineered token file of the four — a real 12-step ramp instead of ad-hoc oklch values, a published contrast audit, and the only direction that caught a live production accessibility bug: I verified `--primary: oklch(0.72 0.13 220)` with `--primary-foreground: oklch(0.9 | weakest: It fails the brief at the premise. The owner said the app looks outdated and AI-generated; Ironclad's answer is to keep the dark navy sidebar — the loudest and most cloned artifact in the entire 2019–25 admin-template genre — and add a gradient plus a spill shadow to it, which is the *older* version

# JUDGE GRAFT (label=None)
Ten grafts, ordered by ops payoff. The first three are the ones that decide whether the rebuild is worth the night.

1. FROM IRONCLAD — replace Industrial's row-height-only density toggle with Ironclad's `data-density` attribute on `<html>` that raises BOTH font size and row height (dense = 13px/36px, comfortable = 14px/44px, plus 15px/48px for a large tier). Industrial's toggle only swaps `--row-h`, which does nothing for the actual fatigue risk (13px type). Persist per user, default the owner role to comfortable and the dispatcher to dense. This is the mitigation for Industrial's single biggest bet and it is currently missing.

2. FROM IRONCLAD — signal-tinted row hover instead of Industrial's neutral `--accent` fill: `background: color-mix(in oklch, var(--primary) 5%, var(--surface))`. Tracking a row across 12 columns at 36px height is measurably easier with a hue-shifted wash than a 4% gray step, especially on the low-contrast warm-graphite ramp. Also take Ironclad's sort affordance — a 2px primary underline on the active header cell rather than an icon swap, which reads at a glance and does not reflow the header.

3. FROM BLUEPRINT — the `data-contrast="high"` root override (`--line`/`--border` and `--border-strong` bumped one step darker) wired to a settings toggle, with the technician mobile view and `/portal` shipping high-contrast by default. Industrial has the identical failure mode (3% surface steps plus hairlines vanishing on a dim panel or in a sunlit cab) and its risks section names it but ships no escape hatch. Blueprint's is a 4-line addition.

4. FROM BLUEPRINT — drop uppercase from TABLE COLUMN HEADERS specifically. Keep `.u-label` uppercase for sidebar group labels, KPI labels, and status chips, but set column heads as 11px/600/+0.04em `--muted-foreground` in sentence case. Blueprint's argument holds: uppercase destroys word-shape scanning on long headers ("Days to paid", "Dispatcher first response"), lengthens i18n strings ~15% inside a 32px band, and it is the one place Industrial's transform genuinely fights the repo copy canon rather than merely sidestepping it.

5. FROM BLUEPRINT — exception-row treatment: overdue invoice, unassigned emergency, failed sync get a 2px status-colored left edge with the row body staying `--surface`, never a full-row tint. Industrial specifies a left bar for selection but is silent on exception rows; without this rule a dispatch table with six urgency states becomes an undifferentiated wash. Pair the edge with Industrial's shape token in the chip so it survives CVD.

6. FROM BLUEPRINT — under 640px, tables become stacked records (one `--surface` block per row, 1px `--border` bottom, 11px label left / mono value right) instead of horizontal scroll. Industrial's `.touch-surface` carve-out sets sizes but never says what a 9-column invoice table does on a phone, which is the exact case the tech view hits.

7. FROM IRONCLAD — recessed inputs. Keep Industrial's `--surface-raised` white fill and real 2px outline focus, but add `box-shadow: inset 0 1px 2px oklch(0.245 0.010 95 / 0.05)` so fields read as sunken against risen panels. This is the one depth cue that survives Industrial's no-shadow law, and it recovers the "where do I type" affordance that flat borders lose. Also adopt Ironclad's enumerated six input states (default / focus / error / success-inline-check / disabled-as-`bg-muted`-not-opacity-50 / loading-with-inline-spinner) as an acceptance checklist.

8. FROM IRONCLAD — its dispatch and calendar geometry verbatim, because Industrial's is vague there: dispatch columns 288px, 12px gaps, 12px column padding, job card 12px padding / 8px gap / 76px min-height, sticky 40px column header on `--surface-sunken`; calendar hour rows 56px (14px per 15-minute increment), event block 4px inset with 12px min-height, day column min 168px, time gutter 60px with 11px mono labels. Keep Industrial's rule that drag targets never fall below 32px regardless of density.

9. FROM LEDGER — the ruled definition-list layout for detail pages (customer, invoice, request, estimate): two-column, 11px caps label at a fixed 140px, 13px value, 1px `--border` under each pair, 12px vertical padding. Roughly a third shorter than the current label-above-value card grids, which is what buys back the vertical space Industrial's panel padding spends. Zero conflict with the hairline language — it IS the hairline language.

10. FROM LEDGER — value-change flash and stale-while-revalidate, both absent from Industrial. When a money or count figure updates in place, flash `background: var(--primary-soft)` for 600ms then fade over 400ms; and on refetch, drop existing rows to `opacity: 0.55` over 120ms rather than swapping in a skeleton. Industrial correctly bans count-ups but then leaves live AR and dispatch counters with no change signal at all, which is worse — a dispatcher will not notice a number that silently changed.

ONE FIX TO THE WINNER ITSELF, not a graft: Industrial's `--hvac-accent` flips navy to teal, and `status-colors.ts` line 17 renders `scheduled` as `bg-primary/10 text-primary`. Under the teal primary that chip will read in the same hue as `--primary-soft`, which Industrial also uses as the selected-row fill on tables — a scheduled row and a selected row will look alike on the dispatch list. Move `scheduled` onto the info tokens before merge. And budget for the sweep: the token swap is one file, but 118 `rounded-full` occurrences across 56 files and 60 `shadow-*` utilities are hand-written in pages and will leave the app half-migrated if only `globals.css` changes. Grep `rounded-full`, `shadow-(sm|md|lg|xl)`, `rounded-(lg|xl|2xl)`, and raw `bg-white` before calling the pass done, and screenshot every page with `scripts/agent/screenshot-page.mjs` — half-migrated reads worse than either end state.

- Industrial Utility — "Shop Floor Instrument": 9 | strongest: Status legibility is the best of the four and it is the only direction that makes the signal survive a bad monitor: per-semantic SHAPE tokens (circle/square/triangle/diamond) before every chip label, deliberately separated lightness (danger 0.505 vs warning 0.66), and info split off primary (blue 25 | weakest: 13px admin base is the single largest fatigue bet, and the density toggle only swaps --row-h (36<->44) — it does not raise font size, so an owner who finds 13px small has no remedy. Second: the 0.955 canvas / 0.982 surface split is a 3% lightness step, and unlike Blueprint there is no data-contrast 
- Blueprint — Swiss grid for trade software: 7 | strongest: The most honest engineering in the set: it correctly flags that the existing calc(var(--radius) * n) ladder must be replaced with literals or every legacy rounded-3xl reverts to a blob, it maps --warning-foreground / --info-foreground to the *-ink values correctly in both modes, and it ships a data- | weakest: Status is a 6x6px square plus a word, with no fill, no border, no capsule. That is a direct regression in the one thing a dispatcher does all day — triage a board at a glance. Reading words is not scanning; the current filled badges are faster, and its own risk section concedes 'color is now the onl
- Ironclad — navy chrome, cyan signal: 6 | strongest: The most concrete ops geometry in the set, and it is genuinely useful: dispatch columns 288px / 12px gaps / 76px min job card / 40px sticky column header; calendar 56px hour rows at 14px per 15-minute increment with a 60px time gutter and 11px mono labels; table rows 40px with a 32px compact variant | weakest: Two verifiable status-badge failures in the file that governs every badge in the app. Light mode --info-foreground is white on a near-white --info-light, making the app's most-used badge family invisible by default; dark mode inverts warning and info the same way. In a tool where status legibility I
- Ledger — warm editorial craft: 5 | strongest: Best glare profile of the four for an 8-hour shift: warm paper at hue 80-86 with chroma capped 0.010-0.014, an ochre hover wash instead of blue-50, cards LIGHTER than the canvas, and a warm-charcoal dark mode instead of slate-950. The ruled definition-list layout for detail pages (11px caps label at | weakest: Underline-only inputs are the wrong call for a tool where a dispatcher makes hundreds of field edits a day — no visible hit region, ambiguous target, and it is applied inconsistently (textareas, selects and search keep boxes), which is worse than either choice alone. The Scale A / Scale B split is t

# JUDGE GRAFT (label=None)
SIX grafts, in priority order.

1. FROM IRONCLAD — make PRIMARY navy, keep teal as the marker color. This is the highest-value graft because it fixes Industrial's two worst problems at once. Industrial's own risk section admits teal at oklch(0.45) "can read muted/dated to the owner — the exact complaint being fixed," and separately admits brand-recognition regression from deleting navy. Set --primary to Ironclad's --ink-800 oklch(0.270 0.058 258) for button fills (white-on-navy = 14.89:1 verified, vs 6.69:1 on teal), and keep the teal ONLY as --ring, the 2px active-nav marker, selected-row fill, and chart-1. Navy keeps doing visible work so the brand survives; teal becomes genuinely scarce, which is the discipline Industrial says it needs but doesn't structurally enforce.

2. FROM IRONCLAD — the 12-step --ink-* ramp as named tokens, re-hued to Industrial's hue 95. Industrial hand-picks ~8 neutrals with no ramp, which leaves the 40 surviving raw text-gray-/bg-slate- class sites with no token to migrate to. Publishing --ink-975 through --ink-50 at hue 95 / chroma ≤0.010 gives those 40 sites a mechanical target and makes the "no neutral may use hue 220-265" law enforceable rather than aspirational.

3. FROM IRONCLAD — the --shadow-focus two-ring pattern (2px page-colored spacer, then 2px accent) instead of Industrial's `outline: 2px; outline-offset: 1px`. On a 36px row inside a table with hairlines on every edge, a bare outline at 1px offset visually merges with the row dividers. Also graft Ironclad's proposal to add a contrast assertion over status-colors.ts pairings to the existing pure-helper vitest suite — the repo already does pure-helper tests, and this is the only mechanical defense against the exact class of bug that Ironclad itself shipped (its own 1.16:1 info-foreground).

4. FROM BLUEPRINT — the :root[data-contrast="high"] override, wired to a settings toggle, defaulting ON for /tech and all <768px views. Industrial's #1 stated risk is hairline erosion "on a cheap TN monitor or in a sunlit truck cab" and it offers no mechanism, only guidance. Blueprint has the only actual mitigation. Also graft Blueprint's literal --radius-2xl/3xl/4xl ceiling: Industrial keeps the calc ladder (correct — it buys free migration of 167 sites) but 2.2x and 2.6x of 6px still yields 13.2/15.6px blobs on legacy rounded-3xl sites. Pin those three to a 10px ceiling while leaving sm/md/lg/xl on the ladder.

5. FROM LEDGER — full-bleed row rules: `padding-inline: 0` on leading/trailing table cells so text aligns to the page margin while the 1px rule runs edge to edge. Cheapest highest-signal "a human typeset this" detail in the whole set, it is six lines, and it is strictly additive to Industrial's table spec. Also take Ledger's currency treatment (symbol AND cents at 0.82em in --muted-foreground) over Industrial's weaker symbol-only-at-0.85em version.

6. FROM LEDGER + BLUEPRINT (they agree) — replace Industrial's skeleton shimmer sweep with the opacity breathe (0.55↔0.9 over ~1.5s, one animation on the container, not per block). Industrial specifies a "linear-gradient shimmer sweeping L→R over 1.1s" while simultaneously banning "any gradient shimmer" in its own motion section — it contradicts itself, and the sweep is a recognized template tell. Additionally take Blueprint's narrower position on uppercase: keep Industrial's .u-label mechanism (CSS transform, sentence case in source — this correctly satisfies the copy canon) but restrict it to table headers and sidebar group labels only, dropping it from KPI labels and card eyebrows, since uppercase + wide tracking everywhere is its own recognizable cliché.

DO NOT GRAFT: Blueprint's zero-shadow/zero-radius absolutism (its hairlines measure 1.33:1 with nothing behind them), Ledger's serif display face or its two-scale A/B system (30 pages will drift), and Ironclad's dark-mode surface stack (1.06:1 and 1.11:1 steps — re-derive from Industrial's graphite values instead).

SHIP ORDER, given that only ~60% of any direction lands from tokens+primitives: commit 1 = globals.css + layout.tsx + the radius ceiling + status-colors.ts repoint, verified with scripts/agent/screenshot-page.mjs on dashboard/dispatch/invoices before anything else. Commit 2 = the 18 primitives in src/components/admin/ui/. Commit 3 = the ~97 hand-rolled rounded-full pills and 70 shadow-* sites, which no token change reaches. Industrial is being chosen precisely because commit 1 alone is already a coherent, shippable, transformed product.

- Industrial Utility — "Shop Floor Instrument": 9 | strongest: It is the only direction that is coherent and shippable at the token-only stage — which is what will actually land overnight. Verified: every contrast claim is CONSERVATIVE (real values 6.25–15.87:1, zero misses in light or dark). It keeps the calc radius ladder so all 167 rounded-* sites rescale 10 | weakest: Brand. Cyan 0.72/0.13/220 → teal 0.45/0.10/207 is a large perceptual move (lightness drops 0.27) AND it deletes the navy rail — a double hit on a brand the owner may feel is being taken away. It flags this honestly but the mitigation (--brand-cyan/--brand-navy preserved for BrandMark only) is thin. 
- Blueprint — Swiss grid for trade software: 6 | strongest: The most rigorous token engineering of the four. It is the only direction that caught the calc(var(--radius) * n) ladder trap and wrote literal --radius-* overrides to stop legacy rounded-3xl rendering as a blob, the only one shipping a data-contrast="high" root escape hatch, and its legacy-alias st | weakest: The entire structural thesis rests on hairlines I measured at 1.33:1 light and 1.32:1 dark — and unlike Industrial and Ledger, Blueprint also deletes fills, shadows AND radius, so there is nothing backstopping the line. Its own admitted mitigation is a settings toggle, i.e. shipping a known-broken d
- Ironclad — navy chrome, cyan signal: 6 | strongest: By far the best brand survival — navy and cyan both keep working and get promoted from decoration to structure, so the owner will recognize his product. Lowest churn: 8px base radius is closest to the current 10px, so the 167 rounded-* sites barely move. It correctly identifies that the current whit | weakest: A confirmed defect: it sets --info-foreground to white (0.995) while status-colors.ts uses text-info-foreground on bg-info-light in 15 places — I measured 1.16:1, i.e. invisible badge text across assigned/in_progress/chatting/extracting/info_provided/open across requests, sessions, invoices and esti
- Ledger — warm editorial craft: 5 | strongest: Contains the single best detail in the entire set: leading/trailing table cells at padding-inline: 0 so text aligns to the page margin while the row rule runs full-bleed. Six lines of CSS, unmistakably typeset rather than generated, and it grafts onto anything. Its currency treatment (symbol AND cen | weakest: Genre mismatch — a warm cream trade journal with a variable serif is not what a dispatcher stares at for eight hours, and it is the least recognizable as Spears of the four (cyan demoted to three uses, navy gone). Verified failure: --signal at 2.29:1 on paper is the sole active-nav marker, failing 1

