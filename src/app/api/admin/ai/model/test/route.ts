/**
 * POST /api/admin/ai/model/test  { modelId, prompt } -> { reply }
 *
 * Super-admin-gated stateless test: resolves the chosen registry entry
 * SERVER-SIDE, runs ONE bounded generateText against it, and returns the reply
 * text ONLY. It does NOT change the org's selection. If the model's API key env
 * var is empty it returns a clean { error: "key_not_configured" } (not a 500).
 * The baseUrl / modelId / key are NEVER echoed.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { getAdminSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/authz";
import { errorResponse, successResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getRegistryEntry } from "@/lib/ai/model-registry";

const TEST_MAX_TOKENS = 120;

const testSchema = z.object({
  modelId: z.string().trim().min(1, "modelId is required"),
  prompt: z.string().trim().min(1, "prompt is required").max(2000),
});

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `admin:ai-model-test:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = testSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        parsed.error.issues[0]?.message ?? "Invalid request",
        "VALIDATION_ERROR",
        400,
      );
    }

    const entry = getRegistryEntry(parsed.data.modelId);
    if (!entry) {
      return errorResponse("Unknown model id", "UNKNOWN_MODEL", 400);
    }

    const apiKey = process.env[entry.apiKeyEnv];
    if (!apiKey || apiKey.trim().length === 0) {
      // Clean signal, not a 500 — the key simply isn't wired up in this env.
      return successResponse({ error: "key_not_configured" });
    }

    const provider = createOpenAI({ baseURL: entry.baseUrl, apiKey });

    let reply: string;
    try {
      const result = await generateText({
        model: provider(entry.modelId),
        prompt: parsed.data.prompt,
        maxOutputTokens: TEST_MAX_TOKENS,
      });
      reply = result.text;
    } catch {
      // Don't surface the provider error body — it could echo config. Clean signal.
      return successResponse({ error: "model_call_failed" });
    }

    return successResponse({ reply });
  } catch (error: unknown) {
    logger.error({ error }, "AI model test failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
