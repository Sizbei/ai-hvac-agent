import { NextRequest } from "next/server";
import { z } from "zod";
import { approveEstimate } from "@/lib/admin/estimate-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

// PUBLIC endpoint — authorized by the approval token, NOT an admin session.
// (proxy.ts only session-gates /api/admin/*, so this passes through.)
const approveSchema = z.object({
  token: z.string().min(1).max(200),
  optionId: z.string().uuid(),
  signatureName: z.string().trim().min(1).max(200),
});

export async function POST(request: NextRequest) {
  try {
    // IP is captured server-side (never trusted from the body) for the e-sign
    // record and to rate-limit by approver.
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    const rateCheck = slidingWindow(`estimate-approve:${ip}`, 10, 60_000);
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const parsed = approveSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid request", "VALIDATION_ERROR", 400);
    }

    const result = await approveEstimate({
      token: parsed.data.token,
      optionId: parsed.data.optionId,
      signatureName: parsed.data.signatureName,
      signatureIp: ip,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          // Don't disclose whether the token is wrong vs. consumed.
          return errorResponse("Estimate not found", "NOT_FOUND", 404);
        case "expired":
          return errorResponse("This estimate has expired", "EXPIRED", 410);
        case "already_decided":
          return errorResponse(
            "This estimate has already been signed",
            "ALREADY_DECIDED",
            409,
          );
        case "invalid_option":
          return errorResponse("Invalid option", "INVALID_OPTION", 400);
        default:
          return errorResponse("Could not approve", "VALIDATION_ERROR", 400);
      }
    }

    // Success WITHOUT leaking the estimate id or any tenant data.
    return successResponse({ approved: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to approve estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
