/**
 * Public review-response endpoint — authorized by the review token (NOT a
 * session). The customer submits a 1-5 rating + optional PRIVATE feedback; we
 * record it and the page then shows the public-review link to EVERYONE
 * (compliance: no sentiment routing). IP rate-limited.
 *
 * COMPLIANCE: the response is recorded the same way for every rating. There is
 * no branch that hides the public link from low raters.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { recordReviewResponse } from "@/lib/reviews/review-queries";
import { getReviewProvider } from "@/lib/reviews/review-provider";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const bodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  // PRIVATE free text. Bounded; never logged.
  feedback: z.string().trim().max(2000).optional(),
  clickedPublic: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const rate = slidingWindow(`review-respond:${ip}`, 10, 60_000);
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { token } = await params;
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid request", "VALIDATION_ERROR", 400);
    }

    const result = await recordReviewResponse(token, {
      rating: parsed.data.rating,
      feedback: parsed.data.feedback ?? null,
      clickedPublic: parsed.data.clickedPublic ?? false,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          return errorResponse("Review not found", "NOT_FOUND", 404);
        case "already_responded":
          return errorResponse(
            "This review has already been submitted",
            "ALREADY_RESPONDED",
            409,
          );
        default:
          return errorResponse("Could not submit", "VALIDATION_ERROR", 400);
      }
    }

    // COMPLIANCE: return the public link to EVERYONE, regardless of rating. The
    // org id isn't disclosed by the token, but the configured/mock provider link
    // is the same for the org, so a placeholder org id is safe here.
    const publicReviewUrl = getReviewProvider().getPublicReviewUrl("self");

    return successResponse({ submitted: true, publicReviewUrl });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to submit review response");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
