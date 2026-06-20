/**
 * Tests for the Fieldpulse invoice PULL MIRROR (money-grade, read-only).
 * Covers: the native-state mapping, degrade-safe paths, and the find-or-create
 * outcomes incl. the lost-race re-select. DB + client are mocked; no network.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mapFieldpulseStatusToInvoiceState,
  pullInvoiceFromFieldpulse,
  pullInvoicesForJob,
} from "@/lib/integrations/fieldpulse/invoice-sync";
import { db } from "@/lib/db";
import { getFieldpulseClient } from "@/lib/integrations/fieldpulse/client";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    batch: vi.fn(),
  },
}));

vi.mock("@/lib/integrations/fieldpulse/client", () => ({
  getFieldpulseClient: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockedDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
};
const mockedGetClient = getFieldpulseClient as unknown as ReturnType<typeof vi.fn>;

/** Wire a flexible db mock. `selectResults` are returned in call order. */
function wireDb(selectResults: unknown[][], insertedRows: unknown[]): void {
  const queue = [...selectResults];
  mockedDb.select.mockImplementation(() => ({
    from: () => ({ where: () => Promise.resolve(queue.shift() ?? []) }),
  }));
  mockedDb.update.mockImplementation(() => ({
    set: () => ({ where: () => ({ __stmt: "update" }) }),
  }));
  mockedDb.batch.mockResolvedValue([]);
  mockedDb.insert.mockImplementation(() => ({
    values: () => ({
      onConflictDoNothing: () => ({ returning: () => Promise.resolve(insertedRows) }),
      // awaitable so `await db.insert(auditLog).values(...)` resolves
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    }),
  }));
}

// Narrowed FieldpulseInvoice (already in cents — the client parses the API's
// dollar strings). amountUnpaidCents 0 → derived state "paid".
const INVOICE = {
  id: "fp-inv-1",
  jobId: null,
  customerId: null,
  status: "3",
  totalCents: 12500,
  amountPaidCents: 12500,
  amountUnpaidCents: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mapFieldpulseStatusToInvoiceState", () => {
  it.each([
    ["sent", "open"],
    ["emailed", "open"],
    ["viewed", "open"],
    ["overdue", "open"],
    ["paid", "paid"],
    ["payment_received", "paid"],
    ["complete", "paid"],
    ["void", "void"],
    ["voided", "void"],
    ["cancelled", "void"],
    ["draft", "draft"],
    ["pending", "draft"],
    ["something-unknown", "draft"],
  ])("maps %s -> %s", (input, expected) => {
    expect(mapFieldpulseStatusToInvoiceState(input)).toBe(expected);
  });

  it("maps null/undefined to draft", () => {
    expect(mapFieldpulseStatusToInvoiceState(null)).toBe("draft");
    expect(mapFieldpulseStatusToInvoiceState(undefined)).toBe("draft");
  });

  it("never produces the native-only 'refunded' state", () => {
    const states = ["paid", "void", "refunded", "x"].map(
      mapFieldpulseStatusToInvoiceState,
    );
    expect(states).not.toContain("refunded");
  });
});

describe("pullInvoiceFromFieldpulse — degrade-safe", () => {
  it("skips when the org is not connected (no client)", async () => {
    mockedGetClient.mockResolvedValue(null);
    expect(await pullInvoiceFromFieldpulse("org-1", "fp-inv-1")).toBe("skipped");
  });

  it("skips when the invoice is not found in Fieldpulse", async () => {
    mockedGetClient.mockResolvedValue({ getInvoice: vi.fn().mockResolvedValue(null) });
    expect(await pullInvoiceFromFieldpulse("org-1", "fp-inv-1")).toBe("skipped");
  });

  it("returns failed (never throws) when the client errors", async () => {
    mockedGetClient.mockResolvedValue({
      getInvoice: vi.fn().mockRejectedValue(new Error("FP 500")),
    });
    expect(await pullInvoiceFromFieldpulse("org-1", "fp-inv-1")).toBe("failed");
  });
});

describe("pullInvoiceFromFieldpulse — find-or-create", () => {
  it("creates a new native invoice row when none exists", async () => {
    mockedGetClient.mockResolvedValue({
      getInvoice: vi.fn().mockResolvedValue(INVOICE),
    });
    wireDb([[]], [{ id: "inv-1" }]); // no existing; insert returns a row
    expect(await pullInvoiceFromFieldpulse("org-1", "fp-inv-1")).toBe("created");
    expect(mockedDb.insert).toHaveBeenCalled();
  });

  it("updates the existing row on re-sync (idempotent)", async () => {
    mockedGetClient.mockResolvedValue({
      getInvoice: vi.fn().mockResolvedValue(INVOICE),
    });
    wireDb([[{ id: "inv-1", state: "open" }]], []); // existing found
    expect(await pullInvoiceFromFieldpulse("org-1", "fp-inv-1")).toBe("updated");
    expect(mockedDb.batch).toHaveBeenCalled(); // update + audit batched
  });

  it("treats a lost insert race as 'updated' (re-select finds the winner)", async () => {
    mockedGetClient.mockResolvedValue({
      getInvoice: vi.fn().mockResolvedValue(INVOICE),
    });
    // existing none -> insert conflict (0 rows) -> re-select finds it
    wireDb([[], [{ id: "inv-1" }]], []);
    expect(await pullInvoiceFromFieldpulse("org-1", "fp-inv-1")).toBe("updated");
  });

  it("returns 'skipped' if the lost-race re-select is also empty", async () => {
    mockedGetClient.mockResolvedValue({
      getInvoice: vi.fn().mockResolvedValue(INVOICE),
    });
    wireDb([[], []], []); // none, conflict, re-select empty
    expect(await pullInvoiceFromFieldpulse("org-1", "fp-inv-1")).toBe("skipped");
  });
});

describe("pullInvoicesForJob", () => {
  it("aggregates per-invoice outcomes and isolates failures", async () => {
    const list = [
      { id: "a", jobId: null, customerId: null, totalCents: 100, amountPaidCents: 100, amountUnpaidCents: 0 },
      { id: "b", jobId: null, customerId: null, totalCents: 200, amountPaidCents: 0, amountUnpaidCents: 200 },
    ];
    mockedGetClient.mockResolvedValue({
      listJobInvoices: vi.fn().mockResolvedValue(list),
    });
    // a: existing none -> insert row (created). b: existing found (updated).
    const queue = [[], [{ id: "inv-b", state: "open" }]];
    let call = 0;
    mockedDb.select.mockImplementation(() => ({
      from: () => ({ where: () => Promise.resolve(queue[call++] ?? []) }),
    }));
    mockedDb.batch.mockResolvedValue([]);
    mockedDb.insert.mockImplementation(() => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: "inv-a" }]) }),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      }),
    }));
    const summary = await pullInvoicesForJob("org-1", "fp-job-1");
    expect(summary.created + summary.updated).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it("returns an empty summary when not connected", async () => {
    mockedGetClient.mockResolvedValue(null);
    expect(await pullInvoicesForJob("org-1", "fp-job-1")).toEqual({
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
  });
});
