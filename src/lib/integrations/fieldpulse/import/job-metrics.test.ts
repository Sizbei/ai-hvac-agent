/**
 * Tests for job-metrics enrichment phase.
 *
 * Covers:
 *  - extractJobMetrics: string/number coercion, missing keys → null,
 *    null input, totalPriceCents dollar-string conversion.
 *  - enrichJobMetrics: fetches rows, calls getJob, writes metrics, skips null, error containment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractJobMetrics, enrichJobMetrics } from "./job-metrics";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// ── extractJobMetrics ────────────────────────────────────────────────────────

describe("extractJobMetrics", () => {
  it("returns null for non-object input", () => {
    expect(extractJobMetrics(null)).toBeNull();
    expect(extractJobMetrics("string")).toBeNull();
    expect(extractJobMetrics(42)).toBeNull();
  });

  it("extracts statusLogSeconds from number values", () => {
    const raw = {
      status_log: { pending: 0, on_the_way: 5940, in_progress: 108756, completed: 0 },
      total_price: null,
      map: null,
    };
    const result = extractJobMetrics(raw);
    expect(result).not.toBeNull();
    expect(result!.statusLogSeconds.pending).toBe(0);
    expect(result!.statusLogSeconds.on_the_way).toBe(5940);
    expect(result!.statusLogSeconds.in_progress).toBe(108756);
    expect(result!.statusLogSeconds.completed).toBe(0);
  });

  it("coerces string values in status_log", () => {
    const raw = {
      status_log: { pending: "0", on_the_way: "5940", in_progress: "108756", completed: "0" },
    };
    const result = extractJobMetrics(raw);
    expect(result!.statusLogSeconds.on_the_way).toBe(5940);
    expect(result!.statusLogSeconds.in_progress).toBe(108756);
  });

  it("returns null for missing status_log keys", () => {
    const result = extractJobMetrics({});
    expect(result!.statusLogSeconds.pending).toBeNull();
    expect(result!.statusLogSeconds.on_the_way).toBeNull();
    expect(result!.statusLogSeconds.in_progress).toBeNull();
    expect(result!.statusLogSeconds.completed).toBeNull();
  });

  it("converts dollar-string total_price to cents", () => {
    const result = extractJobMetrics({ total_price: "245.00" });
    expect(result!.totalPriceCents).toBe(24500);
  });

  it("converts number total_price to cents", () => {
    const result = extractJobMetrics({ total_price: 100 });
    expect(result!.totalPriceCents).toBe(10000);
  });

  it("returns null totalPriceCents for empty/null total_price", () => {
    expect(extractJobMetrics({ total_price: null })!.totalPriceCents).toBeNull();
    expect(extractJobMetrics({ total_price: "" })!.totalPriceCents).toBeNull();
    expect(extractJobMetrics({})!.totalPriceCents).toBeNull();
  });

  it("passes map through as-is", () => {
    const coords = { lat: 36.3, lng: -82.3 };
    const result = extractJobMetrics({ map: coords });
    expect(result!.mapCoords).toEqual(coords);
  });

  it("returns null mapCoords when map absent", () => {
    const result = extractJobMetrics({});
    expect(result!.mapCoords).toBeNull();
  });
});

// ── enrichJobMetrics ─────────────────────────────────────────────────────────

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

function makeClient(getJobRawFn: (id: string) => Promise<unknown>): FieldpulseClient {
  return {
    getJobRaw: vi.fn().mockImplementation(getJobRawFn),
  } as unknown as FieldpulseClient;
}

describe("enrichJobMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches rows, calls getJob, writes metrics, increments updated", async () => {
    const rows = [{ id: "req-1", fieldpulseJobId: "fp-1" }];
    const mockRaw = {
      status_log: { pending: 0, on_the_way: 5940, in_progress: 108756, completed: 0 },
      total_price: "150.00",
      map: null,
    };

    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

    const mockSelectWhere = vi.fn().mockResolvedValue(rows);
    const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
    const mockSelectFields = vi.fn().mockReturnValue({ from: mockSelectFrom });

    vi.mocked(db.select).mockImplementation(mockSelectFields as never);
    vi.mocked(db.update).mockImplementation(mockUpdate as never);

    const client = makeClient(async () => mockRaw);
    const counts = makeCounts();
    await enrichJobMetrics("org-1", counts, client);

    expect(counts.fetched).toBe(1);
    expect(counts.updated).toBe(1);
    expect(counts.errors).toBe(0);
    expect(client.getJobRaw).toHaveBeenCalledWith("fp-1");
  });

  it("increments skipped when metrics extraction returns null", async () => {
    const rows = [{ id: "req-1", fieldpulseJobId: "fp-1" }];

    const mockSelectWhere = vi.fn().mockResolvedValue(rows);
    const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
    const mockSelectFields = vi.fn().mockReturnValue({ from: mockSelectFrom });
    vi.mocked(db.select).mockImplementation(mockSelectFields as never);

    // null input → extractJobMetrics returns null
    const client = makeClient(async () => null);
    const counts = makeCounts();
    await enrichJobMetrics("org-1", counts, client);

    expect(counts.skipped).toBe(1);
    expect(counts.updated).toBe(0);
  });

  it("increments errors on per-job exception, continues", async () => {
    const rows = [
      { id: "req-1", fieldpulseJobId: "fp-1" },
      { id: "req-2", fieldpulseJobId: "fp-2" },
    ];
    const mockRaw = { total_price: "50.00" };

    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

    const mockSelectWhere = vi.fn().mockResolvedValue(rows);
    const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
    const mockSelectFields = vi.fn().mockReturnValue({ from: mockSelectFrom });
    vi.mocked(db.select).mockImplementation(mockSelectFields as never);
    vi.mocked(db.update).mockImplementation(mockUpdate as never);

    let callCount = 0;
    const client = makeClient(async () => {
      callCount++;
      if (callCount === 1) throw new Error("API error");
      return mockRaw;
    });

    const counts = makeCounts();
    await enrichJobMetrics("org-1", counts, client);

    expect(counts.errors).toBe(1);
    expect(counts.updated).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
