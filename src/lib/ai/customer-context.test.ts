import { describe, it, expect, vi, beforeEach } from "vitest";

const { findIdMock, selectResult, decryptMock, historyMock } = vi.hoisted(
  () => ({
    findIdMock: vi.fn(),
    selectResult: { value: [] as unknown[] },
    decryptMock: vi.fn(),
    historyMock: vi.fn(),
  }),
);

vi.mock("@/lib/admin/crm-queries", () => ({
  findCustomerIdByContact: findIdMock,
}));

vi.mock("@/lib/integrations/housecall-pro/customer-history", () => ({
  getCustomerServiceHistory: historyMock,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selectResult.value) }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  customers: {
    id: "customers.id",
    nameEncrypted: "customers.name_encrypted",
    customerType: "customers.customer_type",
    membershipStatus: "customers.membership_status",
    doNotService: "customers.do_not_service",
    hcpCustomerId: "customers.hcp_customer_id",
  },
}));

vi.mock("@/lib/db/tenant", () => ({
  withTenant: (...a: unknown[]) => a,
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => a,
  sql: () => ({}),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: decryptMock,
}));

import {
  lookupCustomerContext,
  loadCustomerContextById,
  buildCustomerContextHint,
  enrichWithServiceHistory,
  type CustomerContext,
} from "./customer-context";

const ORG = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
  selectResult.value = [];
  decryptMock.mockImplementation((v: string) => v); // identity unless overridden
  // Default: HCP not connected / no history. Tests override per-case.
  historyMock.mockResolvedValue({
    jobCount: 0,
    lastServiceDate: null,
    lastServiceDescription: null,
  });
});

describe("lookupCustomerContext", () => {
  it("returns null when no customer matches (not found)", async () => {
    findIdMock.mockResolvedValue(null);
    const result = await lookupCustomerContext(ORG, {
      email: "nobody@example.com",
    });
    expect(result).toBeNull();
    // No light query when the id lookup misses.
    expect(selectResult.value).toEqual([]);
  });

  it("returns null when neither email nor phone is provided", async () => {
    findIdMock.mockResolvedValue(null);
    const result = await lookupCustomerContext(ORG, {});
    expect(result).toBeNull();
    expect(findIdMock).toHaveBeenCalledWith(ORG, { email: null, phone: null });
  });

  it("returns light context for a found returning customer", async () => {
    findIdMock.mockResolvedValue("cust-123");
    decryptMock.mockReturnValue("Jane Doe");
    selectResult.value = [
      {
        nameEncrypted: "enc-name",
        customerType: "residential",
        membershipStatus: "active",
        doNotService: false,
        hcpCustomerId: "hcp-1",
        priorRequestCount: 3,
      },
    ];

    const result = await lookupCustomerContext(ORG, {
      email: "jane@example.com",
    });

    expect(result).toEqual({
      customerId: "cust-123",
      isReturning: true,
      priorRequestCount: 3,
      membershipStatus: "active",
      customerType: "residential",
      doNotService: false,
      firstName: "Jane",
      fullName: "Jane Doe",
      hcpCustomerId: "hcp-1",
    });
  });

  it("surfaces the do_not_service flag", async () => {
    findIdMock.mockResolvedValue("cust-dns");
    decryptMock.mockReturnValue("Bad Actor");
    selectResult.value = [
      {
        nameEncrypted: "enc",
        customerType: "commercial",
        membershipStatus: "none",
        doNotService: true,
        priorRequestCount: 0,
      },
    ];

    const result = await lookupCustomerContext(ORG, { phone: "5551234567" });
    expect(result?.doNotService).toBe(true);
    expect(result?.customerType).toBe("commercial");
    expect(result?.priorRequestCount).toBe(0);
  });

  it("drops the 'Unknown' placeholder from name fields", async () => {
    findIdMock.mockResolvedValue("cust-anon");
    decryptMock.mockReturnValue("Unknown");
    selectResult.value = [
      {
        nameEncrypted: "enc",
        customerType: "residential",
        membershipStatus: "none",
        doNotService: false,
        priorRequestCount: 1,
      },
    ];

    const result = await lookupCustomerContext(ORG, { phone: "5550000000" });
    expect(result?.firstName).toBeNull();
    expect(result?.fullName).toBeNull();
  });

  it("returns null when the id resolves but the row was deleted concurrently", async () => {
    findIdMock.mockResolvedValue("cust-gone");
    selectResult.value = [];
    const result = await lookupCustomerContext(ORG, {
      email: "gone@example.com",
    });
    expect(result).toBeNull();
  });

  it("tolerates a decrypt failure and yields null names", async () => {
    findIdMock.mockResolvedValue("cust-x");
    decryptMock.mockImplementation(() => {
      throw new Error("bad ciphertext");
    });
    selectResult.value = [
      {
        nameEncrypted: "corrupt",
        customerType: "residential",
        membershipStatus: "active",
        doNotService: false,
        priorRequestCount: 2,
      },
    ];

    const result = await lookupCustomerContext(ORG, { email: "x@x.com" });
    expect(result?.firstName).toBeNull();
    expect(result?.fullName).toBeNull();
    expect(result?.priorRequestCount).toBe(2);
  });
});

describe("loadCustomerContextById", () => {
  it("maps the row to a context WITHOUT a contact lookup (id is known)", async () => {
    decryptMock.mockReturnValue("Jane Doe");
    selectResult.value = [
      {
        nameEncrypted: "enc",
        customerType: "residential",
        membershipStatus: "active",
        doNotService: false,
        hcpCustomerId: "hcp-1",
        priorRequestCount: 3,
      },
    ];

    const result = await loadCustomerContextById(ORG, "cust-123");

    expect(findIdMock).not.toHaveBeenCalled(); // no contact resolution needed
    expect(result).toEqual({
      customerId: "cust-123",
      isReturning: true,
      priorRequestCount: 3,
      membershipStatus: "active",
      customerType: "residential",
      doNotService: false,
      firstName: "Jane",
      fullName: "Jane Doe",
      hcpCustomerId: "hcp-1",
    });
  });

  it("returns null when no customer row exists (raced delete)", async () => {
    selectResult.value = [];
    expect(await loadCustomerContextById(ORG, "gone")).toBeNull();
  });
});

describe("buildCustomerContextHint", () => {
  it("returns empty string for null context", () => {
    expect(buildCustomerContextHint(null)).toBe("");
  });

  it("greets by first name and notes prior requests + membership", () => {
    const hint = buildCustomerContextHint({
      customerId: "c1",
      isReturning: true,
      priorRequestCount: 2,
      membershipStatus: "active",
      customerType: "residential",
      doNotService: false,
      firstName: "Sam",
      fullName: "Sam Jones",
      hcpCustomerId: null,
    });
    expect(hint).toContain("RETURNING CUSTOMER");
    expect(hint).toContain("Sam");
    expect(hint).toContain("2 prior service requests");
    expect(hint).toContain("active member");
    expect(hint).toContain("do NOT re-ask");
  });

  it("never leaks the full name (PII) into the prompt hint", () => {
    const hint = buildCustomerContextHint({
      customerId: "c1",
      isReturning: true,
      priorRequestCount: 1,
      membershipStatus: "none",
      customerType: "residential",
      doNotService: false,
      firstName: "Sam",
      fullName: "Sam Jones",
      hcpCustomerId: null,
    });
    expect(hint).toContain("Sam");
    expect(hint).not.toContain("Jones");
    expect(hint).toContain("1 prior service request");
  });

  it("flags a commercial account", () => {
    const hint = buildCustomerContextHint({
      customerId: "c1",
      isReturning: true,
      priorRequestCount: 0,
      membershipStatus: "none",
      customerType: "commercial",
      doNotService: false,
      firstName: null,
      fullName: null,
      hcpCustomerId: null,
    });
    expect(hint).toContain("commercial account");
  });

  it("surfaces a prior-service note when present", () => {
    const hint = buildCustomerContextHint({
      customerId: "c1",
      isReturning: true,
      priorRequestCount: 1,
      membershipStatus: "none",
      customerType: "residential",
      doNotService: false,
      firstName: "Sam",
      fullName: "Sam Jones",
      hcpCustomerId: "hcp-1",
      priorServiceNote: "Most recent service: March 2026 — replaced capacitor.",
    });
    expect(hint).toContain("Most recent service: March 2026");
    expect(hint).toContain("replaced capacitor");
  });
});

describe("enrichWithServiceHistory", () => {
  const baseContext: CustomerContext = {
    customerId: "cust-1",
    isReturning: true,
    priorRequestCount: 2,
    membershipStatus: "active",
    customerType: "residential",
    doNotService: false,
    firstName: "Jane",
    fullName: "Jane Doe",
    hcpCustomerId: "hcp-1",
  };

  it("returns null context unchanged (no HCP call)", async () => {
    const result = await enrichWithServiceHistory(ORG, null);
    expect(result).toBeNull();
    expect(historyMock).not.toHaveBeenCalled();
  });

  it("returns context unchanged when there is no hcpCustomerId (no HCP call)", async () => {
    const ctx = { ...baseContext, hcpCustomerId: null };
    const result = await enrichWithServiceHistory(ORG, ctx);
    expect(result).toEqual(ctx);
    expect(result?.priorServiceNote).toBeUndefined();
    expect(historyMock).not.toHaveBeenCalled();
  });

  it("attaches a prior-service note (date + description) when history exists", async () => {
    historyMock.mockResolvedValue({
      jobCount: 4,
      lastServiceDate: "2026-03-15T14:00:00.000Z",
      lastServiceDescription: "Replaced capacitor",
    });
    const result = await enrichWithServiceHistory(ORG, baseContext);
    expect(historyMock).toHaveBeenCalledWith(ORG, "hcp-1", expect.anything());
    expect(result?.priorServiceNote).toBe(
      "Most recent service: March 2026 — Replaced capacitor.",
    );
  });

  it("attaches a date-only note when description is absent", async () => {
    historyMock.mockResolvedValue({
      jobCount: 1,
      lastServiceDate: "2026-03-15T14:00:00.000Z",
      lastServiceDescription: null,
    });
    const result = await enrichWithServiceHistory(ORG, baseContext);
    expect(result?.priorServiceNote).toBe("Most recent service: March 2026.");
  });

  it("leaves context unchanged when HCP has no past jobs (degraded/empty)", async () => {
    historyMock.mockResolvedValue({
      jobCount: 0,
      lastServiceDate: null,
      lastServiceDescription: null,
    });
    const result = await enrichWithServiceHistory(ORG, baseContext);
    expect(result).toEqual(baseContext);
    expect(result?.priorServiceNote).toBeUndefined();
  });
});
