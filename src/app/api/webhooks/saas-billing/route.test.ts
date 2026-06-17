import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { webhook: { maxRequests: 200, windowMs: 60_000 } },
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const applyBillingEvent = vi.fn();
vi.mock("@/lib/billing/webhook-sync", async () => {
  const actual = await vi.importActual<typeof import("@/lib/billing/webhook-sync")>(
    "@/lib/billing/webhook-sync",
  );
  return {
    ...actual,
    applyBillingEvent: (...a: unknown[]) => applyBillingEvent(...a),
  };
});

import { NextRequest } from "next/server";
import { computeBillingSignature } from "@/lib/billing/webhook-signature";
import { POST } from "./route";

const SECRET = "whsec_test";
const ORG = "00000000-0000-0000-0000-000000000001";

function req(body: string, signature?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-saas-billing-signature"] = signature;
  return new NextRequest("https://app.example.com/api/webhooks/saas-billing", {
    method: "POST",
    headers,
    body,
  });
}

const EVENT = JSON.stringify({
  id: "evt_1",
  type: "subscription.created",
  orgId: ORG,
  planId: "pro",
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SAAS_BILLING_WEBHOOK_SECRET;
});

describe("POST /api/webhooks/saas-billing", () => {
  it("FAILS CLOSED with 401 when no webhook secret is configured", async () => {
    const res = await POST(req(EVENT, "anything"));
    expect(res.status).toBe(401);
    expect(applyBillingEvent).not.toHaveBeenCalled();
  });

  it("401 on a missing/invalid signature when a secret IS configured", async () => {
    process.env.SAAS_BILLING_WEBHOOK_SECRET = SECRET;
    expect((await POST(req(EVENT))).status).toBe(401); // no header
    expect((await POST(req(EVENT, "bad"))).status).toBe(401); // wrong sig
    expect(applyBillingEvent).not.toHaveBeenCalled();
  });

  it("verifies a good signature and applies the event (200)", async () => {
    process.env.SAAS_BILLING_WEBHOOK_SECRET = SECRET;
    applyBillingEvent.mockResolvedValue({ outcome: "applied" });
    const sig = computeBillingSignature(EVENT, SECRET);
    const res = await POST(req(EVENT, sig));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.outcome).toBe("applied");
    expect(applyBillingEvent).toHaveBeenCalledOnce();
  });

  it("returns 200 for an idempotent redelivery (outcome=duplicate)", async () => {
    process.env.SAAS_BILLING_WEBHOOK_SECRET = SECRET;
    applyBillingEvent.mockResolvedValue({ outcome: "duplicate" });
    const sig = computeBillingSignature(EVENT, SECRET);
    const res = await POST(req(EVENT, sig));
    expect(res.status).toBe(200);
    expect((await res.json()).data.outcome).toBe("duplicate");
  });

  it("400 on a malformed event that passes signature", async () => {
    process.env.SAAS_BILLING_WEBHOOK_SECRET = SECRET;
    const bad = JSON.stringify({ id: "x", type: "nope", orgId: ORG });
    const sig = computeBillingSignature(bad, SECRET);
    const res = await POST(req(bad, sig));
    expect(res.status).toBe(400);
    expect(applyBillingEvent).not.toHaveBeenCalled();
  });
});
