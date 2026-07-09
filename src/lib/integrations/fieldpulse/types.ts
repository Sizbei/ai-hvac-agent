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
  // E.164-normalized phone (e.g. "+15135620292") — preferred over `phone` for
  // import; present on Phase-0.5-verified payloads (21/50 on page 1).
  readonly phoneE164?: string | null;
  readonly company?: string | null;
  readonly address?: FieldpulseAddress | null;
  // Human-readable display name (present on ALL Phase-0.5-verified rows).
  // Used as the primary name source for the inbound pull mapper.
  readonly displayName?: string | null;
  // Non-null when the customer has been soft-deleted — skip on import.
  readonly deletedAt?: string | null;
  // Non-null when the customer was merged into another — skip on import.
  // Points at the surviving record's id.
  readonly mergedCustomerId?: string | null;
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
  // ── Phase-4 import fields (LIVE-VERIFIED 2026-07-09, account 182499) ──
  // Free-text work classification (e.g. "HVAC DOWN", "Walk in beer cooler").
  readonly jobType?: string | null;
  // Secondary title — used as fallback when jobType is absent.
  readonly subtitle?: string | null;
  // Tech's internal notes (field_notes) and customer-visible notes (notes).
  readonly fieldNotes?: string | null;
  readonly notes?: string | null;
  // Integer status code (vocabulary: 4=completed confirmed; 1,2,3,6 TBD).
  readonly statusInt?: number | null;
  // Non-null when the job is soft-deleted — skip on import.
  readonly deletedAt?: string | null;
  // Non-null for terminal jobs (status 4, all have completed_at set).
  readonly completedAt?: string | null;
  // Customer-facing arrival window (may differ from schedule start/end).
  readonly arrivalWindowStart?: string | null;
  readonly arrivalWindowEnd?: string | null;
  // All technician assignments for this job; first entry is the primary.
  readonly assignments?: readonly { readonly userId: string }[];
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
 * One mirrored invoice line (flattened from the real API's nested
 * line_items[].line_components[]). Money in CENTS (client parses dollar strings).
 */
export interface FieldpulseInvoiceLineItem {
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly unitCostCents: number; // for margin (real API exposes unit_cost)
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
  readonly lineItems?: readonly FieldpulseInvoiceLineItem[];
  // Non-null when the invoice has been soft-deleted — skip on import.
  readonly deletedAt?: string | null;
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

/** A FieldPulse estimate (their "Estimates" resource). Money is in CENTS (client parses dollar strings). */
export interface FieldpulseEstimate {
  readonly id: string;
  readonly customerId?: string | null;
  readonly jobId?: string | null;
  readonly status?: string | null; // FP status string — mapped best-effort
  readonly subtotalCents?: number | null;
  readonly taxCents?: number | null;
  readonly totalCents?: number | null;
  readonly notes?: string | null;
  readonly dueDate?: string | null;
  readonly invoicedDate?: string | null;
  readonly createdAt?: string | null;
  readonly deletedAt?: string | null;
  /** Flattened line items from line_items[].line_components[] (same shape as invoices). */
  readonly lineItems?: readonly FieldpulseInvoiceLineItem[];
  /** Human-readable status label from the per-id GET /estimates/{id} response. */
  readonly customStatus?: string | null;
}

/** A FieldPulse payment (their "Payments" resource). Money is in CENTS (client parses dollar strings). */
export interface FieldpulsePayment {
  readonly id: string;
  readonly invoiceId?: string | null; // FP invoice id (not native)
  readonly customerId?: string | null;
  readonly paymentDate?: string | null;
  readonly amountCents?: number | null;
  readonly method?: string | null; // e.g. "cash", "check", "card", "other"
  readonly status?: string | null; // e.g. "paid", "completed", "pending"
  readonly deletedAt?: string | null;
}

/**
 * A FieldPulse comment (their "Comments" resource).
 * Live-verified 2026-07-09: all 11 records have commentable_type = BaseJob.
 */
export interface FieldpulseComment {
  readonly id: string;
  readonly text?: string | null;
  readonly authorId?: string | null;
  readonly commentableId?: string | null;
  readonly commentableType?: string | null;
  readonly createdAt?: string | null;
  readonly isVisibleInCustomerPortal?: boolean | null;
  readonly deletedAt?: string | null;
}

/**
 * A FieldPulse location (their "Locations" resource).
 * Live-verified 2026-07-09: object_types = BaseCustomer | BaseInvoice.
 */
export interface FieldpulseLocation {
  readonly id: string;
  readonly objectId?: string | null;
  readonly objectType?: string | null; // "BaseCustomer" | "BaseInvoice"
  readonly title?: string | null;
  readonly address1?: string | null;
  readonly address2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zipCode?: string | null;
  readonly isMainLocation?: boolean | null;
  readonly notes?: string | null;
}

/** A FieldPulse asset (their "Assets" resource), maps to native customer_equipment. */
export interface FieldpulseAsset {
  readonly id: string;
  readonly customerId?: string | null; // REQUIRED for import — skip without it
  readonly title?: string | null; // Equipment name/description
  readonly assetType?: string | null; // Free-text asset type (e.g. "ac", "furnace")
  readonly tag?: string | null; // Serial/tag number
  readonly locationDescription?: string | null; // Location in home
  readonly installDate?: string | null; // Installation date string
  readonly maintenanceAgreementId?: string | null;
  readonly status?: string | null;
  readonly deletedAt?: string | null;
}
