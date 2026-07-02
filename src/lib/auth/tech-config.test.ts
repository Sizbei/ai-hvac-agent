import { describe, it, expect, beforeAll } from "vitest";
import { signTechToken, verifyTechToken } from "./tech-config";
import { signToken } from "./config";

beforeAll(() => {
  // getEncodedKey requires AUTH_SECRET >= 32 chars (shared with admin signing).
  process.env.AUTH_SECRET = "a".repeat(48);
});

const techPayload = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: "22222222-2222-2222-2222-222222222222",
  email: "tech@example.com",
  name: "Tess Tech",
  role: "technician" as const,
};

describe("tech session token", () => {
  it("round-trips a technician payload", async () => {
    const token = await signTechToken(techPayload);
    expect(await verifyTechToken(token)).toEqual(techPayload);
  });

  it("rejects a tampered token", async () => {
    const token = await signTechToken(techPayload);
    expect(await verifyTechToken(`${token}x`)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyTechToken("not.a.jwt")).toBeNull();
    expect(await verifyTechToken("")).toBeNull();
  });

  it("rejects an ADMIN token (no privilege crossover into the tech session)", async () => {
    const adminToken = await signToken({
      ...techPayload,
      role: "admin",
    });
    // An admin token presented to the tech verifier must be refused: its role is
    // not "technician" and it lacks the tech audience claim.
    expect(await verifyTechToken(adminToken)).toBeNull();
  });
});
