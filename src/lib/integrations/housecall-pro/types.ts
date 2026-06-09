/**
 * Housecall Pro integration — shared types.
 *
 * These describe the SEAM between our app and the Housecall Pro REST API
 * (MAX-plan only). They are deliberately minimal: the HCP resources we actually
 * read/write (Customer, Job, Address) plus the small DTOs our code passes when
 * creating them. Nothing here imports the DB or `fetch`, so any request->DTO
 * mapping stays pure and unit-testable without touching HCP or the network.
 *
 * Auth note: an HCP API key grants FULL account access. It lives only in
 * {@link HousecallConfig} (resolved from encrypted storage or env) and is NEVER
 * embedded in these resource types, never logged, never sent to the client.
 */

/**
 * A Housecall Pro address as the API returns/accepts it. All fields optional on
 * read (HCP omits blanks); on write we send what we have.
 */
export interface HousecallAddress {
  readonly street?: string;
  readonly street_line_2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly zip?: string;
  readonly country?: string;
}

/**
 * A Housecall Pro customer resource (the subset we consume). `id` is HCP's
 * customer identifier — the value we persist to map HCP customers <-> ours.
 */
export interface HousecallCustomer {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly email: string | null;
  readonly mobile_number: string | null;
  readonly home_number: string | null;
  readonly company: string | null;
  readonly addresses: readonly HousecallAddress[];
}

/** The fields we send to create an HCP customer. */
export interface CreateCustomerInput {
  readonly firstName: string;
  readonly lastName: string;
  /** At least one of email/phone should be present so HCP can dedupe/contact. */
  readonly email?: string;
  readonly mobileNumber?: string;
  readonly address?: HousecallAddress;
}

/** How we look an HCP customer up before creating (avoids duplicates). */
export interface FindCustomerQuery {
  readonly email?: string;
  readonly phone?: string;
}

/**
 * A Housecall Pro job resource (the subset we consume). `work_status` is HCP's
 * lifecycle enum; we keep it as a string because HCP may add values and we
 * never want an unknown value to crash a webhook handler.
 */
export interface HousecallJob {
  readonly id: string;
  readonly customer_id: string;
  readonly work_status: string;
  readonly description: string | null;
  /** ISO-8601 UTC start, or null when unscheduled. */
  readonly schedule_start: string | null;
  /** ISO-8601 UTC end, or null when unscheduled. */
  readonly schedule_end: string | null;
}

/**
 * A single structured line item on an HCP job (a "service", "material", or
 * "labor" row the tech sees alongside the free-text description).
 *
 * PRICING NOTE: this business charges based on actual work performed on-site —
 * there is NO flat fee and NO intake-time pricing. Line items we emit are
 * DESCRIPTIVE only; `unitPriceCents` is left undefined so the tech prices the
 * job on-site. The field exists solely to mirror HCP's shape (it accepts a
 * unit amount) and to keep this type honest about what HCP supports — our
 * mapping never sets it. Callers that synthesize line items MUST leave it unset.
 */
export interface HousecallLineItem {
  /** Human label for the row, e.g. "Diagnostic — No Cool". */
  readonly name: string;
  /** How HCP classifies the row. Defaults conceptually to a service. */
  readonly kind?: "service" | "material" | "labor";
  /** Quantity of the item; defaults to 1 when omitted. */
  readonly quantity?: number;
  /**
   * Unit price in CENTS. INTENTIONALLY OPTIONAL AND LEFT UNSET by our mapping —
   * see the pricing note above. Present only so the type matches HCP's surface.
   */
  readonly unitPriceCents?: number;
  /** Optional longer note shown under the line. */
  readonly description?: string;
}

/**
 * The fields we send to create an HCP job. Times are ISO-8601 UTC strings — the
 * app persists UTC everywhere and only renders Eastern, so the boundary stays
 * UTC. `requestId` is OUR service_request id, carried so a webhook can map the
 * HCP job back to our record.
 */
export interface CreateJobInput {
  readonly customerId: string;
  readonly description: string;
  /** ISO-8601 UTC. Null/omitted for an unscheduled job. */
  readonly scheduleStart?: string;
  /** ISO-8601 UTC. */
  readonly scheduleEnd?: string;
  /** Our service_request id, stored on the job for back-mapping. */
  readonly requestId?: string;
  /**
   * Structured, DESCRIPTIVE line items derived from the intake (see
   * {@link HousecallLineItem}). Emitted IN ADDITION TO `description`, never
   * instead of it. Carries no prices. Omitted when nothing could be derived.
   */
  readonly lineItems?: readonly HousecallLineItem[];
}

/**
 * The fields we send to UPDATE an existing HCP job (idempotent re-push). Same
 * schedule/description shape as create, minus the customer (HCP keys a job to its
 * customer at create time and that doesn't change on a reschedule). All optional:
 * we send only the fields that changed. Times stay ISO-8601 UTC.
 */
export interface UpdateJobInput {
  readonly description?: string;
  /** ISO-8601 UTC. Send both bounds together when the window moves. */
  readonly scheduleStart?: string;
  /** ISO-8601 UTC. */
  readonly scheduleEnd?: string;
  /**
   * Structured, DESCRIPTIVE line items (see {@link HousecallLineItem}). Sent
   * only when present so a description/schedule-only update never blanks the
   * job's existing items. Carries no prices.
   */
  readonly lineItems?: readonly HousecallLineItem[];
}

/**
 * A bookable availability slot as exposed to scheduling. HCP's availability
 * surface differs by account; we normalize to a half-open [startIso, endIso)
 * UTC window so it can plug into the SchedulingSource seam later (Stage 4).
 */
export interface HousecallAvailabilitySlot {
  readonly startIso: string;
  readonly endIso: string;
}

/** Half-open [startIso, endIso) UTC range for an availability query. */
export interface HousecallAvailabilityRange {
  readonly startIso: string;
  readonly endIso: string;
}

/**
 * Cached, NON-secret account metadata shown after a successful connect (e.g. the
 * company name HCP reports). Never contains the API key. Persisted as JSON on
 * the connection row purely so the settings panel can display "connected as X".
 */
export interface HousecallAccountInfo {
  readonly companyName: string | null;
  readonly accountId: string | null;
}

/**
 * A Housecall Pro technician (employee) resource — the subset we consume to build
 * the active-tech roster the scheduling source reports. HCP models a tech as an
 * "employee"; `id` is HCP's employee identifier. Only `id` is guaranteed; name is
 * optional (and treated as PII — never crosses the public availability surface),
 * and `isActive` mirrors HCP's active/deactivated flag so we can filter the
 * roster down to staff who can still take jobs. Tolerant of omitted fields:
 * HCP omits blanks and may add fields, and a missing field must never crash sync.
 */
export interface HousecallTechnician {
  /** HCP employee id — the value we map to an opaque scheduling tech id. */
  readonly id: string;
  /** Display name, when HCP returns one. Optional + PII; not exposed publicly. */
  readonly name?: string;
  /** Whether the employee is active in HCP. Undefined when HCP omits it. */
  readonly isActive?: boolean;
}

/**
 * A PII-free summary of a customer's PAST service with us, derived from their HCP
 * job history. Used to enrich the bot's returning-customer context and the admin
 * customer view ("last serviced in March"). Deliberately omits the customer name,
 * address, and any contact detail — it carries only a count and the most-recent
 * job's date + free-text description (the work performed, not who it was for).
 */
export interface HousecallCustomerServiceHistory {
  /** Total past jobs HCP has on file for this customer (0 when none / degraded). */
  readonly jobCount: number;
  /** ISO-8601 UTC start of the most-recent job, or null when none/unscheduled. */
  readonly lastServiceDate: string | null;
  /** Free-text description of the most-recent job, or null when absent. */
  readonly lastServiceDescription: string | null;
}
