import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/admin/staff-queries";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { createAdminSession } from "@/lib/auth/session";
import type { AdminRole } from "@/lib/auth/types";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

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
    const ip = clientIp(request);
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

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      return errorResponse("Invalid JSON body", "BAD_REQUEST", 400);
    }
    const parsed = loginSchema.safeParse(bodyResult.data);

    if (!parsed.success) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }

    // Canonicalize the email the same way createStaff does before persisting
    // (trim + lowercase). User rows are stored normalized, and Postgres text
    // equality is case-sensitive, so a mixed-case login would otherwise miss a
    // real row and fall through to the dummy-hash path — failing a legitimate
    // login AND leaking (via timing) that the exact-case email didn't exist.
    const { password } = parsed.data;
    const email = normalizeEmail(parsed.data.email);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Only an active admin-tier user (super_admin or admin) WITH a password is a
    // valid password login. A Google-only user has passwordHash === null and can
    // never log in this way — we treat it as ineligible and (critically) never
    // pass null to bcrypt.compare as the stored hash. For every ineligible case
    // (no user, wrong role, disabled, password-less), still run bcrypt.compare
    // against a dummy hash and return the SAME generic 401 so neither timing nor
    // the error message reveals whether the email exists or what's wrong.
    const adminRole: AdminRole | null =
      user && (user.role === "super_admin" || user.role === "admin")
        ? user.role
        : null;
    const eligibleUser =
      user && adminRole && user.isActive && user.passwordHash !== null
        ? { ...user, role: adminRole, passwordHash: user.passwordHash }
        : null;
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
      role: eligibleUser.role,
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
