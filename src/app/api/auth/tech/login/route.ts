import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/admin/staff-queries";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { createTechSession } from "@/lib/auth/tech-session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Constant-time fallback so a wrong email and a wrong password are
// indistinguishable by timing (same dummy-hash compare). Mirrors the admin
// login route. Never matches (hash of an unknowable value).
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEeO3.q3O0Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Zu";

/**
 * POST /api/auth/tech/login — password login for FIELD TECHNICIANS only.
 *
 * Parallel to the admin login route but issues a separate technician session
 * (hvac_tech_session). Only an active, password-bearing user whose role is
 * exactly "technician" is eligible; admin-tier users must use /api/auth/login.
 * Every ineligible case still runs bcrypt.compare against a dummy hash and
 * returns the same generic 401 so the response can't enumerate accounts.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request);
    const rateCheck = slidingWindow(
      `auth:tech-login:${ip}`,
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

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      return errorResponse("Invalid JSON body", "BAD_REQUEST", 400);
    }
    const parsed = loginSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }

    const { password } = parsed.data;
    const email = normalizeEmail(parsed.data.email);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Eligible iff the row is an ACTIVE technician WITH a password. Anything else
    // (no row, admin-tier, disabled, Google-only) is ineligible; we still compare
    // against the dummy hash so timing/messages don't leak which condition failed.
    const eligibleUser =
      user &&
      user.role === "technician" &&
      user.isActive &&
      user.passwordHash !== null
        ? { ...user, passwordHash: user.passwordHash }
        : null;

    const passwordValid = await bcrypt.compare(
      password,
      eligibleUser ? eligibleUser.passwordHash : DUMMY_HASH,
    );

    if (!eligibleUser || !passwordValid) {
      return errorResponse("Invalid credentials", "INVALID_CREDENTIALS", 401);
    }

    await createTechSession({
      userId: eligibleUser.id,
      organizationId: eligibleUser.organizationId,
      email: eligibleUser.email,
      name: eligibleUser.name,
      role: "technician",
    });

    logger.info({ userId: eligibleUser.id }, "Technician login successful");

    return successResponse({
      user: {
        id: eligibleUser.id,
        name: eligibleUser.name,
        email: eligibleUser.email,
      },
      redirectTo: "/tech/jobs",
    });
  } catch (error) {
    logger.error({ error }, "Technician login failed");
    return errorResponse("Login failed", "LOGIN_FAILED", 500);
  }
}
