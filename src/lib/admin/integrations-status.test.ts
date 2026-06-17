import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `server-only` throws when imported outside a React Server Component (vitest is
// a plain Node env), so stub it to an empty module — the guard is irrelevant here.
vi.mock("server-only", () => ({}));

// --- Mock the per-org connection queries (no DB) ---------------------------
const fieldpulseStatus = vi.fn();
const housecallStatus = vi.fn();
const googleStatus = vi.fn();
vi.mock("@/lib/integrations/fieldpulse/connection-queries", () => ({
  getFieldpulseConnectionStatus: () => fieldpulseStatus(),
}));
vi.mock("@/lib/integrations/housecall-pro/connection-queries", () => ({
  getHousecallConnectionStatus: () => housecallStatus(),
}));
vi.mock("@/lib/integrations/google-calendar/connection-queries", () => ({
  getGoogleConnectionStatus: () => googleStatus(),
}));

// --- Mock the provider seams (.name is what we read) -----------------------
const paymentName = vi.fn(() => "mock");
const financingName = vi.fn(() => "mock");
vi.mock("@/lib/payments/provider", () => ({
  getPaymentProvider: () => ({ name: paymentName() }),
}));
vi.mock("@/lib/financing/provider", () => ({
  getFinancingProvider: () => ({ name: financingName() }),
}));

// --- Mock the DB read for the AI model selection ---------------------------
const aiModelRow = vi.fn<() => Array<{ aiModelId: string | null }>>(() => []);
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(aiModelRow()),
        }),
      }),
    }),
  },
}));

import { getIntegrationsStatus } from "./integrations-status";

const ENV_KEYS = [
  "FIELDPULSE_API_KEY",
  "HOUSECALL_API_KEY",
  "STRIPE_SECRET_KEY",
  "WISETACK_API_KEY",
  "RESEND_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Snapshot + clear all integration env so each test starts from "not configured".
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Default: everything disconnected / mock.
  fieldpulseStatus.mockResolvedValue({ connected: false, accountInfo: null });
  housecallStatus.mockResolvedValue({ connected: false, accountInfo: null });
  googleStatus.mockResolvedValue({ connected: false, calendarId: null });
  paymentName.mockReturnValue("mock");
  financingName.mockReturnValue("mock");
  aiModelRow.mockReturnValue([]);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.clearAllMocks();
});

function byKey(items: Awaited<ReturnType<typeof getIntegrationsStatus>>) {
  return Object.fromEntries(items.map((i) => [i.key, i]));
}

describe("getIntegrationsStatus — mock vs live detection", () => {
  it("reports payments as 'mock' when provider name is mock", async () => {
    paymentName.mockReturnValue("mock");
    const items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.payments.status).toBe("mock");
  });

  it("reports payments as 'live' when provider name is not mock", async () => {
    paymentName.mockReturnValue("stripe");
    const items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.payments.status).toBe("live");
  });

  it("flags the 'live key present but adapter mock' nuance for payments", async () => {
    paymentName.mockReturnValue("mock");
    process.env.STRIPE_SECRET_KEY = "sk_live_dummy";
    const items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.payments.status).toBe("mock");
    expect(items.payments.detail.toLowerCase()).toContain("adapter is mock");
  });

  it("reports financing as 'mock' on the mock seam", async () => {
    financingName.mockReturnValue("mock");
    const items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.financing.status).toBe("mock");
  });

  it("marks email comms 'live' when RESEND_API_KEY is set, else not_configured", async () => {
    let items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.email.status).toBe("not_configured");

    process.env.RESEND_API_KEY = "re_dummy";
    items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.email.status).toBe("live");
    expect(items.email.detail.toLowerCase()).toContain("configured");
  });

  it("marks Twilio 'live' only when BOTH sid and auth token are present", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC_dummy";
    let items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.twilio.status).toBe("not_configured");

    process.env.TWILIO_AUTH_TOKEN = "tok_dummy";
    items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.twilio.status).toBe("live");
  });

  it("reports FSM as 'connected' when a per-org connection exists", async () => {
    fieldpulseStatus.mockResolvedValue({
      connected: true,
      accountInfo: { companyName: "Acme HVAC", accountId: "acct_123" },
    });
    const items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.fieldpulse.status).toBe("connected");
    expect(items.fieldpulse.detail).toContain("Acme HVAC");
  });

  it("reports FSM as 'live' on env-fallback key when not connected", async () => {
    process.env.FIELDPULSE_API_KEY = "fp_env_dummy";
    const items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.fieldpulse.status).toBe("live");
  });

  it("reports the AI model label when a selection is persisted", async () => {
    aiModelRow.mockReturnValue([{ aiModelId: "glm-4.6" }]);
    const items = byKey(await getIntegrationsStatus("org-1"));
    expect(items.ai_model.status).toBe("live");
    expect(items.ai_model.detail).toContain("GLM-4.6");
  });
});

describe("getIntegrationsStatus — secrecy contract", () => {
  it("never leaks any secret value in the output", async () => {
    // Set recognizable secret sentinels in every env var.
    process.env.FIELDPULSE_API_KEY = "SECRET_fp_key";
    process.env.HOUSECALL_API_KEY = "SECRET_hcp_key";
    process.env.STRIPE_SECRET_KEY = "SECRET_stripe_key";
    process.env.WISETACK_API_KEY = "SECRET_wisetack_key";
    process.env.RESEND_API_KEY = "SECRET_resend_key";
    process.env.TWILIO_ACCOUNT_SID = "SECRET_twilio_sid";
    process.env.TWILIO_AUTH_TOKEN = "SECRET_twilio_token";

    const items = await getIntegrationsStatus("org-1");
    const serialized = JSON.stringify(items);

    for (const secret of [
      "SECRET_fp_key",
      "SECRET_hcp_key",
      "SECRET_stripe_key",
      "SECRET_wisetack_key",
      "SECRET_resend_key",
      "SECRET_twilio_sid",
      "SECRET_twilio_token",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("emits only booleans/enums/labels — no raw key material in details", async () => {
    const items = await getIntegrationsStatus("org-1");
    for (const item of items) {
      expect(typeof item.status).toBe("string");
      expect(typeof item.configurable).toBe("boolean");
      // detail is a short human string, never base64/hex secret-shaped.
      expect(item.detail.length).toBeLessThan(120);
    }
  });
});
