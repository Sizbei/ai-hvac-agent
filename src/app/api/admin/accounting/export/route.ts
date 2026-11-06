/**
 * Super-admin accounting export (parity Stage 10 — QuickBooks / accounting).
 *
 *   GET /api/admin/accounting/export?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]
 *     -> a downloadable journal file (text/csv attachment) of invoice/payment/
 *        refund/labor lines for the period, in a QBO-compatible shape.
 *
 * READ-ONLY: no writes to any money table. The file contains customer-adjacent
 * financial data (amounts, ids), so this is super_admin-gated like a signed
 * download (getAdminSession -> 401, isSuperAdmin -> 403) and read-rate-limited.
 * The export action is audited with the PERIOD + ROW COUNT only — never PII.
 *
 * from/to are BUSINESS days (the org's time zone, after-hours settings): the
 * period runs from that zone's midnight on `from` through the end of `to`, and
 * each row is dated in that zone. A full ISO timestamp is accepted for older
 * clients; only its date part is used.
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
import { getOrgTimeZone } from "@/lib/admin/org-time-zone";
import { isRealIsoDate } from "@/lib/admin/calendar-time";
import { zonedDayRange } from "@/lib/admin/zoned-date";

/** The YYYY-MM-DD day of a date param (plain date or ISO); null when invalid. */
function parseDayParam(value: string | null): string | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  return isRealIsoDate(day) ? day : null;
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
    const fromDay = parseDayParam(params.get("from"));
    const toDay = parseDayParam(params.get("to"));
    if (!fromDay || !toDay) {
      return errorResponse(
        "Pick both a start and end date.",
        "VALIDATION_ERROR",
        400,
      );
    }
    if (fromDay > toDay) {
      return errorResponse(
        "The start date must be on or before the end date.",
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

    const timeZone = await getOrgTimeZone(session.organizationId);
    const { fromDate, toDate } = zonedDayRange(fromDay, toDay, timeZone);
    const journal = await getAccountingExport(session.organizationId, {
      fromDate,
      toDate,
      timeZone,
    });

    const provider = getAccountingProvider();
    const body = provider.format(journal);

    const filename = `accounting-export-${fromDay}_to_${toDay}.${provider.fileExtension}`;

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
