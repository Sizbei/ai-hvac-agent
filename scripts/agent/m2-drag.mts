/**
 * Playwright drag helpers for the M2 calendar walks. Pointer drags only
 * (dnd-kit PointerSensor: activation distance 6 px, so the first move is 10 px).
 * Auto-scroll is driven by holding the pointer near the lanes scroller's right
 * edge over a band, then polling until the target band is fully visible.
 */
import type { Locator, Page } from "playwright";

export type Band = "morning" | "afternoon" | "evening";

export function bandLocator(page: Page, scope: string, day: string, window: Band): Locator {
  return page.locator(`[data-band-scope="${scope}"][data-band-day="${day}"][data-window="${window}"]`);
}

export function laneScroller(page: Page): Locator {
  return page.locator("[data-lanes-scroller]");
}

export async function scrollLeft(page: Page): Promise<number> {
  return laneScroller(page).evaluate((el) => (el as HTMLElement).scrollLeft);
}

async function box(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error("element has no box (not rendered)");
  return b;
}

/** Fully inside the scroller horizontally (the scroller clips; boundingBox does not). */
async function fullyVisible(page: Page, target: Locator): Promise<boolean> {
  const [s, t] = await Promise.all([box(laneScroller(page)), box(target)]);
  return t.x >= s.x && t.x + t.width <= s.x + s.width;
}

export interface DragOptions {
  /** Point inside the target band, as fractions of its box (default centre). */
  readonly at?: { readonly fx: number; readonly fy?: number; readonly dy?: number };
  /** Hold near the scroller's right edge until the target is visible. */
  readonly viaRightEdge?: boolean;
  readonly timeoutMs?: number;
}

export async function dragToBand(page: Page, source: Locator, target: Locator, opts: DragOptions = {}): Promise<void> {
  const s = await box(source);
  await page.mouse.move(s.x + s.width / 2, s.y + Math.min(12, s.height / 2));
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 10, s.y + Math.min(12, s.height / 2) + 10, { steps: 3 });

  if (opts.viaRightEdge && !(await fullyVisible(page, target))) {
    const sc = await box(laneScroller(page));
    const t = await box(target);
    // Over a band (the peeking lane's) so dnd-kit's `over` node has the scroller as an ancestor.
    await page.mouse.move(sc.x + sc.width - 20, t.y + t.height / 2, { steps: 12 });
    const deadline = Date.now() + (opts.timeoutMs ?? 8_000);
    while (!(await fullyVisible(page, target))) {
      if (Date.now() > deadline) {
        await page.mouse.up();
        throw new Error("auto-scroll never brought the target band into view");
      }
      await page.waitForTimeout(50);
    }
  }

  const point = async () => {
    const t = await box(target);
    const fx = opts.at?.fx ?? 0.5;
    const y = opts.at?.dy !== undefined ? t.y + opts.at.dy : t.y + t.height * (opts.at?.fy ?? 0.5);
    return { x: t.x + t.width * fx, y };
  };
  const first = await point();
  await page.mouse.move(first.x, first.y, { steps: 12 });
  await page.waitForTimeout(150);
  // Re-aim once: the board may have scrolled while the pointer left the edge zone.
  const second = await point();
  await page.mouse.move(second.x, second.y, { steps: 2 });
  await page.mouse.up();
}

/** Open /admin/calendar (the context carries the session cookie) and step forward to `day` (one or two days ahead in every M2 walk). */
export async function openBoard(page: Page, base: string, day: string): Promise<void> {
  await page.goto(`${base}/admin/calendar`, { waitUntil: "load", timeout: 60_000 });
  const band = page.locator(`[data-band-day="${day}"]`).first();
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Next day" }).click();
    if (await band.waitFor({ timeout: 10_000 }).then(() => true, () => false)) return;
  }
  throw new Error(`the board never showed ${day}`);
}
