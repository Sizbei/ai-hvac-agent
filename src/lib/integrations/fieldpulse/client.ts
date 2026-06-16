/**
 * Fieldpulse CLIENT seam.
 *
 * ┌─ FIELDPULSE SEAM ────────────────────────────────────────────────────────┐
 * │ {@link FieldpulseClient} is the only surface business code calls. The live │
 * │ implementation talks to the Fieldpulse REST API with x-api-key header      │
 * │ auth. Mirrors housecall-pro/client.ts: a narrow interface + a concrete    │
 * │ impl + a factory, so the live client (or a fake in tests) can be swapped  │
 * │ without touching callers.                                                   │
 * │                                                                              │
 * │ {@link getFieldpulseClient} returns null when the org has no API key (no   │
 * │ connection + no env fallback) — the single signal callers branch on to       │
 * │ DEGRADE SAFELY. The API key is never logged. `fetchImpl` is injectable so   │
 * │ tests mock the network and NEVER hit the real Fieldpulse API.              │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
import { getFieldpulseConfig, type FieldpulseConfig } from "./config";
import type {
  CreateCustomerInput,
  CreateJobInput,
  FieldpulseAccountInfo,
  FieldpulseAddress,
  FieldpulseAvailabilityRange,
  FieldpulseAvailabilitySlot,
  FieldpulseCustomer,
  FieldpulseInvoice,
  FieldpulseJob,
  FieldpulseUser,
  FindCustomerQuery,
  UpdateJobInput,
  GeocodeInput,
  FieldpulseGeocodeResult,
} from "./types";

/** Max attempts (1 initial + retries) for transient 429/5xx failures. */
const MAX_ATTEMPTS = 3;
/** Base backoff; doubles per attempt (100ms, 200ms, ...). */
const BACKOFF_BASE_MS = 100;

/** Retryable per REST norms: rate-limit + server errors. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The seam every business caller depends on. One client instance is bound to
 * one org's resolved config (the API key arrives inside {@link FieldpulseConfig}).
 */
export interface FieldpulseClient {
  /** Create a Fieldpulse customer; returns the created resource (with its id). */
  createCustomer(input: CreateCustomerInput): Promise<FieldpulseCustomer>;

  /**
   * Find an existing Fieldpulse customer by email/phone, or null when none matches.
   * Used to avoid creating duplicates (pairs with our blind-index dedupe).
   */
  findCustomer(query: FindCustomerQuery): Promise<FieldpulseCustomer | null>;

  /** Create a Fieldpulse job for a customer; returns the created resource. */
  createJob(input: CreateJobInput): Promise<FieldpulseJob>;

  /**
   * Update an existing Fieldpulse job (reschedule/reassign). Used for the
   * idempotent re-push path: once we hold a fieldpulse_job_id we UPDATE rather
   * than create a duplicate. Returns the updated resource.
   */
  updateJob(jobId: string, input: UpdateJobInput): Promise<FieldpulseJob>;

  /**
   * Cancel an existing Fieldpulse job (our request was cancelled). Fieldpulse
   * models a cancel as a work-status change to "canceled", which keeps the job's
   * history rather than hard-deleting it. Idempotent from our side: a second
   * cancel is harmless.
   */
  cancelJob(jobId: string): Promise<void>;

  /**
   * Append a note to an existing Fieldpulse job so the field tech sees it.
   * Returns the created note; we ignore the body since the caller only needs
   * "it happened".
   */
  addJobNote(jobId: string, note: string): Promise<void>;

  /**
   * List the jobs Fieldpulse has on file for one customer (their service history),
   * newest-first as returned. READ-ONLY. Used to surface prior service to the
   * bot and admin views.
   */
  listCustomerJobs(fieldpulseCustomerId: string): Promise<readonly FieldpulseJob[]>;

  /** Fetch a job by Fieldpulse id (e.g. to reconcile a webhook). */
  getJob(jobId: string): Promise<FieldpulseJob>;

  /**
   * List the org's user (technician) roster. Used to derive the active technician
   * set the scheduling source reports. Tolerant of omitted fields; the active
   * filter is applied by the mapping, not here.
   */
  listUsers(): Promise<readonly FieldpulseUser[]>;

  /**
   * List bookable availability slots within a UTC range (if endpoint exists).
   * May not be available in Fieldpulse — throws on 404, callers should degrade.
   */
  listAvailability(
    range: FieldpulseAvailabilityRange,
  ): Promise<readonly FieldpulseAvailabilitySlot[]>;

  /**
   * Lightweight authenticated probe used to VALIDATE an API key at connect time
   * and to cache non-secret account metadata. Throws on auth failure.
   */
  getAccountInfo(): Promise<FieldpulseAccountInfo>;

  /**
   * Fetch an invoice by Fieldpulse id (e.g., to reconcile a webhook).
   * Returns null if not found.
   */
  getInvoice(invoiceId: string): Promise<FieldpulseInvoice | null>;

  /**
   * List invoices for a specific job (to determine payment status).
   * Returns newest-first as returned.
   */
  listJobInvoices(fieldpulseJobId: string): Promise<readonly FieldpulseInvoice[]>;

  /**
   * Validate and normalize an address using Fieldpulse's geocoding API (if available).
   * Used to verify addresses before creating customers/jobs.
   * Returns null if the endpoint doesn't exist or on any error (degrades gracefully).
   */
  geocodeAddress(input: GeocodeInput): Promise<FieldpulseGeocodeResult | null>;
}

/** Map a raw Fieldpulse address to our type (tolerant of omitted fields). */
function toAddress(raw: unknown): FieldpulseAddress | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  return {
    street: str(obj.street),
    streetLine2: str(obj.street_line_2),
    city: str(obj.city),
    state: str(obj.state),
    zip: str(obj.zip),
    country: str(obj.country),
  };
}

/** Narrow an untrusted Fieldpulse customer payload to {@link FieldpulseCustomer}. */
function toCustomer(raw: unknown): FieldpulseCustomer {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Fieldpulse returned a malformed customer");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string") {
    throw new Error("Fieldpulse customer missing id");
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  const address = typeof obj.address === "object" && obj.address !== null
    ? toAddress(obj.address)
    : null;
  return {
    id: obj.id,
    firstName: str(obj.first_name),
    lastName: str(obj.last_name),
    email: str(obj.email),
    phone: str(obj.phone),
    company: str(obj.company),
    address,
  };
}

/** Narrow an untrusted Fieldpulse job payload to {@link FieldpulseJob}. */
function toJob(raw: unknown): FieldpulseJob {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Fieldpulse returned a malformed job");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.customer_id !== "string") {
    throw new Error("Fieldpulse job missing id/customer_id");
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  return {
    id: obj.id,
    customerId: obj.customer_id,
    workStatus: str(obj.work_status),
    description: str(obj.description),
    scheduleStart: str(obj.schedule_start),
    scheduleEnd: str(obj.schedule_end),
    assignedUserId: str(obj.assigned_user_id),
    createdAt: str(obj.created_at),
  };
}

/**
 * Narrow an untrusted Fieldpulse user payload to {@link FieldpulseUser}, or
 * null when it has no usable id. Tolerant of omitted fields: a missing name or
 * active flag must NOT crash the roster sync.
 */
function toUser(raw: unknown): FieldpulseUser | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return null;
  }
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const isActive =
    typeof obj.active === "boolean"
      ? obj.active
      : typeof obj.is_active === "boolean"
        ? obj.is_active
        : undefined;
  return {
    id: obj.id,
    name: str(obj.name),
    email: str(obj.email),
    isActive,
    role: str(obj.role),
  };
}

/**
 * Narrow an untrusted Fieldpulse availability slot payload to
 * {@link FieldpulseAvailabilitySlot}, or null when malformed.
 */
function toAvailabilitySlot(raw: unknown): FieldpulseAvailabilitySlot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.start_time !== "string" ||
    typeof obj.end_time !== "string"
  ) {
    return null;
  }
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  return {
    startIso: obj.start_time,
    endIso: obj.end_time,
    userId: str(obj.user_id),
  };
}

/** Narrow an untrusted Fieldpulse invoice payload to {@link FieldpulseInvoice}. */
function toInvoice(raw: unknown): FieldpulseInvoice | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string") {
    return null;
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  const num = (v: unknown): number | null =>
    typeof v === "number" ? v : null;
  return {
    id: obj.id,
    jobId: str(obj.job_id),
    customerId: str(obj.customer_id),
    status: str(obj.status),
    total: num(obj.total),
    dueDate: str(obj.due_date),
    paidAt: str(obj.paid_at),
    createdAt: str(obj.created_at),
  };
}

/**
 * REST client for the Fieldpulse API. Holds one org's resolved config and
 * authenticates every request with the API key in an x-api-key header. Retries
 * transient 429/5xx with exponential backoff; surfaces other non-OK responses
 * as errors.
 */
export class RestFieldpulseClient implements FieldpulseClient {
  constructor(
    private readonly config: FieldpulseConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Authenticated fetch with retry/backoff. Sends the API key in the x-api-key
   * header (Fieldpulse's documented auth method). The key is NEVER logged —
   * errors carry only status codes.
   */
  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          "x-api-key": this.config.apiKey,
          accept: "application/json",
          "content-type": "application/json",
        },
      });

      if (res.ok) {
        // 204 No Content has no body; callers that need a body never hit 204.
        if (res.status === 204) {
          return null;
        }
        return res.json();
      }

      lastStatus = res.status;
      if (!isRetryableStatus(res.status) || attempt === MAX_ATTEMPTS - 1) {
        throw new Error(`Fieldpulse request failed: HTTP ${res.status}`);
      }
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
    }
    // Unreachable: the loop either returns or throws, but satisfies the compiler.
    throw new Error(`Fieldpulse request failed: HTTP ${lastStatus}`);
  }

  async createCustomer(
    input: CreateCustomerInput,
  ): Promise<FieldpulseCustomer> {
    const body = {
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      phone: input.phone,
      company: input.company,
      address: input.address,
    };
    const raw = await this.request("/customers", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return toCustomer(raw);
  }

  async findCustomer(
    query: FindCustomerQuery,
  ): Promise<FieldpulseCustomer | null> {
    const term = query.email ?? query.phone;
    if (!term) {
      return null;
    }
    // Fieldpulse uses a `q` parameter for search (mirrors HCP pattern).
    const params = new URLSearchParams({ q: term, page_size: "1" });
    const raw = await this.request(`/customers?${params.toString()}`, {
      method: "GET",
    });
    const list =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).customers
        : undefined;
    if (!Array.isArray(list) || list.length === 0) {
      return null;
    }
    return toCustomer(list[0]);
  }

  async createJob(input: CreateJobInput): Promise<FieldpulseJob> {
    const body = {
      customer_id: input.customerId,
      description: input.description,
      schedule_start: input.scheduleStart,
      schedule_end: input.scheduleEnd,
      assigned_user_id: input.assignedUserId,
      // Carry our request id so a webhook can map the Fieldpulse job back to us.
      tags: input.requestId ? [`request:${input.requestId}`] : undefined,
    };
    const raw = await this.request("/jobs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return toJob(raw);
  }

  async updateJob(
    jobId: string,
    input: UpdateJobInput,
  ): Promise<FieldpulseJob> {
    const body = {
      description: input.description,
      schedule_start: input.scheduleStart,
      schedule_end: input.scheduleEnd,
      assigned_user_id: input.assignedUserId,
      work_status: input.workStatus,
    };
    const raw = await this.request(`/jobs/${encodeURIComponent(jobId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return toJob(raw);
  }

  async cancelJob(jobId: string): Promise<void> {
    // Fieldpulse cancels via a work-status transition, not a DELETE — this
    // preserves the job's history. The endpoint returns the updated job (or 204);
    // we ignore the body since the caller only needs "it happened".
    await this.request(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "PUT",
    });
  }

  async addJobNote(jobId: string, note: string): Promise<void> {
    // ASSUMED FIELDPULSE SHAPE: a job's notes live under a `/jobs/{id}/notes`
    // sub-collection; a POST with a JSON body `{ content }` appends one.
    await this.request(`/jobs/${encodeURIComponent(jobId)}/notes`, {
      method: "POST",
      body: JSON.stringify({ content: note }),
    });
  }

  async listCustomerJobs(
    fieldpulseCustomerId: string,
  ): Promise<readonly FieldpulseJob[]> {
    const params = new URLSearchParams({
      customer_id: fieldpulseCustomerId,
      page_size: "100",
    });
    const raw = await this.request(`/jobs?${params.toString()}`, {
      method: "GET",
    });
    const list =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).jobs
        : undefined;
    if (!Array.isArray(list)) {
      return [];
    }
    // Drop any malformed job rather than throwing, so a single bad row never
    // blows up the whole history read.
    return list
      .map((j): FieldpulseJob | null => {
        try {
          return toJob(j);
        } catch {
          return null;
        }
      })
      .filter((j): j is FieldpulseJob => j !== null);
  }

  async getJob(jobId: string): Promise<FieldpulseJob> {
    const raw = await this.request(`/jobs/${encodeURIComponent(jobId)}`, {
      method: "GET",
    });
    return toJob(raw);
  }

  async listUsers(): Promise<readonly FieldpulseUser[]> {
    // Fieldpulse exposes the user roster as the users collection.
    const raw = await this.request("/users", { method: "GET" });
    const list =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).users
        : undefined;
    if (!Array.isArray(list)) {
      return [];
    }
    return list
      .map(toUser)
      .filter((u): u is FieldpulseUser => u !== null);
  }

  async listAvailability(
    range: FieldpulseAvailabilityRange,
  ): Promise<readonly FieldpulseAvailabilitySlot[]> {
    // This endpoint may not exist in Fieldpulse. We attempt it; callers should
    // handle 404 and degrade gracefully.
    const params = new URLSearchParams({
      start_time: range.startIso,
      end_time: range.endIso,
    });
    const raw = await this.request(
      `/company/availability?${params.toString()}`,
      { method: "GET" },
    );
    const slots =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).availability
        : undefined;
    if (!Array.isArray(slots)) {
      return [];
    }
    return slots
      .map(toAvailabilitySlot)
      .filter((s): s is FieldpulseAvailabilitySlot => s !== null);
  }

  async getAccountInfo(): Promise<FieldpulseAccountInfo> {
    const raw = await this.request("/company", { method: "GET" });
    const obj =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    return {
      companyName: typeof obj.name === "string" ? obj.name : null,
      accountId: typeof obj.id === "string" ? obj.id : null,
    };
  }

  async getInvoice(invoiceId: string): Promise<FieldpulseInvoice | null> {
    try {
      const raw = await this.request(
        `/invoices/${encodeURIComponent(invoiceId)}`,
        { method: "GET" },
      );
      return toInvoice(raw);
    } catch {
      // Return null if invoice not found (404) or other error
      return null;
    }
  }

  async listJobInvoices(
    fieldpulseJobId: string,
  ): Promise<readonly FieldpulseInvoice[]> {
    const params = new URLSearchParams({
      job_id: fieldpulseJobId,
      page_size: "50",
    });
    const raw = await this.request(`/invoices?${params.toString()}`, {
      method: "GET",
    });
    const list =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).invoices
        : undefined;
    if (!Array.isArray(list)) {
      return [];
    }
    // Drop any malformed invoices rather than throwing
    return list
      .map(toInvoice)
      .filter((i): i is FieldpulseInvoice => i !== null);
  }

  async geocodeAddress(input: GeocodeInput): Promise<FieldpulseGeocodeResult | null> {
    try {
      // Build address string from components
      const addressParts = [
        input.street,
        input.city,
        input.state,
        input.zip,
        input.country,
      ].filter((p): p is string => Boolean(p && p.trim()));

      if (addressParts.length === 0) {
        return { valid: false, error: "No address components provided" };
      }

      const addressQuery = addressParts.join(", ");

      // Try Fieldpulse's address validation endpoint (may not exist)
      const raw = await this.request(`/addresses/validate?q=${encodeURIComponent(addressQuery)}`, {
        method: "GET",
      });

      // Parse the response
      if (typeof raw !== "object" || raw === null) {
        return null; // Endpoint exists but returned unexpected format
      }

      const obj = raw as Record<string, unknown>;

      // Check if Fieldpulse marked the address as valid
      const isValid = typeof obj.valid === "boolean" ? obj.valid : false;

      if (!isValid) {
        return {
          valid: false,
          error: typeof obj.error === "string" ? obj.error : "Address validation failed"
        };
      }

      // Extract normalized address components
      const str = (v: unknown): string | null =>
        typeof v === "string" ? v : null;
      const num = (v: unknown): number | null =>
        typeof v === "number" ? v : null;

      return {
        valid: true,
        normalizedAddress: {
          street: str(obj.street),
          streetLine2: str(obj.street_line_2),
          city: str(obj.city),
          state: str(obj.state),
          zip: str(obj.zip),
          country: str(obj.country),
        },
        latitude: num(obj.latitude),
        longitude: num(obj.longitude),
      };
    } catch {
      // Endpoint doesn't exist or failed - degrade gracefully
      return null;
    }
  }
}

/**
 * Resolve the active Fieldpulse client for an org, or null when not configured
 * (no connection + no env fallback). A single seam: callers branch on null to
 * degrade safely. `baseUrl`/`fetchImpl` are injectable for tests so the real
 * Fieldpulse API is never called in test.
 */
export async function getFieldpulseClient(
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl?: string,
): Promise<FieldpulseClient | null> {
  const config = await getFieldpulseConfig(organizationId, baseUrl);
  if (!config) {
    return null;
  }
  return new RestFieldpulseClient(config, fetchImpl);
}
