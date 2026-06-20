/**
 * Tests for the Housecall Pro invoice PULL MIRROR (parity with FieldPulse).
 * Mapper + degrade paths + find-or-create outcomes incl. lost-race re-select.
 * DB + client mocked; no network.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mapHousecallStatusToInvoiceState,
  mapHousecallStatusToRequestInvoiceStatus,
  pullInvoiceFromHousecall,
  pullInvoicesForJob,
} from "@/lib/integrations/housecall-pro/invoice-sync";
import { db } from "@/lib/db";
import { getHousecallClient } from "@/lib/integrations/housecall-pro/client";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), batch: vi.fn() },
}));
vi.mock("@/lib/integrations/housecall-pro/client", () => ({
  getHousecallClient: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockedDb = db as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedGetClient = getHousecallClient as unknown as ReturnType<typeof vi.fn>;

function wireDb(selectResults: unknown[][], insertedRows: unknown[]): void {
  const queue = [...selectResults];
  mockedDb.select.mockImplementation(() => ({
    from: () => ({ where: () => Promise.resolve(queue.shift() ?? []) }),
  }));
  mockedDb.update.mockImplementation(() => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }));
  mockedDb.batch.mockResolvedValue([]);
  mockedDb.insert.mockImplementation(() => ({
    values: () => ({
      onConflictDoNothing: () => ({ returning: () => Promise.resolve(insertedRows) }),
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    }),
  }));
}

// jobId/customerId null so link-resolution + badge mirror are no-ops (isolates outcome logic).
const INVOICE = { id: "hcp-inv-1", jobId: null, customerId: null, status: "paid", total: 9900 };

beforeEach(() => vi.clearAllMocks());

describe("mapHousecallStatusToInvoiceState", () => {
  it.each([
    ["sent", "open"],
    ["overdue", "open"],
    ["paid", "paid"],
    ["payment_received", "paid"],
    ["voided", "void"],
    ["cancelled", "void"],
    ["draft", "draft"],
    ["weird", "draft"],
  ])("maps %s -> %s", (i, o) => {
    expect(mapHousecallStatusToInvoiceState(i)).toBe(o);
  });
  it("null -> draft; never produces refunded", () => {
    expect(mapHousecallStatusToInvoiceState(null)).toBe("draft");
    expect(["paid", "void", "refunded"].map(mapHousecallStatusToInvoiceState)).not.toContain("refunded");
  });
});

describe("mapHousecallStatusToRequestInvoiceStatus", () => {
  it("maps to the request badge enum", () => {
    expect(mapHousecallStatusToRequestInvoiceStatus("sent")).toBe("sent");
    expect(mapHousecallStatusToRequestInvoiceStatus("paid")).toBe("paid");
    expect(mapHousecallStatusToRequestInvoiceStatus("voided")).toBe("void");
    expect(mapHousecallStatusToRequestInvoiceStatus("draft")).toBe("none");
  });
});

describe("pullInvoiceFromHousecall — degrade-safe", () => {
  it("skips when not connected", async () => {
    mockedGetClient.mockResolvedValue(null);
    expect(await pullInvoiceFromHousecall("org-1", "hcp-inv-1")).toBe("skipped");
  });
  it("skips when the invoice is not found", async () => {
    mockedGetClient.mockResolvedValue({ getInvoice: vi.fn().mockResolvedValue(null) });
    expect(await pullInvoiceFromHousecall("org-1", "hcp-inv-1")).toBe("skipped");
  });
  it("returns failed (never throws) on client error", async () => {
    mockedGetClient.mockResolvedValue({
      getInvoice: vi.fn().mockRejectedValue(new Error("HCP 500")),
    });
    expect(await pullInvoiceFromHousecall("org-1", "hcp-inv-1")).toBe("failed");
  });
});

describe("pullInvoiceFromHousecall — find-or-create", () => {
  beforeEach(() => {
    mockedGetClient.mockResolvedValue({ getInvoice: vi.fn().mockResolvedValue(INVOICE) });
  });
  it("creates when none exists", async () => {
    wireDb([[]], [{ id: "inv-1" }]);
    expect(await pullInvoiceFromHousecall("org-1", "hcp-inv-1")).toBe("created");
    expect(mockedDb.insert).toHaveBeenCalled();
  });
  it("updates the existing row on re-sync", async () => {
    wireDb([[{ id: "inv-1", state: "open" }]], []);
    expect(await pullInvoiceFromHousecall("org-1", "hcp-inv-1")).toBe("updated");
    expect(mockedDb.batch).toHaveBeenCalled();
  });
  it("treats a lost insert race as 'updated'", async () => {
    wireDb([[], [{ id: "inv-1" }]], []);
    expect(await pullInvoiceFromHousecall("org-1", "hcp-inv-1")).toBe("updated");
  });
  it("returns 'skipped' if the lost-race re-select is empty", async () => {
    wireDb([[], []], []);
    expect(await pullInvoiceFromHousecall("org-1", "hcp-inv-1")).toBe("skipped");
  });
});

describe("pullInvoicesForJob", () => {
  it("returns an empty summary when not connected", async () => {
    mockedGetClient.mockResolvedValue(null);
    expect(await pullInvoicesForJob("org-1", "hcp-job-1")).toEqual({
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
  });
  it("aggregates outcomes across a job's invoices", async () => {
    mockedGetClient.mockResolvedValue({
      listJobInvoices: vi.fn().mockResolvedValue([INVOICE, { ...INVOICE, id: "hcp-inv-2" }]),
    });
    wireDb([[], []], [{ id: "inv-x" }]); // both insert as created
    const s = await pullInvoicesForJob("org-1", "hcp-job-1");
    expect(s.created + s.updated).toBe(2);
    expect(s.failed).toBe(0);
  });
});
