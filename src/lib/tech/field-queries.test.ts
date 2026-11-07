import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  addJobMaterial,
  removeJobMaterial,
  getActualMaterialsCostCents,
  getJobTimelineForTech,
  listJobPhotos,
  recordSignature,
  isJobOwnedByTech,
  getTechJobSummary,
  SIGNABLE_IN,
} from "./field-queries";
import { db } from "@/lib/db";
import { findAllAssignments, findReadableJob } from "@/lib/tech/ownership";
import { getPricebookItemById } from "@/lib/admin/pricebook-queries";
import { adjustStock } from "@/lib/admin/inventory-queries";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/admin/pricebook-queries", () => ({
  getPricebookItemById: vi.fn(),
}));

vi.mock("@/lib/admin/inventory-queries", () => ({
  adjustStock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tech/ownership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tech/ownership")>()),
  findReadableJob: vi.fn(),
  findActiveVisit: vi.fn(),
  findAllAssignments: vi.fn(),
}));

const ORG = "org-1";
const TECH = "tech-1";
const JOB = "job-1";

/**
 * Sequence db.select results. Each call returns a chain whose where() is BOTH
 * awaitable (for list reads) and .limit()-able (for the ownership guard).
 */
function mockSelectSeq(results: unknown[][]): void {
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const rows = results[i++] ?? [];
    const result = Promise.resolve(rows);
    return {
      from: () => ({
        where: () =>
          Object.assign(result, {
            limit: () => Promise.resolve(rows),
            orderBy: () => Promise.resolve(rows),
          }),
      }),
    } as never;
  });
}

/** Whether the technician can read/act on the job (the ownership module's answer). */
function owned(yes: boolean): void {
  vi.mocked(findReadableJob).mockResolvedValue(
    yes ? { id: JOB, customerId: null, native: true, status: "assigned" } : null,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("addJobMaterial — catalog line", () => {
  it("snapshots cost/price from the pricebook item and ignores client costs", async () => {
    // 1) ownership guard -> owned job
    owned(true);
    vi.mocked(getPricebookItemById).mockResolvedValue({
      id: "pb-1",
      organizationId: ORG,
      type: "material",
      name: "Capacitor",
      sku: null,
      description: null,
      categoryId: null,
      costCents: 1200,
      markupPct: 0,
      priceCents: 3500,
      memberPriceCents: null,
      hours: null,
      warranty: null,
      active: true,
      isLaborItem: false,
      fieldpulseItemId: null,
      fieldpulseData: null,
    });

    const valuesSpy = vi.fn(() => ({
      returning: () => Promise.resolve([{ id: "mat-1" }]),
    }));
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);

    const r = await addJobMaterial(ORG, TECH, JOB, {
      pricebookItemId: "pb-1",
      quantity: 2,
      unitPriceCents: 1, // a client price never overrides the catalog snapshot
    });

    expect(r).toEqual({ ok: true, id: "mat-1" });
    // Snapshotted from the item, NOT from any client-sent value.
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pricebookItemId: "pb-1",
        unitCostCents: 1200,
        unitPriceCents: 3500,
        quantity: 2,
        createdBy: TECH,
        organizationId: ORG,
        serviceRequestId: JOB,
      }),
    );
    // A catalog line draws down tracked inventory by the used quantity (a
    // no-op for untracked items). Best-effort, but always attempted.
    expect(adjustStock).toHaveBeenCalledWith(ORG, "pb-1", -2);
  });

  it("still records the material when the stock decrement fails (best-effort)", async () => {
    owned(true);
    vi.mocked(getPricebookItemById).mockResolvedValue({
      id: "pb-1",
      organizationId: ORG,
      type: "material",
      name: "Capacitor",
      sku: null,
      description: null,
      categoryId: null,
      costCents: 1200,
      markupPct: 0,
      priceCents: 3500,
      memberPriceCents: null,
      hours: null,
      warranty: null,
      active: true,
      isLaborItem: false,
      fieldpulseItemId: null,
      fieldpulseData: null,
    });
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([{ id: "mat-1" }]) }),
    } as never);
    vi.mocked(adjustStock).mockRejectedValueOnce(new Error("db down"));

    const r = await addJobMaterial(ORG, TECH, JOB, {
      pricebookItemId: "pb-1",
      quantity: 1,
    });
    expect(r).toEqual({ ok: true, id: "mat-1" });
  });

  it("returns item_not_found for a service item (services are not materials)", async () => {
    owned(true);
    vi.mocked(getPricebookItemById).mockResolvedValue({
      id: "pb-svc", organizationId: ORG, type: "service", name: "Tune-up", sku: null,
      description: null, categoryId: null, costCents: 0, markupPct: 0, priceCents: 9900,
      memberPriceCents: null, hours: null, warranty: null, active: true, isLaborItem: false,
      fieldpulseItemId: null, fieldpulseData: null,
    });
    const r = await addJobMaterial(ORG, TECH, JOB, { pricebookItemId: "pb-svc", quantity: 1 });
    expect(r).toEqual({ ok: false, reason: "item_not_found" });
    expect(db.insert).not.toHaveBeenCalled();
    expect(adjustStock).not.toHaveBeenCalled();
  });

  it("returns item_not_found when the pricebook item is missing", async () => {
    owned(true);
    vi.mocked(getPricebookItemById).mockResolvedValue(null);
    const r = await addJobMaterial(ORG, TECH, JOB, {
      pricebookItemId: "pb-x",
      quantity: 1,
    });
    expect(r).toEqual({ ok: false, reason: "item_not_found" });
  });
});

describe("addJobMaterial — manual line", () => {
  it("defaults costs to 0 and never reads the pricebook", async () => {
    owned(true);
    const valuesSpy = vi.fn(() => ({
      returning: () => Promise.resolve([{ id: "mat-2" }]),
    }));
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);

    const r = await addJobMaterial(ORG, TECH, JOB, {
      description: "Misc fittings",
      quantity: 3,
    });

    expect(r).toEqual({ ok: true, id: "mat-2" });
    expect(getPricebookItemById).not.toHaveBeenCalled();
    // Manual (off-catalog) lines never touch inventory.
    expect(adjustStock).not.toHaveBeenCalled();
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pricebookItemId: null,
        description: "Misc fittings",
        unitCostCents: 0,
        unitPriceCents: 0,
        quantity: 3,
      }),
    );
  });

  it("stores the tech's price on a manual line, cost stays 0", async () => {
    owned(true);
    const valuesSpy = vi.fn(() => ({ returning: () => Promise.resolve([{ id: "mat-3" }]) }));
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);
    const r = await addJobMaterial(ORG, TECH, JOB, { description: "Capacitor 45/5", quantity: 2, unitPriceCents: 4250 });
    expect(r).toEqual({ ok: true, id: "mat-3" });
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ unitCostCents: 0, unitPriceCents: 4250, quantity: 2 }),
    );
  });

  it("rejects a manual price that is negative, fractional, or over the money cap", async () => {
    owned(true);
    for (const unitPriceCents of [-1, 10.5, 100_000_000]) {
      const r = await addJobMaterial(ORG, TECH, JOB, { description: "x", quantity: 1, unitPriceCents });
      expect(r).toEqual({ ok: false, reason: "invalid_input" });
    }
    // The line total is capped too.
    const r = await addJobMaterial(ORG, TECH, JOB, { description: "x", quantity: 2, unitPriceCents: 60_000_000 });
    expect(r).toEqual({ ok: false, reason: "invalid_input" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects a manual line with no description", async () => {
    owned(true);
    const r = await addJobMaterial(ORG, TECH, JOB, { quantity: 1 });
    expect(r).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("rejects a non-positive quantity before any DB read", async () => {
    const r = await addJobMaterial(ORG, TECH, JOB, {
      description: "x",
      quantity: 0,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_input" });
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("assignee guard", () => {
  it("a tech cannot add a material to a job not assigned to them", async () => {
    // ownership guard returns no rows -> not owned
    owned(false);
    const r = await addJobMaterial(ORG, TECH, JOB, {
      description: "x",
      quantity: 1,
    });
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("refuses a new material on a completed or cancelled request", async () => {
    for (const status of ["completed", "cancelled"] as const) {
      vi.mocked(findReadableJob).mockResolvedValue({ id: JOB, customerId: null, native: true, status });
      const r = await addJobMaterial(ORG, TECH, JOB, { description: "x", quantity: 1 });
      expect(r).toEqual({ ok: false, reason: "job_closed" });
    }
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("a tech cannot remove a material on a job not assigned to them", async () => {
    // 1) material lookup -> found on JOB; 2) ownership guard -> not owned
    mockSelectSeq([[{ serviceRequestId: JOB }]]);
    owned(false);
    const r = await removeJobMaterial(ORG, TECH, "mat-9");
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("removes a material the tech owns", async () => {
    mockSelectSeq([[{ serviceRequestId: JOB }]]);
    owned(true);
    vi.mocked(db.delete).mockReturnValue({
      where: () => Promise.resolve(undefined),
    } as never);
    const r = await removeJobMaterial(ORG, TECH, "mat-9");
    expect(r).toEqual({ ok: true });
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});

describe("getActualMaterialsCostCents", () => {
  it("sums unitCost × quantity across recorded materials", async () => {
    mockSelectSeq([
      [
        { quantity: 2, unitCostCents: 1200 }, // 2400
        { quantity: 1, unitCostCents: 500 }, // 500
        { quantity: 3, unitCostCents: 0 }, // 0 (manual line)
      ],
    ]);
    const total = await getActualMaterialsCostCents(ORG, JOB);
    expect(total).toBe(2900);
  });

  it("is 0 when no materials were recorded", async () => {
    mockSelectSeq([[]]);
    const total = await getActualMaterialsCostCents(ORG, JOB);
    expect(total).toBe(0);
  });
});

describe("getJobTimelineForTech", () => {
  it("returns the ordered, PII-free status timeline for an owned job", async () => {
    const at1 = new Date("2026-06-24T10:00:00.000Z");
    const at2 = new Date("2026-06-24T12:30:00.000Z");
    owned(true);
    mockSelectSeq([
      [
        { fromStatus: null, toStatus: "pending", actorType: "ai", at: at1 },
        { fromStatus: "pending", toStatus: "assigned", actorType: "system", at: at2 },
      ],
    ]);

    const res = await getJobTimelineForTech(ORG, TECH, JOB);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timeline).toEqual([
      { fromStatus: null, toStatus: "pending", actorType: "ai", at: at1.toISOString() },
      { fromStatus: "pending", toStatus: "assigned", actorType: "system", at: at2.toISOString() },
    ]);
  });

  it("refuses a job not assigned to the tech (not_owned)", async () => {
    owned(false); // ownership guard misses
    const res = await getJobTimelineForTech(ORG, "other-tech", JOB);
    expect(res).toEqual({ ok: false, reason: "not_owned" });
  });

  it("returns an empty timeline for an owned job with no events", async () => {
    owned(true);
    mockSelectSeq([[]]);
    const res = await getJobTimelineForTech(ORG, TECH, JOB);
    expect(res).toEqual({ ok: true, timeline: [] });
  });
});

describe("recordSignature", () => {
  const SIG = { signatureUrl: "https://r2/sig.png", signatureName: "Jane Doe" };
  const dialect = new PgDialect();

  /** Capture the SQL handed to db.execute and resolve it with `rows`. */
  function mockExecute(rows: unknown[]): { readonly q: () => { sql: string; params: unknown[] } } {
    let captured: SQL | undefined;
    vi.mocked(db.execute).mockImplementation(((q: SQL) => {
      captured = q;
      return Promise.resolve({ rows });
    }) as never);
    return {
      q: () => {
        const r = dialect.sqlToQuery(captured as SQL);
        return { sql: r.sql.replace(/\s+/g, " "), params: r.params };
      },
    };
  }

  it("persists the signature and returns the previous URL", async () => {
    owned(true);
    mockExecute([{ old: "https://r2/old.png" }]);
    const r = await recordSignature(ORG, TECH, JOB, SIG);
    expect(r).toEqual({ ok: true, previousUrl: "https://r2/old.png" });
  });

  it("previousUrl is null for a first signature", async () => {
    owned(true);
    mockExecute([{ old: null }]);
    const r = await recordSignature(ORG, TECH, JOB, SIG);
    expect(r).toEqual({ ok: true, previousUrl: null });
  });

  it("refuses a job not assigned to the tech (not_owned, no write)", async () => {
    owned(false);
    const r = await recordSignature(ORG, TECH, JOB, SIG);
    expect(r).toEqual({ ok: false, reason: "not_owned" });
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("is one statement: database-clock signed_at, FOR UPDATE old-URL read, RETURNING o.old", async () => {
    owned(true);
    const m = mockExecute([{ old: null }]);
    await recordSignature(ORG, TECH, JOB, SIG);
    expect(db.execute).toHaveBeenCalledTimes(1);
    const { sql: text, params } = m.q();
    expect(text).toContain("signed_at = now()");
    expect(text).toContain("updated_at = now()");
    expect(text).toContain("FROM (SELECT id, signature_url AS old FROM service_requests WHERE id = $");
    expect(text).toContain("FOR UPDATE) o");
    expect(text).toContain("WHERE service_requests.id = o.id");
    expect(text).toContain("RETURNING o.old");
    // No JS clock: no Date param bound anywhere (signed_at comes from now()).
    expect(params.some((p) => p instanceof Date)).toBe(false);
    // org on the subquery, the outer UPDATE and the EXISTS body.
    expect(params.filter((p) => p === ORG)).toHaveLength(4);
    expect(params).toEqual([SIG.signatureUrl, SIG.signatureName, JOB, ORG, ORG, ORG, ORG, TECH]);
    expect(params).toHaveLength(8);
    expect((text.match(/organization_id = \$\d+::uuid/g) ?? [])).toHaveLength(4);
    expect(text).toContain("p.organization_id = $6::uuid AND a.organization_id = $7::uuid");
  });

  it("signs only from a lead row that is not cancelled on a live visit (open statuses + completed)", async () => {
    owned(true);
    const m = mockExecute([{ old: null }]);
    await recordSignature(ORG, TECH, JOB, SIG);
    const { sql: text } = m.q();
    expect(text).toContain("a.is_lead");
    expect(text).toContain("p.cancelled_at IS NULL");
    expect(text).toContain("p.service_request_id = service_requests.id");
    expect(text).toContain("a.status IN ('assigned'::request_status, 'scheduled'::request_status, 'en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status, 'completed'::request_status)");
    expect(text).not.toContain("a.status <> 'cancelled'");
  });

  it("refuses if the job is reassigned between the ownership check and the write (TOCTOU)", async () => {
    owned(true);
    mockExecute([]);
    const r = await recordSignature(ORG, TECH, JOB, SIG);
    expect(r).toEqual({ ok: false, reason: "not_owned" });
  });

  it("exports SIGNABLE_IN as the raw enum-cast list", () => {
    expect(dialect.sqlToQuery(SIGNABLE_IN).sql).toBe(
      "('assigned'::request_status, 'scheduled'::request_status, 'en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status, 'completed'::request_status)",
    );
  });
});

describe("getTechJobSummary — signedAt + invoice summary", () => {
  const dialect = new PgDialect();
  const SIGNED = new Date("2026-11-04T15:00:00Z");
  const baseRow = {
    id: JOB, referenceNumber: "R-1", status: "in_progress", issueType: "no_heat",
    systemType: null, urgency: "normal", description: null, scheduledDate: null,
    arrivalWindowStart: null, arrivalWindowEnd: null, customerNameEncrypted: null,
    customerPhoneEncrypted: null, addressEncrypted: null, accessNotes: null,
    fieldpulseJobId: null, hcpJobId: null, signedAt: SIGNED,
  };

  function setup(row: unknown, invoiceRows: unknown[]): { fields: () => Record<string, unknown>; invoiceSql: () => { sql: string; params: unknown[] } } {
    let fields: Record<string, unknown> = {};
    vi.mocked(db.select).mockImplementation(((f: Record<string, unknown>) => {
      fields = f;
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }) };
    }) as never);
    let captured: SQL | undefined;
    vi.mocked(db.execute).mockImplementation(((q: SQL) => {
      captured = q;
      return Promise.resolve({ rows: invoiceRows });
    }) as never);
    vi.mocked(findAllAssignments).mockResolvedValue([]);
    return {
      fields: () => fields,
      invoiceSql: () => {
        const r = dialect.sqlToQuery(captured as SQL);
        return { sql: r.sql.replace(/\s+/g, " "), params: r.params };
      },
    };
  }

  it("selects signed_at and returns signedAt", async () => {
    const s = setup(baseRow, []);
    const out = await getTechJobSummary(ORG, TECH, JOB);
    expect(Object.keys(s.fields())).toContain("signedAt");
    expect(out?.signedAt).toEqual(SIGNED);
    expect(out?.invoiceSummary).toBeNull();
  });

  it("returns the invoice summary with a numeric balance", async () => {
    setup(baseRow, [{ id: "inv-1", state: "open", balance_cents: "4200" }]);
    const out = await getTechJobSummary(ORG, TECH, JOB);
    expect(out?.invoiceSummary).toEqual({ id: "inv-1", state: "open", balanceCents: 4200 });
  });

  it("the invoice query: native, non-void, org-scoped, draft/open first, balance floored at 0", async () => {
    const s = setup(baseRow, []);
    await getTechJobSummary(ORG, TECH, JOB);
    const { sql: text, params } = s.invoiceSql();
    expect(text).toContain("FROM invoices");
    expect(text).toContain("state <> 'void'::invoice_state");
    expect(text).toContain("fieldpulse_invoice_id IS NULL");
    expect(text).toContain("hcp_invoice_id IS NULL");
    expect(text).toContain("organization_id = $1::uuid");
    expect(text).toContain("service_request_id = $2::uuid");
    expect(text).toContain("GREATEST(0, total_cents - amount_paid_cents)");
    expect(text).toContain("ORDER BY (state IN ('draft'::invoice_state, 'open'::invoice_state)) DESC, created_at DESC LIMIT 1");
    expect(params).toEqual([ORG, JOB]);
  });

  it("returns null (and runs no invoice query) when the job is not readable", async () => {
    setup(null, []);
    expect(await getTechJobSummary(ORG, TECH, JOB)).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("listJobPhotos", () => {
  it("returns the job's attachments oldest-first (org-scoped)", async () => {
    const rows = [
      { id: "a1", filename: "1.jpg", mimeType: "image/jpeg", size: 10, storageKey: "k1", createdAt: new Date("2026-06-24T10:00:00Z") },
      { id: "a2", filename: "2.png", mimeType: "image/png", size: 20, storageKey: "k2", createdAt: new Date("2026-06-24T11:00:00Z") },
    ];
    mockSelectSeq([rows]);
    const out = await listJobPhotos(ORG, JOB);
    expect(out).toEqual(rows);
  });
});

describe("isJobOwnedByTech", () => {
  it("true when the ownership read returns the job", async () => {
    owned(true);
    expect(await isJobOwnedByTech(ORG, TECH, JOB)).toBe(true);
  });
  it("false when the job is not assigned to this tech / not in org", async () => {
    owned(false);
    expect(await isJobOwnedByTech(ORG, TECH, JOB)).toBe(false);
  });
});

