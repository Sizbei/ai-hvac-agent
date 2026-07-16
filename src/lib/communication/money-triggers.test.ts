/**
 * Tests for the money-loop comms triggers: estimate_sent, payment_receipt, and
 * invoice_overdue (dunning). Mocks the DB + the comms queue + side deps so we can
 * assert WHAT gets enqueued (channel, recipient, template variables) without any
 * real DB or send.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  triggerEstimateSent,
  triggerPaymentReceipt,
  sendOverdueInvoiceReminders,
  invoiceRef,
} from "./money-triggers";
import { queueCommunicationJob } from "./job-queue";
import { db } from "@/lib/db";
import { claimOutboundOnce } from "./outbound-ledger";
import { TRIGGER_RULES } from "./consent";

// ── Mocks ──────────────────────────────────────────────────────────────────
// server-only throws at import in a non-server env (vitest is not a React
// Server Component host). Stub it so the transitive import from portal-queries
// doesn't abort the entire test suite before any mocks apply.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/portal/portal-queries", () => ({
  generatePortalToken: vi.fn().mockResolvedValue("tok-portal"),
}));
vi.mock("./job-queue", () => ({ queueCommunicationJob: vi.fn().mockResolvedValue("job-1") }));
vi.mock("./outbound-ledger", () => ({ claimOutboundOnce: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/admin/org-config-queries", () => ({
  getOrgConfig: vi.fn().mockResolvedValue({
    companyName: "Acme HVAC",
    businessInfo: { phone: "+18005551212" },
  }),
}));
// decrypt is the identity here so a stored "value" reads back as itself.
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));

// db has both a fluent select() (for customer/invoice reads) and db.query
// (for template lookups). Build a flexible chainable.
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    query: {
      communicationTemplates: { findFirst: vi.fn() },
    },
  },
}));

const ORG = "org-1";
const CUST = "cust-1";

/** Make db.select resolve a single row (via .limit) OR a list (via .where). */
function mockSelect(rows: Record<string, unknown>[]) {
  const where = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(rows),
  });
  // `.where(...)` is itself awaitable for list queries (dunning has no .limit()).
  Object.assign(where, { then: undefined });
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      // For list queries (no .limit), the dunning code awaits the .where() result.
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as never);
  return where;
}

/** Customer-contact read returns via .limit; invoice list read returns via .where.
 *  These need different shapes, so allow sequencing select() return values. */
function mockSelectSequence(
  results: Array<{ kind: "single" | "list"; rows: Record<string, unknown>[] }>,
) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            const r = results[i++] ?? { kind: "single", rows: [] };
            if (r.kind === "single") {
              return { limit: vi.fn().mockResolvedValue(r.rows) };
            }
            // list: the .where() itself is awaited
            return Promise.resolve(r.rows);
          }),
        }),
      }) as never,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("invoiceRef", () => {
  it("derives a short uppercase reference from the invoice id", () => {
    expect(invoiceRef("abcdef12-3456-7890-aaaa-bbbbbbbbbbbb")).toBe("#ABCDEF12");
  });
});

describe("triggerEstimateSent", () => {
  it("enqueues an SMS whose body link is sent, and never a dollar figure", async () => {
    // customer-contact read (single row)
    mockSelectSequence([
      { kind: "single", rows: [{ phoneEncrypted: "+15551234567", emailEncrypted: null, nameEncrypted: "Pat" }] },
    ]);
    vi.mocked(db.query.communicationTemplates.findFirst).mockResolvedValue({ id: "tpl-est" } as never);

    const approvalUrl = "https://app.example.com/estimates/tok_abc";
    await triggerEstimateSent({ organizationId: ORG, customerId: CUST, approvalUrl });

    expect(queueCommunicationJob).toHaveBeenCalledTimes(1);
    const job = vi.mocked(queueCommunicationJob).mock.calls[0][0];
    expect(job.triggerType).toBe("estimate_sent");
    expect(job.channel).toBe("sms");
    expect(job.recipientPhone).toBe("+15551234567");
    // The approval LINK is present...
    expect(job.templateVariables.approvalUrl).toBe(approvalUrl);
    // ...and NO binding price / dollar figure is anywhere in the variables.
    const serialized = JSON.stringify(job.templateVariables);
    expect(serialized).not.toMatch(/\$\d/);
  });

  it("does nothing when the customer has no phone or email", async () => {
    mockSelectSequence([
      { kind: "single", rows: [{ phoneEncrypted: null, emailEncrypted: null, nameEncrypted: "Pat" }] },
    ]);
    await triggerEstimateSent({ organizationId: ORG, customerId: CUST, approvalUrl: "x" });
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });
});

describe("triggerPaymentReceipt", () => {
  it("enqueues a payment_receipt SMS with a dollar-formatted amount", async () => {
    mockSelectSequence([
      { kind: "single", rows: [{ phoneEncrypted: "+15551234567", emailEncrypted: null, nameEncrypted: "Pat" }] },
    ]);
    vi.mocked(db.query.communicationTemplates.findFirst).mockResolvedValue({ id: "tpl-rcpt" } as never);

    await triggerPaymentReceipt({
      organizationId: ORG,
      invoiceId: "abcdef12-0000-0000-0000-000000000000",
      customerId: CUST,
      amountCents: 12345,
    });

    expect(queueCommunicationJob).toHaveBeenCalledTimes(1);
    const job = vi.mocked(queueCommunicationJob).mock.calls[0][0];
    expect(job.triggerType).toBe("payment_receipt");
    expect(job.channel).toBe("sms");
    expect(job.templateVariables.amount).toBe("$123.45"); // cents -> dollars
    expect(job.templateVariables.invoiceNumber).toBe("#ABCDEF12");
  });

  it("skips when there is no phone (receipts are SMS-only)", async () => {
    mockSelectSequence([
      { kind: "single", rows: [{ phoneEncrypted: null, emailEncrypted: "a@b.co", nameEncrypted: "Pat" }] },
    ]);
    await triggerPaymentReceipt({ organizationId: ORG, invoiceId: "i", customerId: CUST, amountCents: 100 });
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });
});

describe("sendOverdueInvoiceReminders (dunning)", () => {
  it("enqueues a reminder for an aged open invoice with a balance", async () => {
    // 1st select = invoice list (list), 2nd = customer contact (single)
    mockSelectSequence([
      {
        kind: "list",
        rows: [
          { id: "abcdef12-0000-0000-0000-000000000000", customerId: CUST, totalCents: 20000, amountPaidCents: 5000 },
        ],
      },
      { kind: "single", rows: [{ phoneEncrypted: "+15551234567", emailEncrypted: null, nameEncrypted: "Pat" }] },
    ]);
    vi.mocked(db.query.communicationTemplates.findFirst).mockResolvedValue({ id: "tpl-dun" } as never);

    const r = await sendOverdueInvoiceReminders(ORG);
    expect(r.considered).toBe(1);
    expect(r.enqueued).toBe(1);
    expect(queueCommunicationJob).toHaveBeenCalledTimes(1);
    const job = vi.mocked(queueCommunicationJob).mock.calls[0][0];
    expect(job.triggerType).toBe("invoice_overdue");
    expect(job.templateVariables.amount).toBe("$150.00"); // remaining balance
  });

  it("is spam-safe: skips when the ledger already claimed the period", async () => {
    mockSelectSequence([
      {
        kind: "list",
        rows: [{ id: "i1", customerId: CUST, totalCents: 100, amountPaidCents: 0 }],
      },
    ]);
    vi.mocked(claimOutboundOnce).mockResolvedValueOnce(false);

    const r = await sendOverdueInvoiceReminders(ORG);
    expect(r.enqueued).toBe(0);
    expect(r.skipped).toBe(1);
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });

  it("considers no invoices when the org has none open+aged", async () => {
    mockSelectSequence([{ kind: "list", rows: [] }]);
    const r = await sendOverdueInvoiceReminders(ORG);
    expect(r).toEqual({ considered: 0, enqueued: 0, skipped: 0 });
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });
});

describe("consent rules exist for all money-loop triggers", () => {
  it("TRIGGER_RULES has an entry for each new trigger (else checkSendAllowed throws)", () => {
    for (const t of ["estimate_sent", "payment_receipt", "invoice_overdue"] as const) {
      expect(TRIGGER_RULES[t]).toBeDefined();
    }
    // Transactional money messages are quiet-hours exempt; dunning is gated.
    expect(TRIGGER_RULES.payment_receipt.quietHours).toBe(false);
    expect(TRIGGER_RULES.estimate_sent.quietHours).toBe(false);
    expect(TRIGGER_RULES.invoice_overdue.quietHours).toBe(true);
  });
});

void mockSelect; // kept for symmetry; sequence helper covers the cases above
