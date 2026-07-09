/**
 * Tests for Phase 11 — FieldPulse locations inbound pull (address enrichment).
 *
 * Covers:
 *  - mapFpLocation: non-customer skip, no-address skip, no-object-id skip, happy path.
 *  - importLocationsFromFieldpulse: fills null addresses, skips customers with
 *    existing addresses, skips non-BaseCustomer types, per-record error containment.
 *
 * Uses sanitized fixtures (fake PII only).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mapFpLocation, importLocationsFromFieldpulse } from "./locations";
import type { FieldpulseLocation } from "../types";
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
}));
vi.mock("@/lib/ai/sanitize-fields", () => ({
  sanitizeAddress: vi.fn((v: string) => v),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeLocation(overrides: Partial<FieldpulseLocation> = {}): FieldpulseLocation {
  return {
    id: "60001001",
    objectId: "10001001",
    objectType: "BaseCustomer",
    title: "Main Location",
    address1: "1 Fake St",
    address2: null,
    city: "Testville",
    state: "TN",
    zipCode: "37000",
    isMainLocation: true,
    notes: null,
    ...overrides,
  };
}

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

function makeClient(
  locations: FieldpulseLocation[],
  totalCount: number | null = null,
): FieldpulseClient {
  return {
    listLocations: vi.fn().mockResolvedValue({ items: locations, totalCount }),
  } as unknown as FieldpulseClient;
}

// ── mapFpLocation ─────────────────────────────────────────────────────────────

describe("mapFpLocation", () => {
  it("maps a valid BaseCustomer location correctly", () => {
    const result = mapFpLocation(makeLocation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.location.fpCustomerId).toBe("10001001");
    expect(result.location.address).toBe("1 Fake St, Testville, TN 37000");
  });

  it("skips BaseInvoice locations", () => {
    const result = mapFpLocation(makeLocation({ objectType: "BaseInvoice" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-customer");
  });

  it("skips locations with no objectId", () => {
    const result = mapFpLocation(makeLocation({ objectId: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-object-id");
  });

  it("skips locations with no usable address parts", () => {
    const result = mapFpLocation(
      makeLocation({ address1: null, address2: null, city: null, state: null, zipCode: null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-address");
  });

  it("composes address without street2 when absent", () => {
    const result = mapFpLocation(makeLocation({ address2: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.location.address).toBe("1 Fake St, Testville, TN 37000");
  });

  it("composes address city-only when no street", () => {
    const result = mapFpLocation(
      makeLocation({ address1: null, address2: null, state: null, zipCode: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.location.address).toBe("Testville");
  });
});

// ── importLocationsFromFieldpulse ─────────────────────────────────────────────

const ORG = "org-test-uuid";

function wireSelect(resolveWith: unknown[]) {
  const where = vi.fn().mockResolvedValue(resolveWith);
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
  return { from, where };
}

function wireUpdate(resolveWith: unknown[] = []) {
  const where = vi.fn().mockResolvedValue(resolveWith);
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set, where };
}

describe("importLocationsFromFieldpulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enriches address for customer with null addressEncrypted", async () => {
    const client = makeClient([makeLocation()]);
    const counts = makeCounts();
    wireSelect([
      { id: "cust-1", fieldpulseCustomerId: "10001001", addressEncrypted: null },
    ]);
    const { set } = wireUpdate();

    await importLocationsFromFieldpulse(ORG, counts, client);

    expect(counts.updated).toBe(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        addressEncrypted: "enc(1 Fake St, Testville, TN 37000)",
      }),
    );
    expect(counts.enriched).toBe(1);
  });

  it("skips customer who already has addressEncrypted set", async () => {
    const client = makeClient([makeLocation()]);
    const counts = makeCounts();
    wireSelect([
      { id: "cust-1", fieldpulseCustomerId: "10001001", addressEncrypted: "enc(existing)" },
    ]);

    await importLocationsFromFieldpulse(ORG, counts, client);

    expect(counts.updated).toBe(0);
    expect(counts.skipped).toBe(1);
    expect(db.update).not.toHaveBeenCalled();
    expect(counts.skippedHasAddress).toBe(1);
  });

  it("ignores BaseInvoice locations without counting as skipped", async () => {
    const invoiceLoc = makeLocation({ objectType: "BaseInvoice" });
    const client = makeClient([invoiceLoc]);
    const counts = makeCounts();
    wireSelect([]);

    await importLocationsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(0);
    expect(counts.updated).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ ignoredCount: 1 }),
      expect.stringContaining("non-BaseCustomer"),
    );
  });

  it("skips location whose FP customer is not imported", async () => {
    const client = makeClient([makeLocation({ objectId: "99999999" })]);
    const counts = makeCounts();
    wireSelect([
      { id: "cust-1", fieldpulseCustomerId: "10001001", addressEncrypted: null },
    ]); // 99999999 not in pre-select

    await importLocationsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("per-record errors are contained", async () => {
    const client = makeClient([makeLocation()]);
    const counts = makeCounts();
    wireSelect([
      { id: "cust-1", fieldpulseCustomerId: "10001001", addressEncrypted: null },
    ]);

    // db.update throws.
    const where = vi.fn().mockRejectedValue(new Error("DB explode"));
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as never);

    await importLocationsFromFieldpulse(ORG, counts, client);

    expect(counts.errors).toBe(1);
    expect(counts.updated).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
