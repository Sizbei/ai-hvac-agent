import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, batch } = vi.hoisted(() => ({ readQueue: [] as unknown[][], batch: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => ({
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err),
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

beforeEach(() => { readQueue.length = 0; batch.mockReset(); });

describe("addJobPhoto (spec §5.4)", () => {
  it("one batch: L_req, then INSERT … SELECT with the read rule and the not-erased check", async () => {
    batch.mockResolvedValueOnce(rowsOf([], [{ id: "att-1" }]));
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: true, id: "att-1" });
    const [lock, insert] = (batch.mock.calls[0]![0] as unknown[]).map(render);
    expect(lock).toBe("SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(insert).toMatch(/^INSERT INTO attachments \(organization_id, service_request_id, filename, mime_type, size, storage_key\) SELECT /);
    expect(insert).toContain("FROM appointment_assignments a JOIN appointments p");
    expect(insert).toContain("NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = service_requests.customer_id AND c.organization_id = $");
    expect(insert).toContain("c.anonymized_at IS NOT NULL) RETURNING id");
  });

  it("nothing written: an erased customer → customer_removed; unreadable → not_owned", async () => {
    batch.mockResolvedValueOnce(rowsOf([], []));
    readQueue.push([{ live: false }]);
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: false, reason: "customer_removed" });
    batch.mockResolvedValueOnce(rowsOf([], []));
    readQueue.push([]);
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: false, reason: "not_owned" });
  });
});
