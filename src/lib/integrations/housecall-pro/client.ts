/**
 * Housecall Pro CLIENT seam.
 *
 * ┌─ HOUSECALL PRO SEAM ───────────────────────────────────────────────────────┐
 * │ {@link HousecallProClient} is the only surface business code calls. The live │
 * │ implementation talks to the HCP REST API (MAX plan) with API-key header      │
 * │ auth. Mirrors admin/scheduling-source.ts and the Google client: a narrow     │
 * │ interface + a concrete impl + a factory, so the live client (or a fake in    │
 * │ tests) can be swapped without touching callers.                              │
 * │                                                                              │
 * │ {@link getHousecallClient} returns null when the org has no API key (no       │
 * │ connection + no env fallback) — the single signal callers branch on to       │
 * │ DEGRADE SAFELY. The API key is never logged. `fetchImpl` is injectable so     │
 * │ tests mock the network and NEVER hit the real HCP API.                       │
 * └──────────────────────────────────────────────────────────────────────────────┘
 */
import { getHousecallConfig, type HousecallConfig } from "./config";
import type {
  CreateCustomerInput,
  CreateJobInput,
  FindCustomerQuery,
  HousecallAccountInfo,
  HousecallAvailabilityRange,
  HousecallAvailabilitySlot,
  HousecallCustomer,
  HousecallJob,
  HousecallLineItem,
  HousecallTechnician,
  UpdateJobInput,
} from "./types";

/** Max attempts (1 initial + retries) for transient 429/5xx failures. */
const MAX_ATTEMPTS = 3;
/** Base backoff; doubles per attempt (100ms, 200ms, ...). */
const BACKOFF_BASE_MS = 100;

/** Retryable per HCP/REST norms: rate-limit + server errors. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The seam every business caller depends on. One client instance is bound to
 * one org's resolved config (the API key arrives inside {@link HousecallConfig}).
 */
export interface HousecallProClient {
  /** Create an HCP customer; returns the created resource (with its HCP id). */
  createCustomer(input: CreateCustomerInput): Promise<HousecallCustomer>;

  /**
   * Find an existing HCP customer by email/phone, or null when none matches.
   * Used to avoid creating duplicates (pairs with our blind-index dedupe).
   */
  findCustomer(query: FindCustomerQuery): Promise<HousecallCustomer | null>;

  /** Create an HCP job for a customer; returns the created resource. */
  createJob(input: CreateJobInput): Promise<HousecallJob>;

  /**
   * Update an existing HCP job (reschedule/re-describe). Used for the idempotent
   * re-push path: once we hold an hcp_job_id we UPDATE rather than create a
   * duplicate. Returns the updated resource.
   */
  updateJob(jobId: string, input: UpdateJobInput): Promise<HousecallJob>;

  /**
   * Cancel an existing HCP job (our request was cancelled). HCP models a cancel
   * as a work-status change to "canceled", which keeps the job's history rather
   * than hard-deleting it. Idempotent from our side: a second cancel is harmless.
   */
  cancelJob(jobId: string): Promise<void>;

  /**
   * Append a note to an existing HCP job so the field tech sees it (a dispatcher
   * note / appointment update). HCP returns the created note (or 204); we ignore
   * the body — the caller only needs "it happened". Mirrors {@link cancelJob}'s
   * void-return style. Appending is additive, so a repeat is harmless.
   */
  addJobNote(jobId: string, note: string): Promise<void>;

  /**
   * List the jobs HCP has on file for one customer (their service history),
   * newest-ish first as HCP returns them. READ-ONLY. Used to surface prior
   * service ("last serviced in March") to the bot and admin views.
   */
  listCustomerJobs(hcpCustomerId: string): Promise<readonly HousecallJob[]>;

  /** Fetch a job by HCP id (e.g. to reconcile a webhook). */
  getJob(jobId: string): Promise<HousecallJob>;

  /** List bookable availability slots within a UTC range (Stage 4 source). */
  listAvailability(
    range: HousecallAvailabilityRange,
  ): Promise<readonly HousecallAvailabilitySlot[]>;

  /**
   * List the org's technician (employee) roster. Used to derive the REAL set of
   * active technicians the scheduling source reports (replacing synthetic ids
   * inferred from availability windows). Tolerant of omitted fields; the active
   * filter is applied by the mapping, not here.
   */
  listTechnicians(): Promise<readonly HousecallTechnician[]>;

  /**
   * Lightweight authenticated probe used to VALIDATE an API key at connect time
   * and to cache non-secret account metadata. Throws on auth failure.
   */
  getAccountInfo(): Promise<HousecallAccountInfo>;
}

/** Map a raw HCP address to our type (tolerant of omitted fields). */
function toAddress(raw: unknown): Record<string, string | undefined> {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  return {
    street: str(obj.street),
    street_line_2: str(obj.street_line_2),
    city: str(obj.city),
    state: str(obj.state),
    zip: str(obj.zip),
    country: str(obj.country),
  };
}

/** Narrow an untrusted HCP customer payload to {@link HousecallCustomer}. */
function toCustomer(raw: unknown): HousecallCustomer {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Housecall Pro returned a malformed customer");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string") {
    throw new Error("Housecall Pro customer missing id");
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  const addresses = Array.isArray(obj.addresses)
    ? obj.addresses.map(toAddress)
    : [];
  return {
    id: obj.id,
    first_name: str(obj.first_name),
    last_name: str(obj.last_name),
    email: str(obj.email),
    mobile_number: str(obj.mobile_number),
    home_number: str(obj.home_number),
    company: str(obj.company),
    addresses,
  };
}

/**
 * Serialize our descriptive line items into HCP's job `line_items` payload.
 *
 * ASSUMED HCP SHAPE: HCP's job endpoints accept a `line_items` array whose
 * entries carry `name`, a `kind` ("service" | "material" | "labor"), a
 * `quantity`, an optional `description`, and a `unit_price` in CENTS. We map our
 * field names to those keys.
 *
 * PRICING (CRITICAL): our line items never carry a price — `unitPriceCents` is
 * always undefined — so `unit_price` is OMITTED from every serialized row. This
 * business prices on-site; we send descriptive rows only. Returns undefined when
 * there are no items, so the key is omitted from the job body entirely.
 */
function toLineItemsPayload(
  items: readonly HousecallLineItem[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!items || items.length === 0) {
    return undefined;
  }
  return items.map((item) => ({
    name: item.name,
    kind: item.kind ?? "service",
    quantity: item.quantity ?? 1,
    description: item.description,
    // unit_price is sent ONLY when a price exists. Our mapping never sets one
    // (descriptive items, priced on-site), so this stays omitted in practice.
    unit_price: item.unitPriceCents,
  }));
}

/** Narrow an untrusted HCP job payload to {@link HousecallJob}. */
function toJob(raw: unknown): HousecallJob {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Housecall Pro returned a malformed job");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.customer_id !== "string") {
    throw new Error("Housecall Pro job missing id/customer_id");
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  const schedule =
    typeof obj.schedule === "object" && obj.schedule !== null
      ? (obj.schedule as Record<string, unknown>)
      : {};
  return {
    id: obj.id,
    customer_id: obj.customer_id,
    work_status: typeof obj.work_status === "string" ? obj.work_status : "unknown",
    description: str(obj.description),
    schedule_start: str(schedule.start_time),
    schedule_end: str(schedule.end_time),
  };
}

/**
 * Narrow an untrusted HCP employee payload to {@link HousecallTechnician}, or
 * null when it has no usable id. Tolerant of omitted fields: HCP omits blanks and
 * may add fields, so a missing name/active flag must NOT crash the roster sync.
 *
 * Name is assembled from `name` (if HCP returns a single field) or first/last;
 * the active flag is read from either `active` or `is_active` (HCP's employee
 * payloads have varied), left undefined when neither is a boolean so the mapping
 * can decide how to treat unknown-status staff.
 */
function toTechnician(raw: unknown): HousecallTechnician | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return null;
  }
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const assembled = [str(obj.first_name), str(obj.last_name)]
    .filter((p): p is string => p !== undefined)
    .join(" ");
  // Prefer HCP's single `name` field; else first+last; else undefined (never "").
  const name = str(obj.name) ?? (assembled.length > 0 ? assembled : undefined);
  const isActive =
    typeof obj.active === "boolean"
      ? obj.active
      : typeof obj.is_active === "boolean"
        ? obj.is_active
        : undefined;
  return { id: obj.id, name, isActive };
}

/**
 * REST client for the HCP API (MAX plan). Holds one org's resolved config and
 * authenticates every request with the API key in a header. Retries transient
 * 429/5xx with exponential backoff; surfaces other non-OK responses as errors.
 */
export class RestHousecallProClient implements HousecallProClient {
  constructor(
    private readonly config: HousecallConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Authenticated fetch with retry/backoff. Sends the API key as a Bearer
   * token in the Authorization header (HCP accepts `Authorization: Token <key>`
   * historically and `Bearer` for newer keys; we use the documented Token
   * scheme). The key is NEVER logged — errors carry only status codes.
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
          authorization: `Token ${this.config.apiKey}`,
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
        throw new Error(`Housecall Pro request failed: HTTP ${res.status}`);
      }
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
    }
    // Unreachable: the loop either returns or throws, but satisfies the compiler.
    throw new Error(`Housecall Pro request failed: HTTP ${lastStatus}`);
  }

  async createCustomer(
    input: CreateCustomerInput,
  ): Promise<HousecallCustomer> {
    const body = {
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      mobile_number: input.mobileNumber,
      addresses: input.address ? [input.address] : undefined,
    };
    const raw = await this.request("/customers", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return toCustomer(raw);
  }

  async findCustomer(
    query: FindCustomerQuery,
  ): Promise<HousecallCustomer | null> {
    const term = query.email ?? query.phone;
    if (!term) {
      return null;
    }
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

  async createJob(input: CreateJobInput): Promise<HousecallJob> {
    const body = {
      customer_id: input.customerId,
      description: input.description,
      schedule:
        input.scheduleStart || input.scheduleEnd
          ? { start_time: input.scheduleStart, end_time: input.scheduleEnd }
          : undefined,
      // Carry our request id so a webhook can map the HCP job back to us.
      tags: input.requestId ? [`request:${input.requestId}`] : undefined,
      // Descriptive line items (no prices); omitted when none were derived.
      line_items: toLineItemsPayload(input.lineItems),
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
  ): Promise<HousecallJob> {
    // Send only what changed: a reschedule carries the new window, a
    // re-describe carries description. `schedule` is sent only when either
    // bound is present so a description-only update doesn't blank the window.
    const body = {
      description: input.description,
      schedule:
        input.scheduleStart || input.scheduleEnd
          ? { start_time: input.scheduleStart, end_time: input.scheduleEnd }
          : undefined,
      // Sent only when present so a description/schedule-only update never blanks
      // the job's existing items. Descriptive (no prices).
      line_items: toLineItemsPayload(input.lineItems),
    };
    const raw = await this.request(`/jobs/${encodeURIComponent(jobId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return toJob(raw);
  }

  async cancelJob(jobId: string): Promise<void> {
    // HCP cancels via a work-status transition, not a DELETE — this preserves
    // the job's history. The endpoint returns the updated job (or 204); we
    // ignore the body since the caller only needs "it happened".
    await this.request(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "PUT",
    });
  }

  async addJobNote(jobId: string, note: string): Promise<void> {
    // ASSUMED HCP SHAPE: a job's notes live under a `/jobs/{id}/notes`
    // sub-collection; a POST with a JSON body `{ content }` appends one. We
    // follow HCP's convention (`content`, as the request-note POST route already
    // uses). Like cancelJob, the endpoint returns the created note (or 204); we
    // ignore the body since the caller only needs "it happened".
    await this.request(`/jobs/${encodeURIComponent(jobId)}/notes`, {
      method: "POST",
      body: JSON.stringify({ content: note }),
    });
  }

  async listCustomerJobs(
    hcpCustomerId: string,
  ): Promise<readonly HousecallJob[]> {
    // ENDPOINT ASSUMPTION: HCP exposes a customer's jobs via the jobs list
    // endpoint filtered by `customer_id` (mirrors findCustomer's `q=` query +
    // paged `{ jobs: [...] }` envelope). If the account instead nests jobs under
    // `/customers/{id}/jobs`, only this path + the envelope key change; the
    // parse/narrow below is unaffected.
    const params = new URLSearchParams({
      customer_id: hcpCustomerId,
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
      .map((j): HousecallJob | null => {
        try {
          return toJob(j);
        } catch {
          return null;
        }
      })
      .filter((j): j is HousecallJob => j !== null);
  }

  async getJob(jobId: string): Promise<HousecallJob> {
    const raw = await this.request(`/jobs/${encodeURIComponent(jobId)}`, {
      method: "GET",
    });
    return toJob(raw);
  }

  async listAvailability(
    range: HousecallAvailabilityRange,
  ): Promise<readonly HousecallAvailabilitySlot[]> {
    const params = new URLSearchParams({
      start_time: range.startIso,
      end_time: range.endIso,
    });
    const raw = await this.request(
      `/company/schedule_availability?${params.toString()}`,
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
      .map((s): HousecallAvailabilitySlot | null => {
        if (typeof s !== "object" || s === null) {
          return null;
        }
        const obj = s as Record<string, unknown>;
        if (
          typeof obj.start_time !== "string" ||
          typeof obj.end_time !== "string"
        ) {
          return null;
        }
        return { startIso: obj.start_time, endIso: obj.end_time };
      })
      .filter((slot): slot is HousecallAvailabilitySlot => slot !== null);
  }

  async listTechnicians(): Promise<readonly HousecallTechnician[]> {
    // HCP exposes the technician roster as the employees collection. Mirror
    // listAvailability: GET, pull the typed list from the envelope, narrow +
    // drop malformed rows (one bad employee must not blank the whole roster).
    const raw = await this.request("/employees", { method: "GET" });
    const list =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).employees
        : undefined;
    if (!Array.isArray(list)) {
      return [];
    }
    return list
      .map(toTechnician)
      .filter((t): t is HousecallTechnician => t !== null);
  }

  async getAccountInfo(): Promise<HousecallAccountInfo> {
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
}

/**
 * Resolve the active HCP client for an org, or null when not configured (no
 * connection + no env fallback). A single seam: callers branch on null to
 * degrade safely. `baseUrl`/`fetchImpl` are injectable for tests so the real
 * HCP API is never called in test.
 */
export async function getHousecallClient(
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl?: string,
): Promise<HousecallProClient | null> {
  const config = await getHousecallConfig(organizationId, baseUrl);
  if (!config) {
    return null;
  }
  return new RestHousecallProClient(config, fetchImpl);
}
