import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("@/lib/ai/customer-context", () => ({
  lookupCustomerContext: lookupMock,
}));

import { resolveVoiceIdentity } from "./resolve-voice-identity";

describe("resolveVoiceIdentity", () => {
  beforeEach(() => lookupMock.mockReset());

  it("returns null for absent/withheld ANI without calling the lookup", async () => {
    expect(await resolveVoiceIdentity("org1", null)).toBeNull();
    expect(await resolveVoiceIdentity("org1", "")).toBeNull();
    expect(await resolveVoiceIdentity("org1", "anonymous")).toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("resolves a caller by phone via lookupCustomerContext", async () => {
    lookupMock.mockResolvedValue({ customerId: "c1", doNotService: false, firstName: "Sam" });
    const ctx = await resolveVoiceIdentity("org1", "+18655551212");
    expect(ctx?.customerId).toBe("c1");
    expect(lookupMock).toHaveBeenCalledWith("org1", { phone: "+18655551212" });
  });

  it("degrades to null when the lookup throws", async () => {
    lookupMock.mockRejectedValueOnce(new Error("db down"));
    expect(await resolveVoiceIdentity("org1", "+18655551212")).toBeNull();
  });
});
