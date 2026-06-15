/**
 * Fieldpulse API types.
 *
 * Narrowed from untrusted API responses; all fields are optional or nullable
 * to tolerate missing data and Fieldpulse schema changes.
 */

/** A Fieldpulse customer (their "Customer" resource). */
export interface FieldpulseCustomer {
  readonly id: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly company?: string | null;
  readonly address?: FieldpulseAddress | null;
}

/** Address shape within a customer or job. */
export interface FieldpulseAddress {
  readonly street?: string | null;
  readonly streetLine2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zip?: string | null;
  readonly country?: string | null;
}

/** A Fieldpulse job (their "Jobs" resource). */
export interface FieldpulseJob {
  readonly id: string;
  readonly customerId: string;
  readonly workStatus?: string | null;
  readonly description?: string | null;
  readonly scheduleStart?: string | null; // ISO datetime
  readonly scheduleEnd?: string | null; // ISO datetime
  readonly assignedUserId?: string | null; // The Fieldpulse user/technician id
  readonly createdAt?: string | null; // ISO datetime
}

/** A Fieldpulse user/team member (for technician roster). */
export interface FieldpulseUser {
  readonly id: string;
  readonly name?: string | null;
  readonly email?: string | null;
  readonly isActive?: boolean | null;
}

/** A Fieldpulse team (for grouping technicians). */
export interface FieldpulseTeam {
  readonly id: string;
  readonly name?: string | null;
}

/** Non-secret account metadata cache (company name, account id). */
export interface FieldpulseAccountInfo {
  readonly companyName?: string | null;
  readonly accountId?: string | null;
}

/** Input to create a Fieldpulse customer. */
export interface CreateCustomerInput {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly company?: string;
  readonly address?: FieldpulseAddress;
}

/** Input to create a Fieldpulse job. */
export interface CreateJobInput {
  readonly customerId: string;
  readonly description?: string;
  readonly scheduleStart?: string; // ISO datetime
  readonly scheduleEnd?: string; // ISO datetime
  readonly assignedUserId?: string;
  readonly requestId?: string; // Our internal request id, for tagging
}

/** Input to update a Fieldpulse job (reschedule/reassign). */
export interface UpdateJobInput {
  readonly description?: string;
  readonly scheduleStart?: string;
  readonly scheduleEnd?: string;
  readonly assignedUserId?: string;
}

/** Query to find an existing customer (by email or phone). */
export interface FindCustomerQuery {
  readonly email?: string;
  readonly phone?: string;
}

/** Availability range for listing bookable windows (if available). */
export interface FieldpulseAvailabilityRange {
  readonly startIso: string;
  readonly endIso: string;
}

/** An availability slot returned by Fieldpulse (if endpoint exists). */
export interface FieldpulseAvailabilitySlot {
  readonly startIso: string;
  readonly endIso: string;
  readonly userId?: string; // The technician/user this slot belongs to
}
