/**
 * "Collected this month" on /admin/invoices must be NET of refunds: a $200
 * check with a $50 refund collects $150, and a payment refunded in full (its
 * row now reads `refunded`) must not vanish from the received side while its
 * refund still subtracts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { collectedThisMonthCents, netCollectedCents } from "./invoice-queries";
import { VISIBLE_ONLY } from "./visibility";

const wheres: SQL[] = [];

vi.mock("@/lib/db", () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.innerJoin = () => c;
    c.where = (w: SQL) => {
      wheres.push(w);
      return c;
    };
    return c;
  };
  return { db: { select: vi.fn(() => chain()), batch: vi.fn() } };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-05T21:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  wheres.length = 0;
});

describe("netCollectedCents", () => {
  it("subtracts refunds from receipts, coercing neon string sums", () => {
    expect(netCollectedCents("20000", "5000")).toBe(15000);
    expect(netCollectedCents(null, null)).toBe(0);
    expect(netCollectedCents("20000", undefined)).toBe(20000);
    expect(netCollectedCents("garbage", "100")).toBe(-100);
  });
});

describe("collectedThisMonthCents", () => {
  it("returns native received minus refunded plus FieldPulse payments from one batched round trip", async () => {
    vi.mocked(db.batch).mockResolvedValue([[{ value: "20000" }], [{ value: "5000" }], [{ value: "700000" }]] as never);
    await expect(collectedThisMonthCents(ORG, VISIBLE_ONLY, NOW)).resolves.toBe(715000);
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it("counts fully refunded payments as received and scopes both sides to the org and month", async () => {
    vi.mocked(db.batch).mockResolvedValue([[{ value: null }], [{ value: null }], [{ value: null }]] as never);
    await collectedThisMonthCents(ORG, VISIBLE_ONLY, NOW);
    const dialect = new PgDialect();
    const [received, refunded] = wheres.map((w) => dialect.sqlToQuery(w));
    // Month starts at New York midnight on the 1st (04:00Z in EDT), not UTC.
    expect(received!.params).toContain("2026-11-01T04:00:00.000Z");
    expect(received!.sql).toMatch(/"payments"\."status" in/);
    expect(received!.params).toEqual(
      expect.arrayContaining([ORG, "succeeded", "refunded"]),
    );
    expect(received!.sql).toMatch(/"fieldpulse_payment_id" is null/);
    expect(refunded!.sql).toMatch(/"refunds"\."organization_id" = /);
    expect(refunded!.sql).toMatch(/"refunds"\."created_at" >= /);
    expect(refunded!.params).toContain(ORG);
  });

  it("counts FieldPulse payment rows by payment date, settled only", async () => {
    vi.mocked(db.batch).mockResolvedValue([[{ value: null }], [{ value: null }], [{ value: null }]] as never);
    await collectedThisMonthCents(ORG, VISIBLE_ONLY, NOW);
    const fp = new PgDialect().sqlToQuery(wheres[2]!);
    expect(fp.sql).toMatch(/"fieldpulse_payment_id" is not null/);
    expect(fp.sql).toMatch(/"payments"\."created_at" >= /);
    expect(fp.params).toEqual(expect.arrayContaining([ORG, "succeeded"]));
    expect(fp.params).not.toContain("refunded");
  });
});
