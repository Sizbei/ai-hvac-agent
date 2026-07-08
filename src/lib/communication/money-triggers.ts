/**
 * Money-loop communication triggers (Stage: comms + memberships).
 *
 * Wires the three live money events into the EXISTING comms queue:
 *   1. estimate_sent   — the tokenized approval link, on estimate create.
 *   2. payment_receipt — a receipt, on a successful payment (TRANSACTIONAL).
 *   3. invoice_overdue — unpaid-invoice dunning, on a daily cron.
 *
 * Every send is enqueued via queueCommunicationJob, so the consent gate in
 * processPendingJobs is the single SEND chokepoint (TCPA/CAN-SPAM). Money is
 * stored in integer cents and formatted to dollars HERE for the SMS copy — a
 * raw-cents amount or a binding price never reaches a message body. The estimate
 * SMS carries the LINK ONLY (the binding price lives behind the tokenized page).
 *
 * Pattern mirrors triggers.ts (look up the active per-org template, then enqueue).
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { communicationTemplates, customers, invoices } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { formatCentsExact } from "@/lib/admin/money-format";
import { getOrgConfig } from "@/lib/admin/org-config-queries";
import { generatePortalToken } from "@/lib/portal/portal-queries";
import { claimOutboundOnce } from "./outbound-ledger";
import { queueCommunicationJob } from "./job-queue";
import { logger } from "@/lib/logger";
import { isCollectible, invoiceRef, REMINDER_COOLDOWN_MS } from "@/lib/admin/invoice-collectible";
export { invoiceRef } from "@/lib/admin/invoice-collectible";

const DEFAULT_COMPANY_NAME = "Spears Services";

interface CustomerContact {
  readonly phone: string | null;
  readonly email: string | null;
  readonly name: string | null;
}

/** Lightweight tenant-scoped fetch of a customer's decrypted contact fields.
 *  (getCustomerById does heavy joins we don't need for a receipt/reminder.) */
async function getCustomerContact(
  organizationId: string,
  customerId: string,
): Promise<CustomerContact | null> {
  const [row] = await db
    .select({
      phoneEncrypted: customers.phoneEncrypted,
      emailEncrypted: customers.emailEncrypted,
      nameEncrypted: customers.nameEncrypted,
    })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
    .limit(1);
  if (!row) return null;
  const safe = (c: string | null): string | null => {
    if (!c) return null;
    try {
      return decrypt(c);
    } catch {
      return null;
    }
  };
  return {
    phone: safe(row.phoneEncrypted),
    email: safe(row.emailEncrypted),
    name: safe(row.nameEncrypted),
  };
}

interface OrgBrand {
  readonly companyName: string;
  readonly phoneNumber: string;
}

/** Resolve the org's display name + contact phone for message copy. */
async function getOrgBrand(organizationId: string): Promise<OrgBrand> {
  try {
    const config = await getOrgConfig(organizationId);
    return {
      companyName: config.companyName ?? DEFAULT_COMPANY_NAME,
      phoneNumber: config.businessInfo?.phone ?? "",
    };
  } catch {
    return { companyName: DEFAULT_COMPANY_NAME, phoneNumber: "" };
  }
}

/** Find the active SMS template for a trigger in an org, or null. */
async function findActiveSmsTemplate(
  organizationId: string,
  triggerType: "estimate_sent" | "payment_receipt" | "invoice_overdue",
): Promise<{ id: string } | null> {
  const tpl = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, organizationId),
      eq(communicationTemplates.triggerType, triggerType),
      eq(communicationTemplates.templateType, "sms"),
      eq(communicationTemplates.isActive, true),
    ),
    columns: { id: true },
  });
  return tpl ?? null;
}


/**
 * Send the estimate approval LINK to the customer (SMS, falling back to email).
 * The plaintext approval token is only available at create time, so the caller
 * passes the fully-built approvalUrl. Best-effort: never throws.
 */
export async function triggerEstimateSent(params: {
  readonly organizationId: string;
  readonly customerId: string;
  readonly approvalUrl: string;
}): Promise<void> {
  try {
    const contact = await getCustomerContact(
      params.organizationId,
      params.customerId,
    );
    if (!contact || (!contact.phone && !contact.email)) return;

    const brand = await getOrgBrand(params.organizationId);
    const variables = {
      customerName: contact.name ?? "",
      approvalUrl: params.approvalUrl,
      companyName: brand.companyName,
      phoneNumber: brand.phoneNumber,
    };

    const smsTemplate = await findActiveSmsTemplate(
      params.organizationId,
      "estimate_sent",
    );
    if (smsTemplate && contact.phone) {
      await queueCommunicationJob({
        organizationId: params.organizationId,
        templateId: smsTemplate.id,
        triggerType: "estimate_sent",
        channel: "sms" as never,
        recipientPhone: contact.phone,
        templateVariables: variables,
        priority: 50,
        customerId: params.customerId,
      });
    } else if (contact.email) {
      // No SMS path (no phone or no SMS template) — try an email template.
      const emailTemplate = await db.query.communicationTemplates.findFirst({
        where: and(
          eq(communicationTemplates.organizationId, params.organizationId),
          eq(communicationTemplates.triggerType, "estimate_sent"),
          eq(communicationTemplates.templateType, "email_html"),
          eq(communicationTemplates.isActive, true),
        ),
        columns: { id: true },
      });
      if (emailTemplate) {
        await queueCommunicationJob({
          organizationId: params.organizationId,
          templateId: emailTemplate.id,
          triggerType: "estimate_sent",
          channel: "email" as never,
          recipientEmail: contact.email,
          templateVariables: variables,
          priority: 50,
          customerId: params.customerId,
        });
      }
    }
  } catch (error) {
    logger.error(
      { error, organizationId: params.organizationId },
      "triggerEstimateSent failed (best-effort)",
    );
  }
}

/**
 * Enqueue a payment receipt (TRANSACTIONAL) for the invoice's customer. Prefers
 * SMS. The amount is formatted to dollars here — never raw cents. Best-effort:
 * a comms failure must never fail the payment that already succeeded.
 */
export async function triggerPaymentReceipt(params: {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly customerId: string;
  readonly amountCents: number;
}): Promise<void> {
  try {
    const contact = await getCustomerContact(
      params.organizationId,
      params.customerId,
    );
    if (!contact || !contact.phone) return; // SMS-only for receipts

    const smsTemplate = await findActiveSmsTemplate(
      params.organizationId,
      "payment_receipt",
    );
    if (!smsTemplate) return;

    const brand = await getOrgBrand(params.organizationId);
    await queueCommunicationJob({
      organizationId: params.organizationId,
      templateId: smsTemplate.id,
      triggerType: "payment_receipt",
      channel: "sms" as never,
      recipientPhone: contact.phone,
      templateVariables: {
        customerName: contact.name ?? "",
        amount: formatCentsExact(params.amountCents),
        invoiceNumber: invoiceRef(params.invoiceId),
        companyName: brand.companyName,
        phoneNumber: brand.phoneNumber,
      },
      priority: 60,
      customerId: params.customerId,
    });
  } catch (error) {
    logger.error(
      { error, organizationId: params.organizationId, invoiceId: params.invoiceId },
      "triggerPaymentReceipt failed (best-effort)",
    );
  }
}

/**
 * One-click manual collections reminder for a single invoice. Unlike the weekly
 * dunning sweep, this is operator-initiated, so it is NOT gated by the 7-day
 * bucket — only a short 6h cooldown guards against accidental double-clicks.
 * Includes a real pay link (fresh portal token). Best-effort at SEND time
 * (consent + quiet hours enforced in processPendingJobs). Stamps
 * lastReminderSentAt so the UI can show "Reminded Nd ago".
 */
export async function sendInvoiceReminder(
  organizationId: string,
  invoiceId: string,
  now: Date = new Date(),
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly reason:
      "not_found" | "not_collectible" | "no_phone" | "no_template" | "cooldown" }
> {
  const [inv] = await db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
      state: invoices.state,
      lastReminderSentAt: invoices.lastReminderSentAt,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
    .limit(1);

  if (!inv || !inv.customerId) return { ok: false, reason: "not_found" };
  if (!isCollectible(inv)) return { ok: false, reason: "not_collectible" };
  const balanceCents = inv.totalCents - inv.amountPaidCents;
  if (
    inv.lastReminderSentAt &&
    now.getTime() - inv.lastReminderSentAt.getTime() < REMINDER_COOLDOWN_MS
  ) {
    return { ok: false, reason: "cooldown" };
  }

  const contact = await getCustomerContact(organizationId, inv.customerId);
  if (!contact || !contact.phone) return { ok: false, reason: "no_phone" };

  const smsTemplate = await findActiveSmsTemplate(organizationId, "invoice_overdue");
  if (!smsTemplate) return { ok: false, reason: "no_template" };

  // Real pay link: mint a fresh portal token for this customer.
  const token = await generatePortalToken(organizationId, inv.customerId);
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const payLink = token ? `${base}/portal/${token}` : "";

  const brand = await getOrgBrand(organizationId);

  // ATOMIC CLAIM: stamp the cooldown window in a single guarded UPDATE. Only the
  // first concurrent caller matches (the row's stamp is null or older than the
  // cooldown); a racing second caller matches 0 rows and is rejected here.
  const [claimed] = await db
    .update(invoices)
    .set({ lastReminderSentAt: now, updatedAt: now })
    .where(
      withTenant(
        invoices,
        organizationId,
        eq(invoices.id, invoiceId),
        or(
          isNull(invoices.lastReminderSentAt),
          lt(invoices.lastReminderSentAt, new Date(now.getTime() - REMINDER_COOLDOWN_MS)),
        )!,
      ),
    )
    .returning({ id: invoices.id });
  if (!claimed) return { ok: false, reason: "cooldown" };

  try {
    await queueCommunicationJob({
      organizationId,
      templateId: smsTemplate.id,
      triggerType: "invoice_overdue",
      channel: "sms" as never,
      recipientPhone: contact.phone,
      templateVariables: {
        customerName: contact.name ?? "",
        amount: formatCentsExact(balanceCents),
        invoiceNumber: invoiceRef(inv.id),
        invoiceId: inv.id,
        payLink,
        companyName: brand.companyName,
        phoneNumber: brand.phoneNumber,
      },
      priority: 30,
      customerId: inv.customerId,
    });
  } catch (error) {
    // Compensate: the side effect failed, so release the claim we just took by
    // restoring the prior stamp — otherwise the cooldown would block a retry of
    // a reminder that never actually went out. Best-effort (no transactions).
    await db
      .update(invoices)
      .set({ lastReminderSentAt: inv.lastReminderSentAt })
      .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
      .catch(() => {});
    throw error;
  }
  return { ok: true };
}

export interface DunningResult {
  readonly considered: number;
  readonly enqueued: number;
  readonly skipped: number;
}

/** Dunning cadence: only remind invoices open longer than this, and (via the
 *  ledger) at most once per this window so we never spam. */
const DUNNING_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DUNNING_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Run one dunning pass for an org: enqueue an invoice_overdue reminder for each
 * 'open' invoice older than DUNNING_MIN_AGE_MS, tenant-scoped by the row's own
 * organizationId (no session). Idempotent / spam-safe: the outbound ledger
 * claims one reminder per (customer, invoice, 7-day bucket) — a re-run, or two
 * runs in the same week, enqueues nothing new. The consent gate (quiet-hours +
 * do-not-contact) is still applied at SEND time in processPendingJobs.
 * Best-effort per invoice — one bad row never aborts the sweep.
 */
export async function sendOverdueInvoiceReminders(
  organizationId: string,
  now: Date = new Date(),
): Promise<DunningResult> {
  const cutoff = new Date(now.getTime() - DUNNING_MIN_AGE_MS);
  const overdue = await db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
    })
    .from(invoices)
    .where(
      withTenant(
        invoices,
        organizationId,
        eq(invoices.state, "open"),
        lt(invoices.createdAt, cutoff),
      ),
    );

  let enqueued = 0;
  let skipped = 0;
  const brand = await getOrgBrand(organizationId);

  for (const inv of overdue) {
    // Need a customer (consent + dedupe both key on it).
    if (!inv.customerId) {
      skipped++;
      continue;
    }

    // Spam guard: at most one reminder per 7-day bucket per invoice. Bucket the
    // ledger periodKey by week so a re-run inside the window claims nothing.
    const bucket = Math.floor(now.getTime() / DUNNING_PERIOD_MS);
    const claimed = await claimOutboundOnce({
      organizationId,
      customerId: inv.customerId,
      triggerType: "invoice_overdue",
      periodKey: `dunning:${inv.id}:${bucket}`,
    });
    if (!claimed) {
      skipped++;
      continue;
    }

    const contact = await getCustomerContact(organizationId, inv.customerId);
    if (!contact || !contact.phone) {
      skipped++;
      continue;
    }

    const smsTemplate = await findActiveSmsTemplate(
      organizationId,
      "invoice_overdue",
    );
    if (!smsTemplate) {
      skipped++;
      continue;
    }

    const balanceCents = Math.max(0, inv.totalCents - inv.amountPaidCents);
    try {
      await queueCommunicationJob({
        organizationId,
        templateId: smsTemplate.id,
        triggerType: "invoice_overdue",
        channel: "sms" as never,
        recipientPhone: contact.phone,
        templateVariables: {
          customerName: contact.name ?? "",
          amount: formatCentsExact(balanceCents),
          invoiceNumber: invoiceRef(inv.id),
          invoiceId: inv.id,
          payLink: "",
          companyName: brand.companyName,
          phoneNumber: brand.phoneNumber,
        },
        priority: 30,
        customerId: inv.customerId,
      });
      enqueued++;
      // Reflect the automated send in the UI (list chip + detail Activity) just like
      // the manual path does. Best-effort — the reminder is already queued.
      await db
        .update(invoices)
        .set({ lastReminderSentAt: now })
        .where(withTenant(invoices, organizationId, eq(invoices.id, inv.id)))
        .catch(() => {});
    } catch (error) {
      logger.error(
        { error, organizationId, invoiceId: inv.id },
        "Dunning enqueue failed for invoice",
      );
      skipped++;
    }
  }

  logger.info(
    { organizationId, considered: overdue.length, enqueued, skipped },
    "Dunning pass complete",
  );
  return { considered: overdue.length, enqueued, skipped };
}
