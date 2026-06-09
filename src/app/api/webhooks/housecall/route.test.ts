import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeWebhookSignature } from "@/lib/integrations/housecall-pro/webhook-signature";

// Route test for POST /api/webhooks/housecall. Signature verification is the
// SECURITY-critical path, so we keep it REAL (the actual HMAC code runs) and
// mock only the secret source, the apply step, rate-limit, and the logger. The
// real HCP API and the DB stay entirely out of the test.

const SECRET = "whsec_test_secret";
const getOrgWebhookSecret = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/integrations/housecall-pro/webhook-secret-queries", () => ({
  getOrgWebhookSecret: () => getOrgWebhookSecret(),
}));

const applyWebhookEvent = vi.fn();
vi.mock("@/lib/integrations/housecall-pro/webhook-sync", () => ({
  applyWebhookEvent: (...args: unknown[]) => applyWebhookEvent(...args),
}));

const allowed = { value: true };
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: allowed.value }),
  RATE_LIMITS: { chat: { maxRequests: 20, windowMs: 60_000 } },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The route only needs DEMO_ORG_ID; the real module imports "server-only"
// (throws under vitest), so provide just the constant.
vi.mock("@/lib/tenancy/organization", () => ({
  DEMO_ORG_ID: "00000000-0000-0000-0000-000000000001",
}));

import { POST } from "./route";

function makeRequest(body: string, signature: string | null): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set("x-housecallpro-signature", signature);
  }
  return new Request("https://app.test/api/webhooks/housecall", {
    method: "POST",
    headers,
    body,
  });
}

const validBody = JSON.stringify({
  id: "evt_1",
  event: "job.completed",
  data: { id: "job_1", work_status: "completed" },
});

beforeEach(() => {
  allowed.value = true;
  getOrgWebhookSecret.mockReset();
  getOrgWebhookSecret.mockResolvedValue(SECRET);
  applyWebhookEvent.mockReset();
  applyWebhookEvent.mockResolvedValue({ outcome: "applied" });
});

describe("POST /api/webhooks/housecall", () => {
  it("accepts a VALID signature and applies the event (200)", async () => {
    const sig = computeWebhookSignature(validBody, SECRET);
    const res = await POST(makeRequest(validBody, sig) as never);

    expect(res.status).toBe(200);
    expect(applyWebhookEvent).toHaveBeenCalledTimes(1);
    const [, event] = applyWebhookEvent.mock.calls[0]!;
    expect(event).toMatchObject({
      eventId: "evt_1",
      eventType: "job.completed",
      hcpJobId: "job_1",
    });
  });

  it("rejects an INVALID signature with 401 and never applies", async () => {
    const res = await POST(makeRequest(validBody, "deadbeef") as never);
    expect(res.status).toBe(401);
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects a signature for a DIFFERENT body (replay/tamper) with 401", async () => {
    const sig = computeWebhookSignature(validBody, SECRET);
    const tampered = JSON.stringify({
      id: "evt_1",
      event: "job.canceled",
      data: { id: "job_1" },
    });
    const res = await POST(makeRequest(tampered, sig) as never);
    expect(res.status).toBe(401);
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("fails CLOSED with 401 when no webhook secret is configured", async () => {
    getOrgWebhookSecret.mockResolvedValue(null);
    const sig = computeWebhookSignature(validBody, SECRET);
    const res = await POST(makeRequest(validBody, sig) as never);
    expect(res.status).toBe(401);
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON (after a valid signature)", async () => {
    const body = "not-json";
    const sig = computeWebhookSignature(body, SECRET);
    const res = await POST(makeRequest(body, sig) as never);
    expect(res.status).toBe(400);
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed-but-structurally-invalid event", async () => {
    const body = JSON.stringify({ event: "job.completed" }); // missing id
    const sig = computeWebhookSignature(body, SECRET);
    const res = await POST(makeRequest(body, sig) as never);
    expect(res.status).toBe(400);
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("rate-limits with 429 before doing any work", async () => {
    allowed.value = false;
    const sig = computeWebhookSignature(validBody, SECRET);
    const res = await POST(makeRequest(validBody, sig) as never);
    expect(res.status).toBe(429);
    expect(getOrgWebhookSecret).not.toHaveBeenCalled();
  });
});
