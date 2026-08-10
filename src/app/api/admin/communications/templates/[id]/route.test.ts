/**
 * Tests for DC-2 (templates CRUD accepts all 15 live trigger types) and
 * DC-3 (delete is refused when send history exists, instead of the FK
 * cascade silently wiping communication_jobs rows).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { communicationTriggerTypeEnum } from "@/lib/db/schema";
import { COMMUNICATION_TRIGGER_TYPE_VALUES } from "@/lib/communication/sms-templates";

// ─── Hoisted mock state ────────────────────────────────────────────────────
const { templateQueue, jobQueue, deleteCalls, updateSetCalls } = vi.hoisted(
  () => ({
    templateQueue: [] as unknown[],
    jobQueue: [] as unknown[],
    deleteCalls: [] as string[],
    updateSetCalls: [] as Record<string, unknown>[],
  }),
);

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

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
        findFirst: vi.fn(() => Promise.resolve(templateQueue.shift() ?? null)),
      },
      communicationJobs: {
        findFirst: vi.fn(() => Promise.resolve(jobQueue.shift() ?? null)),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        updateSetCalls.push(vals);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([{ id: TEMPLATE_ID, ...vals }]),
            ),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => {
        deleteCalls.push(TEMPLATE_ID);
        return Promise.resolve();
      }),
    })),
  },
}));

import { DELETE, PATCH } from "./route";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";

const EXISTING_TEMPLATE = {
  id: TEMPLATE_ID,
  organizationId: SESSION.organizationId,
  key: "job_completed_sms",
  templateType: "sms",
  triggerType: "job_completed",
};

function deleteReq() {
  return new NextRequest(
    `https://app.example.com/api/admin/communications/templates/${TEMPLATE_ID}`,
    { method: "DELETE" },
  );
}

function patchReq(body: unknown) {
  return new NextRequest(
    `https://app.example.com/api/admin/communications/templates/${TEMPLATE_ID}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: TEMPLATE_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  templateQueue.length = 0;
  jobQueue.length = 0;
  deleteCalls.length = 0;
  updateSetCalls.length = 0;
  getAdminSession.mockResolvedValue(SESSION);
});

describe("DELETE /api/admin/communications/templates/[id] (DC-3)", () => {
  it("refuses to delete a template with communication_jobs send history", async () => {
    templateQueue.push(EXISTING_TEMPLATE);
    jobQueue.push({ id: "job-1" });

    const res = await DELETE(deleteReq(), ctx());
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("HAS_SEND_HISTORY");
    // Copy points the operator at deactivation, never a fake "fallback".
    expect(body.error.message).toMatch(/deactivate/i);
    expect(body.error.message).not.toMatch(/fallback/i);
    expect(deleteCalls).toHaveLength(0);
  });

  it("deletes a template with no send history", async () => {
    templateQueue.push(EXISTING_TEMPLATE);
    jobQueue.push(null);

    const res = await DELETE(deleteReq(), ctx());
    const body = (await res.json()) as { data: { deleted: boolean } };

    expect(res.status).toBe(200);
    expect(body.data.deleted).toBe(true);
    expect(deleteCalls).toEqual([TEMPLATE_ID]);
  });
});

describe("PATCH /api/admin/communications/templates/[id] (DC-2)", () => {
  it("accepts every live communicationTriggerTypeEnum value", async () => {
    // The DB enum is the ground truth; the shared list (and therefore the
    // zod schema built from it) must cover exactly the same set.
    expect(COMMUNICATION_TRIGGER_TYPE_VALUES.slice().sort()).toEqual(
      communicationTriggerTypeEnum.enumValues.slice().sort(),
    );
    expect(COMMUNICATION_TRIGGER_TYPE_VALUES).toHaveLength(15);

    for (const triggerType of communicationTriggerTypeEnum.enumValues) {
      templateQueue.push(EXISTING_TEMPLATE);

      const res = await PATCH(patchReq({ triggerType }), ctx());
      expect(res.status, `triggerType=${triggerType}`).toBe(200);
    }

    expect(updateSetCalls.map((v) => v.triggerType)).toEqual(
      communicationTriggerTypeEnum.enumValues,
    );
  });

  it("rejects an unknown trigger type", async () => {
    templateQueue.push(EXISTING_TEMPLATE);

    const res = await PATCH(
      patchReq({ triggerType: "not_a_real_trigger" }),
      ctx(),
    );
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
