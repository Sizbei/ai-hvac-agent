/**
 * Tests for Step 20 web-abandon recovery — the chat-widget mirror of the SMS
 * booking-recovery sweep. Selects abandoned WEB sessions with a resolved
 * customer + decryptable phone, deduped via the ledger and consent-gated.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { recoverAbandonedWebSessions } from "./booking-recovery";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { claimOutboundOnce } from "./outbound-ledger";
import { checkSendAllowed } from "./consent";
import { sendSms } from "./twilio-adapter";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/crypto", () => ({ decrypt: vi.fn() }));
vi.mock("./outbound-ledger", () => ({ claimOutboundOnce: vi.fn() }));
vi.mock("./consent", () => ({ checkSendAllowed: vi.fn() }));
vi.mock("./twilio-adapter", () => ({ sendSms: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

const ORG = "org-1";

function mockCandidates(
  rows: Array<{ id: string; customerId: string | null; phoneEncrypted: string | null }>,
) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: encrypted phone decrypts to a usable number.
  vi.mocked(decrypt).mockReturnValue("+15551112222");
});

describe("recoverAbandonedWebSessions", () => {
  it("sends one recovery SMS for an eligible web session (claimed + consent ok)", async () => {
    mockCandidates([{ id: "s1", customerId: "c1", phoneEncrypted: "enc" }]);
    vi.mocked(claimOutboundOnce).mockResolvedValue(true);
    vi.mocked(checkSendAllowed).mockResolvedValue({ allowed: true });

    const r = await recoverAbandonedWebSessions(ORG);

    expect(r.sent).toBe(1);
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15551112222" }),
    );
  });

  it("claims with a web-specific periodKey (distinct from SMS recovery)", async () => {
    mockCandidates([{ id: "s1", customerId: "c1", phoneEncrypted: "enc" }]);
    vi.mocked(claimOutboundOnce).mockResolvedValue(true);
    vi.mocked(checkSendAllowed).mockResolvedValue({ allowed: true });

    await recoverAbandonedWebSessions(ORG);

    expect(claimOutboundOnce).toHaveBeenCalledWith(
      expect.objectContaining({ periodKey: "webrecovery:s1", customerId: "c1" }),
    );
  });

  it("does not send when the ledger already claimed the session (dedupe)", async () => {
    mockCandidates([{ id: "s1", customerId: "c1", phoneEncrypted: "enc" }]);
    vi.mocked(claimOutboundOnce).mockResolvedValue(false);

    const r = await recoverAbandonedWebSessions(ORG);

    expect(r.sent).toBe(0);
    expect(checkSendAllowed).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("does not send when consent is blocked", async () => {
    mockCandidates([{ id: "s1", customerId: "c1", phoneEncrypted: "enc" }]);
    vi.mocked(claimOutboundOnce).mockResolvedValue(true);
    vi.mocked(checkSendAllowed).mockResolvedValue({
      allowed: false,
      reason: "do_not_contact",
    });

    const r = await recoverAbandonedWebSessions(ORG);

    expect(r.sent).toBe(0);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("skips a session whose phone cannot be decrypted", async () => {
    mockCandidates([{ id: "s1", customerId: "c1", phoneEncrypted: "bad" }]);
    vi.mocked(decrypt).mockImplementation(() => {
      throw new Error("tampered");
    });

    const r = await recoverAbandonedWebSessions(ORG);

    expect(r.sent).toBe(0);
    expect(claimOutboundOnce).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("isolates a send failure — one throw does not abort the batch", async () => {
    mockCandidates([
      { id: "s1", customerId: "c1", phoneEncrypted: "enc" },
      { id: "s2", customerId: "c2", phoneEncrypted: "enc" },
    ]);
    vi.mocked(claimOutboundOnce).mockResolvedValue(true);
    vi.mocked(checkSendAllowed).mockResolvedValue({ allowed: true });
    vi.mocked(sendSms)
      .mockRejectedValueOnce(new Error("twilio down"))
      .mockResolvedValueOnce(undefined as never);

    const r = await recoverAbandonedWebSessions(ORG);

    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(1);
    expect(sendSms).toHaveBeenCalledTimes(2);
  });
});
