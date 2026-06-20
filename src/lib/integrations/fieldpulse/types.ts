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
  readonly role?: string | null; // e.g. "technician" — used to filter the roster
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
  readonly workStatus?: string; // e.g. "en_route", "in_progress", "completed"
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

/**
 * A Fieldpulse invoice (their "Invoice" resource), narrowed to what the mirror
 * needs. Money is in CENTS here (the client parses the API's dollar strings).
 * Verified against the live API 2026-06-19.
 */
export interface FieldpulseInvoice {
  readonly id: string;
  readonly jobId?: string | null; // The associated job id
  readonly customerId?: string | null;
  readonly status?: string | null; // Real API: an int, stringified (informational)
  readonly totalCents?: number | null;
  readonly amountPaidCents?: number | null; // Real API exposes amount_paid
  readonly amountUnpaidCents?: number | null; // Real API exposes amount_unpaid
  readonly dueDate?: string | null;
  readonly paidAt?: string | null; // From last_payment_date
  readonly createdAt?: string | null;
}

/** Invoice status values from Fieldpulse (adjusted per actual docs). */
export type FieldpulseInvoiceStatus = "draft" | "sent" | "viewed" | "paid" | "void" | "overdue";

/** Invoice webhook event type. */
export interface FieldpulseInvoiceEvent {
  readonly id: string; // Event id for idempotency
  readonly eventType: "invoice.sent" | "invoice.paid" | "invoice.voided" | "invoice.updated";
  readonly invoiceId: string;
  readonly jobId?: string | null; // May be present to link to a job
  readonly invoice?: FieldpulseInvoice | null; // Full invoice payload if provided
}

/** Geocoding result from Fieldpulse (if they provide address validation). */
export interface FieldpulseGeocodeResult {
  readonly valid: boolean;
  readonly normalizedAddress?: FieldpulseAddress | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly error?: string | null;
}

/** Input to validate an address against Fieldpulse. */
export interface GeocodeInput {
  readonly street?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zip?: string | null;
  readonly country?: string | null;
}
