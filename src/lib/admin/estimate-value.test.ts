/**
 * A sold estimate is worth its SOLD option, not its most expensive one: the
 * "Won" KPI and list totals must use sold_option_id's total. And new line
 * items read back in the order they were added.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { ESTIMATE_VALUE_SQL, createEstimate, getEstimatePipelineStats } from "./estimate-queries";

const selected: Record<string, unknown>[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn((cols: Record<string, unknown>) => {
      selected.push(cols);
      const chain = Promise.resolve([{}]) as unknown as Record<string, unknown>;
      chain.from = () => chain;
      chain.where = () => chain;
      return chain;
    }),
    insert: vi.fn(() => ({ values: vi.fn((rows: unknown) => rows) })),
    batch: vi.fn().mockResolvedValue([]),
  },
}));

const dialect = new PgDialect();
const render = (s: unknown) => dialect.sqlToQuery(s as SQL).sql;

beforeEach(() => {
  vi.clearAllMocks();
  selected.length = 0;
});

describe("ESTIMATE_VALUE_SQL", () => {
  it("prefers the sold option's total of the same estimate, else the headline total", () => {
    const q = render(ESTIMATE_VALUE_SQL);
    expect(q).toMatch(/coalesce\(/);
    expect(q).toContain('"estimate_options"."total_cents"');
    expect(q).toContain('"estimate_options"."id" = "estimates"."sold_option_id"');
    expect(q).toContain('"estimate_options"."estimate_id" = "estimates"."id"');
    expect(q).toContain('"estimates"."total_cents"');
  });
});

describe("getEstimatePipelineStats", () => {
  it("sums won (and every bucket) by the sold-aware value", async () => {
    await getEstimatePipelineStats("org-1");
    const cols = selected[0]!;
    for (const k of ["wonCents", "openCents", "staleCents", "lostCents", "draftCents"]) {
      expect(render(cols[k])).toContain('"estimates"."sold_option_id"');
    }
  });
});

describe("createEstimate line order", () => {
  it("gives line items time-ordered ids so ORDER BY id is insertion order", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
    await createEstimate("org-1", {
      taxBps: 0,
      options: [{ name: "Good", lineItems: names.map((name) => ({ name, quantity: 1, unitPriceCents: 100 })) }],
    });
    const lineRows = (vi.mocked(db.batch).mock.calls[0]![0] as unknown as unknown[])[2] as Array<{ id: string; name: string }>;
    const byId = [...lineRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(byId.map((r) => r.name)).toEqual(names);
  });
});
