/**
 * fp:import — FieldPulse full-import operator script.
 *
 * Runs in dependency order: technicians → customers → jobs → invoices.
 * Every phase is idempotent (upserts keyed on per-org fieldpulse*Id indexes).
 *
 * Usage:
 *   npm run fp:import -- --org <uuid> [--dry-run] [--phase <name>[,<name>...]] [--yes]
 *
 * Flags:
 *   --org <uuid>          (required) Target organization id.
 *   --dry-run             Fetch first page only per phase; no DB writes; print counts.
 *   --phase <name[,...]>  Run one or more named phases, comma-separated
 *                         (technicians|customers|jobs|invoices|estimates|payments|assets).
 *   --yes                 Skip the interactive `import` confirmation. FOR CI USE ONLY
 *                         (nightly GitHub Actions sweep). Never pass this interactively —
 *                         the confirmation exists to prevent accidental prod writes.
 *   --since <date>        deliberately deferred — Phase 0.5 verified FP ignores server-side date filters; Phase 6 deltas will full-re-page + filter client-side.
 *
 * Safety: On a real run the script prints DB host + org name and requires the
 * operator to type `import` on stdin before any write is made (unless --yes is given).
 */
import * as dotenv from "dotenv";
import * as readline from "readline";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import { organizations, fpImportRuns } from "../../../db/schema";
import { getFieldpulseClient } from "../client";
import { syncTechniciansFromFieldpulse } from "../technician-sync";
import { importCustomersFromFieldpulse } from "./customers";
import { importJobsFromFieldpulse } from "./jobs";
import { importInvoicesFromFieldpulse } from "./invoices";
import { importEstimatesFromFieldpulse } from "./estimates";
import { importPaymentsFromFieldpulse } from "./payments";
import { importAssetsFromFieldpulse } from "./assets";
import { importCommentsFromFieldpulse } from "./comments";
import { importLocationsFromFieldpulse } from "./locations";
import { importItemsFromFieldpulse } from "./items";
import { enrichJobMetrics } from "./job-metrics";

dotenv.config({ path: ".env.local" });

// ── Phase types ──────────────────────────────────────────────────────────────

export interface PhaseResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  total?: number | null;
  /** customers phase: number of deleted/merged FP records imported as archived. */
  archivedImported?: number;
  /** jobs phase: number of jobs with more than one tech assignment. */
  multiTechJobs?: number;
  /** jobs phase: customers fetched per-id and imported during self-heal. */
  customersSelfHealed?: number;
  /** locations phase: customers whose null address was filled. */
  enriched?: number;
  /** locations phase: customers already having an address (skipped enrichment). */
  skippedHasAddress?: number;
}

interface PhaseContext {
  orgId: string;
  dryRun: boolean;
  db: ReturnType<typeof drizzle>;
  fpClient: Awaited<ReturnType<typeof getFieldpulseClient>>;
}

type PhaseFn = (ctx: PhaseContext, counts: PhaseResult) => Promise<PhaseResult>;

export const PHASES: { name: string; fn: PhaseFn }[] = [
  {
    name: "technicians",
    fn: async (ctx, counts) => {
      // syncTechniciansFromFieldpulse reports a single `synced` count — no
      // created/updated split is available from this function. We put `synced`
      // into `fetched` and `updated` (both reflect the roster processed) and
      // leave created/skipped at 0; the caller's ledger documents this gap.
      const { synced } = await syncTechniciansFromFieldpulse(ctx.orgId);
      counts.fetched = synced;
      counts.updated = synced;
      return counts;
    },
  },
  {
    name: "customers",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await importCustomersFromFieldpulse(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
  {
    name: "jobs",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await importJobsFromFieldpulse(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
  {
    name: "invoices",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await importInvoicesFromFieldpulse(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
  {
    name: "estimates",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await importEstimatesFromFieldpulse(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
  {
    name: "payments",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await importPaymentsFromFieldpulse(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
  {
    name: "assets",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await importAssetsFromFieldpulse(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
  {
    name: "comments",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await importCommentsFromFieldpulse(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
  {
    name: "locations",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await importLocationsFromFieldpulse(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
  {
    name: "items",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await importItemsFromFieldpulse(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
  {
    name: "job-metrics",
    fn: async (ctx, counts) => {
      if (!ctx.fpClient) throw new Error("No FieldPulse client available");
      await enrichJobMetrics(ctx.orgId, counts, ctx.fpClient);
      return counts;
    },
  },
];

// ── Argument parsing ─────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): {
  orgId: string;
  dryRun: boolean;
  /** Phase names to run. null = run all. */
  phaseNames: string[] | null;
  /** Skip interactive confirmation. FOR CI (nightly sweep) ONLY. */
  yes: boolean;
} {
  const args = argv.slice(2);
  let orgId: string | null = null;
  let dryRun = false;
  let phaseFilter: string | null = null;
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--org" && args[i + 1]) {
      orgId = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--phase" && args[i + 1]) {
      phaseFilter = args[++i];
    } else if (args[i] === "--yes") {
      yes = true;
    }
  }

  if (!orgId) {
    console.error("ERROR: --org <uuid> is required");
    process.exit(1);
  }

  // Support comma-separated phase list: --phase technicians,customers,jobs
  const phaseNames = phaseFilter
    ? phaseFilter.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  return { orgId, dryRun, phaseNames, yes };
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
  const { orgId, dryRun, phaseNames, yes } = parseArgs(process.argv);

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
  if (phaseNames) {
    console.log(`  Phase(s): ${phaseNames.join(", ")}`);
  }
  console.log("");

  // Build the FP client.
  const fpClient = await getFieldpulseClient(orgId);
  if (!fpClient) {
    console.error("ERROR: No FieldPulse API key configured for this org.");
    process.exit(1);
  }

  // Select phases to run.
  let selectedPhases = PHASES;
  if (phaseNames) {
    // Validate all names before running any phase.
    const validNames = new Set(PHASES.map((p) => p.name));
    const invalid = phaseNames.filter((n) => !validNames.has(n));
    if (invalid.length > 0) {
      console.error(
        `ERROR: Unknown phase(s): "${invalid.join('", "')}". Valid: ${PHASES.map((p) => p.name).join(", ")}`,
      );
      process.exit(1);
    }
    // Preserve canonical dependency order regardless of user-supplied order.
    selectedPhases = PHASES.filter((p) => phaseNames.includes(p.name));
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
        } else if (phase.name === "estimates") {
          sample = await fpClient.listEstimates(1);
        } else if (phase.name === "payments") {
          sample = await fpClient.listPayments(1);
        } else if (phase.name === "assets") {
          sample = await fpClient.listAssets(1);
        } else if (phase.name === "comments") {
          sample = await fpClient.listComments(1);
        } else if (phase.name === "locations") {
          sample = await fpClient.listLocations(1);
        } else if (phase.name === "items") {
          sample = await fpClient.listItems(1);
        } else if (phase.name === "job-metrics") {
          // Per-id enrichment phase — no list endpoint. In a real run,
          // iterates all service_requests with fieldpulseJobId.
          console.log("per-id enrichment phase (no list sample in dry-run)");
          continue;
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

  // Real run: require confirmation before any write (unless --yes for CI).
  console.log("Phases to run:", selectedPhases.map((p) => p.name).join(", "));
  console.log("");
  if (yes) {
    console.log("(--yes flag: skipping interactive confirmation — CI mode)");
  } else {
    try {
      await requireConfirmation(
        'Type "import" and press Enter to begin writing to the database: ',
      );
    } catch (err) {
      console.log(`Aborted: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
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

    // Powers the live status page — best-effort mid-run count flush every 2 s.
    const flushInterval = setInterval(() => {
      db.update(fpImportRuns)
        .set({ counts: counts as unknown as Record<string, unknown> })
        .where(eq(fpImportRuns.id, runId))
        .execute()
        .catch(() => {});
    }, 2000);

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
    } finally {
      clearInterval(flushInterval);
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

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
