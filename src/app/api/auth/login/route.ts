import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { createAdminSession } from "@/lib/auth/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// A valid-looking bcrypt hash to compare against when no user (or no eligible
// user) is found. Comparing against it keeps the response time the same as a
// real wrong-password attempt, so an attacker can't enumerate accounts by
// timing. The hash is for a random unknowable value, so it never matches.
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEeO3.q3O0Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Zu";

export async function POST(request: NextRequest) {
  try {
    // Throttle login attempts per-IP to blunt credential brute-forcing. Reuse
    // the strict session-create budget (5/min) — admin login should be rare.
    const ip = request.headers.get("x-forwarded-for") ?? "unknown";
    const rateCheck = slidingWindow(
      `auth:login:${ip}`,
      RATE_LIMITS.sessionCreate.maxRequests,
      RATE_LIMITS.sessionCreate.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse(
        "Too many login attempts. Try again later.",
        "RATE_LIMITED",
        429,
      );
    }

    const body: unknown = await request.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }

    const { email, password } = parsed.data;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));

    // Only an active admin is a valid login. For any other case (no user,
    // wrong role, disabled), still run bcrypt.compare against a dummy hash and
    // return the SAME generic 401 so neither timing nor the error message
    // reveals whether the email exists or what's wrong with it.
    const eligibleUser =
      user && user.role === "admin" && user.isActive ? user : null;
    const passwordValid = await bcrypt.compare(
      password,
      eligibleUser ? eligibleUser.passwordHash : DUMMY_HASH,
    );

    if (!eligibleUser || !passwordValid) {
      return errorResponse(
        "Invalid credentials",
        "INVALID_CREDENTIALS",
        401,
      );
    }

    await createAdminSession({
      userId: eligibleUser.id,
      organizationId: eligibleUser.organizationId,
      email: eligibleUser.email,
      name: eligibleUser.name,
      role: "admin",
    });

    logger.info({ userId: eligibleUser.id }, "Admin login successful");

    return successResponse({
      user: {
        id: eligibleUser.id,
        name: eligibleUser.name,
        email: eligibleUser.email,
      },
    });
  } catch (error) {
    logger.error({ error }, "Login failed");
    return errorResponse("Login failed", "LOGIN_FAILED", 500);
  }
}
