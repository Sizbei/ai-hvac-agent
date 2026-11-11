/**
 * Hide requests whose FieldPulse job was deleted in FieldPulse (GET /jobs/{id}
 * → 404), so they stop looking like live work in the org's view. Reversible.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/fp-hide-deleted-jobs.mts --org <uuid>              # dry run: prints the list
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/fp-hide-deleted-jobs.mts --org <uuid> --apply      # hides, writes the undo file
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/fp-hide-deleted-jobs.mts --org <uuid> --undo <file> [--apply]
 *   --manifest <file> names the undo file
 *   (default ~/.hvac-golive/fp-deleted-jobs-hidden-<org8>-<timestamp>.json, outside the repo)
 *
 * Only IMPORTED requests are hidden (synthetic fp-import- session). A native
 * request pushed to FieldPulse whose FieldPulse copy was deleted is listed for
 * review and never hidden: the office may delete the FieldPulse copy of real,
 * live work. golive-hide-history.mjs --unhide-fieldpulse reads the undo files
 * in ~/.hvac-golive/ and leaves their rows hidden; a successful --undo --apply
 * renames the file *.undone-<time>.json so it no longer counts.
 *
 * What is hidden (rules in src/lib/integrations/fieldpulse/deleted-job-hide.ts):
 * the request, its own invoices and estimates when every one of them is
 * FieldPulse-less with no money paid, and its synthetic fp-import- conversation.
 * A request with anything synced or paid stays visible and is listed for
 * review. Only 404 counts as deleted; any other FieldPulse error stops the run.
 * Rows already hidden are left out, so the undo file holds exactly the rows
 * this run hid and --undo un-hides exactly those.
 *
 * FieldPulse is only READ. Only hidden_from_org changes; no unhide trigger
 * watches it. Any run against the production host (ep-withered-hill, any
 * letter case) needs --prod; only the user passes it, never an agent.
 * .env.local (the DEV branch) fills missing values only when DATABASE_URL is
 * not exported and the run is not --prod (scripts/agent/golive-env.mjs).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { goliveRecordPath, loadGoliveEnv } from "./golive-env.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(reason: string): never {
  console.error(`Refused: ${reason}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const out = { org: "", apply: false, prod: false, undo: null as string | null, manifest: null as string | null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org" || arg === "--undo" || arg === "--manifest") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse(`missing value for ${arg}`);
      out[arg.slice(2) as "org" | "undo" | "manifest"] = value;
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
const { planDeletedJobHide, describeDeletedJobRequest } = await import("../../src/lib/integrations/fieldpulse/deleted-job-hide");

type Row = Record<string, unknown>;
type Stmt = ReturnType<typeof sql>;
const rows = async (q: Stmt): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

interface Manifest {
  readonly org: string;
  readonly createdAt: string;
  readonly requests: { id: string; referenceNumber: string }[];
  readonly invoices: string[];
  readonly estimates: string[];
  readonly sessions: string[];
}

const org = (await rows(sql`SELECT name FROM organizations WHERE id = ${args.org}::uuid`))[0];
if (!org) refuse(`no organization ${args.org}`);
console.log(`${args.apply ? "APPLY" : "DRY RUN"} ${args.undo ? "undo " : ""}for ${org.name} (${args.org})`);

async function setHidden(m: Manifest, hidden: boolean): Promise<void> {
  const targets = [
    ["service_requests", m.requests.map((r) => r.id)],
    ["invoices", m.invoices],
    ["estimates", m.estimates],
    ["customer_sessions", m.sessions],
  ] as const;
  for (const [table, ids] of targets) {
    if (ids.length === 0) continue;
    const res = await db.execute(sql`
      UPDATE ${sql.raw(table)} SET hidden_from_org = ${hidden}
       WHERE organization_id = ${args.org}::uuid AND id = ANY(${uuidArray(ids)}) AND hidden_from_org <> ${hidden}`);
    console.log(`  ${table}: ${hidden ? "hid" : "un-hid"} ${res.rowCount ?? 0}`);
  }
}

if (args.undo) {
  const m = JSON.parse(readFileSync(args.undo, "utf8")) as Manifest;
  if (m.org !== args.org) refuse(`the undo file is for org ${m.org}, not ${args.org}`);
  console.log(`undo file from ${m.createdAt}: ${m.requests.length} requests, ${m.invoices.length} invoices, ${m.estimates.length} estimates, ${m.sessions.length} conversations`);
  for (const r of m.requests) console.log(`  ${r.referenceNumber}`);
  if (args.apply) {
    await setHidden(m, false);
    renameSync(args.undo, args.undo.replace(/\.json$/, `.undone-${Date.now()}.json`));
  }
  console.log(args.apply ? "\nDone." : "\nDry run only; pass --apply to un-hide.");
  process.exit(0);
}

const client = await getFieldpulseClient(args.org);
if (!client) refuse("this organization has no FieldPulse connection (and no env key fallback)");

// imported = created by the FieldPulse import (synthetic fp-import- session);
// otherwise a native request that was pushed to FieldPulse.
const linked = await rows(sql`
  SELECT r.id, r.reference_number, r.status::text AS status, r.issue_type, r.description, r.fieldpulse_job_id, r.hidden_from_org,
         EXISTS (SELECT 1 FROM customer_sessions s WHERE s.organization_id = ${args.org}::uuid AND s.id = r.session_id AND s.token LIKE 'fp-import-%') AS imported
    FROM service_requests r
   WHERE r.organization_id = ${args.org}::uuid AND r.fieldpulse_job_id IS NOT NULL
   ORDER BY r.created_at DESC`);

// Only a 404 means deleted; anything else (rate limit, outage) stops the run.
const deleted: Row[] = [];
for (const r of linked) {
  try {
    await client.getJob(String(r.fieldpulse_job_id));
  } catch (err) {
    const status = (err as { fpStatus?: number | null }).fpStatus;
    if (status === 404) deleted.push(r);
    else refuse(`FieldPulse answered ${status ?? "with a network error"} for job ${r.fieldpulse_job_id}; try again later`);
  }
}

const nativeDeleted = deleted.filter((r) => r.imported !== true);
const deletedRequests = deleted.filter((r) => r.imported === true).map((r) => ({
  id: r.id as string,
  referenceNumber: r.reference_number as string,
  status: r.status as string,
  title: String(r.issue_type ?? r.description ?? ""),
  hidden: r.hidden_from_org === true,
}));
const ids = deletedRequests.map((r) => r.id);
const children = ids.length === 0 ? [] : [
  ...(await rows(sql`
    SELECT 'invoice' AS kind, i.id, i.service_request_id AS request_id, i.hidden_from_org,
           (i.fieldpulse_invoice_id IS NOT NULL OR i.hcp_invoice_id IS NOT NULL) AS synced,
           GREATEST(i.amount_paid_cents,
                    CASE WHEN EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id) THEN 1 ELSE 0 END) AS paid_cents
      FROM invoices i
     WHERE i.organization_id = ${args.org}::uuid AND i.service_request_id = ANY(${uuidArray(ids)})`)),
  ...(await rows(sql`
    SELECT 'estimate' AS kind, e.id, e.service_request_id AS request_id, e.hidden_from_org,
           (e.fieldpulse_estimate_id IS NOT NULL) AS synced, 0 AS paid_cents
      FROM estimates e
     WHERE e.organization_id = ${args.org}::uuid AND e.service_request_id = ANY(${uuidArray(ids)})`)),
].map((c) => ({
  kind: c.kind as "invoice" | "estimate",
  id: c.id as string,
  requestId: c.request_id as string,
  synced: c.synced === true,
  paidCents: Number(c.paid_cents),
  hidden: c.hidden_from_org === true,
}));

const plan = planDeletedJobHide(deletedRequests, children);
const hiddenIds = plan.requests.map((r) => r.id);
const sessions = hiddenIds.length === 0 ? [] : (await rows(sql`
  SELECT s.id FROM customer_sessions s JOIN service_requests r ON r.session_id = s.id
   WHERE r.organization_id = ${args.org}::uuid AND r.id = ANY(${uuidArray(hiddenIds)})
     AND s.token LIKE 'fp-import-%' AND s.hidden_from_org = false`)).map((s) => s.id as string);

console.log(`\n${linked.length} FieldPulse-linked requests checked; ${deleted.length} deleted in FieldPulse: ${deletedRequests.length} imported (${deletedRequests.filter((r) => r.hidden).length} already hidden), ${nativeDeleted.length} native`);
console.log(`\nto hide: ${plan.requests.length} requests, ${plan.children.filter((c) => c.kind === "invoice").length} invoices, ${plan.children.filter((c) => c.kind === "estimate").length} estimates, ${sessions.length} conversations`);
for (const r of plan.requests) console.log(`  ${describeDeletedJobRequest(r)}`);
if (plan.kept.length) {
  console.log(`\nkept visible for review (${plan.kept.length}):`);
  for (const k of plan.kept) console.log(`  ${describeDeletedJobRequest(k.request)}  — ${k.reason}`);
}

if (nativeDeleted.length) {
  console.log(`\nnative requests whose FieldPulse copy was deleted, never hidden here (${nativeDeleted.length}), for review:`);
  for (const r of nativeDeleted) {
    console.log(`  ${describeDeletedJobRequest({ id: r.id as string, referenceNumber: r.reference_number as string, status: r.status as string, title: String(r.issue_type ?? r.description ?? ""), hidden: r.hidden_from_org === true })}${r.hidden_from_org === true ? "  (hidden)" : ""}`);
  }
}

if (args.apply && (plan.requests.length || plan.children.length || sessions.length)) {
  const manifest: Manifest = {
    org: args.org,
    createdAt: new Date().toISOString(),
    requests: plan.requests.map((r) => ({ id: r.id, referenceNumber: r.referenceNumber })),
    invoices: plan.children.filter((c) => c.kind === "invoice").map((c) => c.id),
    estimates: plan.children.filter((c) => c.kind === "estimate").map((c) => c.id),
    sessions,
  };
  const path = args.manifest ?? goliveRecordPath(`fp-deleted-jobs-hidden-${args.org.slice(0, 8)}-${manifest.createdAt.replace(/[:.]/g, "-")}.json`);
  // Write the undo file before any change, so a failed run is still reversible.
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  console.log(`\nundo file: ${path}`);
  await setHidden(manifest, true);
}

console.log(args.apply ? "\nDone." : "\nDry run only; pass --apply to hide.");
