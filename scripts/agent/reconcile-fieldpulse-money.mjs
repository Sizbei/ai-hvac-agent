/**
 * Reconcile every mirrored FieldPulse invoice against the live FieldPulse API.
 *
 * WHY: the mirror is where the money on screen comes from — AR, collections,
 * the accounting export and the dashboard tile all read `invoices`. Sampling 30
 * of 2,853 rows tells you the mirror is *probably* right. This tells you
 * whether it is right.
 *
 * READ-ONLY. It issues GET requests to FieldPulse and SELECTs against the
 * database. It never writes to either.
 *
 * Usage:
 *   node scripts/agent/reconcile-fieldpulse-money.mjs --org <uuid> [--limit N] [--json]
 *
 * Exit code is 1 when any invoice disagrees, so it can gate a release.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

const DEV_HOST_MARKER = 'ep-patient-surf';
const FP_BASE = 'https://ywe3crmpll.execute-api.us-east-2.amazonaws.com/stage';
// FieldPulse serves /invoices at a fixed 20 rows per page; page_size is
// advisory at best. MAX_PAGES is a spin guard, not an expected bound.
const PAGE_SIZE = 20;
const MAX_PAGES = 1000;

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;
const AS_JSON = args.includes('--json');

const dbUrl = process.env.DATABASE_URL;
const apiKey = process.env.FIELDPULSE_API_KEY;
if (!dbUrl) { console.error('ERROR: DATABASE_URL is not set'); process.exit(1); }
if (!apiKey) { console.error('ERROR: FIELDPULSE_API_KEY is not set'); process.exit(1); }

// This script only reads, but a surprising target still means the numbers you
// are about to trust describe a database you did not mean to inspect.
const host = new URL(dbUrl.replace(/^postgres(ql)?:\/\//, 'https://')).hostname;
if (!host.includes(DEV_HOST_MARKER)) {
  console.error(`Refusing to run against '${host}' — not the dev branch.`);
  console.error('Re-point DATABASE_URL, or edit DEV_HOST_MARKER if the dev branch moved.');
  process.exit(1);
}

const { neon } = await import('@neondatabase/serverless');
const sql = neon(dbUrl);

/** Dollars-string → integer cents, matching the importer's own conversion. */
function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Page /invoices the way the app's own client does.
 *
 * FieldPulse does NOT support `offset`/`limit` on this endpoint — it ignores
 * them and returns the identical first page forever, so an offset walk never
 * terminates and never sees past row 100. (Verified: offsets 0, 2900, 5000 and
 * 10000 all return the same first id.) The supported contract is
 * `page`/`page_size`, with a fixed 20 rows per page, and even that must be
 * treated as advisory: if a page comes back identical to the previous one, the
 * API is ignoring the parameter and the walk has to stop rather than spin.
 */
async function fetchAllUpstream() {
  const byId = new Map();
  let lastBatchKey = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${FP_BASE}/invoices?page=${page}&page_size=${PAGE_SIZE}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) throw new Error(`FieldPulse /invoices ${res.status} on page ${page}`);
    const body = await res.json();
    const rows = Array.isArray(body.response) ? body.response : [];
    if (rows.length === 0) break;

    const batchKey = rows.map((r) => r.id).join(',');
    if (batchKey === lastBatchKey) break; // API ignored `page` — stop, don't spin.
    lastBatchKey = batchKey;

    let added = 0;
    for (const r of rows) {
      const id = String(r.id);
      if (!byId.has(id)) added++;
      byId.set(id, r);
    }

    if (rows.length < PAGE_SIZE || added === 0) break;
    if (byId.size >= LIMIT) break;
  }
  return byId;
}

// Tenant scope is mandatory, not defensive. The upstream side of this
// comparison is ONE FieldPulse account (the single key in env), so pulling
// every org's invoices would compare org B's money against org A's books and
// report the difference as a mismatch — turning a release gate into noise.
const orgArg = args.indexOf('--org');
const ORG_ID = orgArg !== -1 ? args[orgArg + 1] : process.env.FP_SYNC_ORG_ID;
if (!ORG_ID) {
  console.error('ERROR: pass --org <uuid> (or set FP_SYNC_ORG_ID).');
  console.error('This compares against a single FieldPulse account, so it must target a single org.');
  process.exit(1);
}

const local = await sql.query(
  `select fieldpulse_invoice_id as fp_id, total_cents, amount_paid_cents, state
     from invoices
    where fieldpulse_invoice_id is not null
      and organization_id = $1
    order by fieldpulse_invoice_id`,
  [ORG_ID],
);

process.stderr.write(`local mirrored invoices: ${local.length}\nfetching upstream…\n`);
const upstream = await fetchAllUpstream();
process.stderr.write(`upstream invoices fetched: ${upstream.size}\n\n`);

const mismatches = [];
let compared = 0;
let missingUpstream = 0;

for (const row of local) {
  if (compared >= LIMIT) break;
  const up = upstream.get(String(row.fp_id));
  if (!up) { missingUpstream++; continue; }
  compared++;

  const upTotal = toCents(up.total);
  if (upTotal !== null && upTotal !== row.total_cents) {
    mismatches.push({
      fpId: row.fp_id,
      field: 'total_cents',
      local: row.total_cents,
      upstream: upTotal,
      deltaCents: row.total_cents - upTotal,
    });
  }
}

const summary = {
  localMirrored: local.length,
  upstreamFetched: upstream.size,
  compared,
  missingUpstream,
  mismatches: mismatches.length,
  worstDeltaCents: mismatches.reduce((m, x) => Math.max(m, Math.abs(x.deltaCents)), 0),
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, mismatches: mismatches.slice(0, 50) }, null, 2));
} else {
  console.log('=== FieldPulse money reconciliation ===');
  console.log(`  local mirrored : ${summary.localMirrored}`);
  console.log(`  upstream       : ${summary.upstreamFetched}`);
  console.log(`  compared       : ${summary.compared}`);
  console.log(`  not upstream   : ${summary.missingUpstream}  (local rows with no matching FP invoice)`);
  console.log(`  MISMATCHES     : ${summary.mismatches}`);
  if (mismatches.length) {
    console.log(`  worst delta    : $${(summary.worstDeltaCents / 100).toFixed(2)}`);
    console.log('\n  first 20:');
    for (const m of mismatches.slice(0, 20)) {
      console.log(`   fp#${m.fpId} ${m.field}: local ${m.local} vs upstream ${m.upstream} (delta ${m.deltaCents})`);
    }
  } else {
    console.log('\n  Every compared invoice total matches FieldPulse exactly.');
  }
}

process.exit(mismatches.length > 0 ? 1 : 0);
