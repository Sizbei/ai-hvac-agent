/**
 * Tests for Fieldpulse invoice webhook handling (Stage 7).
 *
 * These tests verify that the webhook endpoint correctly processes invoice events:
 * - invoice.sent
 * - invoice.paid
 * - invoice.voided
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "@/app/api/admin/integrations/fieldpulse/webhook/route";
import { db } from "@/lib/db";
import { serviceRequests, fieldpulseWebhookEvents, auditLog } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// Mock dependencies
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: {
    webhook: { maxRequests: 100, windowMs: 60000 },
  },
}));

vi.mock("@/lib/api-response", () => ({
  errorResponse: (message: string, code: string, status: number) => {
    return new Response(JSON.stringify({ error: message, code }), { status });
  },
}));

vi.mock("@/lib/integrations/fieldpulse/invoice-sync", () => ({
  syncInvoiceStatus: vi.fn().mockResolvedValue(true),
}));

describe("Fieldpulse Invoice Webhook", () => {
  const mockRequestId = "req-123";
  const mockFieldpulseJobId = "fp-job-456";
  const mockOrgId = "org-789";
  const mockEventId = "evt-invoice-abc";

  // The route issues two selects: the request lookup (`.where()` awaited) and
  // the per-org webhook-secret lookup (`.where().limit(1)`). This helper returns
  // a `where` result that is BOTH awaitable and `.limit()`-able.
  function selectReturning(rows: unknown[]) {
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const p = Promise.resolve(rows);
          return Object.assign(p, {
            limit: vi.fn().mockResolvedValue(rows),
          });
        }),
      }),
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // No webhook secret configured in tests -> signature verification is
    // optional (verifySignature returns valid with no_secret_configured).
    delete process.env.FIELDPULSE_WEBHOOK_SECRET;

    // Default mock for successful request lookup (the secret lookup reuses this
    // chain and finds no webhookSecretEncrypted -> env fallback -> null).
    vi.mocked(db.select).mockReturnValue(
      selectReturning([
        {
          id: mockRequestId,
          organizationId: mockOrgId,
          status: "completed",
          invoiceStatus: "none",
          fieldpulseJobId: mockFieldpulseJobId,
        },
      ]),
    );

    // Default mock for successful event insertion
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "webhook-1" }]),
        }),
      }),
    } as never);

    // Default mock for successful update. The job-status path uses
    // .where().returning() (gated on a row); the invoice path awaits .where()
    // directly — so .where() is both awaitable and .returning()-able.
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const p = Promise.resolve(undefined);
          return Object.assign(p, {
            returning: vi.fn().mockResolvedValue([{ id: mockRequestId }]),
          });
        }),
      }),
    } as never);
  });

  describe("invoice.sent event", () => {
    it("should process invoice sent event and update status", async () => {
      const request = new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: mockEventId,
          eventType: "invoice.sent",
          jobId: mockFieldpulseJobId,
        }),
      });

      const response = await POST(request as never);

      expect(response.status).toBe(204);
    });

    it("should be idempotent for duplicate invoice sent events", async () => {
      // Event already processed (no row inserted)
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]), // No rows inserted
          }),
        }),
      } as never);

      const request = new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: mockEventId,
          eventType: "invoice.sent",
          jobId: mockFieldpulseJobId,
        }),
      });

      const response = await POST(request as never);

      expect(response.status).toBe(200); // Already processed
    });
  });

  describe("invoice.paid event", () => {
    it("should process invoice paid event and update status", async () => {
      const request = new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: mockEventId,
          eventType: "invoice.paid",
          jobId: mockFieldpulseJobId,
        }),
      });

      const response = await POST(request as never);

      expect(response.status).toBe(204);
    });
  });

  describe("invoice.voided event", () => {
    it("should process invoice voided event and update status", async () => {
      const request = new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: mockEventId,
          eventType: "invoice.voided",
          jobId: mockFieldpulseJobId,
        }),
      });

      const response = await POST(request as never);

      expect(response.status).toBe(204);
    });
  });

  describe("missing jobId for invoice events", () => {
    it("should return 200 when jobId is missing but no request found", async () => {
      vi.mocked(db.select).mockReturnValue(selectReturning([])); // No matching request

      const request = new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: mockEventId,
          eventType: "invoice.sent",
          jobId: "non-existent-job",
        }),
      });

      const response = await POST(request as never);

      expect(response.status).toBe(200);
    });
  });

  describe("unknown invoice event types", () => {
    it("should return 200 for unknown invoice event types", async () => {
      const request = new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: mockEventId,
          eventType: "invoice.updated", // Not mapped to a status
          jobId: mockFieldpulseJobId,
        }),
      });

      const response = await POST(request as never);

      expect(response.status).toBe(200);
    });
  });

  describe("mixed job and invoice events", () => {
    it("should process a job status event from the payload status field", async () => {
      // New contract: the status comes from the payload `status` field, not the
      // eventType string. Mock request is "completed"; move it to "in_progress".
      const request = new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: mockEventId,
          eventType: "job.status_updated",
          status: "in_progress",
          jobId: mockFieldpulseJobId,
        }),
      });

      const response = await POST(request as never);

      expect(response.status).toBe(204);
      expect(db.update).toHaveBeenCalled();
    });

    it("does NOT destructively reset status when the event carries no mappable status", async () => {
      // Regression guard: an unrecognized eventType with no status field must
      // SKIP (200), not reset the request to "pending".
      const request = new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: mockEventId,
          eventType: "job.status_updated",
          jobId: mockFieldpulseJobId,
        }),
      });

      const response = await POST(request as never);

      expect(response.status).toBe(200);
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
