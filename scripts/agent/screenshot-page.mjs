#!/usr/bin/env node
/**
 * Screenshot an admin page on the local dev server with a minted session.
 * Requires the dev server to ALREADY be running on :3000 (this script never
 * starts or kills servers).
 *
 *   node scripts/agent/screenshot-page.mjs /admin/map [width] [outfile]
 *
 * Defaults: width 1440 (height 900; 390 → 844), outfile ./page-shot.png.
 * Prints the outfile path on success.
 */
import { execFileSync } from "child_process";
import { chromium } from "playwright";

const [, , path = "/admin", widthArg, outArg] = process.argv;
const width = Number(widthArg) || 1440;
const height = width <= 500 ? 844 : 900;
const outfile = outArg || "./page-shot.png";

const token = execFileSync(
  "npx",
  ["tsx", "scripts/agent/mint-admin-session.mjs"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .pop();

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 2,
});
await ctx.addCookies([
  { name: "hvac_admin_session", value: token, domain: "localhost", path: "/" },
]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3000${path}`, {
  waitUntil: "load",
  timeout: 60_000,
});
await page.waitForTimeout(8_000); // client fetches + map tiles
await page.screenshot({ path: outfile });
await browser.close();
console.log(outfile);
