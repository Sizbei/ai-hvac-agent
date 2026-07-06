/**
 * TDD tests for sendInvoiceReminder (Task 3).
 * Mocks DB (chainable select queue + update recorder), portal token mint,
 * job-queue, brand/contact stubs. Three cases: happy path, cooldown, no_balance.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { sendInvoiceReminder } from "./money-triggers";
import { queueCommunicationJob } from "./job-queue";

// ── Hoisted state ────────────────────────────────────────────────────────────
const { selectQueue, updateSetCalls, templateQueue } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updateSetCalls: [] as Record<string, unknown>[],
  templateQueue: [] as unknown[],
}));

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(selectQueue.shift() ?? [])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        updateSetCalls.push(vals);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: 'i1' }])),
            catch: vi.fn(() => Promise.resolve()),
          })),
        };
      }),
    })),
    query: {
      communicationTemplates: {
        findFirst: vi.fn(() => Promise.resolve(templateQueue.shift() ?? null)),
      },
    },
  },
}));

vi.mock("@/lib/db/tenant", () => ({
  withTenant: vi.fn((_t: unknown, _o: unknown, ...rest: unknown[]) => rest[0]),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lt: vi.fn(),
  gte: vi.fn(),
  sql: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock("@/lib/db/schema", () => ({
  invoices: {
    id: "id",
    customerId: "customerId",
    totalCents: "totalCents",
    amountPaidCents: "amountPaidCents",
    state: "state",
    lastReminderSentAt: "lastReminderSentAt",
    organizationId: "organizationId",
    updatedAt: "updatedAt",
  },
  customers: {
    id: "id",
    organizationId: "organizationId",
    phoneEncrypted: "phoneEncrypted",
    emailEncrypted: "emailEncrypted",
    nameEncrypted: "nameEncrypted",
  },
  communicationTemplates: {
    organizationId: "organizationId",
    triggerType: "triggerType",
    templateType: "templateType",
    isActive: "isActive",
  },
}));

vi.mock("@/lib/portal/portal-queries", () => ({
  generatePortalToken: vi.fn(async () => "TOK"),
}));

vi.mock("./job-queue", () => ({
  queueCommunicationJob: vi.fn(),
}));

vi.mock("@/lib/admin/org-config-queries", () => ({
  getOrgConfig: vi.fn().mockResolvedValue({
    companyName: "Acme HVAC",
    businessInfo: { phone: "+18005551212" },
  }),
}));

vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));

process.env.NEXT_PUBLIC_APP_URL = "https://app.test";

// ── Lifecycle ────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  updateSetCalls.length = 0;
  templateQueue.length = 0;
});

// ── Tests ────────────────────────────────────────────────────────────────────
describe("sendInvoiceReminder", () => {
  it("enqueues invoice_overdue SMS with a real pay link and stamps lastReminderSentAt", async () => {
    // invoice read: open, $50 balance, customer c1, never reminded
    const testNow = new Date("2026-07-06T12:00:00Z");
    selectQueue.push([{
      id: "i1",
      customerId: "c1",
      totalCents: 5000,
      amountPaidCents: 0,
      state: "open",
      lastReminderSentAt: null,
    }]);
    // customer contact read: phone present
    selectQueue.push([{ phoneEncrypted: "P", emailEncrypted: null, nameEncrypted: "N" }]);
    // active template read
    templateQueue.push({ id: "tpl-1" });

    const res = await sendInvoiceReminder("org-1", "i1", testNow);

    expect(res).toEqual({ ok: true });
    const call = (queueCommunicationJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.triggerType).toBe("invoice_overdue");
    expect(call.templateId).toBe("tpl-1");
    expect(call.templateVariables.payLink).toBe("https://app.test/portal/TOK");
    expect(call.templateVariables.amount).toBe("$50.00");
    // stamped last_reminder_sent_at via UPDATE
    expect(updateSetCalls[0].lastReminderSentAt).toEqual(testNow);
  });

  it("rejects when the last reminder was under 6h ago (cooldown)", async () => {
    selectQueue.push([{
      id: "i1",
      customerId: "c1",
      totalCents: 5000,
      amountPaidCents: 0,
      state: "open",
      lastReminderSentAt: new Date("2026-07-06T10:00:00Z"),
    }]);
    const res = await sendInvoiceReminder("org-1", "i1", new Date("2026-07-06T12:00:00Z"));
    expect(res).toEqual({ ok: false, reason: "cooldown" });
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });

  it("rejects a fully-paid invoice (no balance)", async () => {
    selectQueue.push([{
      id: "i1",
      customerId: "c1",
      totalCents: 5000,
      amountPaidCents: 5000,
      state: "paid",
      lastReminderSentAt: null,
    }]);
    const res = await sendInvoiceReminder("org-1", "i1", new Date());
    expect(res).toEqual({ ok: false, reason: "no_balance" });
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });
});
