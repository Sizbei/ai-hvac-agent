/**
 * Tests for Stage 6 abandoned-booking recovery.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { recoverAbandonedBookings } from "./booking-recovery";
import { db } from "@/lib/db";
import { claimOutboundOnce } from "./outbound-ledger";
import { checkSendAllowed } from "./consent";
import { sendSms } from "./twilio-adapter";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));
vi.mock("./outbound-ledger", () => ({ claimOutboundOnce: vi.fn() }));
vi.mock("./consent", () => ({ checkSendAllowed: vi.fn() }));
vi.mock("./twilio-adapter", () => ({ sendSms: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

const ORG = "org-1";

function mockCandidates(rows: Array<{ id: string; token: string; customerId: string | null }>) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("recoverAbandonedBookings", () => {
  it("sends one recovery SMS for an eligible session (claimed + consent ok)", async () => {
    mockCandidates([{ id: "s1", token: "sms:+15551112222", customerId: "c1" }]);
    vi.mocked(claimOutboundOnce).mockResolvedValue(true);
    vi.mocked(checkSendAllowed).mockResolvedValue({ allowed: true });

    const r = await recoverAbandonedBookings(ORG);

    expect(r.sent).toBe(1);
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15551112222" }),
    );
  });

  it("does not send when the ledger already claimed the session (dedupe)", async () => {
    mockCandidates([{ id: "s1", token: "sms:+15551112222", customerId: "c1" }]);
    vi.mocked(claimOutboundOnce).mockResolvedValue(false);

    const r = await recoverAbandonedBookings(ORG);

    expect(r.sent).toBe(0);
    expect(checkSendAllowed).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("does not send when consent is blocked", async () => {
    mockCandidates([{ id: "s1", token: "sms:+15551112222", customerId: "c1" }]);
    vi.mocked(claimOutboundOnce).mockResolvedValue(true);
    vi.mocked(checkSendAllowed).mockResolvedValue({ allowed: false, reason: "do_not_contact" });

    const r = await recoverAbandonedBookings(ORG);

    expect(r.sent).toBe(0);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("skips sessions without a resolved customer", async () => {
    mockCandidates([{ id: "s1", token: "sms:+15551112222", customerId: null }]);
    const r = await recoverAbandonedBookings(ORG);
    expect(r.sent).toBe(0);
    expect(claimOutboundOnce).not.toHaveBeenCalled();
  });
});
