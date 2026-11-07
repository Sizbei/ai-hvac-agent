import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, reads, batch } = vi.hoisted(() => ({ readQueue: [] as unknown[][], reads: [] as unknown[], batch: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => ({
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => {
        reads.push(q);
        return Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err);
      },
    }),
    batch,
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));

import { addJobPhoto } from "./photo-writes";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const photo = { filename: "before.jpg", mimeType: "image/jpeg", size: 1234, storageKey: "org/job/before.jpg" };
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL).sql.replace(/\s+/g, " ").trim();
const rowsOf = (...r: unknown[][]) => r.map((rows) => ({ rows }));
const orgParams = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL).params.filter((p) => p === ORG).length;

beforeEach(() => { readQueue.length = 0; reads.length = 0; batch.mockReset(); });

describe("addJobPhoto (spec §5.4)", () => {
  it("one batch: L_req, then INSERT … SELECT with the read rule and the not-erased check", async () => {
    batch.mockResolvedValueOnce(rowsOf([], [{ id: "att-1" }]));
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: true, id: "att-1" });
    const stmts = batch.mock.calls[0]![0] as unknown[];
    const [lock, insert] = stmts.map(render);
    expect(lock).toBe("SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(insert).toMatch(/^INSERT INTO attachments \(organization_id, service_request_id, filename, mime_type, size, storage_key\) SELECT /);
    expect(insert).toContain("FROM appointment_assignments a JOIN appointments p");
    expect(insert).toContain("NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = service_requests.customer_id AND c.organization_id = $");
    expect(insert).toContain("c.anonymized_at IS NOT NULL) RETURNING id");
    // The request is pinned to the org (select, where, read rule, not-erased).
    expect(insert).toMatch(/WHERE service_requests\.id = \$\d+::uuid AND service_requests\.organization_id = \$\d+::uuid AND /);
    expect(orgParams(stmts[1])).toBe(4);
    expect(reads).toHaveLength(0);
  });

  it("nothing written: an erased customer → customer_removed; unreadable → not_owned", async () => {
    batch.mockResolvedValueOnce(rowsOf([], []));
    readQueue.push([{ live: false }]);
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: false, reason: "customer_removed" });
    batch.mockResolvedValueOnce(rowsOf([], []));
    readQueue.push([]);
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: false, reason: "not_owned" });
    // The follow-up read is org-pinned too (where, read rule, not-erased).
    expect(reads).toHaveLength(2);
    for (const r of reads) {
      expect(render(r)).toContain("service_requests.organization_id = $");
      expect(orgParams(r)).toBe(3);
    }
  });

  it("a failed batch (deadlock) is retryable: stale, and no follow-up read", async () => {
    batch.mockRejectedValueOnce(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: false, reason: "stale" });
    expect(reads).toHaveLength(0);
  });
});
