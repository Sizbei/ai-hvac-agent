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
  // Parsed custom fields (name+value pairs). Null when absent or all entries
  // were filtered (empty name/value). lead_source is folded in as a synthetic
  // entry { name: "Lead Source", value: raw.lead_source }.
  readonly customFields?: readonly { name: string; value: string }[] | null;
  // Raw lead source string from the FP API — folded into customFields by the
  // mapper; retained here so types.ts mirrors the raw API shape.
  readonly leadSource?: string | null;
  // ── Field-parity P1 additions ──
  // Raw FP account_type string (e.g. "residential", "commercial"). NULL when absent.
  readonly accountType?: string | null;
  // Whether this customer is tax-exempt per FP. NULL when absent.
  readonly isTaxExempt?: boolean | null;
  // Billing address fields — only when has_different_billing_address is true in FP.
  readonly billingAddress?: FieldpulseAddress | null;
  // ── Import-internal: raw FP API payload ──
  // Retained by toCustomer() so importers can pass it to buildFpSpillover.
  // NOT written to any DB column directly; treated as opaque by callers.
  readonly _raw?: Record<string, unknown>;
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
  // ── Import-internal: raw FP API payload ──
  // Retained by toJob() so importers can pass it to buildFpSpillover.
  // NOT written to any DB column directly; treated as opaque by callers.
  readonly _raw?: Record<string, unknown>;
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
  readonly taxCents?: number | null; // FP `tax` — real sales tax (>0 on ~56% of invoices)
  readonly totalCents?: number | null;
  readonly amountPaidCents?: number | null; // Real API exposes amount_paid
  readonly amountUnpaidCents?: number | null; // Real API exposes amount_unpaid
  readonly dueDate?: string | null;
  /** FP invoiced_date — the REAL issue date (created_at is the QB bulk-import day). */
  readonly invoicedDate?: string | null;
  readonly paidAt?: string | null; // From last_payment_date
  readonly createdAt?: string | null;
  readonly lineItems?: readonly FieldpulseInvoiceLineItem[];
  // Non-null when the invoice has been soft-deleted — skip on import.
  readonly deletedAt?: string | null;
  // ── Import-internal: raw FP API payload ──
  // Retained by toInvoice() so importers can pass it to buildFpSpillover.
  // NOT written to any DB column directly; treated as opaque by callers.
  readonly _raw?: Record<string, unknown>;
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

/**
 * A FieldPulse pricebook item (their "Items" resource).
 *
 * Row keys observed: id (number), name, default_taxable, default_unit_price
 * (dollar string or number), type, is_active, plus qbo_* noise.
 * All fields are optional/nullable to tolerate API shape drift.
 */
export interface FieldpulseItem {
  readonly id: string;
  readonly name: string;
  /** Price in integer cents (parsed from dollar string or number). */
  readonly priceCents: number;
  /** Whether this item is taxable by default. */
  readonly taxable: boolean;
  /** Whether this item is active (not archived). */
  readonly isActive: boolean;
  /**
   * Item type mapped to the native pricebookItemTypeEnum.
   * "service" | "material" | "equipment" — unknown FP types map to "service"
   * (tallied separately by the importer so no mapping decision is silent).
   */
  readonly type: "service" | "material" | "equipment";
  /**
   * The raw FP `type` string before mapping (preserved for importer tallying).
   * Null/undefined when absent from the API payload.
   */
  readonly rawFpType: string | null;
  // ── Field-parity P1 additions ──
  /** Cost in integer cents from `default_unit_cost`. NULL when absent. */
  readonly costCents: number | null;
  /** Default description text from `default_description`. NULL when absent. */
  readonly description: string | null;
  /** True when FP `is_labor_item` is set. */
  readonly isLaborItem: boolean;
  /** FP inventory stock count from `quantity_available`. NULL when absent/untracked. */
  readonly quantityAvailable: number | null;
  /** FP vendor type string from `vendor_type`. NULL when absent. */
  readonly vendorType: string | null;
  /**
   * Markup percentage from `automatic_markup_percentage`, rounded to int.
   * NULL when absent.
   */
  readonly markupPct: number | null;
  // ── Import-internal: raw FP API payload ──
  // Retained by toItem() so importers can pass it to buildFpSpillover.
  // NOT written to any DB column directly; treated as opaque by callers.
  readonly _raw?: Record<string, unknown>;
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
  // ── Field-parity P1 additions ──
  /** Human-readable estimate title from FP `name` or `title`. NULL when absent. */
  readonly title?: string | null;
  // ── Import-internal: raw FP API payload ──
  // Retained by toEstimate() so importers can pass it to buildFpSpillover.
  // NOT written to any DB column directly; treated as opaque by callers.
  readonly _raw?: Record<string, unknown>;
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
  // ── Import-internal: raw FP API payload ──
  // Retained by toAsset() so importers can pass it to buildFpSpillover.
  // NOT written to any DB column directly; treated as opaque by callers.
  readonly _raw?: Record<string, unknown>;
}
