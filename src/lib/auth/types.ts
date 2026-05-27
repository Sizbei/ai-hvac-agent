export interface AdminSessionPayload {
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly name: string;
  readonly role: "admin";
}
