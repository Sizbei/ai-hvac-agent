/**
 * Tests for AI-assisted estimate drafting (admin-side suggestions).
 *
 * Core guarantees under test:
 *  1. A hallucinated pricebookItemId (not in the catalog) is DROPPED.
 *  2. Names/prices in the output come from the CATALOG, not the LLM payload.
 *  3. An LLM error / unparseable output yields an empty suggestions array (no throw).
 *  4. The line cap (12) and quantity clamp (>=1, <=99) are enforced.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { suggestEstimateLineItems } from "./estimate-suggester";
import { generateText } from "ai";
import { listPricebookItems } from "@/lib/admin/pricebook-queries";
import { getRequestById } from "@/lib/admin/queries";

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("./provider", () => ({ getExtractionModel: () => ({}) }));
vi.mock("@/lib/admin/pricebook-queries", () => ({ listPricebookItems: vi.fn() }));
vi.mock("@/lib/admin/queries", () => ({ getRequestById: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

const ORG = "org-1";
const SRID = "req-1";

function mockCatalog(
  rows: Array<{
    id: string;
    type?: string;
    name: string;
    priceCents: number;
    memberPriceCents?: number | null;
    hours?: number | null;
  }>,
) {
  vi.mocked(listPricebookItems).mockResolvedValue(
    rows.map((r) => ({
      id: r.id,
      type: r.type ?? "service",
      name: r.name,
      priceCents: r.priceCents,
      memberPriceCents: r.memberPriceCents ?? null,
      hours: r.hours ?? null,
    })),
  );
}

function mockRequest() {
  vi.mocked(getRequestById).mockResolvedValue({
    id: SRID,
    issueType: "cooling_not_working",
    urgency: "high",
    description: "AC blowing warm air",
    transcript: [{ role: "user", content: "my AC is broken", createdAt: "2026-01-01" }],
  } as never);
}

function mockLLM(text: string) {
  vi.mocked(generateText).mockResolvedValue({ text } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("suggestEstimateLineItems", () => {
  it("drops a hallucinated pricebookItemId not in the catalog", async () => {
    mockCatalog([{ id: "real-1", name: "Diagnostic", priceCents: 9900 }]);
    mockRequest();
    mockLLM(
      JSON.stringify([
        { pricebookItemId: "real-1", quantity: 1, reason: "diag" },
        { pricebookItemId: "ghost-999", quantity: 1, reason: "hallucinated" },
      ]),
    );

    const { suggestions } = await suggestEstimateLineItems(ORG, {
      serviceRequestId: SRID,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.pricebookItemId).toBe("real-1");
  });

  it("uses catalog name/price, ignoring the LLM payload's name/price", async () => {
    mockCatalog([{ id: "real-1", name: "Diagnostic", priceCents: 9900 }]);
    mockRequest();
    // LLM tries to smuggle a fake name + a tampered (low) price.
    mockLLM(
      JSON.stringify([
        {
          pricebookItemId: "real-1",
          quantity: 1,
          name: "FREE service",
          priceCents: 1,
          reason: "x",
        },
      ]),
    );

    const { suggestions } = await suggestEstimateLineItems(ORG, {
      serviceRequestId: SRID,
    });

    expect(suggestions[0]!.name).toBe("Diagnostic"); // from catalog
    expect(suggestions[0]!.priceCents).toBe(9900); // from catalog, not 1
  });

  it("returns empty suggestions (no throw) when the LLM throws", async () => {
    mockCatalog([{ id: "real-1", name: "Diagnostic", priceCents: 9900 }]);
    mockRequest();
    vi.mocked(generateText).mockRejectedValue(new Error("upstream 500"));

    const result = await suggestEstimateLineItems(ORG, {
      serviceRequestId: SRID,
    });

    expect(result.suggestions).toEqual([]);
    expect(result.note).toBeTruthy();
  });

  it("returns empty suggestions for unparseable LLM output", async () => {
    mockCatalog([{ id: "real-1", name: "Diagnostic", priceCents: 9900 }]);
    mockRequest();
    mockLLM("I'm sorry, I cannot help with that.");

    const { suggestions } = await suggestEstimateLineItems(ORG, {
      serviceRequestId: SRID,
    });

    expect(suggestions).toEqual([]);
  });

  it("caps the number of suggested lines at 12", async () => {
    // 20 distinct valid catalog items, all suggested by the LLM.
    const catalog = Array.from({ length: 20 }, (_, i) => ({
      id: `item-${i}`,
      name: `Item ${i}`,
      priceCents: 1000 + i,
    }));
    mockCatalog(catalog);
    mockRequest();
    mockLLM(
      JSON.stringify(
        catalog.map((c) => ({ pricebookItemId: c.id, quantity: 1, reason: "x" })),
      ),
    );

    const { suggestions } = await suggestEstimateLineItems(ORG, {
      serviceRequestId: SRID,
    });

    expect(suggestions).toHaveLength(12);
  });

  it("clamps quantity into [1, 99]", async () => {
    mockCatalog([
      { id: "a", name: "A", priceCents: 100 },
      { id: "b", name: "B", priceCents: 200 },
      { id: "c", name: "C", priceCents: 300 },
    ]);
    mockRequest();
    mockLLM(
      JSON.stringify([
        { pricebookItemId: "a", quantity: 0, reason: "too low" },
        { pricebookItemId: "b", quantity: 1000, reason: "too high" },
        { pricebookItemId: "c", quantity: 2.9, reason: "fractional" },
      ]),
    );

    const { suggestions } = await suggestEstimateLineItems(ORG, {
      serviceRequestId: SRID,
    });

    const byId = new Map(suggestions.map((s) => [s.pricebookItemId, s.quantity]));
    expect(byId.get("a")).toBe(1); // clamped up from 0
    expect(byId.get("b")).toBe(99); // clamped down from 1000
    expect(byId.get("c")).toBe(2); // floored from 2.9
  });

  it("returns an empty result when no serviceRequestId is given", async () => {
    const result = await suggestEstimateLineItems(ORG, {});
    expect(result.suggestions).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns an empty result when the catalog is empty", async () => {
    mockCatalog([]);
    mockRequest();

    const result = await suggestEstimateLineItems(ORG, {
      serviceRequestId: SRID,
    });

    expect(result.suggestions).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });
});
