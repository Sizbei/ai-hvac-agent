// @ts-check
/**
 * Captures documentation screenshots of the running AI HVAC app.
 *
 * Prerequisites:
 *   - The Next.js dev server must already be running at http://localhost:3000.
 *   - The database must be seeded (admin user admin@demo-hvac.com / admin123).
 *   - Playwright + chromium installed (`npm i -D playwright`, `npx playwright install chromium`).
 *
 * Usage: node scripts/screenshots.mjs
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';

const BASE_URL = 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@demo-hvac.com';
const ADMIN_PASSWORD = 'admin123';
const ACTION_TIMEOUT = 15_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'screenshots');

mkdirSync(OUT_DIR, { recursive: true });

/** @type {{ name: string; status: 'ok' | 'failed'; reason?: string }[]} */
const results = [];

/**
 * Wraps a single screenshot task so one failure does not abort the rest.
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function capture(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'ok' });
    console.log(`[ok]     ${name}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    results.push({ name, status: 'failed', reason });
    console.error(`[FAILED] ${name}: ${reason}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  context.setDefaultTimeout(ACTION_TIMEOUT);
  context.setDefaultNavigationTimeout(ACTION_TIMEOUT);

  const page = await context.newPage();

  // 1. Landing page (full page)
  await capture('landing', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: join(OUT_DIR, 'landing.png'), fullPage: true });
  });

  // 2. Chat page with a short deterministic exchange
  await capture('chat', async () => {
    await page.goto(`${BASE_URL}/chat`, { waitUntil: 'networkidle' });
    const input = page.getByPlaceholder(/describe your hvac issue/i);
    await input.waitFor({ state: 'visible' });
    // Wait for quick-reply chips to render.
    await page.getByText(/common issues/i).waitFor({ state: 'visible' });

    await input.fill('what areas do you serve?');
    await input.press('Enter');
    await sleep(1500);

    const reply = page.getByPlaceholder(/type your reply/i);
    await reply.fill('my ac is blowing warm air');
    await reply.press('Enter');
    await sleep(2000);

    await page.screenshot({ path: join(OUT_DIR, 'chat.png') });
  });

  // 3. Admin login form
  await capture('admin-login', async () => {
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await page.locator('#email').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(OUT_DIR, 'admin-login.png') });
  });

  // Authenticate via the API so the session cookie is set on the context.
  const loginRes = await context.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!loginRes.ok()) {
    console.error(
      `[warn] admin login API returned ${loginRes.status()} — admin screenshots may fail`,
    );
  } else {
    console.log('[ok]     admin login API authenticated');
  }

  // 4. Admin requests
  await capture('admin-requests', async () => {
    await page.goto(`${BASE_URL}/admin/requests`, { waitUntil: 'networkidle' });
    await page.locator('table, [role="table"]').first().waitFor({ state: 'visible' });
    await sleep(800);
    await page.screenshot({ path: join(OUT_DIR, 'admin-requests.png') });
  });

  // 5. Admin conversations + detail sheet
  await capture('admin-conversations', async () => {
    await page.goto(`${BASE_URL}/admin/conversations`, {
      waitUntil: 'networkidle',
    });
    await page.locator('table, [role="table"]').first().waitFor({ state: 'visible' });
    await sleep(800);
    await page.screenshot({ path: join(OUT_DIR, 'admin-conversations.png') });
  });

  await capture('admin-conversation-detail', async () => {
    // Reuse the conversations page; click the first data row to open the sheet.
    const firstRow = page.locator('tbody tr.cursor-pointer').first();
    await firstRow.waitFor({ state: 'visible' });
    await firstRow.click();
    await sleep(1200);
    await page.screenshot({
      path: join(OUT_DIR, 'admin-conversation-detail.png'),
    });
  });

  // 6. Docs page (top of page)
  await capture('docs', async () => {
    await page.goto(`${BASE_URL}/docs.html`, { waitUntil: 'networkidle' });
    await sleep(500);
    await page.screenshot({ path: join(OUT_DIR, 'docs.png') });
  });

  await browser.close();

  // Summary with byte sizes.
  console.log('\n=== Screenshot summary ===');
  for (const r of results) {
    if (r.status === 'ok') {
      const file = join(OUT_DIR, `${r.name}.png`);
      try {
        const { size } = statSync(file);
        console.log(`OK   ${r.name}.png  ${size} bytes`);
      } catch {
        console.log(`OK   ${r.name}.png  (file missing!)`);
      }
    } else {
      console.log(`FAIL ${r.name}.png  reason: ${r.reason}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
