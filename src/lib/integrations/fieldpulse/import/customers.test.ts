/**
 * Tests for Phase 3 — FieldPulse customers inbound pull.
 *
 * Covers:
 *  - mapFpCustomer: all skip-classifications, name resolution priority,
 *    phone preference (phoneE164 > phone), address composition.
 *  - importCustomersFromFieldpulse: path (a) fpId-guarded update, path (b)
 *    upsertCustomerByContact + fpId stamp + guard, path (c) contactless insert,
 *    per-record error containment, partial-walk warning.
 *
 * Uses the sanitized fixture at fixtures/fp-customers-page1-sanitized.json
 * (FAKE PII only — no real customer data).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mapFpCustomer, importCustomersFromFieldpulse, importOneFpCustomer, mapAccountType, makeFpCustomerHealer } from "./customers";
import type { FieldpulseCustomer } from "../types";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));
vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((v: string) => `enc(${v})`),
  blindIndex: vi.fn((v: string) => `blind(${v})`),
}));
vi.mock("@/lib/ai/sanitize-fields", () => ({
  sanitizeName: vi.fn((v: string) => v),
  sanitizePhone: vi.fn((v: string) => v),
  sanitizeEmail: vi.fn((v: string) => v),
  sanitizeAddress: vi.fn((v: string) => v),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/admin/crm-queries", () => ({
  upsertCustomerByContact: vi.fn(),
  normalizeEmail: vi.fn((v: string | null) =>
    v ? v.trim().toLowerCase() : null,
  ),
  normalizePhone: vi.fn((v: string | null) =>
    v ? v.replace(/\D/g, "") : null,
  ),
  computeContactHashes: vi.fn(({ email, phone }: { email: string | null; phone: string | null }) => ({
    emailHash: email ? 'h:' + email : null,
    phoneHash: phone ? 'h:' + phone : null,
  })),
}));

import { db } from "@/lib/db";
import { upsertCustomerByContact } from "@/lib/admin/crm-queries";
import { logger } from "@/lib/logger";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeCustomer(
  overrides: Partial<FieldpulseCustomer> = {},
): FieldpulseCustomer {
  return {
    id: "10001001",
    displayName: "Test User",
    firstName: "Test",
    lastName: "User",
    company: null,
    email: "test@example.invalid",
    phone: "555-010-9999",
    phoneE164: "+15550109999",
    address: {
      street: "1 Test St",
      streetLine2: null,
      city: "Testville",
      state: "TN",
      zip: "37000",
    },
    deletedAt: null,
    mergedCustomerId: null,
    ...overrides,
  };
}

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

// ── mapAccountType unit tests ─────────────────────────────────────────────────

describe("mapAccountType", () => {
  it("maps 'residential' → 'residential'", () => {
    expect(mapAccountType("residential")).toBe("residential");
  });
  it("maps 'commercial' → 'commercial'", () => {
    expect(mapAccountType("commercial")).toBe("commercial");
  });
  it("is case-insensitive for known values", () => {
    expect(mapAccountType("Residential")).toBe("residential");
    expect(mapAccountType("COMMERCIAL")).toBe("commercial");
  });
  it("maps null → null", () => {
    expect(mapAccountType(null)).toBeNull();
  });
  it("maps empty string → null", () => {
    expect(mapAccountType("")).toBeNull();
  });
  it("maps unknown value → null (safe default)", () => {
    expect(mapAccountType("industrial")).toBeNull();
    expect(mapAccountType("business")).toBeNull();
  });
});

// ── mapFpCustomer: P1 field-parity additions ──────────────────────────────────

describe("mapFpCustomer P1 field-parity", () => {
  it("populates customerType='residential' when accountType matches", () => {
    const result = mapFpCustomer(
      makeCustomer({ accountType: "residential" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.customerType).toBe("residential");
  });

  it("populates customerType='commercial' when accountType matches", () => {
    const result = mapFpCustomer(
      makeCustomer({ accountType: "commercial" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.customerType).toBe("commercial");
  });

  it("customerType=null when accountType is absent (no default overwrite)", () => {
    const result = mapFpCustomer(makeCustomer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.customerType).toBeNull();
  });

  it("customerType=null for unknown account_type (safe default)", () => {
    const result = mapFpCustomer(
      makeCustomer({ accountType: "industrial" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.customerType).toBeNull();
  });

  it("isTaxExempt=true passthrough", () => {
    const result = mapFpCustomer(makeCustomer({ isTaxExempt: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.isTaxExempt).toBe(true);
  });

  it("isTaxExempt=false passthrough", () => {
    const result = mapFpCustomer(makeCustomer({ isTaxExempt: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.isTaxExempt).toBe(false);
  });

  it("isTaxExempt=null when absent", () => {
    const result = mapFpCustomer(makeCustomer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.isTaxExempt).toBeNull();
  });

  it("billingAddress composed when billingAddress is present on fp object", () => {
    const result = mapFpCustomer(
      makeCustomer({
        billingAddress: {
          street: "200 Billing Ave",
          streetLine2: null,
          city: "Billington",
          state: "TN",
          zip: "37001",
          country: null,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.billingAddress).toBe("200 Billing Ave, Billington, TN 37001");
  });

  it("billingAddress=null when fp.billingAddress is null", () => {
    const result = mapFpCustomer(makeCustomer({ billingAddress: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.billingAddress).toBeNull();
  });

  it("billingAddress=null when fp.billingAddress is absent", () => {
    const result = mapFpCustomer(makeCustomer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.billingAddress).toBeNull();
  });
});

// ── mapFpCustomer tests ───────────────────────────────────────────────────────

describe("mapFpCustomer", () => {
  it("maps a full-contact record correctly", () => {
    const result = mapFpCustomer(makeCustomer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.fpId).toBe("10001001");
    expect(result.customer.name).toBe("Test User");
    // phone: normalizePhone("+15550109999") → digits only = "15550109999"
    expect(result.customer.phone).toBe("15550109999");
    expect(result.customer.email).toBe("test@example.invalid");
    expect(result.customer.address).toBe("1 Test St, Testville, TN 37000");
  });

  it("prefers phoneE164 over phone", () => {
    const result = mapFpCustomer(
      makeCustomer({ phoneE164: "+15550100001", phone: "555-010-9999" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // normalizePhone("+15550100001") → "15550100001"
    expect(result.customer.phone).toBe("15550100001");
  });

  it("falls back to phone when phoneE164 is null", () => {
    const result = mapFpCustomer(
      makeCustomer({ phoneE164: null, phone: "555-010-0002" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // normalizePhone("555-010-0002") → "5550100002"
    expect(result.customer.phone).toBe("5550100002");
  });

  it("email-only record: phone is null", () => {
    const result = mapFpCustomer(
      makeCustomer({ phoneE164: null, phone: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.phone).toBeNull();
    expect(result.customer.email).toBe("test@example.invalid");
  });

  it("phone-only record: email is null", () => {
    const result = mapFpCustomer(makeCustomer({ email: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.email).toBeNull();
    expect(result.customer.phone).toBe("15550109999");
  });

  it("contactless record: both email and phone are null", () => {
    const result = mapFpCustomer(
      makeCustomer({ email: null, phoneE164: null, phone: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.email).toBeNull();
    expect(result.customer.phone).toBeNull();
  });

  it("maps deleted record as archivedImport=true", () => {
    const result = mapFpCustomer(
      makeCustomer({ deletedAt: "2026-02-01 09:00:00" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archivedImport).toBe(true);
    expect(result.customer.fpId).toBe("10001001");
  });

  it("maps merged record as archivedImport=true", () => {
    const result = mapFpCustomer(
      makeCustomer({ mergedCustomerId: "10001001" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archivedImport).toBe(true);
  });

  it("maps active record as archivedImport=false", () => {
    const result = mapFpCustomer(makeCustomer());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archivedImport).toBe(false);
  });

  it("skips records with no name at all", () => {
    const result = mapFpCustomer(
      makeCustomer({
        displayName: null,
        firstName: null,
        lastName: null,
        company: null,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unnamed");
  });

  it("falls back to first+last when displayName is absent", () => {
    const result = mapFpCustomer(
      makeCustomer({ displayName: null, firstName: "Jane", lastName: "Doe" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.name).toBe("Jane Doe");
  });

  it("falls back to company when displayName and first/last are absent", () => {
    const result = mapFpCustomer(
      makeCustomer({
        displayName: null,
        firstName: null,
        lastName: null,
        company: "Widgets LLC",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.name).toBe("Widgets LLC");
  });

  it("omits address parts that are blank", () => {
    const result = mapFpCustomer(
      makeCustomer({
        address: { street: "1 Test St", city: null, state: null, zip: null },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.address).toBe("1 Test St");
  });

  it("returns null address when all address parts are absent", () => {
    const result = mapFpCustomer(
      makeCustomer({
        address: { street: null, city: null, state: null, zip: null },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.address).toBeNull();
  });

  it("returns null address when address is null", () => {
    const result = mapFpCustomer(makeCustomer({ address: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.address).toBeNull();
  });

  // ── customFields passthrough ──────────────────────────────────────────────

  it("passes through customFields when present", () => {
    const result = mapFpCustomer(
      makeCustomer({ customFields: [{ name: "Source", value: "Google" }] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.customFields).toEqual([{ name: "Source", value: "Google" }]);
  });

  it("returns null customFields when fp.customFields is null", () => {
    const result = mapFpCustomer(makeCustomer({ customFields: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.customFields).toBeNull();
  });

  it("returns null customFields when fp.customFields is absent (undefined)", () => {
    const { customFields: _drop, ...base } = makeCustomer();
    const result = mapFpCustomer(base as FieldpulseCustomer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.customFields).toBeNull();
  });

  it("lead_source present → appears as { name: 'Lead Source', value } in customFields", () => {
    const result = mapFpCustomer(
      makeCustomer({ leadSource: "Yelp", customFields: null }),
    );
    // NOTE: lead_source folding is done in toCustomer (client.ts), so at this
    // mapper level `fp.customFields` already contains the synthetic entry when
    // the raw API is the source. Here we test the passthrough: if the
    // FieldpulseCustomer already has the synthetic entry, it flows through.
    const result2 = mapFpCustomer(
      makeCustomer({
        customFields: [{ name: "Lead Source", value: "Yelp" }],
      }),
    );
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.customer.customFields).toEqual([
      { name: "Lead Source", value: "Yelp" },
    ]);
    // Also verify a non-null leadSource alone (no customFields) still passes null
    // because folding happens upstream in toCustomer, not in mapFpCustomer.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.customer.customFields).toBeNull();
  });
});

// ── importCustomersFromFieldpulse tests ──────────────────────────────────────

/**
 * Wire the chainable Drizzle mock for a SELECT query on customers.
 * Returns a factory for the promise at the end of the chain.
 */
function wireSelect(resolveWith: unknown[]) {
  const limit = vi.fn().mockResolvedValue(resolveWith);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
  return { from, where, limit };
}

function wireUpdate(resolveWith: unknown[] = [{ id: "cust-1" }]) {
  const returning = vi.fn().mockResolvedValue(resolveWith);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set, where, returning };
}

function wireInsert(resolveWith: unknown[] = [{ id: "cust-1" }]) {
  const returning = vi.fn().mockResolvedValue(resolveWith);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { values, onConflictDoNothing, returning };
}

function makeClient(
  customers: FieldpulseCustomer[],
  totalCount: number | null = customers.length,
): FieldpulseClient {
  return {
    listCustomers: vi.fn().mockResolvedValue({ items: customers, totalCount }),
  } as unknown as FieldpulseClient;
}

const ORG = "org-test-uuid";

describe("importCustomersFromFieldpulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("path (d): imports deleted record as archived (NOT skipped)", async () => {
    const fp = makeCustomer({ deletedAt: "2026-01-01 00:00:00" });
    const client = makeClient([fp]);
    const counts = makeCounts();

    // No existing fpId row.
    wireSelect([]);
    const { values } = wireInsert([{ id: "archived-id" }]);

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(counts.fetched).toBe(1);
    expect(counts.created).toBe(1);
    expect(counts.skipped).toBe(0);
    // Must use INSERT path, NOT upsertCustomerByContact.
    expect(upsertCustomerByContact).not.toHaveBeenCalled();
    // Must have archivedAt set.
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ archivedAt: expect.any(Date) }),
    );
  });

  it("path (d): imports merged record as archived", async () => {
    const fp = makeCustomer({ mergedCustomerId: "99999" });
    const client = makeClient([fp]);
    const counts = makeCounts();

    wireSelect([]);
    const { values } = wireInsert([{ id: "archived-merged-id" }]);

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(upsertCustomerByContact).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ archivedAt: expect.any(Date) }),
    );
  });

  it("path (d): counts skipped when archived insert is a re-run no-op", async () => {
    const fp = makeCustomer({ deletedAt: "2026-01-01 00:00:00" });
    const client = makeClient([fp]);
    const counts = makeCounts();

    wireSelect([]);
    wireInsert([]); // onConflictDoNothing → no row

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(0);
    expect(counts.skipped).toBe(1);
  });

  it("counts skipped for unnamed records", async () => {
    const client = makeClient([
      makeCustomer({
        displayName: null,
        firstName: null,
        lastName: null,
        company: null,
      }),
    ]);
    const counts = makeCounts();
    await importCustomersFromFieldpulse(ORG, counts, client);
    expect(counts.skipped).toBe(1);
  });

  it("path (a): updates existing row when fieldpulseCustomerId matches", async () => {
    const fp = makeCustomer();
    const client = makeClient([fp]);
    const counts = makeCounts();

    // findByFpId returns an existing row.
    wireSelect([{ id: "existing-id" }]);
    const { set } = wireUpdate();

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(counts.updated).toBe(1);
    expect(counts.created).toBe(0);
    expect(set).toHaveBeenCalledTimes(1);
    // Confirm we called UPDATE, not INSERT.
    expect(db.insert).not.toHaveBeenCalled();
    // Hash assertions: makeCustomer() has email "test@example.invalid" and phone "15550109999".
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        emailHash: 'h:test@example.invalid',
        phoneHash: 'h:15550109999',
      }),
    );
  });

  it("path (b): upsertCustomerByContact + fpId stamp when email present", async () => {
    const fp = makeCustomer({ id: "10001002" });
    const client = makeClient([fp]);
    const counts = makeCounts();

    // No existing fpId row.
    wireSelect([]);
    vi.mocked(upsertCustomerByContact).mockResolvedValue("new-native-id");
    wireUpdate([{ id: "new-native-id" }]); // fpId stamp succeeds

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(upsertCustomerByContact).toHaveBeenCalledTimes(1);
    expect(counts.created).toBe(1);
    expect(counts.skipped).toBe(0);
  });

  it("path (b): guard UPDATE includes fieldpulseCustomFields", async () => {
    const fp = makeCustomer({
      id: "10001003",
      customFields: [{ name: "Lead Source", value: "Google" }],
    });
    const client = makeClient([fp]);
    const counts = makeCounts();

    wireSelect([]);
    vi.mocked(upsertCustomerByContact).mockResolvedValue("native-id-cf");
    const { set } = wireUpdate([{ id: "native-id-cf" }]);

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldpulseCustomFields: [{ name: "Lead Source", value: "Google" }],
      }),
    );
  });

  it("path (b): counts skipped when fpId stamp guard rejects (another row owns fpId)", async () => {
    const fp = makeCustomer({ id: "10001002" });
    const client = makeClient([fp]);
    const counts = makeCounts();

    wireSelect([]);
    vi.mocked(upsertCustomerByContact).mockResolvedValue("existing-native-id");
    wireUpdate([]); // guard UPDATE returns no rows → fpId already owned elsewhere

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(0);
  });

  it("path (c): inserts contactless customer keyed on fpId", async () => {
    const fp = makeCustomer({ email: null, phone: null, phoneE164: null });
    const client = makeClient([fp]);
    const counts = makeCounts();

    wireSelect([]);
    const { values } = wireInsert([{ id: "contactless-id" }]);

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(upsertCustomerByContact).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledTimes(1);
    expect(counts.created).toBe(1);
    // Hash assertions: contactless → both hashes must be null.
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        emailHash: null,
        phoneHash: null,
      }),
    );
  });

  it("path (c): counts skipped when contactless insert is a no-op (re-run)", async () => {
    const fp = makeCustomer({ email: null, phone: null, phoneE164: null });
    const client = makeClient([fp]);
    const counts = makeCounts();

    wireSelect([]);
    wireInsert([]); // onConflictDoNothing → no row returned

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(0);
  });

  it("per-record errors are contained: increments errors and continues", async () => {
    const fp1 = makeCustomer({ id: "10001001" });
    const fp2 = makeCustomer({ id: "10001002" });
    const client = makeClient([fp1, fp2]);
    const counts = makeCounts();

    // First record throws; second should still succeed.
    wireSelect([]);
    vi.mocked(upsertCustomerByContact)
      .mockRejectedValueOnce(new Error("DB explode"))
      .mockResolvedValueOnce("cust-2");
    wireUpdate([{ id: "cust-2" }]);

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(counts.errors).toBe(1);
    expect(counts.created).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("warns when fetched < totalCount (partial walk)", async () => {
    const fp = makeCustomer();
    const client = makeClient([fp], 2597);
    const counts = makeCounts();

    wireSelect([]);
    vi.mocked(upsertCustomerByContact).mockResolvedValue("cust-1");
    wireUpdate([{ id: "cust-1" }]);

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fetched: 1, totalCount: 2597 }),
      expect.stringContaining("partial walk"),
    );
  });

  it("does not warn when fetched === totalCount", async () => {
    const fp = makeCustomer();
    const client = makeClient([fp], 1); // totalCount matches items.length
    const counts = makeCounts();

    wireSelect([]);
    vi.mocked(upsertCustomerByContact).mockResolvedValue("cust-1");
    wireUpdate([{ id: "cust-1" }]);

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not warn when totalCount is null", async () => {
    const fp = makeCustomer();
    const client = makeClient([fp], null);
    const counts = makeCounts();

    wireSelect([]);
    vi.mocked(upsertCustomerByContact).mockResolvedValue("cust-1");
    wireUpdate([{ id: "cust-1" }]);

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});


// ── Spillover integration: fp._raw → importOneFpCustomer → DB write ─────────────
//
// The first test drives the REAL importer with _raw attached and asserts the
// fieldpulseData that reaches the DB write — the load-bearing wiring proof.
// (If importOneFpCustomer fed buildFpSpillover {} or a camelCase struct — the
// original P1 bug — the write would carry null and the test fails.)
// The remaining tests exercise buildFpSpillover("customers") edge cases directly.

describe("importOneFpCustomer — fieldpulseData spillover from raw payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("DB write carries allowlist-only fieldpulseData — PII keys can never reach the write", async () => {
    const fp = makeCustomer({
      _raw: {
        // ALLOWLIST keys — must survive into the write
        status: "active",
        booking_portal_consent: true,
        account_type: "residential",
        // PII keys — must be stripped before the write
        first_name: "Alice",
        last_name: "Smith",
        email: "alice@example.invalid",
        phone: "555-000-0001",
        phone_e164: "+15550000001",
        address_1: "1 Test St",
        display_name: "Alice Smith",
      },
    });

    // Path (a): existing fpId row → updateCustomerFields (db.update .set()).
    wireSelect([{ id: "cust-existing" }]);
    const { set } = wireUpdate();

    const id = await importOneFpCustomer(ORG, fp);
    expect(id).toBe("cust-existing");

    expect(set).toHaveBeenCalledTimes(1);
    const written = set.mock.calls[0][0] as Record<string, unknown>;
    // Exact equality: the write contains ONLY the allowlisted keys — zero PII.
    expect(written.fieldpulseData).toEqual({
      status: "active",
      booking_portal_consent: true,
      account_type: "residential",
    });
  });

  it("populates fieldpulseData with allowlisted fields from fp._raw", async () => {
    // Simulate the _raw object that toCustomer() would attach from the FP API.
    const raw = {
      // ALLOWLIST keys — all should survive
      status: "active",
      booking_portal_consent: true,
      is_phone_notification_subscribed: true,
      is_email_notification_subscribed: false,
      pipeline_status_updated_at: "2026-07-01 10:00:00",
      account_type: "residential",
      // PII keys — must be stripped by the strict ALLOWLIST
      first_name: "Alice",
      last_name: "Smith",
      email: "alice@example.invalid",
      phone: "555-000-0001",
      phone_e164: "+15550000001",
      address_1: "1 Test St",
      display_name: "Alice Smith",
    };

    const { buildFpSpillover } = await import("./spillover");
    const spillover = buildFpSpillover(raw, "customers");

    // Must have a result.
    expect(spillover).not.toBeNull();
    // All allowlisted populated fields survive.
    expect(spillover).toMatchObject({
      status: "active",
      booking_portal_consent: true,
      is_phone_notification_subscribed: true,
      is_email_notification_subscribed: false,
      pipeline_status_updated_at: "2026-07-01 10:00:00",
      account_type: "residential",
    });

    // PII keys must never appear.
    const piiKeys = [
      "first_name", "last_name", "email", "phone", "phone_e164",
      "address_1", "display_name",
    ];
    for (const key of piiKeys) {
      expect(spillover).not.toHaveProperty(key);
    }
  });

  it("fieldpulseData is null when _raw has no allowlisted fields (PII only)", async () => {
    const raw = {
      // Only PII — nothing should survive the strict ALLOWLIST
      first_name: "Bob",
      last_name: "Jones",
      email: "bob@example.invalid",
      address_1: "2 Test Ave",
      lead_source: "Google",
    };

    const { buildFpSpillover } = await import("./spillover");
    const spillover = buildFpSpillover(raw, "customers");
    expect(spillover).toBeNull();
  });

  it("fieldpulseData is null when fp._raw is absent (fallback to {})", async () => {
    // No _raw → importOneFpCustomer falls back to {} → all fields filtered out.
    const { buildFpSpillover } = await import("./spillover");
    const spillover = buildFpSpillover({}, "customers");
    expect(spillover).toBeNull();
  });

  it("boolean false survives (is_email_notification_subscribed=false is not empty)", async () => {
    const raw = {
      is_email_notification_subscribed: false,
    };

    const { buildFpSpillover } = await import("./spillover");
    const spillover = buildFpSpillover(raw, "customers");
    expect(spillover).not.toBeNull();
    expect(spillover?.is_email_notification_subscribed).toBe(false);
  });
});

// ── makeFpCustomerHealer ─────────────────────────────────────────────────────

/**
 * The healer exists because a strict fieldpulseCustomerId lookup misses for
 * customers merged away by contact dedupe, and every miss orphans the dependent
 * record permanently.
 *
 * Live shape (dev mirror, 2026-08-11): several sibling commercial sites of one
 * franchise share a single billing email and phone. Contact dedupe collapses
 * them onto one native row; that row already owns a different fp id, so the
 * fpId guard refuses to relink and the siblings' fp ids exist on no row at all.
 * 506 FP invoices were orphaned this way, 93 of them unpaid, holding money no
 * collections screen could route.
 *
 * The contract that matters most is what the healer must NOT do: it resolves by
 * SELECT only. The link it returns is an authorization boundary (the portal
 * mints a token from invoices.customerId), and one caller is an inbound
 * webhook — so it must never insert, un-archive, or clobber a customer, and it
 * must not match on a phone number alone.
 */
/**
 * True when a drizzle predicate contains the healer's fp-id ownership clause.
 * Matches the raw SQL fragment's own text: searching for the column name would
 * succeed regardless, because the table object referenced by any condition
 * reaches every column in the schema.
 */
function hasOwnershipClause(predicate: unknown): boolean {
  const seen = new Set<object>();
  let found = false;
  const walk = (n: unknown): void => {
    if (n == null || found) return;
    if (typeof n === "string") {
      if (n.includes("IS NULL OR")) found = true;
      return;
    }
    if (typeof n !== "object") return;
    if (seen.has(n as object)) return;
    seen.add(n as object);
    for (const v of Object.values(n as Record<string, unknown>)) walk(v);
  };
  walk(predicate);
  return found;
}

describe("makeFpCustomerHealer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function healerClient(impl: (id: string) => Promise<FieldpulseCustomer | null>) {
    const getCustomer = vi.fn(impl);
    return {
      client: { getCustomer } as unknown as Pick<FieldpulseClient, "getCustomer">,
      getCustomer,
    };
  }

  it("resolves a native row that carries no FieldPulse identity of its own", async () => {
    wireSelect([{ id: "native-row" }]);
    const { client, getCustomer } = healerClient(async () =>
      makeCustomer({ id: "17492296", email: "billing@example.invalid" }),
    );

    const healed = await makeFpCustomerHealer(ORG, client)("17492296");

    expect(getCustomer).toHaveBeenCalledWith("17492296");
    expect(healed).toBe("native-row");
  });

  it("refuses a row that already belongs to a DIFFERENT FieldPulse customer", async () => {
    // A shared email is not a shared identity. In this operator's live data a
    // single accounts-payable address covers many unrelated businesses, because
    // AP desks, warranty administrators and property managers pay on behalf of
    // multiple customers. Filing one company's invoices under another company's
    // row would also expose them in that company's portal.
    //
    // The guard lives in SQL, so the mocked db can't filter for us — assert the
    // predicate itself carries the ownership clause. Walking for the column name
    // would pass either way (the drizzle table object reaches every column), so
    // match the raw fragment's own text instead, which appears only when the
    // clause is present.
    const { where } = wireSelect([]);
    const { client } = healerClient(async () => makeCustomer({ id: "17492296" }));

    expect(await makeFpCustomerHealer(ORG, client)("17492296")).toBeNull();
    expect(where).toHaveBeenCalledTimes(1);
    expect(hasOwnershipClause(where.mock.calls[0]?.[0])).toBe(true);
  });

  it("never writes — no insert, no update, however it resolves", async () => {
    wireSelect([{ id: "native-1" }]);
    const { client } = healerClient(async () => makeCustomer());

    await makeFpCustomerHealer(ORG, client)("10001001");

    // An inbound webhook must not be able to create customers, resurrect
    // archived ones, or null out their fields.
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("refuses to match a customer that has no email — phone alone is not identity", async () => {
    wireSelect([{ id: "should-not-be-used" }]);
    const { client } = healerClient(async () =>
      makeCustomer({ email: null, phone: "555-010-9999", phoneE164: "+15550109999" }),
    );

    // A shared office line must never hand one customer another's invoices.
    expect(await makeFpCustomerHealer(ORG, client)("10001001")).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns null when no row matches", async () => {
    wireSelect([]);
    const { client } = healerClient(async () => makeCustomer());
    expect(await makeFpCustomerHealer(ORG, client)("10001001")).toBeNull();
  });

  it("caches per instance so N records sharing a customer cost one fetch", async () => {
    wireSelect([{ id: "native-1" }]);
    const { client, getCustomer } = healerClient(async () => makeCustomer());
    const heal = makeFpCustomerHealer(ORG, client);

    await heal("10001001");
    await heal("10001001");
    await heal("10001001");

    expect(getCustomer).toHaveBeenCalledTimes(1);
  });

  it("caches a 404 too — one hard-deleted id is not re-fetched per record", async () => {
    const { client, getCustomer } = healerClient(async () => null);
    const heal = makeFpCustomerHealer(ORG, client);

    expect(await heal("99999999")).toBeNull();
    expect(await heal("99999999")).toBeNull();

    expect(getCustomer).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a transient failure — a blip must not become permanent for the run", async () => {
    let calls = 0;
    const { client, getCustomer } = healerClient(async () => {
      calls++;
      if (calls === 1) throw new Error("Fieldpulse request failed: HTTP 503");
      return makeCustomer();
    });
    wireSelect([{ id: "native-1" }]);
    const heal = makeFpCustomerHealer(ORG, client);

    expect(await heal("10001001")).toBeNull();
    // Second record for the same customer must get a real answer.
    expect(await heal("10001001")).toBe("native-1");
    expect(getCustomer).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("opens a breaker after repeated failures instead of retrying into a dead API", async () => {
    const { client, getCustomer } = healerClient(async () => {
      throw new Error("Fieldpulse request failed: HTTP 503");
    });
    const heal = makeFpCustomerHealer(ORG, client);

    for (let i = 0; i < 12; i++) await heal(`id-${i}`);

    // 5 failures trip it; everything after is refused without a round-trip.
    expect(getCustomer).toHaveBeenCalledTimes(5);
    expect(logger.error).toHaveBeenCalled();
  });
});

/**
 * GDPR erasure must survive the nightly FieldPulse sweep. Anonymizing scrubs the
 * encrypted contact fields and the blind indexes but leaves fieldpulseCustomerId
 * on the row, so path (a) finds it again on the next run. Without a guard it
 * re-writes every field from FieldPulse — re-encrypting the exact PII the person
 * asked us to delete — while `anonymizedAt` stays set, so a compliance check
 * that looks for "anonymizedAt IS NOT NULL" still reports it as erased.
 */
describe("importOneFpCustomer — erasure is not undone by a re-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips an anonymized row instead of re-importing its PII", async () => {
    wireSelect([{ id: "erased-1", anonymizedAt: new Date("2026-07-01") }]);
    const counts = makeCounts();

    const id = await importOneFpCustomer(ORG, makeCustomer(), counts);

    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(counts.skipped).toBe(1);
    expect(counts.updated).toBe(0);
    // The row is still the right answer for linking — it just must not be refilled.
    expect(id).toBe("erased-1");
  });

  it("still updates a normal (non-anonymized) row", async () => {
    wireSelect([{ id: "live-1", anonymizedAt: null }]);
    wireUpdate([{ id: "live-1" }]);
    const counts = makeCounts();

    await importOneFpCustomer(ORG, makeCustomer(), counts);

    expect(db.update).toHaveBeenCalled();
    expect(counts.updated).toBe(1);
  });
});

// ── --split-shared-contacts (SPEC §2.0/§2.1) ─────────────────────────────────
//
// The customers phase runs unattended, nightly, against production. So the
// behaviour that gives every FieldPulse customer its own row — and therefore
// creates rows sharing a contact hash — is opt-in per run, and the DEFAULT is
// today's code with exactly one addition: a counter.

/**
 * A db.select() mock that answers a QUEUE of results, one per call, and
 * supports both chain shapes used by the importer: .where().limit() and
 * .where().orderBy().limit(). Records every predicate it was handed.
 */
function wireSelectQueue(results: unknown[][]) {
  const wheres: unknown[] = [];
  const queue = [...results];
  vi.mocked(db.select).mockImplementation((() => {
    const rows = queue.shift() ?? [];
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn((predicate: unknown) => {
      wheres.push(predicate);
      return { limit, orderBy };
    });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  }) as never);
  return { wheres };
}

/** True when a drizzle predicate carries the given raw SQL text. */
function predicateContains(predicate: unknown, needle: string): boolean {
  const seen = new Set<object>();
  let found = false;
  const walk = (n: unknown): void => {
    if (n == null || found) return;
    if (typeof n === "string") {
      if (n.includes(needle)) found = true;
      return;
    }
    if (typeof n !== "object") return;
    if (seen.has(n as object)) return;
    seen.add(n as object);
    for (const v of Object.values(n as Record<string, unknown>)) walk(v);
  };
  walk(predicate);
  return found;
}

const SPLIT = { splitSharedContacts: true } as const;

describe("importOneFpCustomer — unflagged default is today's path plus a counter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The fp-id guard's return value is a contract with the jobs phase:
   * jobs.ts:424-428 skips the WHOLE job when the customer resolves to null, so
   * a null here would silently drop jobs on every nightly run. The counter is
   * the only thing that may change on this path.
   */
  it("fp-id guard: counts sharedContactSkipped and STILL returns the resolved row id", async () => {
    wireSelect([]); // no row owns this fp id
    vi.mocked(upsertCustomerByContact).mockResolvedValue("merged-row-id");
    wireUpdate([]); // guard UPDATE matches nothing — another row owns the fp id
    const counts = makeCounts();

    const id = await importOneFpCustomer(ORG, makeCustomer(), counts);

    expect(id).toBe("merged-row-id");
    expect(counts.sharedContactSkipped).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(0);
  });

  it("does not count sharedContactSkipped when the fp id stamp succeeds", async () => {
    wireSelect([]);
    vi.mocked(upsertCustomerByContact).mockResolvedValue("native-id");
    wireUpdate([{ id: "native-id" }]);
    const counts = makeCounts();

    await importOneFpCustomer(ORG, makeCustomer(), counts);

    expect(counts.sharedContactSkipped).toBeUndefined();
    expect(counts.created).toBe(1);
  });

  it("never probes pg_indexes and keeps using upsertCustomerByContact", async () => {
    const client = makeClient([makeCustomer()]);
    const counts = makeCounts();
    wireSelect([]);
    vi.mocked(upsertCustomerByContact).mockResolvedValue("native-id");
    wireUpdate([{ id: "native-id" }]);

    await importCustomersFromFieldpulse(ORG, counts, client);

    expect(db.execute).not.toHaveBeenCalled();
    expect(upsertCustomerByContact).toHaveBeenCalledTimes(1);
  });
});

describe("importCustomersFromFieldpulse — flagged pre-flight index probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts the whole phase when a legacy contact unique is still present", async () => {
    // A throw here reaches run-import's phase handler → run 'failed', exit 1.
    // It must NOT be a per-record error, which the walk would absorb.
    vi.mocked(db.execute).mockResolvedValue([
      { indexname: "customers_org_email_hash_unique" },
    ] as never);
    const client = makeClient([makeCustomer()]);
    const counts = makeCounts();

    await expect(
      importCustomersFromFieldpulse(ORG, counts, client, SPLIT),
    ).rejects.toThrow(/split-shared-contacts refused/);

    // Nothing was fetched and nothing was written.
    expect(client.listCustomers).not.toHaveBeenCalled();
    expect(counts.errors).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("aborts on the neon-http { rows } result shape too", async () => {
    vi.mocked(db.execute).mockResolvedValue({
      rows: [{ indexname: "customers_org_phone_hash_unique" }],
    } as never);
    const client = makeClient([makeCustomer()]);

    await expect(
      importCustomersFromFieldpulse(ORG, makeCounts(), client, SPLIT),
    ).rejects.toThrow(/split-shared-contacts refused/);
  });

  it("proceeds when the probe comes back empty", async () => {
    vi.mocked(db.execute).mockResolvedValue([] as never);
    const client = makeClient([makeCustomer()]);
    const counts = makeCounts();
    wireSelectQueue([[], []]); // findByFpId miss, no claim candidate
    wireInsert([{ id: "fresh-1" }]);

    await importCustomersFromFieldpulse(ORG, counts, client, SPLIT);

    expect(counts.created).toBe(1);
    expect(counts.errors).toBe(0);
  });
});

describe("importOneFpCustomer — flagged split resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims the oldest live native row on an email match, without upsertCustomerByContact", async () => {
    wireSelectQueue([[], [{ id: "native-1", fieldpulseCustomerId: null }]]);
    const { set } = wireUpdate([{ id: "native-1" }]);
    const counts = makeCounts();

    const id = await importOneFpCustomer(ORG, makeCustomer(), counts, SPLIT);

    expect(id).toBe("native-1");
    expect(counts.created).toBe(1);
    expect(db.insert).not.toHaveBeenCalled();
    // The flagged path must never route through upsertCustomerByContact: it
    // un-archives a matched row and creates one on a miss.
    expect(upsertCustomerByContact).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ fieldpulseCustomerId: "10001001" }),
    );
  });

  it("candidate SELECT and guarded UPDATE carry the SAME filter, do-not-service included", async () => {
    // A do-not-service row is excluded from the candidate set, so a refusal can
    // never be bypassed by stamping an FP identity onto the blocked row. And
    // the UPDATE repeats every SELECT term: the phase runs ~20 minutes and
    // nothing pauses an operator archiving or blocking a row in between.
    const { wheres } = wireSelectQueue([
      [],
      [{ id: "native-1", fieldpulseCustomerId: null }],
    ]);
    const { where: updateWhere } = wireUpdate([{ id: "native-1" }]);

    await importOneFpCustomer(ORG, makeCustomer(), makeCounts(), SPLIT);

    const candidateWhere = wheres[1];
    for (const term of [
      "fieldpulse_customer_id IS NULL",
      "anonymized_at IS NULL",
      "archived_at IS NULL",
      "do_not_service = false",
    ]) {
      expect(predicateContains(candidateWhere, term)).toBe(true);
      expect(predicateContains(updateWhere.mock.calls[0]?.[0], term)).toBe(true);
    }
  });

  it("contested candidate: the second FP customer in the run inserts its own row", async () => {
    // FP list order carries no identity meaning, so first-arrival must not win
    // a candidate outright — the loser gets its own row rather than none.
    vi.mocked(db.execute).mockResolvedValue([] as never);
    const client = makeClient([
      makeCustomer({ id: "10001001" }),
      makeCustomer({ id: "10001002" }),
    ]);
    wireSelectQueue([
      [], // findByFpId — customer 1
      [{ id: "native-1", fieldpulseCustomerId: null }], // candidate — customer 1
      [], // findByFpId — customer 2
      [{ id: "native-1", fieldpulseCustomerId: null }], // same candidate
    ]);
    wireUpdate([{ id: "native-1" }]);
    const { values } = wireInsert([{ id: "fresh-2" }]);
    const counts = makeCounts();

    await importCustomersFromFieldpulse(ORG, counts, client, SPLIT);

    expect(db.update).toHaveBeenCalledTimes(1); // only the first claim
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ fieldpulseCustomerId: "10001002" }),
    );
    expect(counts.created).toBe(2);
    expect(counts.errors).toBe(0);
  });

  it("a claim that matches no row falls through to the insert — never null, never an error", async () => {
    // Zero rows can only mean "that row is not available to me" (raced, erased,
    // archived or blocked in between). An FP customer must never end a run with
    // no row because of a race.
    wireSelectQueue([[], [{ id: "native-1", fieldpulseCustomerId: null }]]);
    wireUpdate([]); // guarded claim matched nothing
    const { values } = wireInsert([{ id: "fresh-1" }]);
    const counts = makeCounts();

    const id = await importOneFpCustomer(ORG, makeCustomer(), counts, SPLIT);

    expect(id).toBe("fresh-1");
    expect(counts.created).toBe(1);
    expect(counts.errors).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ fieldpulseCustomerId: "10001001" }),
    );
  });

  it("phone-only FP customer gets its own row — a phone is never claimed on", async () => {
    // The claim carries the row's portal token, so a shared office line would
    // hand one customer another's invoices.
    const fp = makeCustomer({ email: null });
    const { wheres } = wireSelectQueue([[]]); // findByFpId only
    const { values } = wireInsert([{ id: "fresh-phone" }]);
    const counts = makeCounts();

    const id = await importOneFpCustomer(ORG, fp, counts, SPLIT);

    expect(id).toBe("fresh-phone");
    expect(wheres).toHaveLength(1); // no candidate query at all
    expect(db.update).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        emailHash: null,
        phoneHash: "h:15550109999",
        fieldpulseCustomerId: "10001001",
      }),
    );
    expect(counts.created).toBe(1);
  });

  it("contactless FP customer takes the same insert — no separate branch", async () => {
    const fp = makeCustomer({ email: null, phone: null, phoneE164: null });
    wireSelectQueue([[]]);
    const { values } = wireInsert([{ id: "fresh-contactless" }]);
    const counts = makeCounts();

    expect(await importOneFpCustomer(ORG, fp, counts, SPLIT)).toBe(
      "fresh-contactless",
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ emailHash: null, phoneHash: null }),
    );
  });

  it("insert conflict (concurrent run) re-selects by fp id instead of returning null", async () => {
    wireSelectQueue([
      [], // findByFpId — miss (contactless, so no candidate query)
      [{ id: "raced-in" }], // re-select after the conflict
    ]);
    wireInsert([]); // onConflictDoNothing → no row
    const counts = makeCounts();

    const id = await importOneFpCustomer(
      ORG,
      makeCustomer({ email: null, phone: null, phoneE164: null }),
      counts,
      SPLIT,
    );

    expect(id).toBe("raced-in");
    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(0);
  });

  it("archived import: a conflict miss re-selects by fp id instead of returning null", async () => {
    // Before the repair, null meant BOTH "no row" and "a row already exists" —
    // and jobs.ts:424-428 reads null as unresolved and skips the whole job.
    const fp = makeCustomer({ deletedAt: "2026-01-01 00:00:00" });
    wireSelectQueue([
      [], // findByFpId — miss
      [{ id: "archived-existing" }], // re-select after the conflict
    ]);
    const { values } = wireInsert([]); // conflict — the placeholder exists
    const counts = makeCounts();

    const id = await importOneFpCustomer(ORG, fp, counts, SPLIT);

    expect(id).toBe("archived-existing");
    expect(counts.skipped).toBe(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ archivedAt: expect.any(Date) }),
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("archived import still inserts as archived and is never claimed", async () => {
    const fp = makeCustomer({ mergedCustomerId: "99999" });
    const { wheres } = wireSelectQueue([[]]);
    wireInsert([{ id: "archived-new" }]);
    const counts = makeCounts();

    expect(await importOneFpCustomer(ORG, fp, counts, SPLIT)).toBe("archived-new");
    expect(wheres).toHaveLength(1); // no candidate query for an archived import
    expect(counts.created).toBe(1);
    expect(counts.archivedImported).toBe(1);
  });

  it("updates the row already keyed on the fp id, exactly as the unflagged path does", async () => {
    wireSelectQueue([[{ id: "existing-id", anonymizedAt: null }]]);
    const { set } = wireUpdate([{ id: "existing-id" }]);
    const counts = makeCounts();

    expect(await importOneFpCustomer(ORG, makeCustomer(), counts, SPLIT)).toBe(
      "existing-id",
    );
    expect(counts.updated).toBe(1);
    expect(db.insert).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ emailHash: "h:test@example.invalid" }),
    );
  });

  it("keeps the erasure guard: an anonymized row is not refilled with PII", async () => {
    wireSelectQueue([[{ id: "erased-1", anonymizedAt: new Date("2026-07-01") }]]);
    const counts = makeCounts();

    const id = await importOneFpCustomer(ORG, makeCustomer(), counts, SPLIT);

    expect(id).toBe("erased-1");
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(counts.skipped).toBe(1);
  });

  it("does not count sharedContactSkipped — the fp-id guard cannot fire on this path", async () => {
    wireSelectQueue([[], [{ id: "native-1", fieldpulseCustomerId: null }]]);
    wireUpdate([{ id: "native-1" }]);
    const counts = makeCounts();

    await importOneFpCustomer(ORG, makeCustomer(), counts, SPLIT);

    expect(counts.sharedContactSkipped).toBeUndefined();
  });
});
