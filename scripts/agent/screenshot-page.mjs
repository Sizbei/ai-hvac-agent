#!/usr/bin/env node
/**
 * Screenshot an admin (or, with --tech, technician) page on the local dev
 * server with a minted session. Requires the dev server to ALREADY be
 * running on :3000 (this script never starts or kills servers).
 *
 *   node scripts/agent/screenshot-page.mjs /admin/map [width] [outfile]
 *   node scripts/agent/screenshot-page.mjs /tech/jobs [width] [outfile] --tech
 *
 * Defaults: width 1440 (height 900; 390 → 844), outfile ./page-shot.png.
 * Without --tech, behavior is unchanged: mints hvac_admin_session via
 * mint-admin-session.mjs. With --tech, mints hvac_tech_session via
 * mint-tech-session.mjs instead.
 * Prints the outfile path on success.
 */
import { execFileSync } from "child_process";
import { chromium } from "playwright";

const rawArgs = process.argv.slice(2);
const isTech = rawArgs.includes("--tech");
const [path = "/admin", widthArg, outArg] = rawArgs.filter(
  (a) => a !== "--tech",
);
const width = Number(widthArg) || 1440;
const height = width <= 500 ? 844 : 900;
const outfile = outArg || "./page-shot.png";

const mintScript = isTech
  ? "scripts/agent/mint-tech-session.mjs"
  : "scripts/agent/mint-admin-session.mjs";
const cookieName = isTech ? "hvac_tech_session" : "hvac_admin_session";

const token = execFileSync("npx", ["tsx", mintScript], { encoding: "utf8" })
  .trim()
  .split("\n")
  .pop();

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 2,
});
await ctx.addCookies([
  { name: cookieName, value: token, domain: "localhost", path: "/" },
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
