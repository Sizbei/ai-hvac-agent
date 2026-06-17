/**
 * Equipment warranty tracking + proactive expiry reminders (lead-gen).
 *
 * listExpiringWarranties finds ACTIVE (non-retired) installed units whose
 * `warrantyExpiration` falls inside a look-ahead window, tenant-scoped, joined to
 * the owning customer's id (consent + dedupe both key on the customer).
 *
 * enqueueWarrantyReminders runs one sweep for an org: for each expiring unit it
 * claims a per-(equipment, month) slot in the outbound ledger, then enqueues a
 * consent-gated `warranty_expiring` SMS via the existing comms queue. The consent
 * gate (quiet-hours + do-not-contact + marketing toggle) is applied at SEND time
 * in processPendingJobs — this module only ENQUEUES. Idempotent: a re-run, or two
 * runs in the same month, claims nothing new. Best-effort per unit — one bad row
 * never aborts the sweep.
 *
 * The expiry window is keyed off the ORG's configured timezone (consistent with
 * the after-hours config), so "expires this month" means the org's local month.
 *
 * NOTE: this reminder system keys off `customerEquipment.warrantyExpiration`,
 * the single authoritative warranty-expiry column.
 */
import { and, eq, isNull, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerEquipment, customers, communicationTemplates } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { getOrgConfig } from "@/lib/admin/org-config-queries";
import { claimOutboundOnce } from "@/lib/communication/outbound-ledger";
import { queueCommunicationJob } from "@/lib/communication/job-queue";
import { logger } from "@/lib/logger";

const DEFAULT_COMPANY_NAME = "Spears Services";
/** How far ahead to look for an expiring warranty by default (days). */
export const DEFAULT_WARRANTY_WINDOW_DAYS = 30;

/** Human-readable label for an equipment_type enum value (for the SMS copy). */
const EQUIPMENT_LABELS: Record<string, string> = {
  ac: "A/C",
  furnace: "furnace",
  heat_pump: "heat pump",
  boiler: "boiler",
  mini_split: "mini split",
  thermostat: "thermostat",
  other: "HVAC system",
};

export interface ExpiringWarranty {
  readonly equipmentId: string;
  readonly customerId: string;
  readonly equipmentType: string;
  readonly warrantyExpiration: Date;
}

/**
 * List active (non-retired) equipment in an org whose `warrantyExpiration` falls
 * within [now, now + withinDays]. Tenant-scoped; only rows tied to a customer
 * (consent + dedupe need a customerId) are returned.
 */
export async function listExpiringWarranties(
  organizationId: string,
  withinDays: number = DEFAULT_WARRANTY_WINDOW_DAYS,
  now: Date = new Date(),
): Promise<readonly ExpiringWarranty[]> {
  const windowEnd = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      equipmentId: customerEquipment.id,
      customerId: customerEquipment.customerId,
      equipmentType: customerEquipment.equipmentType,
      warrantyExpiration: customerEquipment.warrantyExpiration,
    })
    .from(customerEquipment)
    .where(
      withTenant(
        customerEquipment,
        organizationId,
        // Active units only — never nudge about a retired/replaced unit.
        isNull(customerEquipment.retiredAt),
        gte(customerEquipment.warrantyExpiration, now),
        lte(customerEquipment.warrantyExpiration, windowEnd),
      ),
    );

  return rows.flatMap((r) =>
    r.warrantyExpiration
      ? [
          {
            equipmentId: r.equipmentId,
            customerId: r.customerId,
            equipmentType: r.equipmentType,
            warrantyExpiration: r.warrantyExpiration,
          },
        ]
      : [],
  );
}

export interface WarrantyReminderResult {
  readonly considered: number;
  readonly enqueued: number;
  readonly skipped: number;
}

interface CustomerContact {
  readonly phone: string | null;
  readonly name: string | null;
}

/** Tenant-scoped fetch of a customer's decrypted name + phone. */
async function getCustomerContact(
  organizationId: string,
  customerId: string,
): Promise<CustomerContact | null> {
  const [row] = await db
    .select({
      phoneEncrypted: customers.phoneEncrypted,
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
  return { phone: safe(row.phoneEncrypted), name: safe(row.nameEncrypted) };
}

/** Find the active warranty_expiring SMS template for an org, or null. */
async function findWarrantyTemplate(
  organizationId: string,
): Promise<{ id: string } | null> {
  const tpl = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, organizationId),
      eq(communicationTemplates.triggerType, "warranty_expiring"),
      eq(communicationTemplates.templateType, "sms"),
      eq(communicationTemplates.isActive, true),
    ),
    columns: { id: true },
  });
  return tpl ?? null;
}

/** The org-local "YYYY-MM" of a date — the dedupe bucket so a unit is nudged at
 *  most once per calendar month in the org's timezone. */
function orgLocalMonth(at: Date, timezone: string): string {
  try {
    // en-CA yields YYYY-MM-DD; slice to YYYY-MM.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
    })
      .format(at)
      .slice(0, 7);
  } catch {
    return at.toISOString().slice(0, 7);
  }
}

/** Format an expiry date for the SMS copy in the org timezone (e.g. "Jul 5"). */
function formatExpiry(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
    }).format(at);
  } catch {
    return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

/**
 * Run one warranty-expiry reminder pass for an org. Enqueues a consent-gated
 * `warranty_expiring` SMS for each active unit expiring within `withinDays`,
 * deduped via the outbound ledger to at most once per (equipment, org-local
 * month). Best-effort per unit; never throws. The send-time consent gate
 * (do-not-contact, marketing toggle, quiet hours) still applies in the drain.
 */
export async function enqueueWarrantyReminders(
  organizationId: string,
  now: Date = new Date(),
  withinDays: number = DEFAULT_WARRANTY_WINDOW_DAYS,
): Promise<WarrantyReminderResult> {
  const expiring = await listExpiringWarranties(organizationId, withinDays, now);

  let enqueued = 0;
  let skipped = 0;

  if (expiring.length === 0) {
    return { considered: 0, enqueued, skipped };
  }

  // Resolve org brand + timezone once for the whole sweep.
  const config = await getOrgConfig(organizationId);
  const companyName = config.companyName ?? DEFAULT_COMPANY_NAME;
  const phoneNumber =
    (config.businessInfo?.phone as string | undefined) ?? "";
  const timezone =
    (config.afterHoursConfig?.timezone as string | undefined) ??
    "America/New_York";

  const template = await findWarrantyTemplate(organizationId);

  for (const unit of expiring) {
    // Spam guard: one nudge per unit per org-local month. A re-run inside the
    // same month claims nothing.
    const periodKey = `warranty:${unit.equipmentId}:${orgLocalMonth(now, timezone)}`;
    const claimed = await claimOutboundOnce({
      organizationId,
      customerId: unit.customerId,
      triggerType: "warranty_expiring",
      periodKey,
    });
    if (!claimed) {
      skipped++;
      continue;
    }

    if (!template) {
      skipped++;
      continue;
    }

    try {
      const contact = await getCustomerContact(organizationId, unit.customerId);
      if (!contact || !contact.phone) {
        skipped++;
        continue;
      }

      await queueCommunicationJob({
        organizationId,
        templateId: template.id,
        triggerType: "warranty_expiring",
        channel: "sms" as never,
        recipientPhone: contact.phone,
        templateVariables: {
          customerName: contact.name ?? "",
          equipment:
            EQUIPMENT_LABELS[unit.equipmentType] ?? unit.equipmentType,
          expiryDate: formatExpiry(unit.warrantyExpiration, timezone),
          companyName,
          phoneNumber,
        },
        priority: 40,
        customerId: unit.customerId,
      });
      enqueued++;
    } catch (error) {
      logger.error(
        { error, organizationId, equipmentId: unit.equipmentId },
        "Warranty reminder enqueue failed for equipment",
      );
      skipped++;
    }
  }

  logger.info(
    { organizationId, considered: expiring.length, enqueued, skipped },
    "Warranty reminder pass complete",
  );
  return { considered: expiring.length, enqueued, skipped };
}
