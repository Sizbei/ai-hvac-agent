/**
 * Customer notification for an auto-dispatch commit (book-on-the-call #2).
 *
 * When autopilot commits a technician, the customer's confirmation said only
 * "you're booked for <window>" — the tech was assigned seconds later in the
 * background and never communicated. This wires the (previously caller-less)
 * triggerAppointmentScheduled so the customer gets the Probook-style follow-up
 * on the existing communications queue: "your <service> is scheduled for
 * <date> at <window>. Technician: <name>."
 *
 * BEST-EFFORT by construction: consent + quiet hours are enforced at send time
 * by the queue processor (checkSendAllowed), a missing/inactive template means
 * no job is enqueued, and every failure here is caught + logged — assignment
 * must never fail or roll back because a courtesy message couldn't be queued.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { getOrgConfig } from "@/lib/admin/org-config-queries";
import { triggerAppointmentScheduled } from "@/lib/communication/triggers";
import { BUSINESS_TIME_ZONE } from "@/lib/admin/calendar-time";
import { logger } from "@/lib/logger";

const DEFAULT_COMPANY_NAME = "Spears Services";

function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

/** "no_cool" → "no cool" — readable in "Your <serviceType> is scheduled". */
function humanizeIssue(issueType: string | null): string {
  return issueType ? issueType.replaceAll("_", " ") : "service visit";
}

/** Time-only span in the BUSINESS timezone (the held bounds are Eastern-
 * anchored, so UTC would state the wrong hours — same rule as the booking
 * confirmation labels). E.g. "8:00 AM – 12:00 PM". */
function timeSpanLabel(start: Date, end: Date): string {
  const time = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: BUSINESS_TIME_ZONE,
    });
  return `${time(start)} – ${time(end)}`;
}

/**
 * Queue the "you're scheduled with technician X" message for a committed
 * auto-assignment. Never throws; a failure only means no courtesy message.
 */
export async function notifyCustomerOfAssignment(params: {
  readonly organizationId: string;
  readonly requestId: string;
  readonly technicianId: string;
  readonly window: { readonly start: Date; readonly end: Date };
}): Promise<void> {
  const { organizationId, requestId, technicianId, window } = params;
  try {
    const [[request], [tech]] = await Promise.all([
      db
        .select({
          customerId: serviceRequests.customerId,
          nameEncrypted: serviceRequests.customerNameEncrypted,
          phoneEncrypted: serviceRequests.customerPhoneEncrypted,
          emailEncrypted: serviceRequests.customerEmailEncrypted,
          addressEncrypted: serviceRequests.addressEncrypted,
          issueType: serviceRequests.issueType,
        })
        .from(serviceRequests)
        .where(
          withTenant(
            serviceRequests,
            organizationId,
            eq(serviceRequests.id, requestId),
          ),
        )
        .limit(1),
      db
        .select({ name: users.name })
        .from(users)
        .where(withTenant(users, organizationId, eq(users.id, technicianId)))
        .limit(1),
    ]);
    // No customer to address, or no way to reach them → nothing to queue.
    if (!request?.customerId || !tech) return;
    const phone = safeDecrypt(request.phoneEncrypted);
    const email = safeDecrypt(request.emailEncrypted);
    if (!phone && !email) return;

    let companyName = DEFAULT_COMPANY_NAME;
    let phoneNumber = "";
    try {
      const config = await getOrgConfig(organizationId);
      companyName = config.companyName ?? DEFAULT_COMPANY_NAME;
      phoneNumber = config.businessInfo?.phone ?? "";
    } catch {
      // Brand fallback is fine — the message still reads correctly.
    }

    await triggerAppointmentScheduled({
      organizationId,
      serviceRequestId: requestId,
      customerId: request.customerId,
      customerName: safeDecrypt(request.nameEncrypted) ?? "there",
      customerPhone: phone ?? undefined,
      customerEmail: email ?? undefined,
      technicianName: tech.name,
      appointmentDate: window.start,
      appointmentTime: timeSpanLabel(window.start, window.end),
      appointmentAddress: safeDecrypt(request.addressEncrypted) ?? "",
      serviceType: humanizeIssue(request.issueType),
      companyName,
      phoneNumber,
    });
  } catch (err) {
    logger.error(
      { error: err, serviceRequestId: requestId, technicianId },
      "notifyCustomerOfAssignment failed (non-fatal) — no courtesy message queued",
    );
  }
}
