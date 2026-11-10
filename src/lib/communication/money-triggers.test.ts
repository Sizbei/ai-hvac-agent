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
  sendInvoicePayLink,
  invoiceRef,
} from "./money-triggers";
import { generatePortalToken } from "@/lib/portal/portal-queries";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { queueCommunicationJob } from "./job-queue";
import { db } from "@/lib/db";
import { claimOutboundOnce } from "./outbound-ledger";
import { TRIGGER_RULES } from "./consent";
import * as moneyTriggers from "./money-triggers";
import { getFeatures } from "@/lib/tenancy/features";
import { DEFAULT_FEATURES } from "@/lib/tenancy/feature-flags";

// ── Mocks ──────────────────────────────────────────────────────────────────
// server-only throws at import in a non-server env (vitest is not a React
// Server Component host). Stub it so the transitive import from portal-queries
// doesn't abort the entire test suite before any mocks apply.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/tenancy/features", () => ({ getFeatures: vi.fn() }));
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
    update: vi.fn(),
    execute: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFeatures).mockResolvedValue(DEFAULT_FEATURES);
});

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

describe("sendInvoicePayLink", () => {
  const INV = "abcdef12-3456-4789-8abc-def012345678";
  const REQ = "22222222-2222-4222-8222-222222222222";
  const ME = "33333333-3333-4333-8333-333333333333";
  const ACTOR = { requestId: REQ, techUserId: ME };
  const PREV = new Date("2026-11-01T10:00:00.000Z");
  const dialect = new PgDialect();
  const render = (q: unknown) => dialect.sqlToQuery(q as SQL);
  const openInvoice = {
    id: INV,
    customerId: CUST,
    totalCents: 12345,
    amountPaidCents: 0,
    state: "open",
    fieldpulseInvoiceId: null,
    hcpInvoiceId: null,
    payLinkSentAt: PREV,
  };
  const contactRow = { phoneEncrypted: "+15550100100", emailEncrypted: null, nameEncrypted: "Pat" };

  /** invoice read, then the contact read. */
  function arrange(inv: Record<string, unknown> | null, contact: Record<string, unknown> | null = contactRow) {
    mockSelectSequence([
      { kind: "single", rows: inv ? [inv] : [] },
      { kind: "single", rows: contact ? [contact] : [] },
    ]);
    vi.mocked(db.query.communicationTemplates.findFirst).mockResolvedValue({ id: "tpl-sent" } as never);
    vi.mocked(db.execute).mockResolvedValue({ rows: [{ id: INV }] } as never);
  }

  it("claims the cooldown, then mints the token, then queues (in that order)", async () => {
    arrange(openInvoice);
    const order: string[] = [];
    vi.mocked(db.execute).mockImplementation((async () => {
      order.push("claim");
      return { rows: [{ id: INV }] };
    }) as never);
    vi.mocked(generatePortalToken).mockImplementationOnce(async () => {
      order.push("mint");
      return "tok-portal";
    });
    vi.mocked(queueCommunicationJob).mockImplementationOnce(async () => {
      order.push("queue");
      return "job-1";
    });

    const r = await sendInvoicePayLink(ORG, INV, ACTOR);
    expect(r).toEqual({ ok: true });
    expect(order).toEqual(["claim", "mint", "queue"]);

    const claim = render(vi.mocked(db.execute).mock.calls[0][0]);
    const claimSql = claim.sql.replace(/\s+/g, " ");
    // 5 minutes: longer than the 2-minute idempotency takeover window.
    expect(claimSql).toMatch(/^UPDATE invoices SET pay_link_sent_at = \$1::timestamptz WHERE id = \$2::uuid AND organization_id = \$3::uuid AND \(pay_link_sent_at IS NULL OR pay_link_sent_at < \$4::timestamptz - interval '5 minutes'\) AND \(EXISTS \(SELECT 1 FROM appointment_assignments a JOIN appointments p ON p\.id = a\.appointment_id/);
    expect(claimSql).toContain("WHERE p.service_request_id = $5::uuid AND p.organization_id = $6::uuid AND a.organization_id = $7::uuid");
    expect(claimSql).toContain("a.technician_id = $8::uuid AND a.is_lead");
    expect(claimSql).toMatch(/\)\) RETURNING id$/);
    expect(claimSql).not.toContain("2 minutes");
    expect(claim.params).toHaveLength(8);
    expect(claim.params[0]).toBe(claim.params[3]); // one JS $now
    expect(claim.params.slice(1, 3)).toEqual([INV, ORG]);
    expect(claim.params.slice(4)).toEqual([REQ, ORG, ORG, ME]);
    expect(claim.sql).not.toContain("last_reminder_sent_at");

    const job = vi.mocked(queueCommunicationJob).mock.calls[0][0];
    expect(job).toMatchObject({
      organizationId: ORG,
      triggerType: "invoice_sent",
      priority: 50,
      customerId: CUST,
      templateId: "tpl-sent",
      channel: "sms",
      recipientPhone: "+15550100100",
    });
    expect(job.templateVariables).toEqual({
      customerName: "Pat",
      amount: "$123.45",
      invoiceNumber: "#ABCDEF12",
      payLink: expect.stringMatching(/\/portal\/tok-portal$/),
      companyName: "Acme HVAC",
      phoneNumber: "+18005551212",
    });
    expect(db.update).not.toHaveBeenCalled(); // last_reminder_sent_at untouched
  });

  it("releases the claim (WHERE pay_link_sent_at = $now, SET $previous) and rethrows on a token-mint throw", async () => {
    arrange(openInvoice);
    vi.mocked(generatePortalToken).mockRejectedValueOnce(new Error("mint down"));
    await expect(sendInvoicePayLink(ORG, INV, ACTOR)).rejects.toThrow("mint down");
    expect(queueCommunicationJob).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledTimes(2);
    const claim = render(vi.mocked(db.execute).mock.calls[0][0]);
    const release = render(vi.mocked(db.execute).mock.calls[1][0]);
    expect(release.sql).toBe(
      "UPDATE invoices SET pay_link_sent_at = $1::timestamptz WHERE id = $2::uuid AND organization_id = $3::uuid AND pay_link_sent_at = $4::timestamptz",
    );
    expect(release.params).toEqual([PREV.toISOString(), INV, ORG, claim.params[0]]);
  });

  it("releases on a null token too (definite failure before the queue)", async () => {
    arrange({ ...openInvoice, payLinkSentAt: null });
    vi.mocked(generatePortalToken).mockResolvedValueOnce(null);
    await expect(sendInvoicePayLink(ORG, INV, ACTOR)).rejects.toThrow();
    const release = render(vi.mocked(db.execute).mock.calls[1][0]);
    expect(release.params[0]).toBeNull();
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });

  it("send_failed with the claim KEPT when queueCommunicationJob throws", async () => {
    arrange(openInvoice);
    vi.mocked(queueCommunicationJob).mockRejectedValueOnce(new Error("insert maybe committed"));
    const r = await sendInvoicePayLink(ORG, INV, ACTOR);
    expect(r).toEqual({ ok: false, reason: "send_failed" });
    expect(db.execute).toHaveBeenCalledTimes(1); // the claim only — no release
  });

  it("cooldown when the claim matches 0 rows and the tech is still lead — no token minted, nothing queued", async () => {
    arrange(openInvoice);
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ still_lead: true }] } as never);
    expect(await sendInvoicePayLink(ORG, INV, ACTOR)).toEqual({ ok: false, reason: "cooldown" });
    const check = render(vi.mocked(db.execute).mock.calls[1][0]);
    expect(check.sql.replace(/\s+/g, " ")).toMatch(/^SELECT \(EXISTS \(SELECT 1 FROM appointment_assignments a/);
    expect(check.params).toEqual([REQ, ORG, ORG, ME]);
    expect(generatePortalToken).not.toHaveBeenCalled();
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });

  it("not_lead when the claim matches 0 rows because the lead moved (in-write gate) — nothing minted or queued", async () => {
    arrange(openInvoice);
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ still_lead: false }] } as never);
    expect(await sendInvoicePayLink(ORG, INV, ACTOR)).toEqual({ ok: false, reason: "not_lead" });
    expect(generatePortalToken).not.toHaveBeenCalled();
    expect(queueCommunicationJob).not.toHaveBeenCalled();
  });

  it("invoice_not_found when the invoice is missing", async () => {
    arrange(null);
    expect(await sendInvoicePayLink(ORG, INV, ACTOR)).toEqual({ ok: false, reason: "invoice_not_found" });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("synced_read_only for FieldPulse and HCP mirrors", async () => {
    arrange({ ...openInvoice, fieldpulseInvoiceId: "fp-1" });
    expect(await sendInvoicePayLink(ORG, INV, ACTOR)).toEqual({ ok: false, reason: "synced_read_only" });
    arrange({ ...openInvoice, hcpInvoiceId: "hcp-1" });
    expect(await sendInvoicePayLink(ORG, INV, ACTOR)).toEqual({ ok: false, reason: "synced_read_only" });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["draft", { state: "draft" }],
    ["paid", { state: "paid", amountPaidCents: 12345 }],
    ["zero balance", { amountPaidCents: 12345 }],
  ])("invoice_not_chargeable on %s", async (_label, patch) => {
    arrange({ ...openInvoice, ...patch });
    expect(await sendInvoicePayLink(ORG, INV, ACTOR)).toEqual({ ok: false, reason: "invoice_not_chargeable" });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("no_contact for a null customer_id", async () => {
    arrange({ ...openInvoice, customerId: null });
    expect(await sendInvoicePayLink(ORG, INV, ACTOR)).toEqual({ ok: false, reason: "no_contact" });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("no_contact when the customer has no phone (SMS only)", async () => {
    arrange(openInvoice, { phoneEncrypted: null, emailEncrypted: "a@b.co", nameEncrypted: "Pat" });
    expect(await sendInvoicePayLink(ORG, INV, ACTOR)).toEqual({ ok: false, reason: "no_contact" });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("PAY_LINK_DEMO_ORG_ID is no longer exported", () => {
    expect("PAY_LINK_DEMO_ORG_ID" in moneyTriggers).toBe(false);
  });

  it("pay_links_off when payLinks is off, before the contact read", async () => {
    arrange(openInvoice);
    vi.mocked(getFeatures).mockResolvedValue({ ...DEFAULT_FEATURES, payLinks: false });
    const r = await sendInvoicePayLink(ORG, INV, ACTOR);
    expect(r).toEqual({ ok: false, reason: "pay_links_off" });
    expect(db.select).toHaveBeenCalledTimes(1); // the invoice read only
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("pay_links_off when getFeatures throws (fail closed)", async () => {
    arrange(openInvoice);
    vi.mocked(getFeatures).mockRejectedValue(new Error("db down"));
    const r = await sendInvoicePayLink(ORG, INV, ACTOR);
    expect(r).toEqual({ ok: false, reason: "pay_links_off" });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("no_template without an active invoice_sent SMS template", async () => {
    arrange(openInvoice);
    vi.mocked(db.query.communicationTemplates.findFirst).mockResolvedValue(undefined as never);
    expect(await sendInvoicePayLink(ORG, INV, ACTOR)).toEqual({ ok: false, reason: "no_template" });
    expect(db.execute).not.toHaveBeenCalled();
  });
});

void mockSelect; // kept for symmetry; sequence helper covers the cases above
