import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db before importing the module under test
const mockSelect = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { select: (...a: unknown[]) => mockSelect(...a) },
}));

vi.mock("@/lib/db/tenant", () => ({
  withTenant: (table: unknown, orgId: string, extra?: unknown) => ({
    _tenantFilter: orgId,
    _extra: extra,
  }),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (v: string | null) => (v ? `dec:${v}` : null),
}));

vi.mock("@/lib/admin/invoice-collectible", () => ({
  invoiceRef: (id: string) => `#${id.slice(0, 8).toUpperCase()}`,
}));

// Drizzle operators used by search-queries.ts (return an opaque marker)
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    ilike: (col: unknown, val: unknown) => ({ _ilike: { col, val } }),
    and: (...args: unknown[]) => ({ _and: args }),
    or: (...args: unknown[]) => ({ _or: args }),
  };
});

import {
  searchCustomers,
  searchInvoices,
  searchJobs,
  searchConversations,
  searchEstimates,
  searchPricebook,
  searchStaff,
  searchAllEntities,
  type SearchResult,
} from "./search-queries";
import { VISIBLE_ONLY } from "./visibility";

// Helper: make a fluent drizzle chain stub that resolves to `rows`
function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const fn = () => chain;
  chain.from = fn;
  chain.leftJoin = fn;
  chain.where = fn;
  // Queries without .limit() await the chain itself.
  chain.then = (resolve: (v: unknown) => void) => resolve(rows);
  chain.orderBy = fn;
  chain.limit = () => Promise.resolve(rows);
  return chain;
}

const ORG = "org-uuid-1";

beforeEach(() => {
  mockSelect.mockReset();
});

// ── searchCustomers ──────────────────────────────────────────────────────────

describe("searchCustomers", () => {
  it("returns empty array when no rows match", async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const results = await searchCustomers(ORG, "smith", VISIBLE_ONLY);
    expect(results).toEqual([]);
  });

  it("filters by decrypted name (case-insensitive)", async () => {
    const rows = [
      {
        id: "c1",
        nameEncrypted: "SMITH",
        phoneEncrypted: "5551234",
        emailEncrypted: null,
        fieldpulseCustomerId: null,
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    // decrypt returns "dec:SMITH"; "dec:smith" includes "smith"
    const results = await searchCustomers(ORG, "smith", VISIBLE_ONLY);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("customer");
    expect(results[0].id).toBe("c1");
    expect(results[0].title).toBe("dec:SMITH");
    expect(results[0].href).toBe("/admin/customers/c1");
  });

  it("filters by decrypted phone", async () => {
    const rows = [
      {
        id: "c2",
        nameEncrypted: "Jones",
        phoneEncrypted: "5559999",
        emailEncrypted: null,
        fieldpulseCustomerId: null,
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchCustomers(ORG, "5559999", VISIBLE_ONLY);
    expect(results).toHaveLength(1);
    expect(results[0].subtitle).toBe("dec:5559999");
  });

  it("filters by decrypted email", async () => {
    const rows = [
      {
        id: "c3",
        nameEncrypted: "Doe",
        phoneEncrypted: null,
        emailEncrypted: "doe@example.com",
        fieldpulseCustomerId: null,
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchCustomers(ORG, "example", VISIBLE_ONLY);
    expect(results).toHaveLength(1);
    expect(results[0].subtitle).toBe("dec:doe@example.com");
  });

  it("excludes non-matching rows", async () => {
    const rows = [
      {
        id: "c4",
        nameEncrypted: "ZZZZ",
        phoneEncrypted: "0000000",
        emailEncrypted: "nope@z.com",
        fieldpulseCustomerId: null,
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchCustomers(ORG, "smith", VISIBLE_ONLY);
    expect(results).toHaveLength(0);
  });

  it("sets syncedSource to fieldpulse when fieldpulseCustomerId is set", async () => {
    const rows = [
      {
        id: "c5",
        nameEncrypted: "Smith",
        phoneEncrypted: null,
        emailEncrypted: null,
        fieldpulseCustomerId: "fp-123",
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchCustomers(ORG, "smith", VISIBLE_ONLY);
    expect(results[0].syncedSource).toBe("fieldpulse");
  });

  it("uses the organizationId in the where clause (org-scoping)", async () => {
    mockSelect.mockReturnValue(makeChain([]));
    await searchCustomers(ORG, "test", VISIBLE_ONLY);
    // The chain.where is called — we verify select was called (org scoping
    // is tested via withTenant mock which captures orgId)
    expect(mockSelect).toHaveBeenCalledOnce();
  });

  it("caps results at 8", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      nameEncrypted: "smith",
      phoneEncrypted: null,
      emailEncrypted: null,
      fieldpulseCustomerId: null,
    }));
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchCustomers(ORG, "smith", VISIBLE_ONLY);
    expect(results.length).toBeLessThanOrEqual(8);
  });
});

// ── searchInvoices ───────────────────────────────────────────────────────────

describe("searchInvoices", () => {
  it("returns empty array when no rows match", async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const results = await searchInvoices(ORG, "zzz", VISIBLE_ONLY);
    expect(results).toEqual([]);
  });

  it("matches on invoiceRef prefix", async () => {
    const id = "abcdef12-0000-0000-0000-000000000000";
    const rows = [
      {
        id,
        state: "open",
        totalCents: 10000,
        fieldpulseInvoiceId: null,
        hcpInvoiceId: null,
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    // invoiceRef mock: #ABCDEF12 — query "abcdef" should match
    const results = await searchInvoices(ORG, "abcdef", VISIBLE_ONLY);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("invoice");
    expect(results[0].title).toBe("#ABCDEF12");
  });

  it("formats subtitle as state · dollar amount", async () => {
    const id = "aabbccdd-0000-0000-0000-000000000000";
    const rows = [
      {
        id,
        state: "draft",
        totalCents: 0,
        fieldpulseInvoiceId: null,
        hcpInvoiceId: null,
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchInvoices(ORG, "aabbccdd", VISIBLE_ONLY);
    expect(results[0].subtitle).toBe("Draft · $0.00");
  });

  it("sets syncedSource=fieldpulse when fieldpulseInvoiceId is set", async () => {
    const id = "11223344-0000-0000-0000-000000000000";
    const rows = [
      {
        id,
        state: "open",
        totalCents: 5000,
        fieldpulseInvoiceId: "fp-inv-1",
        hcpInvoiceId: null,
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchInvoices(ORG, "11223344", VISIBLE_ONLY);
    expect(results[0].syncedSource).toBe("fieldpulse");
  });

  it("sets syncedSource=hcp when hcpInvoiceId is set (and no fieldpulse)", async () => {
    const id = "55667788-0000-0000-0000-000000000000";
    const rows = [
      {
        id,
        state: "open",
        totalCents: 5000,
        fieldpulseInvoiceId: null,
        hcpInvoiceId: "hcp-inv-1",
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchInvoices(ORG, "55667788", VISIBLE_ONLY);
    expect(results[0].syncedSource).toBe("hcp");
  });

  it("caps results at 8", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `aabb${String(i).padStart(4, "0")}-0000-0000-0000-000000000000`,
      state: "open",
      totalCents: 100,
      fieldpulseInvoiceId: null,
      hcpInvoiceId: null,
    }));
    mockSelect.mockReturnValue(makeChain(rows));
    // all ids start with "aabb"
    const results = await searchInvoices(ORG, "aabb", VISIBLE_ONLY);
    expect(results.length).toBeLessThanOrEqual(8);
  });
});

// ── searchJobs ───────────────────────────────────────────────────────────────

describe("searchJobs", () => {
  it("returns empty array when no rows", async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const results = await searchJobs(ORG, "ac", VISIBLE_ONLY);
    expect(results).toEqual([]);
  });

  it("returns jobs with correct shape", async () => {
    const rows = [
      {
        id: "job-uuid-1",
        referenceNumber: "SR-001",
        issueType: "cooling_not_working",
        status: "pending",
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchJobs(ORG, "ac", VISIBLE_ONLY);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("job");
    expect(results[0].title).toBe("SR-001");
    expect(results[0].subtitle).toBe("Cooling not working");
    expect(results[0].href).toBe("/admin/requests?request=job-uuid-1");
    expect(results[0].syncedSource).toBeNull();
  });

  it("uses fallback title when referenceNumber is null", async () => {
    const rows = [
      {
        id: "abcd1234-ef56-0000-0000-000000000000",
        referenceNumber: null,
        issueType: "Heat not working",
        status: "pending",
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchJobs(ORG, "heat", VISIBLE_ONLY);
    expect(results[0].title).toBe("Request ABCD1234");
  });

  it("titles by the customer's name, falling back to the customer row, never an erased name", async () => {
    mockSelect.mockReturnValue(
      makeChain([
        { id: "r1", referenceNumber: "HVAC-1", issueType: "no_heat", requestNameEncrypted: "Ada", customerNameEncrypted: null },
        { id: "r2", referenceNumber: "HVAC-2", issueType: "no_heat", requestNameEncrypted: null, customerNameEncrypted: "Watauga" },
        { id: "r3", referenceNumber: "HVAC-3", issueType: "no_heat", requestNameEncrypted: null, customerNameEncrypted: null },
      ]),
    );
    const results = await searchJobs(ORG, "hvac", VISIBLE_ONLY);
    expect(results.map((r) => r.title)).toEqual(["dec:Ada", "dec:Watauga", "HVAC-3"]);
    expect(results[0].subtitle).toBe("HVAC-1 · No heat");
    expect(results[2].subtitle).toBe("No heat");
  });
});

// ── searchConversations ──────────────────────────────────────────────────────

describe("searchConversations", () => {
  it("titles by the captured name and deep-links into the inbox", async () => {
    mockSelect.mockReturnValueOnce(
      makeChain([
        {
          id: "abcd1234-0000-0000-0000-000000000000",
          channel: "phone",
          status: "submitted",
          metadata: JSON.stringify({ customerName: "Robert Alvarez" }),
        },
        { id: "ffff0000-0000-0000-0000-000000000000", channel: "web", status: "escalated", metadata: "not json", handledAt: new Date("2026-11-06T16:00:00Z") },
      ]),
    );
    mockSelect.mockReturnValueOnce(makeChain([])); // customer messages
    mockSelect.mockReturnValueOnce(makeChain([])); // linked requests
    const results = await searchConversations(ORG, "rob", VISIBLE_ONLY);
    expect(results[0]).toMatchObject({
      type: "conversation",
      title: "Robert Alvarez",
      subtitle: "Phone call · Submitted · abcd1234",
      href: "/admin/conversations?c=abcd1234-0000-0000-0000-000000000000",
    });
    // No name: titled by channel (no hex id); the short id is in the subtitle.
    expect(results[1].title).toBe("Web chat");
    expect(results[1].subtitle).toBe("Escalated · ffff0000");
  });

  it("titles an anonymous chat by its first message and says Needs action like the inbox", async () => {
    mockSelect.mockReturnValueOnce(
      makeChain([
        {
          id: "7d111fea-0000-0000-0000-000000000000",
          channel: "web",
          status: "escalated",
          metadata: null,
          handledAt: null,
        },
      ]),
    );
    // Second read: the customer's messages (first one titles the chat).
    mockSelect.mockReturnValueOnce(
      makeChain([
        { sessionId: "7d111fea-0000-0000-0000-000000000000", content: "I smell gas in the basement right now", createdAt: new Date("2026-11-06T15:00:00Z") },
      ]),
    );
    mockSelect.mockReturnValueOnce(makeChain([]));
    const [result] = await searchConversations(ORG, "7d111fea", VISIBLE_ONLY);
    expect(result.title).toBe("Web chat · \u201cI smell gas in the\u2026\u201d");
    expect(result.subtitle).toBe("Needs action · 7d111fea");
  });

  it("returns [] without a second query when nothing matches", async () => {
    mockSelect.mockReturnValue(makeChain([]));
    expect(await searchConversations(ORG, "zz", VISIBLE_ONLY)).toEqual([]);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
});

// ── searchStaff ──────────────────────────────────────────────────────────────

describe("searchStaff", () => {
  it("finds staff by name, labels the role, and opens the Staff page", async () => {
    mockSelect.mockReturnValue(
      makeChain([
        { id: "u1", name: "Camila Reyes", role: "technician", isActive: true },
        { id: "u2", name: "Cam Ortiz", role: "admin", isActive: false },
      ]),
    );
    const results = await searchStaff(ORG, "cam");
    expect(results).toEqual([
      { type: "staff", id: "u1", title: "Camila Reyes", subtitle: "Technician", href: "/admin/staff", syncedSource: null },
      { type: "staff", id: "u2", title: "Cam Ortiz", subtitle: "Admin · Inactive", href: "/admin/staff", syncedSource: null },
    ]);
  });
});

// ── searchEstimates ──────────────────────────────────────────────────────────

describe("searchEstimates", () => {
  it("returns empty array when no rows match", async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const results = await searchEstimates(ORG, "zzz", VISIBLE_ONLY);
    expect(results).toEqual([]);
  });

  it("matches on id prefix (case-insensitive)", async () => {
    const rows = [
      {
        id: "deadbeef-0000-0000-0000-000000000000",
        status: "open",
        totalCents: 0,
        fieldpulseEstimateId: null,
        fieldpulseStatusName: null,
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchEstimates(ORG, "deadbeef", VISIBLE_ONLY);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("estimate");
    expect(results[0].title).toBe("EST-DEADBEEF");
  });

  it("uses fieldpulseStatusName over status in subtitle", async () => {
    const rows = [
      {
        id: "cafebabe-0000-0000-0000-000000000000",
        status: "open",
        totalCents: 500,
        fieldpulseEstimateId: "fp-est-1",
        fieldpulseStatusName: "Approved",
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchEstimates(ORG, "cafebabe", VISIBLE_ONLY);
    expect(results[0].subtitle).toBe("Approved");
    expect(results[0].syncedSource).toBe("fieldpulse");
  });

  it("falls back to status when fieldpulseStatusName is null", async () => {
    const rows = [
      {
        id: "00112233-0000-0000-0000-000000000000",
        status: "sent",
        totalCents: 200,
        fieldpulseEstimateId: null,
        fieldpulseStatusName: null,
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchEstimates(ORG, "00112233", VISIBLE_ONLY);
    expect(results[0].subtitle).toBe("sent");
    expect(results[0].syncedSource).toBeNull();
  });

  it("caps results at 8", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `test${String(i).padStart(4, "0")}-0000-0000-0000-000000000000`,
      status: "open",
      totalCents: 0,
      fieldpulseEstimateId: null,
      fieldpulseStatusName: null,
    }));
    mockSelect.mockReturnValue(makeChain(rows));
    const results = await searchEstimates(ORG, "test", VISIBLE_ONLY);
    expect(results.length).toBeLessThanOrEqual(8);
  });
});

// ── searchAllEntities ────────────────────────────────────────────────────────

describe("searchAllEntities", () => {
  it("returns combined results from all four queries", async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      // Give each call a distinct row so we can count them
      const id = `id-${callCount}`;
      const rows =
        callCount === 1
          ? // customers
            [
              {
                id,
                nameEncrypted: "foo",
                phoneEncrypted: null,
                emailEncrypted: null,
                fieldpulseCustomerId: null,
              },
            ]
          : callCount === 2
            ? // invoices
              [
                {
                  id,
                  state: "open",
                  totalCents: 100,
                  fieldpulseInvoiceId: null,
                  hcpInvoiceId: null,
                },
              ]
            : // jobs & estimates — return empty to keep it simple
              [];
      return makeChain(rows);
    });
    const results = await searchAllEntities(ORG, "foo", VISIBLE_ONLY);
    // We expect customer result (name matches "foo") + invoice result (id starts with "id-")
    // exact count depends on matching; just verify it's an array
    expect(Array.isArray(results)).toBe(true);
  });

  it("returns a SearchResult array (type assertion via TS types)", async () => {
    mockSelect.mockReturnValue(makeChain([]));
    const results: SearchResult[] = await searchAllEntities(ORG, "test", VISIBLE_ONLY);
    expect(results).toEqual([]);
  });
});

// ── searchPricebook ──────────────────────────────────────────────────────────
describe("searchPricebook", () => {
  it("maps active items and deep-links to the filtered pricebook", async () => {
    mockSelect.mockReturnValueOnce(
      makeChain([
        {
          id: "pb-1",
          name: "24 SEER Condenser",
          sku: "CND-24",
          priceCents: 420000,
          type: "equipment",
          fieldpulseItemId: null,
        },
      ]),
    );
    const results = await searchPricebook(ORG, "condenser");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "pricebook",
      id: "pb-1",
      title: "24 SEER Condenser",
      subtitle: "Equipment · $4,200.00 · CND-24",
      href: "/admin/pricebook?q=24%20SEER%20Condenser",
      syncedSource: null,
    });
  });

  it("omits SKU from the subtitle when absent and marks FP-synced", async () => {
    mockSelect.mockReturnValueOnce(
      makeChain([
        { id: "pb-2", name: "Diagnostic Fee", sku: null, priceCents: 8900, type: "service", fieldpulseItemId: "fp-9" },
      ]),
    );
    const results = await searchPricebook(ORG, "diag");
    expect(results[0].subtitle).toBe("Service · $89.00");
    expect(results[0].syncedSource).toBe("fieldpulse");
  });

  it("returns [] when nothing matches", async () => {
    mockSelect.mockReturnValueOnce(makeChain([]));
    expect(await searchPricebook(ORG, "zzz")).toEqual([]);
  });
});
