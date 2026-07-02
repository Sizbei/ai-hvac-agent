import { SignJWT, jwtVerify } from "jose";

/**
 * Technician session token — a SEPARATE session from the admin JWT (config.ts).
 *
 * Technicians authenticate into the field view (/tech) only; they must NEVER be
 * accepted as an admin session. We keep them apart two ways: (1) the role here is
 * the literal "technician", which the admin verifyToken explicitly rejects, and
 * (2) a distinct `aud` claim ("hvac-tech") that verifyTechToken requires and the
 * admin verifier never sets — so an admin token presented to the tech verifier is
 * refused, and vice versa, even though both sign with AUTH_SECRET.
 */
const ALGORITHM = "HS256";
const EXPIRATION = "24h";
const MIN_SECRET_LENGTH = 32;
const TECH_AUDIENCE = "hvac-tech";

export interface TechSessionPayload {
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly name: string;
  readonly role: "technician";
}

function getEncodedKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET environment variable must be set and at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signTechToken(
  payload: TechSessionPayload,
): Promise<string> {
  const encodedKey = getEncodedKey();
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALGORITHM })
    .setAudience(TECH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(EXPIRATION)
    .sign(encodedKey);
}

export async function verifyTechToken(
  token: string,
): Promise<TechSessionPayload | null> {
  try {
    const encodedKey = getEncodedKey();
    const { payload } = await jwtVerify(token, encodedKey, {
      algorithms: [ALGORITHM],
      // Require the tech audience — an admin token (no/other aud) fails here.
      audience: TECH_AUDIENCE,
    });
    if (
      typeof payload.userId !== "string" ||
      typeof payload.organizationId !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.name !== "string" ||
      payload.role !== "technician"
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      organizationId: payload.organizationId,
      email: payload.email,
      name: payload.name,
      role: "technician",
    };
  } catch {
    return null;
  }
}
