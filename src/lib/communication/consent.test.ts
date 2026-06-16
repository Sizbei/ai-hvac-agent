/**
 * Tests for the outbound consent gate + inbound STOP/HELP keyword handling.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkSendAllowed,
  classifySmsKeyword,
  isQuietHours,
  localHour,
} from "./consent";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/admin/crm-queries", () => ({
  normalizePhone: (p: string) => p.replace(/\D/g, "") || null,
}));
vi.mock("@/lib/crypto", () => ({ blindIndex: (s: string) => `h:${s}` }));

const ORG = "org-1";
const CUST = "cust-1";

/** Make db.select resolve a single preferences row (or none). */
function mockPrefs(row: Record<string, unknown> | null) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  } as never);
}

const FULL_PREFS = {
  smsEnabled: true,
  emailEnabled: true,
  voiceEnabled: false,
  appointmentReminders: true,
  automatedConfirmations: true,
  reviewRequests: true,
  marketingMessages: false,
  doNotContact: false,
  timezone: "America/New_York",
};

beforeEach(() => vi.clearAllMocks());

describe("classifySmsKeyword", () => {
  it("classifies stop variants", () => {
    for (const w of ["STOP", "stop", "stop.", "Unsubscribe", "CANCEL", "quit", "end"]) {
      expect(classifySmsKeyword(w)).toBe("stop");
    }
  });
  it("classifies help and start", () => {
    expect(classifySmsKeyword("HELP")).toBe("help");
    expect(classifySmsKeyword("info")).toBe("help");
    expect(classifySmsKeyword("START")).toBe("start");
    expect(classifySmsKeyword("unstop")).toBe("start");
  });
  it("does not match keywords embedded in a sentence", () => {
    expect(classifySmsKeyword("please stop calling me")).toBeNull();
    expect(classifySmsKeyword("my AC stopped working")).toBeNull();
    expect(classifySmsKeyword("hello")).toBeNull();
  });
});

describe("isQuietHours / localHour (America/New_York, EST)", () => {
  it("computes the local hour", () => {
    expect(localHour(new Date("2026-01-07T15:00:00Z"), "America/New_York")).toBe(10);
  });
  it("is quiet at 21:00 and 00:00 local, not at 10:00", () => {
    expect(isQuietHours(new Date("2026-01-07T02:00:00Z"), "America/New_York")).toBe(true); // 21:00 EST
    expect(isQuietHours(new Date("2026-01-07T05:00:00Z"), "America/New_York")).toBe(true); // 00:00 EST
    expect(isQuietHours(new Date("2026-01-07T15:00:00Z"), "America/New_York")).toBe(false); // 10:00 EST
  });
  it("falls back to default tz on an invalid timezone", () => {
    expect(() => localHour(new Date(), "Not/AZone")).not.toThrow();
  });
});

describe("checkSendAllowed", () => {
  const base = { organizationId: ORG, customerId: CUST, channel: "sms" as const };
  // A daytime instant so quiet hours never interferes unless asserted.
  const daytime = new Date("2026-01-07T15:00:00Z"); // 10:00 EST

  it("allows when no customerId (cannot resolve consent)", async () => {
    const d = await checkSendAllowed({ ...base, customerId: null, triggerType: "follow_up" });
    expect(d.allowed).toBe(true);
  });

  it("blocks do-not-contact across everything", async () => {
    mockPrefs({ ...FULL_PREFS, doNotContact: true });
    const d = await checkSendAllowed({ ...base, triggerType: "appointment_scheduled", now: daytime });
    expect(d).toEqual({ allowed: false, reason: "do_not_contact" });
  });

  it("blocks a disabled channel", async () => {
    mockPrefs({ ...FULL_PREFS, smsEnabled: false });
    const d = await checkSendAllowed({ ...base, triggerType: "appointment_scheduled", now: daytime });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("channel_disabled:sms");
  });

  it("blocks a disabled message type (marketing off -> follow_up)", async () => {
    mockPrefs({ ...FULL_PREFS, marketingMessages: false });
    const d = await checkSendAllowed({ ...base, triggerType: "follow_up", now: daytime });
    expect(d.reason).toBe("type_disabled:follow_up");
  });

  it("blocks a reminder during quiet hours but allows a transactional confirmation", async () => {
    mockPrefs(FULL_PREFS);
    const night = new Date("2026-01-07T05:00:00Z"); // 00:00 EST
    const reminder = await checkSendAllowed({ ...base, triggerType: "appointment_reminder_24h", now: night });
    expect(reminder).toEqual({ allowed: false, reason: "quiet_hours" });
    const confirm = await checkSendAllowed({ ...base, triggerType: "technician_enroute", now: night });
    expect(confirm.allowed).toBe(true); // transactional, quiet-hours-exempt
  });

  it("uses defaults when the customer has no preferences row", async () => {
    mockPrefs(null);
    const ok = await checkSendAllowed({ ...base, triggerType: "appointment_scheduled", now: daytime });
    expect(ok.allowed).toBe(true);
    // voice defaults to disabled
    const voice = await checkSendAllowed({ ...base, channel: "voice", triggerType: "appointment_scheduled", now: daytime });
    expect(voice.reason).toBe("channel_disabled:voice");
  });

  it("allows a fully-permitted send", async () => {
    mockPrefs(FULL_PREFS);
    const d = await checkSendAllowed({ ...base, triggerType: "appointment_scheduled", now: daytime });
    expect(d).toEqual({ allowed: true });
  });
});
