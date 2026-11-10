#!/usr/bin/env node
/**
 * Screenshot an admin (or, with --tech, technician) page on the local dev
 * server with a minted session. Requires the dev server to ALREADY be
 * running on :3000 (this script never starts or kills servers).
 *
 *   node scripts/agent/screenshot-page.mjs /admin/map [width] [outfile]
 *   node scripts/agent/screenshot-page.mjs /tech/jobs [width] [outfile] --tech
 *   node scripts/agent/screenshot-page.mjs /admin [width] [outfile] --preview-as <userId>
 *
 * Defaults: width 1440 (height 900; 390 → 844), outfile ./page-shot.png.
 * Without --tech, behavior is unchanged: mints hvac_admin_session via
 * mint-admin-session.mjs. With --tech, mints hvac_tech_session via
 * mint-tech-session.mjs instead. --preview-as <userId> also sets a "View as"
 * hvac_preview cookie (mint-preview-cookie.mjs) bound to the minted admin
 * session; the dev server needs PLATFORM_ADMIN_EMAILS / PLATFORM_ORG_ID for
 * that admin (the mint script prints the values when they are missing).
 * Prints the outfile path on success.
 */
import { execFileSync } from "child_process";
import { chromium } from "playwright";

const rawArgs = process.argv.slice(2);
const isTech = rawArgs.includes("--tech");
const previewIdx = rawArgs.indexOf("--preview-as");
const previewAs = previewIdx >= 0 ? rawArgs[previewIdx + 1] : undefined;
if (previewIdx >= 0 && (!previewAs || isTech)) {
  console.error("--preview-as needs a target user id and cannot be combined with --tech");
  process.exit(1);
}
const [path = "/admin", widthArg, outArg] = rawArgs.filter(
  (a, i) => a !== "--tech" && (previewIdx < 0 || (i !== previewIdx && i !== previewIdx + 1)),
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
if (previewAs) {
  const preview = execFileSync(
    "npx",
    ["tsx", "scripts/agent/mint-preview-cookie.mjs", previewAs],
    { encoding: "utf8", env: { ...process.env, HVAC_SESSION: token } },
  )
    .trim()
    .split("\n")
    .pop();
  await ctx.addCookies([
    { name: "hvac_preview", value: preview, domain: "localhost", path: "/" },
  ]);
}
const page = await ctx.newPage();
await page.goto(`http://localhost:3000${path}`, {
  waitUntil: "load",
  timeout: 60_000,
});
await page.waitForTimeout(8_000); // client fetches + map tiles
await page.screenshot({ path: outfile });
await browser.close();
console.log(outfile);
