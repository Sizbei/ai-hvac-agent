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
  FieldpulseInvoiceLineItem,
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
/** Per-request timeout — a hung upstream must not stall the lambda until the
 * platform kill. Aborts the fetch and (for non-final attempts) retries. */
const REQUEST_TIMEOUT_MS = 15_000;

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

  /**
   * Page ALL customers from the unfiltered /customers endpoint for backfill.
   * totalCount is from the first-page `total_count` (present on /customers).
   * maxPages defaults to 200 (enough for ~10,000 customers at 50/page).
   */
  listCustomers(maxPages?: number): Promise<{ items: FieldpulseCustomer[]; totalCount: number | null }>;

  /**
   * Page ALL jobs from the unfiltered /jobs endpoint for backfill.
   * totalCount is from the first-page `total_count` (present on /jobs).
   * maxPages defaults to 200 (enough for ~4,000 jobs at 20/page).
   */
  listJobs(maxPages?: number): Promise<{ items: FieldpulseJob[]; totalCount: number | null }>;

  /**
   * Page ALL invoices from the unfiltered /invoices endpoint for backfill.
   * totalCount is null for invoices (FP returns null — size by walking until empty).
   * maxPages defaults to 200.
   */
  listInvoices(maxPages?: number): Promise<{ items: FieldpulseInvoice[]; totalCount: number | null }>;
}

// ── Real-API helpers (verified 2026-06-19 against the live FieldPulse API) ─────
// FieldPulse returns: ids as NUMBERS, money as decimal dollar STRINGS ("200.00"),
// and EVERY payload (list + single) wrapped in `{ error, response, total_count }`.
// See docs/superpowers/specs/2026-06-19-fieldpulse-live-api-remediation-design.md.

/** Coerce a FieldPulse id (number OR string) to a non-empty string, else null. */
function idStr(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Coerce a FieldPulse field that may be a number OR a string (e.g. `role`).
 * Live-verified 2026-07-09: the /users endpoint returns role as an INTEGER.
 */
const numOrStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : undefined;

/** Parse FieldPulse money (dollar string "200.00" or number) to integer cents. */
function dollarsToCents(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Best-guess mapping of FieldPulse's integer invoice `status` to a label.
 *
 * DEFENSIVE + SUPPLEMENTARY ONLY. The integer code meanings are UNCONFIRMED
 * (blocked on a fresh FieldPulse key + vendor docs), so this is NOT used to drive
 * the native invoice state — `deriveInvoiceState` (from the AMOUNTS) remains the
 * source of truth. Any unrecognized code maps to "unknown" so a wrong guess can
 * never silently mis-state an invoice; callers should treat a non-"unknown"
 * result as a hint, never as authoritative. Confirm the codes, then promote.
 */
export function mapFieldpulseInvoiceStatus(
  code: number | string | null | undefined,
): "draft" | "open" | "paid" | "void" | "unknown" {
  const n =
    typeof code === "number"
      ? code
      : typeof code === "string" && code.trim() !== ""
        ? Number(code)
        : NaN;
  switch (n) {
    case 1:
      return "draft";
    case 2:
      return "open";
    case 3:
      return "paid";
    case 4:
      return "void";
    default:
      return "unknown";
  }
}

/** Unwrap the FieldPulse envelope: `{ error, response, ... }` → the payload. */
function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "response" in raw) {
    return (raw as Record<string, unknown>).response;
  }
  return raw;
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
  const id = idStr(obj.id);
  if (!id) {
    throw new Error("Fieldpulse customer missing id");
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  // Real API: flat address fields (address_1/city/state/zip_code), not a nested
  // `address` object; company is `company_name`.
  const flat = toAddress({
    street: obj.address_1,
    street_line_2: obj.address_2,
    city: obj.city,
    state: obj.state,
    zip: obj.zip_code,
  });
  const address =
    typeof obj.address === "object" && obj.address !== null
      ? toAddress(obj.address)
      : flat;
  return {
    id,
    firstName: str(obj.first_name),
    lastName: str(obj.last_name),
    email: str(obj.email),
    phone: str(obj.phone),
    // E.164 phone — present on Phase-0.5-verified payloads; preferred for import.
    phoneE164: str(obj.phone_e164),
    company: str(obj.company) ?? str(obj.company_name),
    address,
    // Import-pull fields (Phase 3). display_name is present on ALL verified rows.
    displayName: str(obj.display_name),
    deletedAt: str(obj.deleted_at),
    mergedCustomerId: idStr(obj.merged_customer_id),
  };
}

/** Narrow an untrusted Fieldpulse job payload to {@link FieldpulseJob}. */
function toJob(raw: unknown): FieldpulseJob {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Fieldpulse returned a malformed job");
  }
  const obj = raw as Record<string, unknown>;
  const id = idStr(obj.id);
  const customerId = idStr(obj.customer_id);
  if (!id || !customerId) {
    throw new Error("Fieldpulse job missing id/customer_id");
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  // Parse assignments[].user_id for Phase-4 import.
  const assignments = Array.isArray(obj.assignments)
    ? obj.assignments
        .map((a): { readonly userId: string } | null => {
          if (!a || typeof a !== "object") return null;
          const uid = idStr((a as Record<string, unknown>).user_id);
          return uid ? { userId: uid } : null;
        })
        .filter((a): a is { readonly userId: string } => a !== null)
    : undefined;
  // Real API: schedule is start_time/end_time; status is an int (stringified).
  return {
    id,
    customerId,
    workStatus:
      obj.status != null ? String(obj.status) : str(obj.work_status),
    description: str(obj.description) ?? str(obj.notes),
    scheduleStart: str(obj.start_time) ?? str(obj.schedule_start),
    scheduleEnd: str(obj.end_time) ?? str(obj.schedule_end),
    assignedUserId: idStr(obj.assigned_user_id),
    createdAt: str(obj.created_at),
    // Phase-4 import fields (LIVE-VERIFIED 2026-07-09).
    jobType: str(obj.job_type),
    subtitle: str(obj.subtitle),
    fieldNotes: str(obj.field_notes),
    notes: str(obj.notes),
    statusInt: typeof obj.status === "number" ? obj.status : null,
    deletedAt: str(obj.deleted_at),
    completedAt: str(obj.completed_at),
    arrivalWindowStart: str(obj.customer_arrival_window_start_time),
    arrivalWindowEnd: str(obj.customer_arrival_window_end_time),
    assignments,
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
  const id = idStr(obj.id);
  if (!id) {
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
  // Real API: no single `name`; assemble from first/last.
  const assembledName =
    [str(obj.first_name), str(obj.last_name)].filter(Boolean).join(" ") ||
    undefined;
  return {
    id,
    name: str(obj.name) ?? assembledName,
    email: str(obj.email),
    isActive,
    role: numOrStr(obj.role),
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
  const id = idStr(obj.id);
  if (!id) {
    return null;
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  return {
    id,
    jobId: idStr(obj.job_id),
    customerId: idStr(obj.customer_id),
    // Real status is an int (e.g. 3) — preserve as a string for reference; the
    // mirror derives paid/open/void from the amounts below, not this code.
    status: obj.status != null ? String(obj.status) : null,
    totalCents: dollarsToCents(obj.total),
    amountPaidCents: dollarsToCents(obj.amount_paid),
    amountUnpaidCents: dollarsToCents(obj.amount_unpaid),
    dueDate: str(obj.due_date),
    // Real paid timestamp is last_payment_date (fallback first_payment_date).
    paidAt: str(obj.last_payment_date) ?? str(obj.first_payment_date),
    createdAt: str(obj.created_at),
    deletedAt: str(obj.deleted_at),
    lineItems: toLineItems(obj.line_items),
  };
}

/**
 * Flatten the real API's nested `line_items[].line_components[]` into our flat
 * line shape (the components carry title/qty/unit_price/unit_cost). Tolerant:
 * malformed entries are skipped, never thrown.
 */
function toLineItems(raw: unknown): FieldpulseInvoiceLineItem[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldpulseInvoiceLineItem[] = [];
  for (const li of raw) {
    if (!li || typeof li !== "object") continue;
    const line = li as Record<string, unknown>;
    const lineTitle = typeof line.line_title === "string" ? line.line_title : "";
    const comps = Array.isArray(line.line_components) ? line.line_components : [];
    for (const c of comps) {
      if (!c || typeof c !== "object") continue;
      const comp = c as Record<string, unknown>;
      const name =
        (typeof comp.title === "string" && comp.title) ||
        lineTitle ||
        "Item";
      // Preserve the FRACTIONAL quantity (e.g. 2.5 hrs of labor) — rounding it to
      // a whole number here inflated the mirrored line total (qty × price). The
      // consumer rounds it to the integer `quantity` column for display but
      // computes the money from this exact value.
      const parsedQty = Number.parseFloat(String(comp.quantity ?? "1"));
      const qty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;
      out.push({
        name,
        quantity: qty,
        unitPriceCents: dollarsToCents(comp.unit_price) ?? 0,
        unitCostCents: dollarsToCents(comp.unit_cost) ?? 0,
      });
    }
  }
  return out;
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
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            ...init.headers,
            "x-api-key": this.config.apiKey,
            accept: "application/json",
            "content-type": "application/json",
          },
        });
      } catch (err) {
        // Network error / timeout abort — retry transiently like a 5xx. The key
        // is never in the error; we re-throw a sanitized error if attempts run out.
        lastNetworkError = err;
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new Error("Fieldpulse request failed: network error");
        }
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
        continue;
      }

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
    void lastNetworkError;
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
    return toCustomer(unwrap(raw));
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
    const list = unwrap(raw);
    if (!Array.isArray(list) || list.length === 0) {
      return null;
    }
    // The `q` filter is NOT verified to narrow server-side (the `job_id` filter
    // on /invoices is ignored), so confirm the candidate actually matches before
    // returning — a wrong "match" would mis-link a customer on the push path.
    const candidate = toCustomer(list[0]);
    const wantEmail = query.email?.toLowerCase();
    const wantPhone = query.phone?.replace(/\D/g, "");
    const okEmail =
      !!wantEmail && candidate.email?.toLowerCase() === wantEmail;
    const okPhone =
      !!wantPhone && candidate.phone?.replace(/\D/g, "") === wantPhone;
    return okEmail || okPhone ? candidate : null;
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
    return toJob(unwrap(raw));
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
    return toJob(unwrap(raw));
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

  /**
   * Fetch a list endpoint across pages, DEFENSIVELY — works whether or not
   * FieldPulse actually honors a `page` param (the param name is unconfirmed,
   * blocked on a fresh key + vendor docs). Safety properties:
   *  - Hard MAX_PAGES cap bounds cost and can never loop forever.
   *  - If the API IGNORES `page`, every page is byte-identical → the repeated-
   *    batch guard stops after the first page (never an infinite loop, never
   *    duplicates).
   *  - Rows are deduped by id across pages; a page shorter than pageSize, or a
   *    page that adds nothing new, ends the walk.
   * Returns the raw row objects (callers map/validate them) plus the
   * `total_count` from the first page's envelope (null when absent).
   */
  private async fetchAllPages(
    basePath: string,
    baseParams: URLSearchParams,
    pageSize: number,
    maxPages = 20,
  ): Promise<{ rows: unknown[]; totalCount: number | null }> {
    const all: unknown[] = [];
    const seenIds = new Set<string>();
    let lastBatchKey: string | null = null;
    let totalCount: number | null = null;
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams(baseParams);
      params.set("page", String(page));
      params.set("page_size", String(pageSize));
      const raw = await this.request(`${basePath}?${params.toString()}`, {
        method: "GET",
      });
      // Capture total_count from the first page's envelope.
      if (page === 1 && raw && typeof raw === "object" && "total_count" in raw) {
        const tc = (raw as Record<string, unknown>).total_count;
        totalCount = typeof tc === "number" ? tc : null;
      }
      const list = unwrap(raw);
      if (!Array.isArray(list) || list.length === 0) break;
      // The API ignores `page` -> identical batch -> stop (no loop, no dupes).
      const batchKey = list
        .map((r) => idStr((r as Record<string, unknown>)?.id) ?? "?")
        .join(",");
      if (batchKey === lastBatchKey) break;
      lastBatchKey = batchKey;
      let added = 0;
      for (const row of list) {
        const id = idStr((row as Record<string, unknown>)?.id);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        all.push(row);
        added++;
      }
      // Last page (short) or no new rows -> done.
      if (list.length < pageSize || added === 0) break;
    }
    return { rows: all, totalCount };
  }

  async listCustomerJobs(
    fieldpulseCustomerId: string,
  ): Promise<readonly FieldpulseJob[]> {
    const { rows } = await this.fetchAllPages(
      "/jobs",
      new URLSearchParams({ customer_id: fieldpulseCustomerId }),
      100,
    );
    // Drop any malformed job rather than throwing, so a single bad row never
    // blows up the whole history read.
    return rows
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
    return toJob(unwrap(raw));
  }

  async listUsers(): Promise<readonly FieldpulseUser[]> {
    // Fieldpulse exposes the user roster as the users collection.
    const raw = await this.request("/users", { method: "GET" });
    const list = unwrap(raw);
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
    // The real API has NO /company route (404). /users validates the key and
    // carries the company_id, which we surface as the accountId (no company name
    // is available from this endpoint). Throws on auth failure (request()).
    const raw = await this.request("/users", { method: "GET" });
    const list = unwrap(raw);
    const first =
      Array.isArray(list) && list.length > 0 && typeof list[0] === "object"
        ? (list[0] as Record<string, unknown>)
        : {};
    return {
      companyName: null,
      accountId: idStr(first.company_id),
    };
  }

  async getInvoice(invoiceId: string): Promise<FieldpulseInvoice | null> {
    try {
      const raw = await this.request(
        `/invoices/${encodeURIComponent(invoiceId)}`,
        { method: "GET" },
      );
      return toInvoice(unwrap(raw));
    } catch {
      // Return null if invoice not found (404) or other error
      return null;
    }
  }

  async listJobInvoices(
    fieldpulseJobId: string,
  ): Promise<readonly FieldpulseInvoice[]> {
    // The `job_id` query param is IGNORED server-side (verified), so we must
    // page through invoices and filter client-side — otherwise a job's invoices
    // beyond the first page would be silently missed. Pagination is bounded +
    // defensive (see fetchAllPages).
    const { rows } = await this.fetchAllPages(
      "/invoices",
      new URLSearchParams({ job_id: fieldpulseJobId }),
      50,
    );
    // Drop malformed invoices rather than throwing.
    return rows
      .map(toInvoice)
      .filter((i): i is FieldpulseInvoice => i !== null)
      .filter((i) => i.jobId === fieldpulseJobId);
  }

  async listCustomers(
    maxPages = 200,
  ): Promise<{ items: FieldpulseCustomer[]; totalCount: number | null }> {
    // /customers returns a fixed 50/page (page_size is IGNORED — Phase 0.5).
    const { rows, totalCount } = await this.fetchAllPages(
      "/customers",
      new URLSearchParams(),
      50,
      maxPages,
    );
    const items = rows
      .map((c): FieldpulseCustomer | null => {
        try {
          return toCustomer(c);
        } catch {
          return null;
        }
      })
      .filter((c): c is FieldpulseCustomer => c !== null);
    return { items, totalCount };
  }

  async listJobs(
    maxPages = 200,
  ): Promise<{ items: FieldpulseJob[]; totalCount: number | null }> {
    // /jobs returns a fixed 20/page (page_size is IGNORED — Phase 0.5).
    const { rows, totalCount } = await this.fetchAllPages(
      "/jobs",
      new URLSearchParams(),
      20,
      maxPages,
    );
    const items = rows
      .map((j): FieldpulseJob | null => {
        try {
          return toJob(j);
        } catch {
          return null;
        }
      })
      .filter((j): j is FieldpulseJob => j !== null);
    return { items, totalCount };
  }

  async listInvoices(
    maxPages = 200,
  ): Promise<{ items: FieldpulseInvoice[]; totalCount: number | null }> {
    // /invoices total_count is NULL (Phase 0.5) — walk until empty. FP returns
    // a fixed 20/page here (live-verified 2026-07-09: pages 2-3 existed with
    // fresh ids); passing 50 made page 1 look "short" and stopped the walk.
    const { rows, totalCount } = await this.fetchAllPages(
      "/invoices",
      new URLSearchParams(),
      20,
      maxPages,
    );
    const items = rows
      .map(toInvoice)
      .filter((i): i is FieldpulseInvoice => i !== null);
    return { items, totalCount };
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
