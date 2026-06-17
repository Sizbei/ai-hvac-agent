import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * exportOrganization unit tests.
 *
 * We mock @/lib/db so every select(...).from(table).where() resolves to a seeded
 * row set keyed by table name, and crypto.decrypt to a deterministic unwrap. The
 * assertions focus on the contract that matters for safety:
 *  - PII is DECRYPTED in the output (it's the data subject's own data),
 *  - SECRETS + hashes are NEVER present (portalTokenHash, emailHash, phoneHash),
 *  - money stays in integer cents.
 */

const { tableForSelect, rowsByTable } = vi.hoisted(() => {
  const rowsByTable: Record<string, unknown[]> = {};
  // Each from() captures which table is being queried via its __name marker.
  const tableForSelect = { current: "" };
  return { tableForSelect, rowsByTable };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (t: { __name?: string }) => {
        const name = t?.__name ?? "unknown";
        return { where: () => Promise.resolve(rowsByTable[name] ?? []) };
      },
    }),
    insert: () => ({ values: () => Promise.resolve() }),
  },
}));

vi.mock("@/lib/db/schema", () => {
  const t = (name: string) =>
    new Proxy({ __name: name } as Record<string, unknown>, {
      get: (target, prop) =>
        prop in target ? target[prop as string] : `${name}.${String(prop)}`,
    });
  return {
    organizations: t("organizations"),
    customers: t("customers"),
    customerLocations: t("customerLocations"),
    serviceRequests: t("serviceRequests"),
    estimates: t("estimates"),
    estimateOptions: t("estimateOptions"),
    estimateLineItems: t("estimateLineItems"),
    invoices: t("invoices"),
    invoiceLineItems: t("invoiceLineItems"),
    payments: t("payments"),
    refunds: t("refunds"),
    financingApplications: t("financingApplications"),
    customerEquipment: t("customerEquipment"),
    serviceHistory: t("serviceHistory"),
    customerMemberships: t("customerMemberships"),
    membershipVisits: t("membershipVisits"),
    messages: t("messages"),
    platformAuditLog: t("platformAuditLog"),
  };
});

vi.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => a }));

vi.mock("@/lib/crypto", () => ({
  // Strip the ENC() wrapper our fixtures use; throw on a "corrupt" value.
  decrypt: (s: string) => {
    const m = /^ENC\((.*)\)$/.exec(s);
    if (!m) throw new Error("bad ciphertext");
    return m[1];
  },
}));

vi.mock("server-only", () => ({}));

import { exportOrganization, exportCounts } from "./export-queries";

const ORG = "org-1";

beforeEach(() => {
  for (const k of Object.keys(rowsByTable)) delete rowsByTable[k];
  void tableForSelect;
});

describe("exportOrganization", () => {
  it("returns null when the org does not exist", async () => {
    // organizations select resolves to [] -> null
    const r = await exportOrganization(ORG);
    expect(r).toBeNull();
  });

  it("decrypts customer PII and EXCLUDES the blind-index + portal token hashes", async () => {
    rowsByTable.organizations = [
      { id: ORG, name: "Acme", slug: "acme", status: "active", plan: null, createdAt: new Date() },
    ];
    rowsByTable.customers = [
      {
        id: "c1",
        nameEncrypted: "ENC(Jane Doe)",
        phoneEncrypted: "ENC(555-1212)",
        emailEncrypted: "ENC(jane@x.com)",
        addressEncrypted: "ENC(1 Main St)",
        emailHash: "HASH_EMAIL",
        phoneHash: "HASH_PHONE",
        portalTokenHash: "TOKENHASH",
        propertyType: "residential",
        propertySqft: 1800,
        notes: "vip",
        customerType: "residential",
        membershipStatus: "none",
        doNotService: false,
        anonymizedAt: null,
        archivedAt: null,
        createdAt: new Date(),
      },
    ];

    const result = (await exportOrganization(ORG)) as Record<string, unknown>;
    const customers = result.customers as Record<string, unknown>[];
    expect(customers[0]!.name).toBe("Jane Doe");
    expect(customers[0]!.email).toBe("jane@x.com");
    expect(customers[0]!.phone).toBe("555-1212");
    expect(customers[0]!.address).toBe("1 Main St");

    // Hashes + portal token MUST NOT be present anywhere in the customer object.
    const serialized = JSON.stringify(customers[0]);
    expect(serialized).not.toContain("HASH_EMAIL");
    expect(serialized).not.toContain("HASH_PHONE");
    expect(serialized).not.toContain("TOKENHASH");
    expect(customers[0]).not.toHaveProperty("emailHash");
    expect(customers[0]).not.toHaveProperty("phoneHash");
    expect(customers[0]).not.toHaveProperty("portalTokenHash");
  });

  it("keeps money in integer cents and includes financial tables", async () => {
    rowsByTable.organizations = [
      { id: ORG, name: "Acme", slug: "acme", status: "active", plan: null, createdAt: new Date() },
    ];
    rowsByTable.invoices = [{ id: "i1", totalCents: 19999, amountPaidCents: 0 }];
    rowsByTable.payments = [{ id: "p1", amountCents: 19999 }];

    const result = (await exportOrganization(ORG)) as Record<string, unknown>;
    const invoices = result.invoices as Record<string, unknown>[];
    const payments = result.payments as Record<string, unknown>[];
    expect(invoices[0]!.totalCents).toBe(19999);
    expect(payments[0]!.amountCents).toBe(19999);
  });

  it("never throws on a corrupt ciphertext (safeDecrypt -> null)", async () => {
    rowsByTable.organizations = [
      { id: ORG, name: "Acme", slug: "acme", status: "active", plan: null, createdAt: new Date() },
    ];
    rowsByTable.customers = [
      {
        id: "c1",
        nameEncrypted: "not-encrypted",
        phoneEncrypted: null,
        emailEncrypted: null,
        addressEncrypted: null,
        emailHash: null,
        phoneHash: null,
        portalTokenHash: null,
        propertyType: null,
        propertySqft: null,
        notes: null,
        customerType: "residential",
        membershipStatus: "none",
        doNotService: false,
        anonymizedAt: null,
        archivedAt: null,
        createdAt: new Date(),
      },
    ];

    const result = (await exportOrganization(ORG)) as Record<string, unknown>;
    const customers = result.customers as Record<string, unknown>[];
    expect(customers[0]!.name).toBeNull();
  });
});

describe("exportCounts", () => {
  it("returns a per-array count and ignores non-array fields", () => {
    const counts = exportCounts({
      organization: { id: "x" },
      customers: [{}, {}],
      invoices: [{}],
      exportedAt: "2026-01-01",
    });
    expect(counts).toEqual({ customers: 2, invoices: 1 });
  });
});
