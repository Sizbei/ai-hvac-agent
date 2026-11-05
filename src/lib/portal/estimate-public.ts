import "server-only";

/**
 * PUBLIC read for the /estimates/[token] page's frame: which org sent it (for
 * the name + phone header) and, once decided, what was approved. Authorized BY
 * THE TOKEN (its SHA-256 hash, same as getEstimateForApproval); never returns
 * the hash, the signature IP, or any cost.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { estimates, estimateOptions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { getOrgConfig } from "@/lib/admin/org-config-queries";
import { logger } from "@/lib/logger";

export interface EstimatePublicContext {
  readonly status: string;
  readonly createdAt: Date;
  readonly signedAt: Date | null;
  readonly signatureName: string | null;
  readonly soldOption: { readonly name: string; readonly totalCents: number } | null;
  readonly companyName: string | null;
  readonly phone: string | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function getEstimatePublicContext(
  token: string,
): Promise<EstimatePublicContext | null> {
  if (!token) return null;
  const [est] = await db
    .select({
      id: estimates.id,
      organizationId: estimates.organizationId,
      status: estimates.status,
      createdAt: estimates.createdAt,
      signedAt: estimates.signedAt,
      signatureName: estimates.signatureName,
      soldOptionId: estimates.soldOptionId,
    })
    .from(estimates)
    .where(eq(estimates.approvalTokenHash, hashToken(token)))
    .limit(1);
  if (!est) return null;

  const [soldOption, brand] = await Promise.all([
    est.soldOptionId
      ? db
          .select({ name: estimateOptions.name, totalCents: estimateOptions.totalCents })
          .from(estimateOptions)
          .where(
            withTenant(
              estimateOptions,
              est.organizationId,
              eq(estimateOptions.id, est.soldOptionId),
              eq(estimateOptions.estimateId, est.id),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    getOrgConfig(est.organizationId)
      .then((c) => ({
        companyName: c.companyName?.trim() || null,
        phone: c.businessInfo?.phone?.trim() || null,
      }))
      .catch((error: unknown) => {
        logger.warn({ error }, "Estimate page org brand lookup failed");
        return { companyName: null, phone: null };
      }),
  ]);

  return {
    status: est.status,
    createdAt: est.createdAt,
    signedAt: est.signedAt,
    signatureName: est.signatureName,
    soldOption,
    ...brand,
  };
}
