import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { createAdminSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
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

    if (!user) {
      return errorResponse(
        "Invalid credentials",
        "INVALID_CREDENTIALS",
        401,
      );
    }

    if (user.role !== "admin") {
      return errorResponse("Access denied", "FORBIDDEN", 403);
    }

    if (!user.isActive) {
      return errorResponse("Account disabled", "ACCOUNT_DISABLED", 403);
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      return errorResponse(
        "Invalid credentials",
        "INVALID_CREDENTIALS",
        401,
      );
    }

    await createAdminSession({
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      name: user.name,
      role: "admin",
    });

    logger.info({ userId: user.id }, "Admin login successful");

    return successResponse({
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (error) {
    logger.error({ error }, "Login failed");
    return errorResponse("Login failed", "LOGIN_FAILED", 500);
  }
}
