import { SignJWT, jwtVerify } from "jose";
import type { AdminSessionPayload } from "./types";

const ALGORITHM = "HS256";
const EXPIRATION = "24h";
const MIN_SECRET_LENGTH = 32;

function getEncodedKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET environment variable must be set and at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signToken(
  payload: AdminSessionPayload,
): Promise<string> {
  const encodedKey = getEncodedKey();
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(EXPIRATION)
    .sign(encodedKey);
}

export async function verifyToken(
  token: string,
): Promise<AdminSessionPayload | null> {
  try {
    const encodedKey = getEncodedKey();
    const { payload } = await jwtVerify(token, encodedKey, {
      algorithms: [ALGORITHM],
    });
    // Validate the claims at runtime rather than blindly casting — a token
    // without role "admin" must never be accepted as an admin session.
    if (
      typeof payload.userId !== "string" ||
      typeof payload.organizationId !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.name !== "string" ||
      payload.role !== "admin"
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      organizationId: payload.organizationId,
      email: payload.email,
      name: payload.name,
      role: "admin",
    };
  } catch {
    return null;
  }
}
