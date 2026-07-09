/**
 * Super-admin accounting export (parity Stage 10 — QuickBooks / accounting).
 *
 *   GET /api/admin/accounting/export?from=ISO&to=ISO[&format=csv]
 *     -> a downloadable journal file (text/csv attachment) of invoice/payment/
 *        refund/labor lines for the period, in a QBO-compatible shape.
 *
 * READ-ONLY: no writes to any money table. The file contains customer-adjacent
 * financial data (amounts, ids), so this is super_admin-gated like a signed
 * download (getAdminSession -> 401, isSuperAdmin -> 403) and read-rate-limited.
 * The export action is audited with the PERIOD + ROW COUNT only — never PII.
 *
 * Money is integer cents in-DB; the journal converts cents->dollars at the
 * export boundary (in accounting-export.ts), never mutating stored cents.
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/admin/audit";
import { errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getAccountingExport } from "@/lib/admin/accounting-export";
import { getAccountingProvider } from "@/lib/accounting/accounting-provider";

/** Parse an ISO date param; returns null when absent/invalid. */
function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `admin:accounting-export:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const params = request.nextUrl.searchParams;
    const fromDate = parseDateParam(params.get("from"));
    const toDate = parseDateParam(params.get("to"));
    if (!fromDate || !toDate) {
      return errorResponse(
        "Both 'from' and 'to' are required ISO dates.",
        "VALIDATION_ERROR",
        400,
      );
    }
    if (fromDate > toDate) {
      return errorResponse(
        "'from' must be on or before 'to'.",
        "VALIDATION_ERROR",
        400,
      );
    }

    // format is reserved for future provider formats (e.g. IIF); only csv today.
    const format = (params.get("format") ?? "csv").toLowerCase();
    if (format !== "csv") {
      return errorResponse(
        "Unsupported export format. Only 'csv' is available.",
        "UNSUPPORTED_FORMAT",
        400,
      );
    }

    const journal = await getAccountingExport(session.organizationId, {
      fromDate,
      toDate,
    });

    const provider = getAccountingProvider();
    const body = provider.format(journal);

    const filename = `accounting-export-${params.get("from")?.slice(0, 10)}_to_${params.get("to")?.slice(0, 10)}.${provider.fileExtension}`;

    // Audit with PERIOD + COUNT only — no customer names, no amounts.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "accounting_exported",
      entity: "accounting_export",
      details: JSON.stringify({
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        nativeRowCount: journal.native.length,
        syncedRowCount: journal.synced.length,
        provider: provider.name,
      }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit accounting export");
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": `${provider.contentType}; charset=utf-8`,
        "Content-Disposition": `attachment; filename="${filename}"`,
        // Never cache a financial export at any shared layer.
        "Cache-Control": "no-store",
      },
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to build accounting export");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
