import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Integration suite for the go-live audit cutoff (P8 M7) against the DEV
 * database (`VITEST_INTEGRATION=1`): the builder, the CLI, getHistoryCutoff and
 * getAuditLog's `since` bound. One throwaway org, deleted in afterAll.
 */

type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;

const SCRIPT = "scripts/agent/set-history-cutoff.mjs";
const CUTOFF = "2026-11-10T17:30:00.000Z";

let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let patch: typeof import("@/lib/admin/history-cutoff-sql").historyCutoffPatchSql;
let getHistoryCutoff: typeof import("@/lib/tenancy/features").getHistoryCutoff;
let getFeatures: typeof import("@/lib/tenancy/features").getFeatures;
let getAuditLog: typeof import("@/lib/admin/audit-queries").getAuditLog;
let org = "";

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

function audit(action: string, at: string) {
  return run(
    sql`INSERT INTO audit_log (organization_id, action, entity, created_at) VALUES (${org}, ${action}, 'organization', ${at}::timestamptz)`,
  );
}

function spawnScript(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8", env, timeout: 60_000 });
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) {
    throw new Error("Refusing to run against the production database");
  }
  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  ({ historyCutoffPatchSql: patch } = await import("@/lib/admin/history-cutoff-sql"));
  ({ getHistoryCutoff, getFeatures } = await import("@/lib/tenancy/features"));
  ({ getAuditLog } = await import("@/lib/admin/audit-queries"));
  const { createOrgCore } = await import("@/lib/admin/provisioning");
  const out = await createOrgCore({
    name: `Probe Org Audit Cutoff ${randomUUID().slice(0, 8)}`,
    createdBy: null,
    ownerEmail: null,
    ownerUser: {
      email: `owner-${randomUUID()}@throwaway.example`,
      name: "Probe Owner",
      googleId: `probe-${randomUUID()}`,
    },
    skipOrgCountCheck: true,
  });
  if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
  org = out.result.organizationId as string;
  await run(sql`UPDATE organizations SET feature_flags = '{"reviewRequests": false}'::jsonb WHERE id = ${org}`);
  // createOrgCore may audit its own provisioning (at now()); these are dated around the cutoff.
  await audit("probe_before_cutoff", "2026-11-10T17:29:59.999Z");
  await audit("probe_at_cutoff", CUTOFF);
  await audit("probe_after_cutoff", "2026-11-11T09:00:00.000Z");
}, 120_000);

afterAll(async () => {
  if (!org) return;
  try {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${org}`);
  } catch (error) {
    console.error(`afterAll: could not delete probe org ${org}`, error);
  }
}, 60_000);

describe("go-live audit cutoff (dev DB)", { timeout: 60_000 }, () => {
  it("without a cutoff, getHistoryCutoff is null and every entry lists", async () => {
    expect(await getHistoryCutoff(org)).toBeNull();
    const page = await getAuditLog(org, { limit: 100 });
    expect(page.actions).toEqual(
      expect.arrayContaining(["probe_before_cutoff", "probe_at_cutoff", "probe_after_cutoff"]),
    );
  });

  it("the builder stores the cutoff and keeps the boolean switches", async () => {
    const [row] = await run(patch(org, "2026-11-10T12:30:00-05:00"));
    expect(row!.history_cutoff).toBe(CUTOFF);
    expect((await getHistoryCutoff(org))?.toISOString()).toBe(CUTOFF);
    expect((await getFeatures(org)).reviewRequests).toBe(false);
  });

  it("since = cutoff lists entries at or after it, and only their actions", async () => {
    const since = (await getHistoryCutoff(org))!;
    const page = await getAuditLog(org, { since, limit: 100 });
    const actions = page.entries.map((e) => e.action);
    expect(actions).toContain("probe_at_cutoff");
    expect(actions).toContain("probe_after_cutoff");
    expect(actions).not.toContain("probe_before_cutoff");
    expect(page.actions).not.toContain("probe_before_cutoff");
    expect(page.total).toBe(page.entries.length);
    expect(page.entries.every((e) => e.createdAt >= CUTOFF)).toBe(true);
  });

  it("the CLI sets the cutoff from --at", () => {
    const res = spawnScript(["--org", org, "--at", "2026-11-11T00:00:00Z"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("set to 2026-11-11T00:00:00.000Z");
  });

  it("the CLI defaults --at to now", async () => {
    const before = Date.now();
    const res = spawnScript(["--org", org]);
    expect(res.status, res.stderr).toBe(0);
    const at = (await getHistoryCutoff(org))!.getTime();
    expect(at).toBeGreaterThanOrEqual(before - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("the CLI refuses a bad org, a bad --at, an unknown org and the production host", () => {
    expect(spawnScript(["--org", "nope"]).stderr).toContain("--org must be an organization uuid");
    expect(spawnScript(["--org", org, "--at", "yesterday"]).stderr).toContain("--at must be an ISO timestamp");
    expect(spawnScript(["--org", randomUUID()]).stderr).toContain("no organization");
    const prod = spawnScript(["--org", org], {
      ...process.env,
      DATABASE_URL: "postgresql://u:p@ep-withered-hill-123.us-east-2.aws.neon.tech/db",
    });
    expect(prod.status).toBe(1);
    expect(prod.stderr).toContain("pass --prod");
  });
});
