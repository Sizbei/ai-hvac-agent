/**
 * DC-2: the create-template zod schema must accept every live
 * communicationTriggerTypeEnum value, including the four money-loop/warranty
 * triggers a seed script could previously insert but the admin CRUD rejected
 * (estimate_sent, payment_receipt, invoice_overdue, warranty_expiring).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { communicationTriggerTypeEnum } from "@/lib/db/schema";

const { insertedRows } = vi.hoisted(() => ({
  insertedRows: [] as Record<string, unknown>[],
}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));
// GET reads the viewer (server-only); POST still reads the session above.
vi.mock("@/lib/auth/viewer", () => ({ getViewerContext: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: {
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/admin/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      communicationTemplates: {
        // No existing template with this key — every POST reaches insert.
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        const row = { id: `row-${insertedRows.length}`, ...vals };
        insertedRows.push(row);
        return { returning: vi.fn(() => Promise.resolve([row])) };
      }),
    })),
  },
}));

import { POST } from "./route";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

function postReq(body: unknown) {
  return new NextRequest(
    "https://app.example.com/api/admin/communications/templates",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows.length = 0;
  getAdminSession.mockResolvedValue(SESSION);
});

describe("POST /api/admin/communications/templates (DC-2)", () => {
  it.each(communicationTriggerTypeEnum.enumValues)(
    "accepts triggerType %s",
    async (triggerType) => {
      const res = await POST(
        postReq({
          key: `${triggerType}_sms`,
          name: "Test template",
          triggerType,
          templateType: "sms",
          bodyTemplate: "Hello {{customerName}}",
        }),
      );
      expect(res.status).toBe(201);
    },
  );

  it("still rejects a trigger type outside the enum", async () => {
    const res = await POST(
      postReq({
        key: "bogus_sms",
        name: "Test template",
        triggerType: "not_a_real_trigger",
        templateType: "sms",
        bodyTemplate: "Hello {{customerName}}",
      }),
    );
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
