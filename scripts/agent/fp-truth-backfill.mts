/**
 * FieldPulse data-truth backfill (2026-11-11). Corrects three import defects
 * on rows already in the database; the importer now gets all three right on
 * every sync, so this only repairs history. Idempotent: a second run plans 0.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/fp-truth-backfill.mts --org <uuid>            # dry run
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/fp-truth-backfill.mts --org <uuid> --apply
 *   add --part estimates,customers,dates,after-hours,invoices to run only some parts (default: all five)
 *
 * Parts
 *   estimates  status + fieldpulse_status_name from the STORED fieldpulse_data
 *              (status_id, estimate_accept_at), resolved against the company's
 *              estimate status workflows read from FieldPulse
 *              (src/lib/integrations/fieldpulse/estimate-status.ts).
 *   customers  customer_type from the STORED fieldpulse_data.account_type
 *              (company → commercial, individual → residential).
 *   dates      created_at of FieldPulse-linked requests, customers and
 *              estimates, from FieldPulse's own created_at (read from the API:
 *              the stored fieldpulse_data never kept it). A row changes only
 *              when FieldPulse has a real date EARLIER than the stored one.
 *   after-hours is_after_hours of IMPORTED requests (synthetic fp-import-
 *              session), recomputed from created_at with the org's after-hours
 *              config — the importer's own rule for new rows. Rows imported
 *              with the import day got `false`; re-dated rows need the real
 *              answer. Native requests later pushed to FieldPulse, and rows
 *              whose created_at is still the import stamp, are untouched.
 *   invoices   state of FieldPulse-mirrored invoices from the STORED
 *              fieldpulse_data.status_id, resolved against the company's
 *              invoice status workflows read from FieldPulse
 *              (src/lib/integrations/fieldpulse/invoice-status.ts): Invoice
 *              Draft → draft, Invoiced/Sent/Partially Paid → open, Paid → paid,
 *              Void → void. A status_id in no current workflow keeps its state.
 *              Paid amounts are NOT touched: amount_paid/amount_unpaid are not
 *              stored (they are promoted out of fieldpulse_data), so the
 *              nightly sync refreshes them from FieldPulse.
 *              NOTE: trg_unhide_on_reopen (0061) un-hides a hidden invoice that
 *              moves TO open, with its request and customer; the dry run counts them.
 *
 * Deleted FieldPulse jobs are hidden by the sibling fp-hide-deleted-jobs.mts
 * (--invoices hides open invoices deleted in FieldPulse).
 *
 * FieldPulse is only READ (GET /estimates/status-workflows,
 * /invoices/status-workflows, /jobs, /customers, /estimates). The database
 * writes touch status, fieldpulse_status_name, customer_type, created_at and
 * invoices.state only. Of those only invoices.state has an unhide trigger
 * (see the invoices part); nothing here sets hidden_from_org itself.
 *
 * Any run against the production host (ep-withered-hill, any letter case)
 * needs --prod; only the user passes it, never an agent. .env.local (the DEV
 * branch) fills missing values only when DATABASE_URL is not exported and the
 * run is not --prod (scripts/agent/golive-env.mjs) — so for a prod run export
 * DATABASE_URL and ENCRYPTION_KEY (or FIELDPULSE_API_KEY) for prod.
 */
import { loadGoliveEnv } from "./golive-env.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTS = ["estimates", "customers", "dates", "after-hours", "invoices"] as const;
type Part = (typeof PARTS)[number];

function refuse(reason: string): never {
  console.error(`Refused: ${reason}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const out = { org: "", apply: false, prod: false, parts: [...PARTS] as Part[] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org" || arg === "--part") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse(`missing value for ${arg}`);
      if (arg === "--org") out.org = value;
      else {
        const parts = value.split(",").map((p) => p.trim());
        for (const p of parts) if (!PARTS.includes(p as Part)) refuse(`unknown part ${p}`);
        out.parts = parts as Part[];
      }
      i += 1;
    } else if (arg === "--apply") out.apply = true;
    else if (arg === "--prod") out.prod = true;
    else refuse(`unknown argument ${arg}`);
  }
  if (!UUID.test(out.org)) refuse("--org must be an organization uuid");
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Before any connection: the database modules are imported only past this line.
loadGoliveEnv({ prod: args.prod });

const { db } = await import("../../src/lib/db");
const { sql } = await import("drizzle-orm");
const { getFieldpulseClient } = await import("../../src/lib/integrations/fieldpulse/client");
const { fpEstimateStatusUpdate } = await import("../../src/lib/integrations/fieldpulse/estimate-status");
const { fpInvoiceStateFromStatus } = await import("../../src/lib/integrations/fieldpulse/invoice-status");
const { parseFpDate, earlierFpDate } = await import("../../src/lib/integrations/fieldpulse/fp-dates");
const { mapAccountType } = await import("../../src/lib/integrations/fieldpulse/import/customers");
const { getOrgConfig } = await import("../../src/lib/admin/org-config-queries");
const { isAfterHours } = await import("../../src/lib/admin/after-hours");

type Row = Record<string, unknown>;
type Stmt = ReturnType<typeof sql>;
const rows = async (q: Stmt): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const BATCH = 200;
async function runBatched(statements: Stmt[]): Promise<number> {
  let changed = 0;
  for (let i = 0; i < statements.length; i += BATCH) {
    const res = await db.batch(statements.slice(i, i + BATCH).map((s) => db.execute(s)) as never);
    changed += (res as { rowCount?: number }[]).reduce((n, r) => n + (r.rowCount ?? 0), 0);
  }
  return changed;
}
const tally = (list: string[]) =>
  Object.fromEntries([...list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].sort());

const org = (await rows(sql`SELECT name FROM organizations WHERE id = ${args.org}::uuid`))[0];
if (!org) refuse(`no organization ${args.org}`);
console.log(`${args.apply ? "APPLY" : "DRY RUN"} for ${org.name} (${args.org}); parts: ${args.parts.join(", ")}`);

const needsFp = args.parts.includes("estimates") || args.parts.includes("dates") || args.parts.includes("invoices");
const client = needsFp ? await getFieldpulseClient(args.org) : null;
if (needsFp && !client) refuse("this organization has no FieldPulse connection (and no env key fallback)");

// ── estimates: status + FieldPulse name ──────────────────────────────────────
if (args.parts.includes("estimates")) {
  const lookup = await client!.listEstimateStatuses();
  if (lookup.size === 0) refuse("FieldPulse returned no estimate statuses; nothing safe to map against");
  const list = await rows(sql`
    SELECT id, status::text AS status, fieldpulse_status_name AS name,
           fieldpulse_data->>'status_id' AS status_id,
           fieldpulse_data->>'estimate_accept_at' AS accepted_at
      FROM estimates
     WHERE organization_id = ${args.org}::uuid AND fieldpulse_estimate_id IS NOT NULL`);
  // No evidence (status id in no workflow, no acceptance) keeps the stored status and name.
  const plan = list.map((r) => {
    const update = fpEstimateStatusUpdate({ statusId: r.status_id, acceptedAt: r.accepted_at }, lookup);
    return {
      id: r.id as string,
      status: update?.status ?? (r.status as string),
      name: update?.name ?? (r.name as string | null),
    };
  });
  const changes = plan.filter((p, i) => p.status !== list[i]!.status || p.name !== list[i]!.name);
  const unknownIds = list.filter((r) => r.status_id && !lookup.has(String(r.status_id))).map((r) => String(r.status_id));
  console.log(`\nestimates: ${list.length} imported, ${changes.length} to change`);
  console.log("  before:", tally(list.map((r) => `${r.status} / ${r.name ?? "—"}`)));
  console.log("  after: ", tally(plan.map((p) => `${p.status} / ${p.name ?? "—"}`)));
  if (unknownIds.length) console.log("  status_id not in any current workflow (status and name kept unless accepted):", tally(unknownIds));
  if (args.apply && changes.length) {
    const n = await runBatched(changes.map((c) => sql`
      UPDATE estimates SET status = ${c.status}::estimate_status, fieldpulse_status_name = ${c.name}
       WHERE id = ${c.id}::uuid AND organization_id = ${args.org}::uuid`));
    console.log(`  updated ${n}`);
  }
}

// ── customers: customer_type from account_type ───────────────────────────────
if (args.parts.includes("customers")) {
  const list = await rows(sql`
    SELECT id, customer_type::text AS type, fieldpulse_data->>'account_type' AS account_type
      FROM customers
     WHERE organization_id = ${args.org}::uuid AND fieldpulse_customer_id IS NOT NULL`);
  const changes = list
    .map((r) => ({ id: r.id as string, from: r.type as string, to: mapAccountType((r.account_type as string | null) ?? null) }))
    .filter((c) => c.to !== null && c.to !== c.from);
  console.log(`\ncustomers: ${list.length} imported, ${changes.length} to change`);
  console.log("  before:", tally(list.map((r) => `${r.type} (FP ${r.account_type ?? "none"})`)));
  console.log("  changes:", tally(changes.map((c) => `${c.from} → ${c.to}`)));
  if (args.apply && changes.length) {
    for (const to of ["commercial", "residential"] as const) {
      const ids = changes.filter((c) => c.to === to).map((c) => c.id);
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        const res = await db.execute(sql`
          UPDATE customers SET customer_type = ${to}::customer_type
           WHERE organization_id = ${args.org}::uuid AND customer_type <> ${to}::customer_type
             AND id = ANY(${`{${chunk.join(",")}}`}::uuid[])`);
        console.log(`  set ${to}: ${res.rowCount ?? 0}`);
      }
    }
  }
}

// ── dates: created_at from FieldPulse's own created_at ───────────────────────
if (args.parts.includes("dates")) {
  const [jobs, fpCustomers, fpEstimates] = [
    await client!.listJobs(),
    await client!.listCustomers(),
    await client!.listEstimates(),
  ];
  for (const [label, walk] of [["jobs", jobs], ["customers", fpCustomers], ["estimates", fpEstimates]] as const) {
    if (walk.cappedByMaxPages) refuse(`the FieldPulse ${label} walk hit its page cap; a partial walk is not safe to backfill from`);
  }
  // Per-id fallback for rows the list walk missed (FP list paging is not
  // stable); a 404 means FieldPulse deleted the record, so it has no date.
  const getJobCreatedAt = async (id: string) => {
    try {
      return (await client!.getJob(id)).createdAt ?? null;
    } catch (err) {
      if ((err as { fpStatus?: number }).fpStatus === 404) return null;
      throw err;
    }
  };
  const targets = [
    { table: "service_requests", fpCol: "fieldpulse_job_id", fp: jobs.items, getOne: getJobCreatedAt, extra: sql`AND reference_number NOT LIKE 'HVAC-DEMO%' AND reference_number NOT LIKE 'HVAC-CAP%'` },
    { table: "customers", fpCol: "fieldpulse_customer_id", fp: fpCustomers.items, getOne: async (id: string) => (await client!.getCustomer(id))?.createdAt ?? null, extra: sql`` },
    { table: "estimates", fpCol: "fieldpulse_estimate_id", fp: fpEstimates.items, getOne: async (id: string) => (await client!.getEstimate(id))?.createdAt ?? null, extra: sql`` },
  ] as const;
  for (const t of targets) {
    const fpDates = new Map<string, Date>();
    for (const item of t.fp) {
      const d = parseFpDate(item.createdAt ?? null);
      if (d) fpDates.set(item.id, d);
    }
    const list = await rows(sql`
      SELECT id, ${sql.raw(t.fpCol)} AS fp_id, created_at
        FROM ${sql.raw(t.table)}
       WHERE organization_id = ${args.org}::uuid AND ${sql.raw(t.fpCol)} IS NOT NULL ${t.extra}`);
    for (const r of list) {
      const fpId = String(r.fp_id);
      if (fpDates.has(fpId)) continue;
      const d = parseFpDate(await t.getOne(fpId));
      if (d) fpDates.set(fpId, d);
    }
    const changes = list.flatMap((r) => {
      const to = earlierFpDate(new Date(r.created_at as string), fpDates.get(String(r.fp_id)) ?? null);
      return to ? [{ id: r.id as string, from: new Date(r.created_at as string), to }] : [];
    });
    const missing = list.filter((r) => !fpDates.has(String(r.fp_id))).length;
    const day = (d: Date) => d.toISOString().slice(0, 10);
    console.log(`\n${t.table}: ${list.length} FieldPulse-linked, ${changes.length} to move earlier, ${missing} with no FieldPulse date (left alone)`);
    console.log("  busiest created days before:", Object.entries(tally(list.map((r) => day(new Date(r.created_at as string))))).sort((a, b) => b[1] - a[1]).slice(0, 4));
    console.log("  rows moving, by old day:", tally(changes.map((c) => day(c.from))));
    if (args.apply && changes.length) {
      const n = await runBatched(changes.map((c) => sql`
        UPDATE ${sql.raw(t.table)} SET created_at = ${c.to.toISOString()}::timestamptz
         WHERE id = ${c.id}::uuid AND organization_id = ${args.org}::uuid AND created_at > ${c.to.toISOString()}::timestamptz`));
      console.log(`  updated ${n}`);
    }
  }
}

// ── after-hours: recompute for imported requests from their (real) created_at ─
if (args.parts.includes("after-hours")) {
  const cfg = (await getOrgConfig(args.org)).afterHoursConfig;
  const list = await rows(sql`
    SELECT r.id, r.created_at, r.is_after_hours
      FROM service_requests r
      JOIN customer_sessions s ON s.id = r.session_id
     WHERE r.organization_id = ${args.org}::uuid AND r.fieldpulse_job_id IS NOT NULL
       AND s.token LIKE 'fp-import-%'
       -- created_at still equal to the import stamp (the synthetic session's
       -- created_at) is not a real booking time: leave those rows alone.
       AND abs(extract(epoch FROM r.created_at - s.created_at)) > 60`);
  const changes = list
    .map((r) => ({ id: r.id as string, from: r.is_after_hours === true, to: isAfterHours(new Date(r.created_at as string), cfg) }))
    .filter((c) => c.from !== c.to);
  console.log(`\nafter-hours: ${list.length} imported requests, ${changes.length} to change`, tally(changes.map((c) => `${c.from} → ${c.to}`)));
  if (args.apply && changes.length) {
    const n = await runBatched(changes.map((c) => sql`
      UPDATE service_requests SET is_after_hours = ${c.to}
       WHERE id = ${c.id}::uuid AND organization_id = ${args.org}::uuid`));
    console.log(`  updated ${n}`);
  }
}

// ── invoices: state from the stored status_id + the live workflow lookup ─────
if (args.parts.includes("invoices")) {
  const lookup = await client!.listInvoiceStatuses();
  if (lookup.size === 0) refuse("FieldPulse returned no invoice statuses; nothing safe to map against");
  const list = await rows(sql`
    SELECT id, state::text AS state, hidden_from_org AS hidden,
           fieldpulse_data->>'status_id' AS status_id,
           GREATEST(total_cents - amount_paid_cents, 0) AS balance_cents
      FROM invoices
     WHERE organization_id = ${args.org}::uuid AND fieldpulse_invoice_id IS NOT NULL`);
  const name = (sid: unknown) => (sid ? lookup.get(String(sid))?.name ?? `unknown ${sid}` : "no status_id");
  const changes = list.flatMap((r) => {
    const to = fpInvoiceStateFromStatus(r.status_id, lookup);
    return to && to !== r.state
      ? [{ id: r.id as string, from: r.state as string, to, sid: r.status_id, hidden: r.hidden === true, balance: Number(r.balance_cents) }]
      : [];
  });
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const openBalance = (pick: (r: Row) => string) =>
    usd(list.filter((r) => pick(r) === "open").reduce((n, r) => n + Number(r.balance_cents), 0));
  const after = new Map(changes.map((c) => [c.id, c.to]));
  console.log(`\ninvoices: ${list.length} FieldPulse-mirrored, ${changes.length} to change`);
  console.log("  changes (stored → FieldPulse):", tally(changes.map((c) => `${c.from} → ${c.to} (${name(c.sid)})`)));
  const byChange = new Map<string, number>();
  for (const c of changes) byChange.set(`${c.from} → ${c.to}`, (byChange.get(`${c.from} → ${c.to}`) ?? 0) + c.balance);
  console.log("  balance on changing rows:", Object.fromEntries([...byChange].map(([k, v]) => [k, usd(v)])));
  console.log(`  open balance before ${openBalance((r) => r.state as string)}, after ${openBalance((r) => after.get(r.id as string) ?? (r.state as string))}`);
  const reopenHidden = changes.filter((c) => c.to === "open" && c.hidden).length;
  if (reopenHidden) console.log(`  ${reopenHidden} hidden invoices move to open; the 0061 trigger will un-hide them with their request and customer`);
  const unknown = list.filter((r) => !fpInvoiceStateFromStatus(r.status_id, lookup)).map((r) => `${r.state} / ${name(r.status_id)}`);
  if (unknown.length) console.log("  kept as stored (status_id in no current workflow, or none stored):", tally(unknown));
  if (args.apply && changes.length) {
    const n = await runBatched(changes.map((c) => sql`
      UPDATE invoices SET state = ${c.to}::invoice_state, updated_at = now()
       WHERE id = ${c.id}::uuid AND organization_id = ${args.org}::uuid
         AND fieldpulse_invoice_id IS NOT NULL AND state = ${c.from}::invoice_state`));
    console.log(`  updated ${n}`);
  }
}

console.log(args.apply ? "\nDone." : "\nDry run only; pass --apply to write.");
