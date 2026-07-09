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
import { mapFpCustomer, importCustomersFromFieldpulse } from "./customers";
import type { FieldpulseCustomer } from "../types";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
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
