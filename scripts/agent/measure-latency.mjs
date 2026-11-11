#!/usr/bin/env node
/**
 * Time to page frame and time to first data row for every admin nav page.
 *
 *   node scripts/agent/measure-latency.mjs [--base http://localhost:3000] [--runs 5] [--out <file>]
 *     [--preview-as <userId>] [--prod]
 *
 * Each run loads /admin, waits for it to settle, clicks the sidebar link and
 * measures from the click (plan ruling 14):
 *   frame     = first moment `main h1` or a skeleton is on the NEW page
 *   first row = first moment `main` has an `h1` and no [data-slot="skeleton"]
 * "New page" = location.pathname equals the target, so the old page's h1 is
 * never counted. Dashboard is reached from /admin/settings (it is /admin).
 *
 * Session: on localhost it is minted with `MINT_EMAIL=<dev non-demo admin>`
 * (reads .env.local = DEV). On any other base set HVAC_SESSION to the raw
 * hvac_admin_session cookie value. Measure a local `next build && next start`.
 *
 * A non-local base is refused without --prod (the user's say-so only). Admin
 * page loads write onboarding stamps, so there --preview-as <userId> measures
 * read-only with HVAC_PREVIEW (the raw hvac_preview cookie value); without
 * --preview-as the run warns that it writes stamps (latency-run.ts).
 *
 * --preview-as <userId> on localhost measures as that user ("View as", spec
 * P7) with a dev hvac_preview cookie from mint-preview-cookie.mjs, bound to
 * the session.
 *
 * Exits 1 when any page never measured a first row (every run failed).
 */
import { execFileSync, spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

// The stats module imports extensionless .ts siblings, which plain node cannot
// resolve; re-run once under tsx so `node scripts/agent/measure-latency.mjs`
// works as documented.
if (!process.env.MEASURE_LATENCY_UNDER_TSX) {
  const r = spawnSync(
    "npx",
    ["tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, MEASURE_LATENCY_UNDER_TSX: "1" } },
  );
  process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const base = opt("base", "http://localhost:3000").replace(/\/+$/, "");
const runs = Number(opt("runs", "5"));
const out = opt("out", "");
const previewAs = opt("preview-as", "");
const { hostname } = new URL(base);
const isLocal = hostname === "localhost" || hostname === "127.0.0.1";

const { LATENCY_PAGES, formatLatencyTable } = await import(
  "../../src/lib/admin/latency-stats.ts"
);
const { latencyExitCode, latencyRunPlan } = await import("../../src/lib/admin/latency-run.ts");

const plan = latencyRunPlan({
  isLocal,
  prod: args.includes("--prod"),
  previewAs,
  envPreviewCookie: Boolean(process.env.HVAC_PREVIEW),
});
if (!plan.ok) {
  console.error(plan.error);
  process.exit(1);
}
if (plan.warning) console.error(`Warning: ${plan.warning}`);

function sessionToken() {
  if (process.env.HVAC_SESSION) return process.env.HVAC_SESSION;
  if (!isLocal) {
    console.error("Non-local base: set HVAC_SESSION to the admin session cookie value.");
    process.exit(1);
  }
  if (!process.env.MINT_EMAIL) {
    console.error("Set MINT_EMAIL to a dev non-demo super_admin/admin email.");
    process.exit(1);
  }
  return execFileSync("npx", ["tsx", "scripts/agent/mint-admin-session.mjs"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();
}

const norm = (p) => p.replace(/\/+$/, "") || "/";

/** Runs in the page: resolves {frame, row} ms measured from now. */
function observeAfterClick(target) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const res = { frame: null, row: null };
    const tick = () => {
      if (location.pathname.replace(/\/+$/, "") === target) {
        const main = document.querySelector("main");
        const h1 = main && main.querySelector("h1");
        const skel = main && main.querySelector('[data-slot="skeleton"]');
        const now = performance.now() - t0;
        if (res.frame === null && (h1 || skel)) res.frame = now;
        if (res.row === null && h1 && !skel) {
          res.row = now;
          return resolve(res);
        }
      }
      if (performance.now() - t0 > 30000) return resolve(res);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const settled = (page) =>
  page.waitForFunction(() => {
    const main = document.querySelector("main");
    return !!main?.querySelector("h1") && !main.querySelector('[data-slot="skeleton"]');
  }, null, { timeout: 30000 });

const token = sessionToken();
const previewCookie =
  plan.preview === "env"
    ? process.env.HVAC_PREVIEW
    : plan.preview === "mint"
      ? execFileSync("npx", ["tsx", "scripts/agent/mint-preview-cookie.mjs", previewAs], {
          encoding: "utf8",
          env: { ...process.env, HVAC_SESSION: token },
        })
          .trim()
          .split("\n")
          .pop()
      : null;
const browser = await chromium.launch();
const rows = [];
try {
  for (const href of LATENCY_PAGES) {
    const row = { path: norm(href), frame: [], firstRow: [] };
    for (let i = 0; i < runs; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addCookies([
        { name: "hvac_admin_session", value: token, domain: hostname, path: "/" },
        ...(previewCookie
          ? [{ name: "hvac_preview", value: previewCookie, domain: hostname, path: "/" }]
          : []),
      ]);
      const page = await ctx.newPage();
      try {
        const start = norm(href) === "/admin" ? "/admin/settings" : "/admin";
        await page.goto(base + start, { waitUntil: "load", timeout: 60000 });
        await settled(page);
        await page.waitForTimeout(500);
        // Next may render "/admin/" as "/admin"; match either.
        const link = page
          .locator(`aside a[href="${norm(href)}"], aside a[href="${norm(href)}/"]`)
          .first();
        await link.waitFor({ timeout: 10000 });
        // Observe from before the click; awaited together so a failed click
        // never leaves the observer's promise rejecting unhandled.
        const [r] = await Promise.all([
          page.evaluate(observeAfterClick, norm(href)),
          link.click(),
        ]);
        if (r.frame !== null) row.frame.push(r.frame);
        if (r.row !== null) row.firstRow.push(r.row);
      } catch (err) {
        console.error(`${row.path} run ${i + 1}: ${String(err.message).split("\n")[0]}`);
      } finally {
        await ctx.close();
      }
    }
    rows.push(row);
    console.error(`${row.path} done`);
  }
} finally {
  await browser.close();
}

const table = formatLatencyTable(rows);
const header = `# ${new Date().toISOString()}  base=${base}  runs=${runs}  (ms from click)\n`;
console.log(header + table);
if (out) writeFileSync(out, header + table + "\n");
process.exitCode = latencyExitCode(rows);
