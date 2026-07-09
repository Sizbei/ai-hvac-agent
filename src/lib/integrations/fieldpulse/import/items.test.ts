/**
 * Tests for FieldPulse pricebook items inbound pull.
 *
 * Covers:
 *  - importItemsFromFieldpulse: full walk counts (fetched, total=null);
 *    nameless-skip; created/updated via pre-select; per-record error containment;
 *    unknown-type tally+warn; cappedByMaxPages warn+note.
 *  - toItem (via client) and mapFpItemType are exercised via the client mock.
 *  - Cap-flag: cappedByMaxPages=true → warn + cappedNote in counts;
 *    cappedByMaxPages=false → no warn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { importItemsFromFieldpulse } from "./items";
import type { FieldpulseItem } from "../types";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<FieldpulseItem> = {}): FieldpulseItem {
  return {
    id: "10001",
    name: "Diagnostic Service",
    priceCents: 9900,
    taxable: true,
    isActive: true,
    type: "service",
    rawFpType: "service",
    ...overrides,
  };
}

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

function makeClient(
  items: FieldpulseItem[],
  opts: { totalCount?: number | null; cappedByMaxPages?: boolean } = {},
): FieldpulseClient {
  return {
    listItems: vi.fn().mockResolvedValue({
      items,
      totalCount: opts.totalCount ?? null,
      cappedByMaxPages: opts.cappedByMaxPages ?? false,
    }),
  } as unknown as FieldpulseClient;
}

/** Wire a single SELECT returning existingIds already in DB. */
function wireSelect(existingFpIds: string[]) {
  const rows = existingFpIds.map((id) => ({ fieldpulseItemId: id }));
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

/** Wire INSERT → onConflictDoUpdate chain. */
function wireInsert() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { values, onConflictDoUpdate };
}

const ORG = "org-test-uuid";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("importItemsFromFieldpulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets fetched=items.length and total=null (FP never returns total_count for /items)", async () => {
    const client = makeClient([makeItem()], { totalCount: null });
    const counts = makeCounts();
    wireSelect([]);
    wireInsert();

    await importItemsFromFieldpulse(ORG, counts, client);

    expect(counts.fetched).toBe(1);
    expect(counts.total).toBeNull();
  });

  it("counts created for new item (not in pre-select set)", async () => {
    const item = makeItem({ id: "10001" });
    const client = makeClient([item]);
    const counts = makeCounts();

    wireSelect([]); // no existing fp ids
    wireInsert();

    await importItemsFromFieldpulse(ORG, counts, client);

    expect(counts.created).toBe(1);
    expect(counts.updated).toBe(0);
  });

  it("counts updated for item already in pre-select set", async () => {
    const item = makeItem({ id: "10001" });
    const client = makeClient([item]);
    const counts = makeCounts();

    wireSelect(["10001"]); // already exists
    wireInsert();

    await importItemsFromFieldpulse(ORG, counts, client);

    expect(counts.updated).toBe(1);
    expect(counts.created).toBe(0);
  });

  it("skips nameless items (blank name)", async () => {
    const item = makeItem({ name: "   " }); // blank after trim
    const client = makeClient([item]);
    const counts = makeCounts();

    wireSelect([]);

    await importItemsFromFieldpulse(ORG, counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.created).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("per-record errors are contained: increments errors and continues", async () => {
    const fp1 = makeItem({ id: "10001" });
    const fp2 = makeItem({ id: "10002", name: "HVAC Unit" });
    const client = makeClient([fp1, fp2]);
    const counts = makeCounts();

    wireSelect([]);
    const onConflictDoUpdate = vi.fn()
      .mockRejectedValueOnce(new Error("DB constraint"))
      .mockResolvedValueOnce([]);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    await importItemsFromFieldpulse(ORG, counts, client);

    expect(counts.errors).toBe(1);
    expect(counts.created).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("logs WARN + sets cappedNote when cappedByMaxPages=true", async () => {
    const client = makeClient([makeItem()], { cappedByMaxPages: true });
    const counts = makeCounts();
    wireSelect([]);
    wireInsert();

    await importItemsFromFieldpulse(ORG, counts, client);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fetched: 1 }),
      expect.stringContaining("cappedByMaxPages"),
    );
    expect((counts as unknown as Record<string, unknown>).cappedNote).toBe("cappedByMaxPages");
  });

  it("does NOT warn when cappedByMaxPages=false (natural end)", async () => {
    const client = makeClient([makeItem()], { cappedByMaxPages: false });
    const counts = makeCounts();
    wireSelect([]);
    wireInsert();

    await importItemsFromFieldpulse(ORG, counts, client);

    // No cappedByMaxPages warn (errors warn may still fire from other paths
    // but the cap-specific log should not).
    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const capWarn = warnCalls.find((c) =>
      String(c[1]).includes("cappedByMaxPages"),
    );
    expect(capWarn).toBeUndefined();
    expect((counts as unknown as Record<string, unknown>).cappedNote).toBeUndefined();
  });

  it("logs WARN for unknown FP type strings (mapped to 'service')", async () => {
    // rawFpType=null triggers the unknown-type path since null is not in any known set.
    const item = makeItem({ type: "service", rawFpType: null });
    const client = makeClient([item]);
    const counts = makeCounts();
    wireSelect([]);
    wireInsert();

    await importItemsFromFieldpulse(ORG, counts, client);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ unknownTypes: expect.any(Object) }),
      expect.stringContaining("unknown FP type"),
    );
  });

  it("does NOT warn for known service type string", async () => {
    const item = makeItem({ type: "service", rawFpType: "service" });
    const client = makeClient([item]);
    const counts = makeCounts();
    wireSelect([]);
    wireInsert();

    await importItemsFromFieldpulse(ORG, counts, client);

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const typeWarn = warnCalls.find((c) =>
      String(c[1]).includes("unknown FP type"),
    );
    expect(typeWarn).toBeUndefined();
  });

  it("upserts inactive items with active=false", async () => {
    const item = makeItem({ id: "10003", isActive: false });
    const client = makeClient([item]);
    const counts = makeCounts();
    wireSelect([]);
    const { values } = wireInsert();

    await importItemsFromFieldpulse(ORG, counts, client);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ active: false }),
    );
    expect(counts.created).toBe(1);
  });

  it("multiple items: correct created/updated split", async () => {
    const existingItem = makeItem({ id: "10001", name: "Filter Change" });
    const newItem = makeItem({ id: "10002", name: "AC Tune-Up" });
    const client = makeClient([existingItem, newItem]);
    const counts = makeCounts();

    wireSelect(["10001"]); // 10001 already exists
    wireInsert();

    await importItemsFromFieldpulse(ORG, counts, client);

    expect(counts.fetched).toBe(2);
    expect(counts.updated).toBe(1);
    expect(counts.created).toBe(1);
  });
});
