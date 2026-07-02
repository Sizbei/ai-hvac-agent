import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadCustomerProfile } from "./customer-profile";
import { db } from "@/lib/db";
import { withTenant } from "@/lib/db/tenant";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

// Decrypt is deterministic in tests: plaintext = "plain-" + ciphertext.
vi.mock("@/lib/crypto", () => ({
  decrypt: (s: string) => `plain-${s}`,
}));

// Record tenant scoping without exercising real drizzle SQL builders.
vi.mock("@/lib/db/tenant", () => ({
  withTenant: vi.fn((_table: unknown, orgId: string) => ({ __org: orgId })),
}));

const ORG = "org-1";
const CUST = "cust-1";

/**
 * loadCustomerProfile fires six db.select() calls inside a single Promise.all,
 * in this fixed order: identity, memberships, balance, lastService,
 * openEstimates, recentJobs. Each select() returns the next result in the
 * sequence wrapped in a chain that is a thenable AND answers every builder
 * method (from/innerJoin/where/orderBy/limit) by returning itself.
 */
function mockSelectSeq(results: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const result = results[i++] ?? [];
    const chain = Promise.resolve(result) as unknown as Record<string, unknown>;
    for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) {
      chain[m] = () => chain;
    }
    return chain as never;
  });
}

function identityRow() {
  return {
    id: CUST,
    nameEncrypted: "name",
    phoneEncrypted: "phone",
    emailEncrypted: "email",
    addressEncrypted: "addr",
    customerType: "residential",
    membershipStatus: "active",
    doNotService: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadCustomerProfile — aggregation shape", () => {
  it("assembles identity, memberships, balance, last service, estimates, and recent jobs", async () => {
    mockSelectSeq([
      [identityRow()],
      [
        {
          id: "mem-1",
          planId: "plan-1",
          status: "active",
          startedAt: new Date("2026-02-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-03-01T00:00:00.000Z"),
          planName: "Comfort Club",
          billingPeriod: "monthly",
          priceCents: 1999,
        },
      ],
      [{ balanceDueCents: 12300, openInvoiceCount: 2 }],
      [{ lastServiceDate: "2026-05-20 14:00:00+00" }],
      [{ count: 1, totalCents: 45000 }],
      [
        {
          id: "sr-1",
          referenceNumber: "REF-001",
          status: "completed",
          issueType: "no_cool",
          createdAt: new Date("2026-05-20T14:00:00.000Z"),
          scheduledDate: new Date("2026-05-20T13:00:00.000Z"),
          completedAt: new Date("2026-05-20T14:00:00.000Z"),
        },
      ],
    ]);

    const profile = await loadCustomerProfile(ORG, CUST);

    expect(profile).not.toBeNull();
    // Identity is decrypted via the mocked crypto.
    expect(profile!.customer).toMatchObject({
      id: CUST,
      name: "plain-name",
      phone: "plain-phone",
      email: "plain-email",
      address: "plain-addr",
      customerType: "residential",
      membershipStatus: "active",
      doNotService: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // Active membership joined to its plan.
    expect(profile!.memberships).toEqual([
      {
        id: "mem-1",
        planId: "plan-1",
        planName: "Comfort Club",
        status: "active",
        billingPeriod: "monthly",
        priceCents: 1999,
        startedAt: "2026-02-01T00:00:00.000Z",
        currentPeriodEnd: "2026-03-01T00:00:00.000Z",
      },
    ]);
    // Balance + last service + open estimates + recent jobs.
    expect(profile!.balanceDueCents).toBe(12300);
    expect(profile!.openInvoiceCount).toBe(2);
    expect(profile!.lastServiceDate).toBe("2026-05-20 14:00:00+00");
    expect(profile!.openEstimates).toEqual({ count: 1, totalCents: 45000 });
    expect(profile!.recentJobs).toEqual([
      {
        id: "sr-1",
        referenceNumber: "REF-001",
        status: "completed",
        issueType: "no_cool",
        createdAt: "2026-05-20T14:00:00.000Z",
        scheduledDate: "2026-05-20T13:00:00.000Z",
        completedAt: "2026-05-20T14:00:00.000Z",
      },
    ]);
  });
});

describe("loadCustomerProfile — empty customer", () => {
  it("returns zeroed/empty aggregates when the customer has no memberships, invoices, estimates, or jobs", async () => {
    mockSelectSeq([
      [identityRow()],
      [], // no memberships
      [{ balanceDueCents: 0, openInvoiceCount: 0 }], // aggregate over zero rows
      [{ lastServiceDate: null }], // MAX over zero completed jobs
      [{ count: 0, totalCents: 0 }],
      [], // no jobs
    ]);

    const profile = await loadCustomerProfile(ORG, CUST);

    expect(profile).not.toBeNull();
    expect(profile!.memberships).toEqual([]);
    expect(profile!.balanceDueCents).toBe(0);
    expect(profile!.openInvoiceCount).toBe(0);
    expect(profile!.lastServiceDate).toBeNull();
    expect(profile!.openEstimates).toEqual({ count: 0, totalCents: 0 });
    expect(profile!.recentJobs).toEqual([]);
  });
});

describe("loadCustomerProfile — not found", () => {
  it("returns null when the customer row is absent (wrong tenant reads as not found)", async () => {
    mockSelectSeq([
      [], // identity gate: no row
      [],
      [{ balanceDueCents: 0, openInvoiceCount: 0 }],
      [{ lastServiceDate: null }],
      [{ count: 0, totalCents: 0 }],
      [],
    ]);

    const profile = await loadCustomerProfile(ORG, CUST);
    expect(profile).toBeNull();
  });
});

describe("loadCustomerProfile — tenancy scoping", () => {
  it("org-scopes every one of the six reads via withTenant", async () => {
    mockSelectSeq([
      [identityRow()],
      [],
      [{ balanceDueCents: 0, openInvoiceCount: 0 }],
      [{ lastServiceDate: null }],
      [{ count: 0, totalCents: 0 }],
      [],
    ]);

    await loadCustomerProfile(ORG, CUST);

    // One withTenant call per read — all six carry the same org id, so no read
    // can span tenants.
    expect(withTenant).toHaveBeenCalledTimes(6);
    for (const call of vi.mocked(withTenant).mock.calls) {
      expect(call[1]).toBe(ORG);
    }
  });
});
