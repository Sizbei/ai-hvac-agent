#!/usr/bin/env node
/**
 * Mechanical 390 px audit of the admin pages Chick uses daily. Reports
 * horizontal overflow and interactive elements in <main> under 44x44.
 * Requires a dev server ALREADY running (never starts or kills one).
 *
 *   node scripts/agent/mobile-audit.mjs [--base http://localhost:3000] [--preview-as <userId>]
 *
 * --preview-as adds one "View as" pass over /admin (the dev server needs
 * PLATFORM_ADMIN_EMAILS / PLATFORM_ORG_ID for the minted admin).
 * Exit 0 with "0 findings" when clean, 1 otherwise.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { chromium } from "playwright";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
if ((process.env.DATABASE_URL ?? "").includes("ep-withered-hill")) {
  console.error("Refusing to run against the production database.");
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = opt("--base") ?? "http://localhost:3000";
const previewAs = opt("--preview-as");
// Cookies go to the base's host (127.0.0.1 or a LAN host too, not only localhost).
const cookieDomain = new URL(base).hostname;
const VIEWPORT = 390;

const { auditFindings } = await import("../../src/lib/admin/mobile-audit.ts");
const { verifyToken } = await import("../../src/lib/auth/config.ts");
const { neon } = await import("@neondatabase/serverless");

const token = execFileSync("npx", ["tsx", "scripts/agent/mint-admin-session.mjs"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .pop();
const session = await verifyToken(token);
const sql = neon(process.env.DATABASE_URL);
const [cust] = await sql`SELECT id FROM customers WHERE organization_id = ${session.organizationId}::uuid ORDER BY created_at LIMIT 1`;
const [inv] = await sql`SELECT id FROM invoices WHERE organization_id = ${session.organizationId}::uuid ORDER BY created_at LIMIT 1`;

const pages = [
  "/admin",
  "/admin/requests",
  "/admin/calendar",
  "/admin/customers",
  cust && `/admin/customers/${cust.id}`,
  "/admin/invoices",
  inv && `/admin/invoices/${inv.id}`,
  "/admin/estimates",
  "/admin/staff",
  "/admin/conversations",
  "/admin/setup?lesson=requests",
  // Back-to-tour strip.
  "/admin/requests?from=tour&lesson=requests",
  "/admin/calendar?from=tour&lesson=schedule",
  "/admin/customers?from=tour&lesson=customers",
].filter(Boolean);

// Runs in the page: every visible interactive element inside <main>.
const measure = (viewport) => {
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const id =
      el.getAttribute("data-testid") ||
      el.getAttribute("aria-label") ||
      (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30) ||
      el.getAttribute("href") ||
      el.getAttribute("name") ||
      el.getAttribute("type") ||
      "";
    return `${tag}[${id}]`;
  };
  const sel =
    'main a[href], main button, main input:not([type=hidden]), main select, main textarea, main [role=button], main [role=tab], main [role=switch], main [role=checkbox]';
  const seen = new Set();
  const targets = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[aria-hidden="true"], [hidden], [inert]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // The Switch's positioned ::after is its real hit area; nothing else counts.
    const after = getComputedStyle(el, "::after");
    const pad =
      el.getAttribute("data-slot") === "switch" &&
      after.position === "absolute" &&
      after.content !== "none";
    const w = pad ? Math.max(r.width, parseFloat(after.width) || 0) : r.width;
    const h = pad ? Math.max(r.height, parseFloat(after.height) || 0) : r.height;
    const key = `${describe(el)}|${Math.round(w)}x${Math.round(h)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ selector: describe(el), w, h });
  }
  return { scrollWidth: document.documentElement.scrollWidth, viewport, targets };
};

async function auditPage(ctx, path) {
  const page = await ctx.newPage();
  try {
    const response = await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 90_000 });
    if (!response?.ok()) throw new Error(`HTTP ${response?.status()}`);
    const target = new URL(path, base);
    const landed = new URL(page.url());
    if (landed.pathname !== target.pathname) {
      throw new Error(`redirected to ${landed.pathname}`);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
    const m = await page.evaluate(measure, VIEWPORT);
    return auditFindings(m);
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch();
let total = 0;
async function run(label, ctx, list) {
  for (const path of list) {
    const label2 = `${label}${path}`;
    let findings;
    try {
      // A cold dev compile can time out once; retry before calling it a failure.
      findings = await auditPage(ctx, path).catch(() => auditPage(ctx, path));
    } catch (e) {
      findings = [{ kind: "load", detail: `page failed to load (${e.message})` }];
    }
    total += findings.length;
    console.log(`${label2}  ${findings.length ? `${findings.length} finding(s)` : "ok"}`);
    for (const f of findings) {
      console.log(`  - ${f.kind}${f.selector ? ` ${f.selector}` : ""}: ${f.detail}`);
    }
  }
}

const newCtx = () =>
  browser.newContext({ viewport: { width: VIEWPORT, height: 844 }, deviceScaleFactor: 2 });

const ctx = await newCtx();
await ctx.addCookies([{ name: "hvac_admin_session", value: token, domain: cookieDomain, path: "/" }]);
await run("", ctx, pages);

if (previewAs) {
  const preview = execFileSync(
    "npx",
    ["tsx", "scripts/agent/mint-preview-cookie.mjs", previewAs],
    { encoding: "utf8", env: { ...process.env, HVAC_SESSION: token } },
  )
    .trim()
    .split("\n")
    .pop();
  const pctx = await newCtx();
  await pctx.addCookies([
    { name: "hvac_admin_session", value: token, domain: cookieDomain, path: "/" },
    { name: "hvac_preview", value: preview, domain: cookieDomain, path: "/" },
  ]);
  await run("[view as] ", pctx, ["/admin"]);
}

await browser.close();
console.log(`\n${total} findings`);
process.exit(total === 0 ? 0 : 1);
