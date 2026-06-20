/**
 * invoice-webhook route — money-grade pull scheduling.
 * Verifies the `after()` pull is scheduled ONLY after the event is verified and
 * freshly recorded (not a replay/duplicate, not an unmatched job), and only when
 * the payload carries invoiceId.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "@/app/api/admin/integrations/fieldpulse/invoice-webhook/route";
import { db } from "@/lib/db";
import { pullInvoiceFromFieldpulse } from "@/lib/integrations/fieldpulse/invoice-sync";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: { webhook: { maxRequests: 100, windowMs: 60000 } },
}));
vi.mock("@/lib/api-response", () => ({
  errorResponse: (m: string, c: string, s: number) =>
    new Response(JSON.stringify({ error: m, code: c }), { status: s }),
}));
vi.mock("@/lib/integrations/fieldpulse/config", () => ({
  getFieldpulseWebhookSecret: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/integrations/fieldpulse/webhook-signature", () => ({
  verifySignature: vi.fn(() => ({ valid: true })),
  isReplayTimestamp: vi.fn(() => false),
}));
vi.mock("@/lib/integrations/fieldpulse/invoice-sync", () => ({
  pullInvoiceFromFieldpulse: vi.fn().mockResolvedValue("created"),
}));
// Run after()-scheduled work synchronously so we can assert it.
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));

const mockedSelect = db.select as unknown as ReturnType<typeof vi.fn>;
const mockedInsert = db.insert as unknown as ReturnType<typeof vi.fn>;
const mockedUpdate = db.update as unknown as ReturnType<typeof vi.fn>;
const mockedPull = pullInvoiceFromFieldpulse as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-1";

/** The request lookup: `.from().where()` resolves to rows. */
function requestLookup(rows: unknown[]) {
  mockedSelect.mockReturnValue({
    from: () => ({ where: () => Promise.resolve(rows) }),
  } as never);
}
/** The idempotency ledger insert: `.values().onConflictDoNothing().returning()`. */
function ledgerInsert(returnedRows: unknown[]) {
  mockedInsert.mockReturnValue({
    values: () => ({
      onConflictDoNothing: () => ({ returning: () => Promise.resolve(returnedRows) }),
    }),
  } as never);
}

function req(body: Record<string, unknown>): Parameters<typeof POST>[0] {
  return {
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUpdate.mockReturnValue({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  } as never);
});

describe("invoice-webhook pull scheduling", () => {
  it("schedules the pull after verify+idempotency when invoiceId is present", async () => {
    requestLookup([{ id: "req-1", organizationId: ORG, invoiceStatus: "none" }]);
    ledgerInsert([{ id: "evt-row-1" }]); // fresh event
    const res = await POST(
      req({ id: "evt-1", eventType: "invoice.paid", jobId: "fp-job-1", invoiceId: "fp-inv-1" }),
    );
    expect(res.status).toBe(204);
    expect(mockedPull).toHaveBeenCalledWith(ORG, "fp-inv-1");
  });

  it("does NOT pull when the event is a replay/duplicate (ledger conflict)", async () => {
    requestLookup([{ id: "req-1", organizationId: ORG, invoiceStatus: "none" }]);
    ledgerInsert([]); // duplicate -> 0 rows
    const res = await POST(
      req({ id: "evt-1", eventType: "invoice.paid", jobId: "fp-job-1", invoiceId: "fp-inv-1" }),
    );
    expect(res.status).toBe(200);
    expect(mockedPull).not.toHaveBeenCalled();
  });

  it("does NOT pull when no service request matches the job", async () => {
    requestLookup([]); // unmatched
    const res = await POST(
      req({ id: "evt-1", eventType: "invoice.paid", jobId: "fp-job-x", invoiceId: "fp-inv-1" }),
    );
    expect(res.status).toBe(200);
    expect(mockedPull).not.toHaveBeenCalled();
  });

  it("does NOT pull when invoiceId is absent (legacy status-only event)", async () => {
    requestLookup([{ id: "req-1", organizationId: ORG, invoiceStatus: "none" }]);
    ledgerInsert([{ id: "evt-row-1" }]);
    const res = await POST(req({ id: "evt-1", eventType: "invoice.paid", jobId: "fp-job-1" }));
    expect(res.status).toBe(204);
    expect(mockedPull).not.toHaveBeenCalled();
  });
});
