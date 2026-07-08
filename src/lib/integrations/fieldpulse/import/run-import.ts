/**
 * fp:import — FieldPulse full-import operator script.
 *
 * Runs in dependency order: technicians → customers → jobs → invoices.
 * Every phase is idempotent (upserts keyed on per-org fieldpulse*Id indexes).
 *
 * Usage:
 *   npm run fp:import -- --org <uuid> [--dry-run] [--phase <name>]
 *
 * Flags:
 *   --org <uuid>    (required) Target organization id.
 *   --dry-run       Fetch first page only per phase; no DB writes; print counts.
 *   --phase <name>  Run a single phase (technicians|customers|jobs|invoices).
 *   --since <date>  deliberately deferred — Phase 0.5 verified FP ignores server-side date filters; Phase 6 deltas will full-re-page + filter client-side.
 *
 * Safety: On a real run the script prints DB host + org name and requires the
 * operator to type `import` on stdin before any write is made.
 */
import * as dotenv from "dotenv";
import * as readline from "readline";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import { organizations, fpImportRuns } from "../../../db/schema";
import { getFieldpulseClient } from "../client";

dotenv.config({ path: ".env.local" });

// ── Phase types ──────────────────────────────────────────────────────────────

export interface PhaseResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

interface PhaseContext {
  orgId: string;
  dryRun: boolean;
  db: ReturnType<typeof drizzle>;
  fpClient: Awaited<ReturnType<typeof getFieldpulseClient>>;
}

type PhaseFn = (ctx: PhaseContext, counts: PhaseResult) => Promise<PhaseResult>;

const PHASES: { name: string; fn: PhaseFn }[] = [
  {
    name: "technicians",
    fn: async (_ctx, counts) => counts,
  },
  {
    name: "customers",
    fn: async (_ctx, counts) => counts,
  },
  {
    name: "jobs",
    fn: async (_ctx, counts) => counts,
  },
  {
    name: "invoices",
    fn: async (_ctx, counts) => counts,
  },
];

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  orgId: string;
  dryRun: boolean;
  phaseFilter: string | null;
} {
  const args = argv.slice(2);
  let orgId: string | null = null;
  let dryRun = false;
  let phaseFilter: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--org" && args[i + 1]) {
      orgId = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--phase" && args[i + 1]) {
      phaseFilter = args[++i];
    }
  }

  if (!orgId) {
    console.error("ERROR: --org <uuid> is required");
    process.exit(1);
  }

  return { orgId, dryRun, phaseFilter };
}

// ── DB host (no credentials) ─────────────────────────────────────────────────

function parseDbHost(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return "(unparseable)";
  }
}

// ── stdin confirmation ───────────────────────────────────────────────────────

async function requireConfirmation(prompt: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve, reject) => {
    rl.question(prompt, (answer) => {
      rl.close();
      if (answer.trim() === "import") {
        resolve();
      } else {
        reject(new Error(`Confirmation rejected (got "${answer.trim()}")`));
      }
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { orgId, dryRun, phaseFilter } = parseArgs(process.argv);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = neon(databaseUrl);
  const db = drizzle(sql);

  // Resolve org.
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) {
    console.error(`ERROR: Organization not found: ${orgId}`);
    process.exit(1);
  }

  const dbHost = parseDbHost(databaseUrl);

  console.log("=== FieldPulse Import ===");
  console.log(`  DB host : ${dbHost}`);
  console.log(`  Org id  : ${org.id}`);
  console.log(`  Org name: ${org.name}`);
  console.log(`  Dry run : ${dryRun}`);
  if (phaseFilter) {
    console.log(`  Phase   : ${phaseFilter}`);
  }
  console.log("");

  // Build the FP client.
  const fpClient = await getFieldpulseClient(orgId);
  if (!fpClient) {
    console.error("ERROR: No FieldPulse API key configured for this org.");
    process.exit(1);
  }

  // Select phases to run.
  const selectedPhases = phaseFilter
    ? PHASES.filter((p) => p.name === phaseFilter)
    : PHASES;

  if (phaseFilter && selectedPhases.length === 0) {
    console.error(
      `ERROR: Unknown phase "${phaseFilter}". Valid: ${PHASES.map((p) => p.name).join(", ")}`,
    );
    process.exit(1);
  }

  const ctx: PhaseContext = { orgId, dryRun, db, fpClient };

  if (dryRun) {
    // Dry-run: first page only, print counts, no writes.
    console.log("DRY RUN — fetching first page per phase, no DB writes.\n");
    for (const phase of selectedPhases) {
      process.stdout.write(`  ${phase.name} ... `);
      try {
        let sample: { items: unknown[]; totalCount: number | null } | null =
          null;
        if (phase.name === "customers") {
          sample = await fpClient.listCustomers(1);
        } else if (phase.name === "jobs") {
          sample = await fpClient.listJobs(1);
        } else if (phase.name === "invoices") {
          sample = await fpClient.listInvoices(1);
        }
        if (sample) {
          const tc =
            sample.totalCount !== null ? String(sample.totalCount) : "null";
          console.log(
            `fetched-sample=${sample.items.length}, totalCount=${tc} (first page only)`,
          );
          // Warn if first page is empty but API reports records exist.
          if (
            sample.items.length === 0 &&
            sample.totalCount !== null &&
            sample.totalCount > 0
          ) {
            console.warn(
              `WARNING: first page empty but totalCount=${sample.totalCount} — paging may be broken`,
            );
          }
        } else {
          // technicians — uses the existing listUsers method.
          const users = await fpClient.listUsers();
          console.log(`fetched-sample=${users.length}, totalCount=null (first page only)`);
        }
      } catch (err) {
        console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log("\nDry run complete. No data was written.");
    return;
  }

  // Real run: require confirmation before any write.
  console.log("Phases to run:", selectedPhases.map((p) => p.name).join(", "));
  console.log("");
  try {
    await requireConfirmation(
      'Type "import" and press Enter to begin writing to the database: ',
    );
  } catch (err) {
    console.log(`Aborted: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log("");

  let anyFailed = false;

  for (const phase of selectedPhases) {
    console.log(`--- Phase: ${phase.name} ---`);

    // Initialize counts accumulator — will be mutated during phase execution.
    const counts: PhaseResult = {
      fetched: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
    };

    // Insert running row.
    const [runRow] = await db
      .insert(fpImportRuns)
      .values({
        organizationId: orgId,
        phase: phase.name,
        status: "running",
        counts: counts as unknown as Record<string, unknown>,
      })
      .returning({ id: fpImportRuns.id });

    const runId = runRow.id;
    const startedAt = Date.now();

    try {
      const result = await phase.fn(ctx, counts);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

      await db
        .update(fpImportRuns)
        .set({
          status: "completed",
          counts: result as unknown as Record<string, unknown>,
          finishedAt: new Date(),
        })
        .where(eq(fpImportRuns.id, runId));

      console.log(
        `  completed in ${elapsed}s — fetched=${result.fetched} created=${result.created} updated=${result.updated} skipped=${result.skipped} errors=${result.errors}`,
      );
    } catch (err) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const errorMsg = err instanceof Error ? err.message : String(err);

      // counts is written on failure too — it's the resume cursor for Phases 2-5
      await db
        .update(fpImportRuns)
        .set({
          status: "failed",
          error: errorMsg,
          counts: counts as unknown as Record<string, unknown>,
          finishedAt: new Date(),
        })
        .where(eq(fpImportRuns.id, runId));

      console.error(`  FAILED in ${elapsed}s — ${errorMsg}`);
      anyFailed = true;
    }
  }

  console.log("");
  if (anyFailed) {
    console.error("Import finished with failures. Check fp_import_runs for details.");
    process.exit(1);
  } else {
    console.log("Import complete.");
  }
}

main().catch((err: unknown) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
