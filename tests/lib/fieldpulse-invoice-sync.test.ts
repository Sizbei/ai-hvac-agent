/**
 * Tests for Fieldpulse invoice sync functionality (Stage 7).
 *
 * These tests verify:
 * - Invoice status mapping from Fieldpulse to our enum
 * - Sync invoice status updates service requests correctly
 * - Batch sync handles multiple invoices
 * - Idempotency (re-adding the same status is a no-op)
 * - Missing job handling (graceful degradation)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { syncInvoiceStatus, batchSyncInvoiceStatuses, deriveInvoiceStatusFromInvoices } from "@/lib/integrations/fieldpulse/invoice-sync";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";

// Mock the database
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

// Mock the logger
vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("Fieldpulse Invoice Sync", () => {
  const mockRequestId = "req-123";
  const mockFieldpulseJobId = "fp-job-456";
  const mockOrgId = "org-789";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("syncInvoiceStatus", () => {
    it("should update invoice status from 'sent' to 'sent'", async () => {
      // Mock database response
      const mockWhere = vi.fn().mockResolvedValue([
        {
          id: mockRequestId,
          invoiceStatus: "none",
        },
      ]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
      const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
      vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

      const mockInsertValues = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      const result = await syncInvoiceStatus(
        mockFieldpulseJobId,
        "sent",
        mockOrgId,
      );

      expect(result).toBe("updated");
      expect(db.update).toHaveBeenCalledWith(serviceRequests);
      expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: mockOrgId,
        entityId: mockRequestId,
        action: "invoice_status_updated",
      }));
    });

    it("should update invoice status from 'paid' to 'paid'", async () => {
      const mockWhere = vi.fn().mockResolvedValue([
        {
          id: mockRequestId,
          invoiceStatus: "sent",
        },
      ]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
      const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
      vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

      const mockInsertValues = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      const result = await syncInvoiceStatus(
        mockFieldpulseJobId,
        "paid",
        mockOrgId,
      );

      expect(result).toBe("updated");
    });

    it("should update invoice status to 'void' for voided invoices", async () => {
      const mockWhere = vi.fn().mockResolvedValue([
        {
          id: mockRequestId,
          invoiceStatus: "sent",
        },
      ]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
      const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
      vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

      const mockInsertValues = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      const result = await syncInvoiceStatus(
        mockFieldpulseJobId,
        "void",
        mockOrgId,
      );

      expect(result).toBe("updated");
    });

    it("should be idempotent when status already matches", async () => {
      const mockWhere = vi.fn().mockResolvedValue([
        {
          id: mockRequestId,
          invoiceStatus: "paid",
        },
      ]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await syncInvoiceStatus(
        mockFieldpulseJobId,
        "paid",
        mockOrgId,
      );

      expect(result).toBe("skipped"); // No update needed
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should handle missing service request gracefully", async () => {
      const mockWhere = vi.fn().mockResolvedValue([]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await syncInvoiceStatus(
        mockFieldpulseJobId,
        "paid",
        mockOrgId,
      );

      expect(result).toBe("skipped");
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should map 'draft' status to 'none'", async () => {
      const mockWhere = vi.fn().mockResolvedValue([
        {
          id: mockRequestId,
          invoiceStatus: "none",
        },
      ]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await syncInvoiceStatus(
        mockFieldpulseJobId,
        "draft",
        mockOrgId,
      );

      expect(result).toBe("skipped"); // No change needed (none → none)
    });

    it("should handle database errors gracefully", async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error("Database error");
      });

      const result = await syncInvoiceStatus(
        mockFieldpulseJobId,
        "paid",
        mockOrgId,
      );

      expect(result).toBe("failed");
    });
  });

  describe("batchSyncInvoiceStatuses", () => {
    it("should process multiple invoice updates", async () => {
      // Use the same mock for all calls (all succeed)
      const mockWhere = vi.fn().mockResolvedValue([{ id: "req-1", invoiceStatus: "none" }]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
      const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
      vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

      const mockInsertValues = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      const updates = [
        {
          fieldpulseJobId: "fp-1",
          invoiceStatus: "sent" as const,
          organizationId: mockOrgId,
        },
        {
          fieldpulseJobId: "fp-2",
          invoiceStatus: "paid" as const,
          organizationId: mockOrgId,
        },
        {
          fieldpulseJobId: "fp-3",
          invoiceStatus: "void" as const,
          organizationId: mockOrgId,
        },
      ];

      const result = await batchSyncInvoiceStatuses(updates);

      expect(result.success).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("should count skips separately from successes and failures", async () => {
      // First two update, third is a no-match (a SKIP, not a failure)
      let callCount = 0;
      const mockWhere = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return [{ id: `req-${callCount}`, invoiceStatus: "none" }];
        }
        return []; // Third call: no request found
      });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
      const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
      vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

      const mockInsertValues = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      const updates = [
        {
          fieldpulseJobId: "fp-1",
          invoiceStatus: "sent" as const,
          organizationId: mockOrgId,
        },
        {
          fieldpulseJobId: "fp-2",
          invoiceStatus: "paid" as const,
          organizationId: mockOrgId,
        },
        {
          fieldpulseJobId: "fp-3",
          invoiceStatus: "void" as const,
          organizationId: mockOrgId,
        },
      ];

      const result = await batchSyncInvoiceStatuses(updates);

      expect(result.success).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.failed).toBe(0);
    });
  });

  describe("deriveInvoiceStatusFromInvoices", () => {
    it("should return 'none' for empty invoice list", () => {
      const result = deriveInvoiceStatusFromInvoices([]);
      expect(result).toBe("none");
    });

    it("should return 'sent' for sent invoice", () => {
      const result = deriveInvoiceStatusFromInvoices([{ status: "sent" }]);
      expect(result).toBe("sent");
    });

    it("should return 'paid' for paid invoice", () => {
      const result = deriveInvoiceStatusFromInvoices([{ status: "paid" }]);
      expect(result).toBe("paid");
    });

    it("should return 'void' for voided invoice", () => {
      const result = deriveInvoiceStatusFromInvoices([{ status: "void" }]);
      expect(result).toBe("void");
    });

    it("should use the first (most recent) invoice status", () => {
      const result = deriveInvoiceStatusFromInvoices([
        { status: "paid" },
        { status: "sent" },
        { status: "void" },
      ]);
      expect(result).toBe("paid"); // First one
    });

    it("should handle null/undefined status gracefully", () => {
      const result = deriveInvoiceStatusFromInvoices([{ status: null }]);
      expect(result).toBe("none");
    });

    it("should map alternative status names correctly", () => {
      expect(deriveInvoiceStatusFromInvoices([{ status: "emailed" }])).toBe("sent");
      expect(deriveInvoiceStatusFromInvoices([{ status: "viewed" }])).toBe("sent");
      expect(deriveInvoiceStatusFromInvoices([{ status: "payment_received" }])).toBe("paid");
      expect(deriveInvoiceStatusFromInvoices([{ status: "voided" }])).toBe("void");
      expect(deriveInvoiceStatusFromInvoices([{ status: "cancelled" }])).toBe("void");
    });
  });
});
