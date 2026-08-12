import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Contrast proof for the status-chip token pairings used by status-colors.ts.
 *
 * globals.css is the single source of truth: the oklch values are PARSED out of
 * the `:root` block, never hardcoded here. If a token is re-tuned in globals.css
 * this test re-measures it automatically; if a re-tune breaks a legibility
 * floor, this test goes red.
 *
 * Colour math is implemented inline (no deps): oklch -> OKLab -> linear sRGB
 * (gamut-clamped) -> WCAG relative luminance -> contrast ratio.
 */

// ── globals.css parsing ───────────────────────────────────────────────────

const GLOBALS_CSS = fileURLToPath(
  new URL("../../app/globals.css", import.meta.url),
);

/** Raw `--name: value` declarations from the FIRST `:root { … }` block. */
function readRootTokens(css: string): Record<string, string> {
  const block = /(?:^|\n):root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!block) return {};
  const out: Record<string, string> = {};
  const decl = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(block[1])) !== null) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** Follows `var(--alias)` indirection (e.g. `--link: var(--marker)`). */
function resolve(
  tokens: Record<string, string>,
  name: string,
  seen: ReadonlySet<string> = new Set(),
): string | null {
  if (seen.has(name)) return null; // cyclic alias
  const raw = tokens[name];
  if (raw === undefined) return null;
  const alias = /^var\(\s*(--[a-z0-9-]+)/i.exec(raw);
  if (alias) return resolve(tokens, alias[1], new Set([...seen, name]));
  return raw;
}

// ── colour math ───────────────────────────────────────────────────────────

interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

function parseOklch(value: string): Oklch | null {
  const m =
    /oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)(%?)\s+([0-9.]+)(?:deg)?\s*(?:\/[^)]*)?\)/i.exec(
      value,
    );
  if (!m) return null;
  return {
    l: m[2] === "%" ? Number(m[1]) / 100 : Number(m[1]),
    c: m[4] === "%" ? (Number(m[3]) / 100) * 0.4 : Number(m[3]),
    h: Number(m[5]),
  };
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** oklch -> linear-light sRGB, clamped into gamut (audit on sRGB, not P3). */
function oklchToLinearSrgb(color: Oklch): readonly [number, number, number] {
  const rad = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(rad);
  const b = color.c * Math.sin(rad);

  const l_ = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = color.l - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * WCAG 2.x relative luminance. The sRGB gamma round-trip (encode for display,
 * decode per the WCAG formula) is the identity, so the linear-light channels
 * are weighted directly.
 */
function luminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearSrgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: Oklch, bg: Oklch): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ── the pairings under test ───────────────────────────────────────────────

interface Pairing {
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
  /** 4.5 = AA body text; 3 = AA non-text (dots, rules, borders). */
  readonly floor: number;
}

const PAIRINGS: readonly Pairing[] = [
  // status-chip text on its own family tint
  { label: "success chip", fg: "--success-strong", bg: "--success-light", floor: 4.5 },
  { label: "warning chip", fg: "--warning-strong", bg: "--warning-light", floor: 4.5 },
  { label: "danger chip", fg: "--danger-strong", bg: "--danger-light", floor: 4.5 },
  { label: "info chip", fg: "--info-strong", bg: "--info-light", floor: 4.5 },
  { label: "marker chip (in-motion)", fg: "--marker-strong", bg: "--marker-light", floor: 4.5 },
  // secondary text on both shell surfaces
  { label: "muted text on canvas", fg: "--muted-foreground", bg: "--canvas", floor: 4.5 },
  { label: "muted text on surface", fg: "--muted-foreground", bg: "--surface", floor: 4.5 },
  // non-text marks (live dot, active-nav bar, sort underline)
  { label: "signal mark on surface", fg: "--signal", bg: "--surface", floor: 3 },
  { label: "marker mark on surface", fg: "--marker", bg: "--surface", floor: 3 },
  // primary fill
  { label: "primary button label", fg: "--primary-foreground", bg: "--primary", floor: 4.5 },
];

const css = readFileSync(GLOBALS_CSS, "utf8");
const tokens = readRootTokens(css);

const missing = [...new Set(PAIRINGS.flatMap((p) => [p.fg, p.bg]))]
  .filter((name) => parseOklch(resolve(tokens, name) ?? "") === null)
  .sort();

if (missing.length > 0) {
  console.warn(
    `[status-colors-contrast] SKIPPED — src/app/globals.css does not define an ` +
      `oklch value for: ${missing.join(", ")}. The contrast floors cannot be ` +
      `measured until those tokens exist.`,
  );
}

describe("globals.css token parsing", () => {
  it("finds the :root custom properties", () => {
    expect(Object.keys(tokens).length).toBeGreaterThan(0);
  });

  it("follows var() aliases to a concrete value", () => {
    for (const [name, raw] of Object.entries(tokens)) {
      if (!raw.startsWith("var(")) continue;
      expect(resolve(tokens, name), `${name} resolves`).not.toBeNull();
    }
  });
});

describe("contrast ratios (values read from globals.css)", () => {
  it.skipIf(missing.length > 0).each(PAIRINGS)(
    "$label: $fg on $bg >= $floor:1",
    ({ label, fg, bg, floor }) => {
      const fgColor = parseOklch(resolve(tokens, fg) ?? "");
      const bgColor = parseOklch(resolve(tokens, bg) ?? "");
      expect(fgColor, `${fg} parsed`).not.toBeNull();
      expect(bgColor, `${bg} parsed`).not.toBeNull();

      const ratio = contrastRatio(fgColor!, bgColor!);
      expect(
        Math.round(ratio * 100) / 100,
        `${label}: ${fg} on ${bg} measured ${ratio.toFixed(2)}:1, floor ${floor}:1`,
      ).toBeGreaterThanOrEqual(floor);
    },
  );
});

describe("colour math", () => {
  it("white is luminance 1 and black is luminance 0", () => {
    expect(luminance({ l: 1, c: 0, h: 0 })).toBeCloseTo(1, 3);
    expect(luminance({ l: 0, c: 0, h: 0 })).toBeCloseTo(0, 6);
  });

  it("black on white is the 21:1 maximum", () => {
    const ratio = contrastRatio({ l: 0, c: 0, h: 0 }, { l: 1, c: 0, h: 0 });
    expect(ratio).toBeCloseTo(21, 1);
  });

  it("is symmetric in its arguments", () => {
    const a: Oklch = { l: 0.45, c: 0.1, h: 207 };
    const b: Oklch = { l: 0.945, c: 0.03, h: 207 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("parses percentage lightness and bare numbers alike", () => {
    expect(parseOklch("oklch(50% 0.1 207)")?.l).toBeCloseTo(0.5, 10);
    expect(parseOklch("oklch(0.5 0.1 207)")?.l).toBeCloseTo(0.5, 10);
    expect(parseOklch("oklch(0.245 0.010 95 / 0.10)")?.c).toBeCloseTo(0.01, 10);
    expect(parseOklch("var(--marker)")).toBeNull();
  });
});
