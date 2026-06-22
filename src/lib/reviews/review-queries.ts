/**
 * Reviews / reputation management — data access + the post-completion ask.
 *
 * On job completion we create one review request per completed job (idempotent:
 * the outbound ledger claims a `review:{serviceRequestId}` slot, and a partial
 * unique index on service_request_id is the backstop). The ask is enqueued
 * through the EXISTING comms queue, so the consent gate in processPendingJobs is
 * still the single send chokepoint (TCPA/CAN-SPAM). The public response page is
 * bearer-authorized by a sha256-hashed token (plaintext never stored).
 *
 * COMPLIANCE (FTC / Google ToS): there is NO sentiment routing. The public
 * review link is offered to EVERYONE on response, regardless of rating — see the
 * public page/handler. `feedback` is PRIVATE free text and is NEVER logged.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, reviewRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { getOrgConfig } from "@/lib/admin/org-config-queries";
import { claimOutboundOnce } from "@/lib/communication/outbound-ledger";
import { queueCommunicationJob } from "@/lib/communication/job-queue";
import { communicationTemplates } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

const DEFAULT_COMPANY_NAME = "Spears Services";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Tenant-scoped fetch of a customer's decrypted name + phone for the ask. */
async function getCustomerContact(
  organizationId: string,
  customerId: string,
): Promise<{ name: string | null; phone: string | null } | null> {
  const [row] = await db
    .select({
      nameEncrypted: customers.nameEncrypted,
      phoneEncrypted: customers.phoneEncrypted,
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
  return { name: safe(row.nameEncrypted), phone: safe(row.phoneEncrypted) };
}

/** Active SMS review_request template for the org, or null. */
async function findReviewTemplate(
  organizationId: string,
): Promise<{ id: string } | null> {
  const tpl = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, organizationId),
      eq(communicationTemplates.triggerType, "review_request"),
      eq(communicationTemplates.templateType, "sms"),
      eq(communicationTemplates.isActive, true),
    ),
    columns: { id: true },
  });
  return tpl ?? null;
}

export interface CreateReviewRequestResult {
  readonly created: boolean;
  readonly reason?: "duplicate" | "no_template" | "no_phone";
}

/**
 * Create the review request for a just-completed job and enqueue the ask.
 * Idempotent per job: the outbound ledger claims `review:{serviceRequestId}` —
 * a re-run (or a job that bounces back into completed) enqueues nothing new.
 * Best-effort by contract of the caller (wrapped in after()); returns a status
 * rather than throwing on the expected skip paths.
 */
export async function createReviewRequest(
  organizationId: string,
  serviceRequestId: string,
  customerId: string | null,
): Promise<CreateReviewRequestResult> {
  // Need a customer to consent-gate + dedupe + reach. No customer = nothing to do.
  if (!customerId) {
    return { created: false, reason: "no_phone" };
  }

  // Idempotency: claim the once-per-job slot BEFORE inserting/enqueuing.
  const claimed = await claimOutboundOnce({
    organizationId,
    customerId,
    triggerType: "review_request",
    periodKey: `review:${serviceRequestId}`,
  });
  if (!claimed) {
    return { created: false, reason: "duplicate" };
  }

  const template = await findReviewTemplate(organizationId);
  if (!template) {
    return { created: false, reason: "no_template" };
  }

  const contact = await getCustomerContact(organizationId, customerId);
  if (!contact || !contact.phone) {
    return { created: false, reason: "no_phone" };
  }

  // Create the row + a one-time token (only its hash is stored).
  const token = randomBytes(24).toString("hex");
  const id = randomUUID();
  await db.insert(reviewRequests).values({
    id,
    organizationId,
    serviceRequestId,
    customerId,
    status: "sent",
    reviewTokenHash: hashToken(token),
    sentAt: new Date(),
  });

  // Resolve brand for the message copy.
  let companyName = DEFAULT_COMPANY_NAME;
  try {
    const config = await getOrgConfig(organizationId);
    companyName = config.companyName ?? DEFAULT_COMPANY_NAME;
  } catch {
    // fall back to default company name
  }

  const reviewLink = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/review/${token}`;

  await queueCommunicationJob({
    organizationId,
    templateId: template.id,
    triggerType: "review_request",
    channel: "sms" as never,
    recipientPhone: contact.phone,
    templateVariables: {
      customerName: contact.name ?? "",
      serviceName: "service",
      reviewLink,
      companyName,
    },
    priority: 40,
    customerId,
    serviceRequestId,
  });

  return { created: true };
}

export type RecordReviewResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "already_responded" };

/**
 * Record a customer's response from the public token page. Token-authority:
 * the hashed token is the bearer of org membership (no session). Sets the rating
 * (1-5), optional PRIVATE feedback, and the public-click flag, flipping status
 * to responded. Guarded so a second submit on an already-responded request is a
 * no-op (the customer still gets shown the link by the page — compliance).
 */
export async function recordReviewResponse(
  token: string,
  input: {
    readonly rating: number;
    readonly feedback?: string | null;
    readonly clickedPublic?: boolean;
  },
): Promise<RecordReviewResult> {
  const [existing] = await db
    .select({ id: reviewRequests.id, status: reviewRequests.status })
    .from(reviewRequests)
    .where(eq(reviewRequests.reviewTokenHash, hashToken(token)))
    .limit(1);

  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status === "responded") {
    return { ok: false, reason: "already_responded" };
  }

  const [updated] = await db
    .update(reviewRequests)
    .set({
      status: "responded",
      rating: input.rating,
      feedback: input.feedback ?? null,
      publicClicked: input.clickedPublic ?? false,
      respondedAt: new Date(),
    })
    // Guard on the not-yet-responded state so two concurrent submits don't both
    // "win" — the second matches zero rows.
    .where(
      and(
        eq(reviewRequests.id, existing.id),
        eq(reviewRequests.status, existing.status),
      ),
    )
    .returning({ id: reviewRequests.id });

  if (!updated) {
    return { ok: false, reason: "already_responded" };
  }

  // Audit-safe log: rating is fine, free-text feedback is NOT — never log it.
  logger.info(
    { reviewRequestId: existing.id, rating: input.rating },
    "Review response recorded",
  );
  return { ok: true };
}

/**
 * Resolve a review request by its public token for the response page. Returns a
 * minimal, PII-free view (no feedback, no token hash). null = unknown token.
 */
export async function getReviewByToken(token: string): Promise<{
  readonly status: "pending" | "sent" | "responded";
  readonly rating: number | null;
} | null> {
  const [row] = await db
    .select({ status: reviewRequests.status, rating: reviewRequests.rating })
    .from(reviewRequests)
    .where(eq(reviewRequests.reviewTokenHash, hashToken(token)))
    .limit(1);
  return row ?? null;
}

export interface ReviewRow {
  readonly id: string;
  readonly serviceRequestId: string;
  readonly status: "pending" | "sent" | "responded";
  readonly rating: number | null;
  readonly publicClicked: boolean;
  readonly sentAt: string | null;
  readonly respondedAt: string | null;
  readonly createdAt: string;
}

/**
 * List an org's review requests, newest first. Tenant-scoped. Deliberately omits
 * the PRIVATE feedback and the token hash — the admin list shows rating + status
 * only (free-text feedback is never surfaced in aggregate UI).
 */
export async function listReviews(organizationId: string): Promise<ReviewRow[]> {
  const rows = await db
    .select({
      id: reviewRequests.id,
      serviceRequestId: reviewRequests.serviceRequestId,
      status: reviewRequests.status,
      rating: reviewRequests.rating,
      publicClicked: reviewRequests.publicClicked,
      sentAt: reviewRequests.sentAt,
      respondedAt: reviewRequests.respondedAt,
      createdAt: reviewRequests.createdAt,
    })
    .from(reviewRequests)
    .where(withTenant(reviewRequests, organizationId))
    .orderBy(desc(reviewRequests.createdAt));

  return rows.map((r) => ({
    id: r.id,
    serviceRequestId: r.serviceRequestId,
    status: r.status,
    rating: r.rating,
    publicClicked: r.publicClicked,
    sentAt: r.sentAt?.toISOString() ?? null,
    respondedAt: r.respondedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface ReviewStats {
  /** Total review requests created. */
  readonly count: number;
  /** Average rating across responded requests, or null if none responded. */
  readonly avgRating: number | null;
  /** Count of responded requests (response rate numerator). */
  readonly responded: number;
}

/** Aggregate review KPIs for an org: total asks, responded count, avg rating. */
export async function getReviewStats(
  organizationId: string,
): Promise<ReviewStats> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      responded: sql<number>`count(*) FILTER (WHERE ${reviewRequests.status} = 'responded')::int`,
      avgRating: sql<number | null>`avg(${reviewRequests.rating})`,
    })
    .from(reviewRequests)
    .where(withTenant(reviewRequests, organizationId));

  const count = row?.count ?? 0;
  const responded = row?.responded ?? 0;
  const avgRating =
    row?.avgRating === null || row?.avgRating === undefined
      ? null
      : Number(row.avgRating);
  return { count, avgRating, responded };
}
