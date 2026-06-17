/**
 * Tests for the reviews data layer: createReviewRequest (idempotent per job),
 * recordReviewResponse (token-authority, sets rating/feedback + status), and
 * getReviewStats (avg computation). Mocks the DB + ledger + comms queue so we
 * assert behavior without a real DB or send.
 *
 * COMPLIANCE assertion: the response flow does NOT gate the public link on the
 * rating — recordReviewResponse records every rating identically, and the public
 * handler returns the link regardless. (The "no gating" assertion lives with the
 * route handler test below.)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  createReviewRequest,
  recordReviewResponse,
  getReviewStats,
} from "./review-queries";
import { db } from "@/lib/db";
import { claimOutboundOnce } from "@/lib/communication/outbound-ledger";
import { queueCommunicationJob } from "@/lib/communication/job-queue";

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("@/lib/communication/job-queue", () => ({
  queueCommunicationJob: vi.fn().mockResolvedValue("job-1"),
}));
vi.mock("@/lib/communication/outbound-ledger", () => ({
  claimOutboundOnce: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/admin/org-config-queries", () => ({
  getOrgConfig: vi.fn().mockResolvedValue({ companyName: "Acme HVAC" }),
}));
// decrypt is identity here so a stored "value" reads back as itself.
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    query: { communicationTemplates: { findFirst: vi.fn() } },
  },
}));

const ORG = "org-1";
const CUST = "cust-1";
const SR = "sr-1";

/** db.select(...).from(...).where(...).limit() resolves `rows`. */
function mockSelectLimit(rows: Record<string, unknown>[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as never);
}

/** db.select(...).from(...).where() resolves `rows` (no .limit — aggregate). */
function mockSelectWhere(rows: Record<string, unknown>[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("createReviewRequest", () => {
  it("creates the row + enqueues the ask once per job", async () => {
    vi.mocked(claimOutboundOnce).mockResolvedValue(true);
    vi.mocked(db.query.communicationTemplates.findFirst).mockResolvedValue({
      id: "tpl-1",
    } as never);
    // customer-contact read
    mockSelectLimit([{ nameEncrypted: "Jane", phoneEncrypted: "+18005551212" }]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as never);

    const result = await createReviewRequest(ORG, SR, CUST);

    expect(result.created).toBe(true);
    // Dedupe slot claimed with the per-job period key.
    expect(claimOutboundOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "review_request",
        periodKey: `review:${SR}`,
      }),
    );
    // The ask was enqueued through the EXISTING comms queue (consent chokepoint).
    expect(queueCommunicationJob).toHaveBeenCalledTimes(1);
    const enqueued = vi.mocked(queueCommunicationJob).mock.calls[0][0];
    expect(enqueued.triggerType).toBe("review_request");
    expect(enqueued.recipientPhone).toBe("+18005551212");
    // The response link points at the public /review/<token> page.
    expect(String(enqueued.templateVariables.reviewLink)).toContain("/review/");
  });

  it("is idempotent per job — a duplicate claim enqueues nothing", async () => {
    vi.mocked(claimOutboundOnce).mockResolvedValue(false);

    const result = await createReviewRequest(ORG, SR, CUST);

    expect(result.created).toBe(false);
    expect(result.reason).toBe("duplicate");
    expect(queueCommunicationJob).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips when there is no customer (cannot consent-gate or reach)", async () => {
    const result = await createReviewRequest(ORG, SR, null);
    expect(result.created).toBe(false);
    expect(claimOutboundOnce).not.toHaveBeenCalled();
  });
});

describe("recordReviewResponse", () => {
  it("sets rating + feedback and flips status to responded via the token", async () => {
    // First select: resolve the request by token hash (not yet responded).
    mockSelectLimit([{ id: "rev-1", status: "sent" }]);
    const setFn = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "rev-1" }]),
      }),
    });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as never);

    const result = await recordReviewResponse("plain-token", {
      rating: 2,
      feedback: "It was okay",
      clickedPublic: true,
    });

    expect(result.ok).toBe(true);
    // The update wrote the rating + PRIVATE feedback + responded status.
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "responded",
        rating: 2,
        feedback: "It was okay",
        publicClicked: true,
      }),
    );
  });

  it("records a LOW rating exactly like a high one (no sentiment gating)", async () => {
    mockSelectLimit([{ id: "rev-low", status: "sent" }]);
    const setFn = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "rev-low" }]),
      }),
    });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as never);

    const result = await recordReviewResponse("plain-token", { rating: 1 });

    // A 1-star response is accepted and recorded — never rejected/branched away.
    expect(result.ok).toBe(true);
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({ status: "responded", rating: 1 }),
    );
  });

  it("returns not_found for an unknown token", async () => {
    mockSelectLimit([]);
    const result = await recordReviewResponse("nope", { rating: 5 });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns already_responded when the request was already answered", async () => {
    mockSelectLimit([{ id: "rev-1", status: "responded" }]);
    const result = await recordReviewResponse("plain-token", { rating: 5 });
    expect(result).toEqual({ ok: false, reason: "already_responded" });
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("getReviewStats", () => {
  it("computes count, responded, and average rating", async () => {
    mockSelectWhere([{ count: 4, responded: 3, avgRating: "3.6667" }]);
    const stats = await getReviewStats(ORG);
    expect(stats.count).toBe(4);
    expect(stats.responded).toBe(3);
    expect(stats.avgRating).toBeCloseTo(3.6667, 3);
  });

  it("returns null avg when nobody has responded", async () => {
    mockSelectWhere([{ count: 2, responded: 0, avgRating: null }]);
    const stats = await getReviewStats(ORG);
    expect(stats.avgRating).toBeNull();
    expect(stats.count).toBe(2);
  });
});
