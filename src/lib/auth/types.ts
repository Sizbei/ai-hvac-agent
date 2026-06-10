/**
 * Roles that may hold an admin session. `super_admin` is the top tier within an
 * organization (manages admins, protected from demotion); `admin` is a normal
 * dashboard operator. `technician` is NOT an admin-session role and must never
 * appear here — verifyToken rejects it.
 */
export type AdminRole = "super_admin" | "admin";

export interface AdminSessionPayload {
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly name: string;
  readonly role: AdminRole;
}
