/**
 * Tests for Phase 9 — FieldPulse assets full-history backfill.
 *
 * Covers:
 *  - importAssetsFromFieldpulse: full walk counts (fetched = items.length,
 *    total = null); deleted-skip; missing-customerId skip (skipped++ not errors++);
 *    unresolvable-customerId skip; created/updated via pre-select;
 *    per-record error containment; once-per-run warn.
 *  - mapFpAssetType: asset type mapping for all known + unknown values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { importAssetsFromFieldpulse, mapFpAssetType } from "./assets";
import type { FieldpulseAsset } from "../types";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";

// ── Module mocks ──────────────────────────────────────────────────────────────

const selectQueue: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./jobs", () => ({
  parseFpDate: (raw: string | null | undefined) => (raw ? new Date(raw) : null),
}));

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

function wireSelects(results: unknown[][]) {
  selectQueue.length = 0;
  results.forEach((r) => selectQueue.push(r));

  vi.mocked(db.select).mockImplementation(() => {
    const rows = selectQueue.shift() ?? [];
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    return { from } as never;
  });
}

function wireInsert() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { onConflictDoUpdate, values };
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeAsset(overrides: Partial<FieldpulseAsset> = {}): FieldpulseAsset {
  return {
    id: "90000001",
    customerId: "20000001",
    title: "Carrier AC Unit",
    assetType: "ac",
    tag: "SN-FAKE-001",
    locationDescription: "Backyard",
    installDate: "2020-05-15",
    maintenanceAgreementId: null,
    status: "active",
    deletedAt: null,
    ...overrides,
  };
}

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

function makeClient(
  items: FieldpulseAsset[],
  totalCount: number | null = null,
): FieldpulseClient {
  return {
    listAssets: vi.fn().mockResolvedValue({ items, totalCount }),
  } as unknown as FieldpulseClient;
}

const ORG = "org-test-uuid";

// ── mapFpAssetType unit tests ─────────────────────────────────────────────────

describe("mapFpAssetType", () => {
  it("maps 'ac' → 'ac'", () => expect(mapFpAssetType("ac")).toBe("ac"));
  it("maps 'air conditioner' → 'ac'", () => expect(mapFpAssetType("air conditioner")).toBe("ac"));
  it("maps 'cooling unit' → 'ac'", () => expect(mapFpAssetType("cooling unit")).toBe("ac"));
  it("maps 'furnace' → 'furnace'", () => expect(mapFpAssetType("furnace")).toBe("furnace"));
  it("maps 'heating unit' → 'furnace'", () => expect(mapFpAssetType("heating unit")).toBe("furnace"));
  it("maps 'heat pump' → 'heat_pump'", () => expect(mapFpAssetType("heat pump")).toBe("heat_pump"));
  it("maps 'boiler' → 'boiler'", () => expect(mapFpAssetType("boiler")).toBe("boiler"));
  it("maps 'mini split' → 'mini_split'", () => expect(mapFpAssetType("mini split")).toBe("mini_split"));
  it("maps 'thermostat' → 'thermostat'", () => expect(mapFpAssetType("thermostat")).toBe("thermostat"));
  it("maps unknown → 'other'", () => expect(mapFpAssetType("water heater")).toBe("other"));
  it("maps null → 'other'", () => expect(mapFpAssetType(null)).toBe("other"));
  it("maps undefined → 'other'", () => expect(mapFpAssetType(undefined)).toBe("other"));
});

// ── importAssetsFromFieldpulse tests ──────────────────────────────────────────

describe("importAssetsFromFieldpulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
  });

  it("sets fetched = items.length and total = null", async () => {
    const client = makeClient([makeAsset()], null);
    const counts = makeCounts();
    // 2 selects: existing fp ids, customers map
    wireSelects([[], [{ fpId: "20000001", nativeId: "native-customer-uuid" }]]);
    wireInsert();

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(counts.fetched).toBe(1);
    expect(counts.total).toBeNull();
  });

  it("skips soft-deleted assets and counts them as skipped", async () => {
    const deleted = makeAsset({ id: "90000002", deletedAt: "2026-06-01 00:00:00" });
    const active = makeAsset({ id: "90000001" });
    const client = makeClient([deleted, active]);
    const counts = makeCounts();
    wireSelects([[], [{ fpId: "20000001", nativeId: "native-customer-uuid" }]]);
    wireInsert();

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(1);
  });

  it("skips assets without customerId (skipped++ not errors++)", async () => {
    const asset = makeAsset({ customerId: null });
    const client = makeClient([asset]);
    const counts = makeCounts();
    wireSelects([[], []]);

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.errors).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips assets where customerId doesn't resolve to a native customer (skipped++ not errors++)", async () => {
    const asset = makeAsset({ customerId: "99999999" });
    const client = makeClient([asset]);
    const counts = makeCounts();
    wireSelects([[], []]); // empty customer map

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.errors).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("resolves customerId from fieldpulseCustomerId pre-select", async () => {
    const asset = makeAsset({ customerId: "20000001" });
    const client = makeClient([asset]);
    const counts = makeCounts();
    wireSelects([[], [{ fpId: "20000001", nativeId: "native-customer-uuid" }]]);
    const { values } = wireInsert();

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "native-customer-uuid" }),
    );
    expect(counts.created).toBe(1);
  });

  it("counts created for new assets (not in pre-select Set)", async () => {
    const asset = makeAsset({ id: "90000001" });
    const client = makeClient([asset]);
    const counts = makeCounts();
    wireSelects([[], [{ fpId: "20000001", nativeId: "native-customer-uuid" }]]);
    wireInsert();

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(counts.updated).toBe(0);
  });

  it("counts updated for assets already in pre-select Set (re-run)", async () => {
    const asset = makeAsset({ id: "90000001" });
    const client = makeClient([asset]);
    const counts = makeCounts();
    wireSelects([
      [{ fieldpulseAssetId: "90000001" }], // pre-existing
      [{ fpId: "20000001", nativeId: "native-customer-uuid" }],
    ]);
    wireInsert();

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(counts.updated).toBe(1);
    expect(counts.created).toBe(0);
  });

  it("counts errors and continues when insert throws", async () => {
    const a1 = makeAsset({ id: "90000001" });
    const a2 = makeAsset({ id: "90000002" });
    const client = makeClient([a1, a2]);
    const counts = makeCounts();
    wireSelects([
      [],
      [{ fpId: "20000001", nativeId: "native-customer-uuid" }],
    ]);

    let callCount = 0;
    vi.mocked(db.insert).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const onConflictDoUpdate = vi.fn().mockRejectedValue(new Error("DB explode"));
        const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
        return { values } as never;
      }
      const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      return { values } as never;
    });

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(counts.errors).toBe(1);
    expect(counts.created).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ fpAssetId: "90000001" }),
      expect.stringContaining("per-record error"),
    );
  });

  it("emits once-per-run warn summary when any errors occurred", async () => {
    const asset = makeAsset();
    const client = makeClient([asset]);
    const counts = makeCounts();
    wireSelects([[], [{ fpId: "20000001", nativeId: "native-customer-uuid" }]]);

    const onConflictDoUpdate = vi.fn().mockRejectedValue(new Error("DB explode"));
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errors: 1, orgId: ORG }),
      expect.stringContaining("per-record errors"),
    );
  });

  it("handles an empty asset list", async () => {
    const client = makeClient([]);
    const counts = makeCounts();
    wireSelects([[], []]);

    await importAssetsFromFieldpulse(ORG, counts, client);

    expect(counts.fetched).toBe(0);
    expect(counts.created).toBe(0);
    expect(counts.errors).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
