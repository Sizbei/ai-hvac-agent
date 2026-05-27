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
    return {
      userId: payload.userId as string,
      organizationId: payload.organizationId as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as "admin",
    };
  } catch {
    return null;
  }
}
