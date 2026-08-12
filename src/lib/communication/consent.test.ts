/**
 * Tests for the outbound consent gate + inbound STOP/HELP keyword handling.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkSendAllowed,
  classifySmsKeyword,
  isQuietHours,
  localHour,
  pickStartTarget,
  setDoNotContactByPhone,
} from "./consent";
import { db } from "@/lib/db";
import { findCustomerMatchCandidates } from "@/lib/admin/crm-queries";
import type { CustomerMatchCandidate } from "@/lib/admin/customer-match";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), batch: vi.fn() },
}));
vi.mock("@/lib/admin/crm-queries", () => ({
  findCustomerMatchCandidates: vi.fn(),
}));

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

  describe("demo org restriction (review_request pipeline)", () => {
    const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";

    it("blocks a review_request for the demo org, even with no customerId and no DB lookup", async () => {
      const d = await checkSendAllowed({
        organizationId: DEMO_ORG_ID,
        customerId: null,
        channel: "sms",
        triggerType: "review_request",
        now: daytime,
      });
      expect(d).toEqual({ allowed: false, reason: "demo_org_restricted" });
      // Short-circuits before any preference lookup.
      expect(db.select).not.toHaveBeenCalled();
    });

    it("blocks a review_request for the demo org even when the customer's own prefs allow it", async () => {
      mockPrefs(FULL_PREFS);
      const d = await checkSendAllowed({
        organizationId: DEMO_ORG_ID,
        customerId: CUST,
        channel: "sms",
        triggerType: "review_request",
        now: daytime,
      });
      expect(d).toEqual({ allowed: false, reason: "demo_org_restricted" });
    });

    it("does NOT block other trigger types for the demo org (live voice/chat demo must keep sending)", async () => {
      mockPrefs(FULL_PREFS);
      const d = await checkSendAllowed({
        organizationId: DEMO_ORG_ID,
        customerId: CUST,
        channel: "sms",
        triggerType: "appointment_scheduled",
        now: daytime,
      });
      expect(d).toEqual({ allowed: true });
    });

    it("does NOT block review_request for a non-demo org", async () => {
      mockPrefs(FULL_PREFS);
      const d = await checkSendAllowed({ ...base, triggerType: "review_request", now: daytime });
      expect(d).toEqual({ allowed: true });
    });
  });
});

// ── STOP / START asymmetry (SPEC §3.5) ────────────────────────────────────────

const PHONE = "+1 (800) 555-1212";

function candidate(
  over: Partial<CustomerMatchCandidate> & { readonly id: string },
): CustomerMatchCandidate {
  return {
    matchedOn: "phone",
    anonymizedAt: null,
    archivedAt: null,
    doNotService: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastActivityAt: null,
    ...over,
  };
}

/** Every preferences upsert the code built, in build order. */
let upserts: { customerId: string; doNotContact: boolean }[] = [];
/** The statement array handed to db.batch, or null when it was never called. */
let batched: unknown[] | null = null;

function mockConsentWrites(candidates: CustomerMatchCandidate[]) {
  upserts = [];
  batched = null;
  vi.mocked(findCustomerMatchCandidates).mockResolvedValue(candidates);
  vi.mocked(db.insert).mockImplementation(
    () =>
      ({
        values: (v: { customerId: string; doNotContact: boolean }) => {
          const stmt = { customerId: v.customerId, doNotContact: v.doNotContact };
          upserts.push(stmt);
          return { onConflictDoUpdate: () => stmt };
        },
      }) as never,
  );
  vi.mocked(db.batch).mockImplementation((stmts: unknown) => {
    batched = stmts as unknown[];
    return Promise.resolve([]) as never;
  });
}

describe("setDoNotContactByPhone — STOP fans out (SPEC §3.5)", () => {
  it("suppresses EVERY row on the number in one db.batch, not just one", async () => {
    mockConsentWrites([
      candidate({ id: "live" }),
      candidate({ id: "blocked", doNotService: true }),
      candidate({ id: "archived", archivedAt: new Date("2026-02-01T00:00:00Z") }),
    ]);

    const result = await setDoNotContactByPhone(ORG, PHONE, true);

    expect(result).toBe(true);
    expect(upserts.map((u) => u.customerId).sort()).toEqual([
      "archived",
      "blocked",
      "live",
    ]);
    expect(upserts.every((u) => u.doNotContact === true)).toBe(true);
    // One round trip for the fan-out (neon-http has no interactive transaction).
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(batched).toHaveLength(3);
  });

  it("takes candidates from the shared resolver, not its own phone SELECT", async () => {
    mockConsentWrites([candidate({ id: "live" })]);

    await setDoNotContactByPhone(ORG, PHONE, true);

    expect(findCustomerMatchCandidates).toHaveBeenCalledWith(
      ORG,
      { email: null, phone: PHONE },
      // limit: null — STOP is a fan-out; the resolver's winner-selection cap
      // must be lifted or a shared number saturates at 50 rows.
      { limit: null },
    );
    expect(db.select).not.toHaveBeenCalled();
  });

  it("writes nothing and returns false when the number matches no row", async () => {
    mockConsentWrites([]);

    expect(await setDoNotContactByPhone(ORG, PHONE, true)).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe("setDoNotContactByPhone — START touches exactly one row (SPEC §3.5)", () => {
  it("un-suppresses only the picked row and never a sibling on the same number", async () => {
    // `sibling` texted STOP earlier; `target` is the most recently active row.
    mockConsentWrites([
      candidate({ id: "sibling", lastActivityAt: new Date("2026-01-05T00:00:00Z") }),
      candidate({ id: "target", lastActivityAt: new Date("2026-03-01T00:00:00Z") }),
    ]);

    const result = await setDoNotContactByPhone(ORG, PHONE, false);

    expect(result).toBe(true);
    expect(upserts).toEqual([{ customerId: "target", doNotContact: false }]);
    // No fan-out on START: a sibling's opt-out must survive.
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("never re-opens a do-not-service row, even when it is the most recently active", async () => {
    mockConsentWrites([
      candidate({
        id: "blocked",
        doNotService: true,
        lastActivityAt: new Date("2026-03-01T00:00:00Z"),
      }),
      candidate({ id: "live", lastActivityAt: new Date("2026-01-05T00:00:00Z") }),
    ]);

    expect(await setDoNotContactByPhone(ORG, PHONE, false)).toBe(true);
    expect(upserts).toEqual([{ customerId: "live", doNotContact: false }]);
  });

  it("is a no-op when every candidate is blocked or archived", async () => {
    mockConsentWrites([
      candidate({ id: "blocked", doNotService: true }),
      candidate({ id: "archived", archivedAt: new Date("2026-02-01T00:00:00Z") }),
    ]);

    expect(await setDoNotContactByPhone(ORG, PHONE, false)).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe("pickStartTarget", () => {
  it("prefers the most recently active live row", () => {
    expect(
      pickStartTarget([
        candidate({ id: "old", lastActivityAt: new Date("2026-01-01T00:00:00Z") }),
        candidate({ id: "new", lastActivityAt: new Date("2026-04-01T00:00:00Z") }),
      ]),
    ).toBe("new");
  });

  it("ranks a row with activity above one with none", () => {
    expect(
      pickStartTarget([
        candidate({ id: "none", createdAt: new Date("2026-06-01T00:00:00Z") }),
        candidate({ id: "some", lastActivityAt: new Date("2026-01-01T00:00:00Z") }),
      ]),
    ).toBe("some");
  });

  it("falls back to newest created, then lowest id", () => {
    expect(
      pickStartTarget([
        candidate({ id: "older", createdAt: new Date("2026-01-01T00:00:00Z") }),
        candidate({ id: "newer", createdAt: new Date("2026-05-01T00:00:00Z") }),
      ]),
    ).toBe("newer");
    expect(
      pickStartTarget([candidate({ id: "b" }), candidate({ id: "a" })]),
    ).toBe("a");
  });

  it("skips anonymized, archived, and do-not-service rows", () => {
    expect(
      pickStartTarget([
        candidate({ id: "erased", anonymizedAt: new Date("2026-02-01T00:00:00Z") }),
        candidate({ id: "archived", archivedAt: new Date("2026-02-01T00:00:00Z") }),
        candidate({ id: "blocked", doNotService: true }),
      ]),
    ).toBeNull();
    expect(pickStartTarget([])).toBeNull();
  });
});
