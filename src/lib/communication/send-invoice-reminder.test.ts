/**
 * TDD tests for sendInvoiceReminder (Task 3).
 * Mocks DB (chainable select queue + update recorder), portal token mint,
 * job-queue, brand/contact stubs. Three cases: happy path, cooldown, no_balance.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { sendInvoiceReminder, sendOverdueInvoiceReminders } from "./money-triggers";
import { queueCommunicationJob } from "./job-queue";
import { claimOutboundOnce } from "./outbound-ledger";

// ── Hoisted state ────────────────────────────────────────────────────────────
const { selectQueue, updateSetCalls, templateQueue } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updateSetCalls: [] as Record<string, unknown>[],
  templateQueue: [] as unknown[],
}));

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock("./outbound-ledger", () => ({
  claimOutboundOnce: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // Returns a thenable (for list queries awaited directly) that also has
        // .limit() (for single-row queries). Both consume from selectQueue at
        // the time where() is called, so sequencing is preserved.
        where: vi.fn(() => {
          const rows = selectQueue.shift() ?? [];
          return Object.assign(Promise.resolve(rows), {
            limit: vi.fn(() => Promise.resolve(rows)),
          });
        }),
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
    // active template read (SMS)
    templateQueue.push({ id: "tpl-1" });

    const res = await sendInvoiceReminder("org-1", "i1", testNow);

    expect(res).toEqual({ ok: true });
    const call = (queueCommunicationJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.triggerType).toBe("invoice_overdue");
    expect(call.templateId).toBe("tpl-1");
    expect(call.channel).toBe("sms");
    expect(call.templateVariables.payLink).toBe("https://app.test/portal/TOK");
    expect(call.templateVariables.amount).toBe("$50.00");
    // invoiceId must be included so reminder history can filter by it
    expect(call.templateVariables.invoiceId).toBe("i1");
    // stamped last_reminder_sent_at via UPDATE
    expect(updateSetCalls[0].lastReminderSentAt).toEqual(testNow);
  });

  it("falls back to EMAIL when customer has no phone but has email + email template", async () => {
    const testNow = new Date("2026-07-06T12:00:00Z");
    selectQueue.push([{
      id: "i1",
      customerId: "c1",
      totalCents: 5000,
      amountPaidCents: 0,
      state: "open",
      lastReminderSentAt: null,
    }]);
    // contact row: no phone, email present
    selectQueue.push([{ phoneEncrypted: null, emailEncrypted: "ENCEMAIL", nameEncrypted: "N" }]);
    // No SMS lookup (phone is null, so findActiveSmsTemplate is skipped).
    // email template lookup → found
    templateQueue.push({ id: "tpl-email" }); // emailTemplate (first and only findFirst call)

    const res = await sendInvoiceReminder("org-1", "i1", testNow);

    expect(res).toEqual({ ok: true });
    const call = (queueCommunicationJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.channel).toBe("email");
    expect(call.templateId).toBe("tpl-email");
    expect(call.recipientEmail).toBe("ENCEMAIL");
    expect(call.recipientPhone).toBeUndefined();
    // templateVariables identical to SMS path
    expect(call.templateVariables.invoiceId).toBe("i1");
    expect(call.templateVariables.payLink).toBe("https://app.test/portal/TOK");
    // claim UPDATE happened
    expect(updateSetCalls[0].lastReminderSentAt).toEqual(testNow);
  });

  it("returns no_contact when customer has neither phone nor email", async () => {
    selectQueue.push([{
      id: "i1",
      customerId: "c1",
      totalCents: 5000,
      amountPaidCents: 0,
      state: "open",
      lastReminderSentAt: null,
    }]);
    // contact: both null
    selectQueue.push([{ phoneEncrypted: null, emailEncrypted: null, nameEncrypted: null }]);

    const res = await sendInvoiceReminder("org-1", "i1", new Date("2026-07-06T12:00:00Z"));

    expect(res).toEqual({ ok: false, reason: "no_contact" });
    expect(queueCommunicationJob).not.toHaveBeenCalled();
    // no claim UPDATE
    const claimCall = updateSetCalls.find(c => "lastReminderSentAt" in c);
    expect(claimCall).toBeUndefined();
  });

  it("prefers SMS when both phone and SMS template exist (email template NOT consulted)", async () => {
    const testNow = new Date("2026-07-06T12:00:00Z");
    selectQueue.push([{
      id: "i1",
      customerId: "c1",
      totalCents: 5000,
      amountPaidCents: 0,
      state: "open",
      lastReminderSentAt: null,
    }]);
    // contact: both phone and email present
    selectQueue.push([{ phoneEncrypted: "PHONE", emailEncrypted: "EMAIL", nameEncrypted: "N" }]);
    // SMS template found → should use SMS; email template should NOT be queried
    templateQueue.push({ id: "tpl-sms" });
    // (no second template pushed — if email is consulted, templateQueue would return null)

    const res = await sendInvoiceReminder("org-1", "i1", testNow);

    expect(res).toEqual({ ok: true });
    const call = (queueCommunicationJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.channel).toBe("sms");
    expect(call.templateId).toBe("tpl-sms");
    expect(call.recipientPhone).toBe("PHONE");
    // Email template lookup must NOT have been called — SMS wins, so findFirst
    // is invoked exactly once (for the SMS template), never for email_html.
    const { db } = await import("@/lib/db");
    expect((db.query.communicationTemplates.findFirst as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    // templateQueue should now be empty (email template was NOT consumed)
    expect(templateQueue.length).toBe(0);
  });

  it("returns no_template when phone-less customer has email but no email template", async () => {
    selectQueue.push([{
      id: "i1",
      customerId: "c1",
      totalCents: 5000,
      amountPaidCents: 0,
      state: "open",
      lastReminderSentAt: null,
    }]);
    // contact: no phone, has email
    selectQueue.push([{ phoneEncrypted: null, emailEncrypted: "EMAIL", nameEncrypted: "N" }]);
    // No SMS lookup (phone is null). Email template: not found.
    templateQueue.push(undefined); // emailTemplate not found (only findFirst call)

    const res = await sendInvoiceReminder("org-1", "i1", new Date("2026-07-06T12:00:00Z"));

    expect(res).toEqual({ ok: false, reason: "no_template" });
    expect(queueCommunicationJob).not.toHaveBeenCalled();
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

  it("rejects a fully-paid invoice (not collectible)", async () => {
    selectQueue.push([{
      id: "i1",
      customerId: "c1",
      totalCents: 5000,
      amountPaidCents: 5000,
      state: "paid",
      lastReminderSentAt: null,
    }]);
    const res = await sendInvoiceReminder("org-1", "i1", new Date());
    expect(res).toEqual({ ok: false, reason: "not_collectible" });
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });

  it("rejects a refunded invoice even when totalCents > 0 (not collectible)", async () => {
    selectQueue.push([{
      id: "i1",
      customerId: "c1",
      totalCents: 5000,
      amountPaidCents: 0,
      state: "refunded",
      lastReminderSentAt: null,
    }]);
    const res = await sendInvoiceReminder("org-1", "i1", new Date());
    expect(res).toEqual({ ok: false, reason: "not_collectible" });
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });
});

describe("sendOverdueInvoiceReminders (dunning sweep)", () => {
  it("stamps lastReminderSentAt after a successful automated enqueue", async () => {
    const testNow = new Date("2026-07-06T12:00:00Z");

    // 1st select: overdue invoice list (awaited directly, no .limit())
    selectQueue.push([{
      id: "inv-1",
      customerId: "c1",
      totalCents: 10000,
      amountPaidCents: 0,
    }]);
    // 2nd select: customer contact (via getCustomerContact, uses .limit(1))
    selectQueue.push([{ phoneEncrypted: "+15551234567", emailEncrypted: null, nameEncrypted: "Pat" }]);
    // SMS template (hoisted outside loop): found
    templateQueue.push({ id: "tpl-dun" });
    // email template (hoisted outside loop): null (unused for phone customer)
    templateQueue.push(null);

    const r = await sendOverdueInvoiceReminders("org-1", testNow);
    expect(r.enqueued).toBe(1);
    expect(queueCommunicationJob).toHaveBeenCalledOnce();

    // The sweep must stamp lastReminderSentAt so the UI chip + Activity timeline
    // reflect the automated send (same as the manual sendInvoiceReminder path).
    const stampCall = updateSetCalls.find(c => "lastReminderSentAt" in c);
    expect(stampCall?.lastReminderSentAt).toEqual(testNow);

    // invoiceId must be included in the sweep path too
    const sweepCall = (queueCommunicationJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sweepCall.templateVariables.invoiceId).toBe("inv-1");
    expect(sweepCall.channel).toBe("sms");
  });

  it("falls back to email in sweep for a phone-less customer (enqueued++ + stamp written)", async () => {
    const testNow = new Date("2026-07-06T12:00:00Z");

    selectQueue.push([{
      id: "inv-2",
      customerId: "c2",
      totalCents: 8000,
      amountPaidCents: 0,
    }]);
    // contact: no phone, has email
    selectQueue.push([{ phoneEncrypted: null, emailEncrypted: "customer@example.com", nameEncrypted: "Alex" }]);
    // SMS template hoisted: null (no phone customers won't match, but template
    // is fetched once outside loop regardless)
    templateQueue.push(null);
    // email template hoisted: found
    templateQueue.push({ id: "tpl-email-sweep" });

    const r = await sendOverdueInvoiceReminders("org-1", testNow);
    expect(r.enqueued).toBe(1);
    expect(r.skipped).toBe(0);

    const sweepCall = (queueCommunicationJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sweepCall.channel).toBe("email");
    expect(sweepCall.templateId).toBe("tpl-email-sweep");
    expect(sweepCall.recipientEmail).toBe("customer@example.com");
    expect(sweepCall.recipientPhone).toBeUndefined();

    const stampCall = updateSetCalls.find(c => "lastReminderSentAt" in c);
    expect(stampCall?.lastReminderSentAt).toEqual(testNow);
  });

  it("skips invoice and does NOT claim ledger slot when neither SMS nor email template is configured", async () => {
    const testNow = new Date("2026-07-06T12:00:00Z");

    selectQueue.push([{
      id: "inv-3",
      customerId: "c3",
      totalCents: 6000,
      amountPaidCents: 0,
    }]);
    // contact: has both phone and email (so no_contact is not the reason)
    selectQueue.push([{ phoneEncrypted: "+15550000001", emailEncrypted: "a@b.com", nameEncrypted: "Sam" }]);
    // No SMS template configured
    templateQueue.push(null);
    // No email template configured
    templateQueue.push(null);

    const r = await sendOverdueInvoiceReminders("org-1", testNow);

    expect(r.enqueued).toBe(0);
    expect(r.skipped).toBe(1);
    expect(queueCommunicationJob).not.toHaveBeenCalled();
    // Critical: ledger slot must NOT have been consumed (Fix 1 guard)
    expect(claimOutboundOnce).not.toHaveBeenCalled();
  });
});
