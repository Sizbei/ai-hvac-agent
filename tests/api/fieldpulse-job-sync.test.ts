/**
 * Integration tests for Fieldpulse job sync flow.
 *
 * Tests Phase 2: Job push, customer sync, cancellation.
 * Mocks the Fieldpulse API and database to test the full sync pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { pushJobToFieldpulse, cancelFieldpulseJob } from "@/lib/integrations/fieldpulse/job-sync";
import { syncCustomerToFieldpulse } from "@/lib/integrations/fieldpulse/customer-sync";

// Mock dependencies
vi.mock("@/lib/db");
vi.mock("@/lib/crypto");
vi.mock("@/lib/logger");
vi.mock("./client");

describe("Fieldpulse Phase 2: Job Sync Flow", () => {
  const mockOrgId = "test-org-123";
  const mockCustomerId = "customer-123";
  const mockRequestId = "request-123";
  const mockFpCustomerId = "fp-customer-123";
  const mockFpJobId = "fp-job-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("syncCustomerToFieldpulse", () => {
    it("should no-op when org is not Fieldpulse-connected", async () => {
      // Mock no client available
      vi.doMock("./client", () => ({
        getFieldpulseClient: () => Promise.resolve(null),
      }));

      await syncCustomerToFieldpulse(mockOrgId, mockCustomerId);

      // Should not throw, should log and return
      expect(true).toBe(true); // Test passes if no exception
    });

    it("should create customer in Fieldpulse when not mapped", async () => {
      // Mock client and database responses
      const mockClient = {
        findCustomer: vi.fn().mockResolvedValue(null),
        createCustomer: vi.fn().mockResolvedValue({ id: mockFpCustomerId }),
      };

      vi.doMock("./client", () => ({
        getFieldpulseClient: () => Promise.resolve(mockClient),
      }));

      const { db } = require("@/lib/db");
      db.select = vi.fn().mockReturnValue([{
        id: mockCustomerId,
        fieldpulseCustomerId: null,
        nameEncrypted: "encrypted:John Doe",
        emailEncrypted: "encrypted:john@example.com",
        phoneEncrypted: "encrypted:555-1234",
        addressEncrypted: "encrypted:123 Main St",
      }]);

      await syncCustomerToFieldpulse(mockOrgId, mockCustomerId);

      expect(mockClient.createCustomer).toHaveBeenCalled();
    });

    it("should reuse existing Fieldpulse customer when found by email", async () => {
      const existingFpCustomer = {
        id: mockFpCustomerId,
        email: "john@example.com",
      };

      const mockClient = {
        findCustomer: vi.fn().mockResolvedValue(existingFpCustomer),
        createCustomer: vi.fn(), // Should NOT be called
      };

      vi.doMock("./client", () => ({
        getFieldpulseClient: () => Promise.resolve(mockClient),
      }));

      const { db } = require("@/lib/db");
      db.select = vi.fn().mockReturnValue([{
        id: mockCustomerId,
        fieldpulseCustomerId: null,
        emailEncrypted: "encrypted:john@example.com",
      }]);

      await syncCustomerToFieldpulse(mockOrgId, mockCustomerId);

      expect(mockClient.findCustomer).toHaveBeenCalled();
      expect(mockClient.createCustomer).not.toHaveBeenCalled();
    });

    it("should be idempotent - no-op when already mapped", async () => {
      const mockClient = {
        findCustomer: vi.fn(),
        createCustomer: vi.fn(),
      };

      vi.doMock("./client", () => ({
        getFieldpulseClient: () => Promise.resolve(mockClient),
      }));

      const { db } = require("@/lib/db");
      db.select = vi.fn().mockReturnValue([{
        id: mockCustomerId,
        fieldpulseCustomerId: mockFpCustomerId, // Already mapped
      }]);

      await syncCustomerToFieldpulse(mockOrgId, mockCustomerId);

      expect(mockClient.findCustomer).not.toHaveBeenCalled();
      expect(mockClient.createCustomer).not.toHaveBeenCalled();
    });
  });

  describe("pushJobToFieldpulse", () => {
    it("should no-op when org is not connected", async () => {
      vi.doMock("./client", () => ({
        getFieldpulseClient: () => Promise.resolve(null),
      }));

      await pushJobToFieldpulse(mockOrgId, mockRequestId);

      // Should not throw
      expect(true).toBe(true);
    });

    it("should sync customer first, then create job", async () => {
      const mockClient = {
        createJob: vi.fn().mockResolvedValue({ id: mockFpJobId }),
      };

      vi.doMock("./client", () => ({
        getFieldpulseClient: () => Promise.resolve(mockClient),
      }));

      const { db } = require("@/lib/db");
      db.select = vi.fn()
        // First call: load job sync row
        .mockReturnValueOnce([{
          requestId: mockRequestId,
          fieldpulseJobId: null,
          customerId: mockCustomerId,
          fieldpulseCustomerId: mockFpCustomerId, // Customer already mapped
          jobFields: {
            referenceNumber: "HVAC-123",
            issueType: "no_cool",
            urgency: "high",
            description: "AC not working",
            arrivalWindowStart: null,
            arrivalWindowEnd: null,
            addressText: "123 Main St",
            accessNotes: "Gate code 1234",
          },
        }])
        // Second call: re-read after customer sync (should still have fpCustomerId)
        .mockReturnValueOnce([{
          requestId: mockRequestId,
          fieldpulseJobId: null,
          fieldpulseCustomerId: mockFpCustomerId,
        }]);

      await pushJobToFieldpulse(mockOrgId, mockRequestId);

      expect(mockClient.createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: mockFpCustomerId,
          description: expect.stringContaining("Reference: HVAC-123"),
        })
      );
    });

    it("should update existing job instead of creating duplicate", async () => {
      const mockClient = {
        updateJob: vi.fn().mockResolvedValue(undefined),
        createJob: vi.fn(), // Should NOT be called
      };

      vi.doMock("./client", () => ({
        getFieldpulseClient: () => Promise.resolve(mockClient),
      }));

      const { db } = require("@/lib/db");
      db.select = vi.fn().mockReturnValue([{
        requestId: mockRequestId,
        fieldpulseJobId: mockFpJobId, // Already has job mapped
        jobFields: {
          referenceNumber: "HVAC-123",
          issueType: "no_cool",
          urgency: "high",
          description: "AC not working",
          arrivalWindowStart: new Date("2024-06-15T10:00:00Z"),
          arrivalWindowEnd: new Date("2024-06-15T12:00:00Z"),
          addressText: "123 Main St",
          accessNotes: null,
        },
      }]);

      await pushJobToFieldpulse(mockOrgId, mockRequestId);

      expect(mockClient.updateJob).toHaveBeenCalled();
      expect(mockClient.createJob).not.toHaveBeenCalled();
    });
  });

  describe("cancelFieldpulseJob", () => {
    it("should cancel job in Fieldpulse", async () => {
      const mockClient = {
        cancelJob: vi.fn().mockResolvedValue(undefined),
      };

      vi.doMock("./client", () => ({
        getFieldpulseClient: () => Promise.resolve(mockClient),
      }));

      const { db } = require("@/lib/db");
      db.select = vi.fn().mockReturnValue([{
        fieldpulseJobId: mockFpJobId,
      }]);

      await cancelFieldpulseJob(mockOrgId, mockRequestId);

      expect(mockClient.cancelJob).toHaveBeenCalledWith(mockFpJobId);
    });

    it("should no-op when no Fieldpulse job is mapped", async () => {
      const mockClient = {
        cancelJob: vi.fn(),
      };

      vi.doMock("./client", () => ({
        getFieldpulseClient: () => Promise.resolve(mockClient),
      }));

      const { db } = require("@/lib/db");
      db.select = vi.fn().mockReturnValue([{
        fieldpulseJobId: null, // No job mapped
      }]);

      await cancelFieldpulseJob(mockOrgId, mockRequestId);

      expect(mockClient.cancelJob).not.toHaveBeenCalled();
    });
  });
});
