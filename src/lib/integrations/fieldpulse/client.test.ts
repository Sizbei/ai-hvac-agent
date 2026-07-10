import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestFieldpulseClient } from "./client";
import type { FieldpulseConfig } from "./config";

describe("RestFieldpulseClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let config: FieldpulseConfig;

  beforeEach(() => {
    mockFetch = vi.fn();
    config = {
      baseUrl: "https://api.fieldpulse.com",
      apiKey: "test-key",
    };
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("geocodeAddress", () => {
    it("returns normalized address when Fieldpulse validates successfully", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          valid: true,
          street: "123 Main St",
          city: "Johnson City",
          state: "TN",
          zip: "37601",
          latitude: 36.334,
          longitude: -82.3819,
        }),
      });

      const client = new RestFieldpulseClient(config, mockFetch as never);
      const result = await client.geocodeAddress({
        street: "123 Main St",
        city: "Johnson City",
        state: "TN",
        zip: "37601",
      });

      expect(result).toEqual({
        valid: true,
        normalizedAddress: {
          street: "123 Main St",
          city: "Johnson City",
          state: "TN",
          zip: "37601",
          country: null,
          streetLine2: null,
        },
        latitude: 36.334,
        longitude: -82.3819,
      });
    });

    it("returns invalid result when Fieldpulse rejects address", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          valid: false,
          error: "Address not found",
        }),
      });

      const client = new RestFieldpulseClient(config, mockFetch as never);
      const result = await client.geocodeAddress({
        street: "Invalid Address",
      });

      expect(result).toEqual({
        valid: false,
        error: "Address not found",
      });
    });

    it("returns null when endpoint doesn't exist (404)", async () => {
      mockFetch.mockRejectedValue(new Error("HTTP 404"));

      const client = new RestFieldpulseClient(config, mockFetch as never);
      const result = await client.geocodeAddress({
        street: "123 Main St",
      });

      expect(result).toBeNull();
    });

    it("returns null when response is malformed", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => null,
      });

      const client = new RestFieldpulseClient(config, mockFetch as never);
      const result = await client.geocodeAddress({
        street: "123 Main St",
      });

      expect(result).toBeNull();
    });

    it("returns error when no address components provided", async () => {
      const client = new RestFieldpulseClient(config, mockFetch as never);
      const result = await client.geocodeAddress({});

      expect(result).toEqual({
        valid: false,
        error: "No address components provided",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("handles optional address components", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          valid: true,
          street: "123 Main St",
          city: "Johnson City",
        }),
      });

      const client = new RestFieldpulseClient(config, mockFetch as never);
      const result = await client.geocodeAddress({
        street: "123 Main St",
        city: "Johnson City",
      });

      expect(result?.valid).toBe(true);
      expect(result?.normalizedAddress?.street).toBe("123 Main St");
    });

    it("includes all components in query string", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ valid: true }),
      });

      const client = new RestFieldpulseClient(config, mockFetch as never);
      await client.geocodeAddress({
        street: "123 Main St",
        city: "Johnson City",
        state: "TN",
        zip: "37601",
        country: "USA",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("123%20Main%20St%2C%20Johnson%20City%2C%20TN%2C%2037601%2C%20USA");
    });

    it("handles street_line_2 in response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          valid: true,
          street: "123 Main St",
          street_line_2: "Apt 4B",
          city: "Johnson City",
          state: "TN",
          zip: "37601",
        }),
      });

      const client = new RestFieldpulseClient(config, mockFetch as never);
      const result = await client.geocodeAddress({
        street: "123 Main St",
      });

      expect(result?.normalizedAddress?.streetLine2).toBe("Apt 4B");
    });
  });

  describe("request retry/timeout", () => {
    it("retries on a network error and succeeds on a later attempt", async () => {
      // First attempt rejects (e.g. timeout abort / connection reset), second OK.
      mockFetch
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ customers: [] }),
        });

      const client = new RestFieldpulseClient(config, mockFetch as never);
      const result = await client.findCustomer({ email: "a@b.com" });

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws a sanitized error after exhausting attempts on network errors", async () => {
      mockFetch.mockRejectedValue(new Error("network down"));

      const client = new RestFieldpulseClient(config, mockFetch as never);
      await expect(client.findCustomer({ email: "a@b.com" })).rejects.toThrow(
        "Fieldpulse request failed: network error",
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("passes an AbortSignal to fetch", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ customers: [] }),
      });

      const client = new RestFieldpulseClient(config, mockFetch as never);
      await client.findCustomer({ email: "a@b.com" });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });
});

import { mapFieldpulseInvoiceStatus } from "./client";

describe("mapFieldpulseInvoiceStatus (defensive, supplementary)", () => {
  it("maps the best-guess integer codes", () => {
    expect(mapFieldpulseInvoiceStatus(1)).toBe("draft");
    expect(mapFieldpulseInvoiceStatus(2)).toBe("open");
    expect(mapFieldpulseInvoiceStatus(3)).toBe("paid");
    expect(mapFieldpulseInvoiceStatus(4)).toBe("void");
  });
  it("accepts the stringified form FieldPulse sends", () => {
    expect(mapFieldpulseInvoiceStatus("3")).toBe("paid");
  });
  it("returns 'unknown' for any unrecognized / missing code (never a wrong guess)", () => {
    for (const c of [0, 5, 99, null, undefined, "", "x", NaN]) {
      expect(mapFieldpulseInvoiceStatus(c as never)).toBe("unknown");
    }
  });
});

describe("RestFieldpulseClient — defensive pagination (listJobInvoices)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A mock fetch Response carrying `n` invoice rows (ids start at `from`). */
  function page(from: number, n: number) {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: from + i,
      job_id: "job-1",
    }));
    return { ok: true, status: 200, json: async () => ({ response: rows }) };
  }

  it("walks pages when the API honors `page` (full page → fetch next; short page → stop)", async () => {
    mockFetch
      .mockResolvedValueOnce(page(1, 50)) // full → continue
      .mockResolvedValueOnce(page(51, 10)); // short → stop
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const invoices = await client.listJobInvoices("job-1");
    expect(invoices).toHaveLength(60);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The 2nd request asked for page=2.
    expect(String(mockFetch.mock.calls[1][0])).toContain("page=2");
  });

  it("does NOT loop or duplicate when the API IGNORES `page` (identical batches)", async () => {
    // Every call returns the SAME 50 rows — a server that ignores `page`.
    mockFetch.mockResolvedValue(page(1, 50));
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const invoices = await client.listJobInvoices("job-1");
    expect(invoices).toHaveLength(50); // deduped, NOT 100+
    expect(mockFetch).toHaveBeenCalledTimes(2); // page1 + page2(identical)→stop
  });

  it("stops after a single short page", async () => {
    mockFetch.mockResolvedValueOnce(page(1, 5));
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const invoices = await client.listJobInvoices("job-1");
    expect(invoices).toHaveLength(5);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("is bounded by the MAX_PAGES cap even if every page is full + distinct", async () => {
    let from = 1;
    mockFetch.mockImplementation(async () => {
      const p = page(from, 50);
      from += 50;
      return p;
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const invoices = await client.listJobInvoices("job-1");
    expect(mockFetch).toHaveBeenCalledTimes(20); // hard cap, never unbounded
    expect(invoices).toHaveLength(1000);
  });
});

describe("listUsers — toUser shape", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("coerces numeric role to string", async () => {
    // Real API shape: role is an integer (live-verified 2026-07-09, account 182499)
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        error: false,
        total_count: 1,
        response: [
          {
            id: 182499,
            first_name: "Jane",
            last_name: "Tech",
            email: "jane@example.com",
            active: true,
            role: 4,            // <-- integer, not string
          },
        ],
      }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const users = await client.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("4");   // must be coerced to string "4"
  });
});

// ── listCustomers / listJobs / listInvoices ──────────────────────────────────

describe("RestFieldpulseClient — listCustomers", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function customerPage(from: number, n: number, totalCount: number | null = null) {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: from + i,
      first_name: `Test${from + i}`,
      last_name: "Customer",
      email: `test${from + i}@example.com`,
      phone: "555-0100",
    }));
    const envelope: Record<string, unknown> = { error: false, response: rows };
    if (totalCount !== null) envelope.total_count = totalCount;
    return { ok: true, status: 200, json: async () => envelope };
  }

  it("pages until an empty/short page and returns mapped customers + totalCount", async () => {
    // FP /customers is fixed 50/page; total_count on first page.
    mockFetch
      .mockResolvedValueOnce(customerPage(1, 50, 75))
      .mockResolvedValueOnce(customerPage(51, 25, 75));
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items, totalCount } = await client.listCustomers();
    expect(items).toHaveLength(75);
    expect(totalCount).toBe(75);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("respects maxPages override", async () => {
    let from = 1;
    mockFetch.mockImplementation(async () => {
      const p = customerPage(from, 50, 500);
      from += 50;
      return p;
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listCustomers(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(items).toHaveLength(100);
  });

  it("stops when the API ignores page (identical batches — no duplicates)", async () => {
    mockFetch.mockResolvedValue(customerPage(1, 50, 50));
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listCustomers();
    expect(items).toHaveLength(50); // deduped
    expect(mockFetch).toHaveBeenCalledTimes(2); // page1 + page2(identical)→stop
  });

  it("surfaces totalCount null when envelope lacks the field", async () => {
    mockFetch.mockResolvedValue(customerPage(1, 3)); // totalCount arg omitted
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { totalCount } = await client.listCustomers();
    expect(totalCount).toBeNull();
  });
});

describe("RestFieldpulseClient — listJobs", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function jobPage(from: number, n: number, totalCount: number | null = null) {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: from + i,
      customer_id: 20000000 + from + i,
      status: 1,
      start_time: "2026-07-07 16:00:00",
      end_time: "2026-07-07 18:00:00",
      created_at: "2026-07-07 13:36:22",
    }));
    const envelope: Record<string, unknown> = { error: false, response: rows };
    if (totalCount !== null) envelope.total_count = totalCount;
    return { ok: true, status: 200, json: async () => envelope };
  }

  it("pages all jobs and returns mapped items + totalCount", async () => {
    // FP /jobs is fixed 20/page (verified Phase 0.5).
    mockFetch
      .mockResolvedValueOnce(jobPage(1, 20, 54))
      .mockResolvedValueOnce(jobPage(21, 20, 54))
      .mockResolvedValueOnce(jobPage(41, 14, 54));
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items, totalCount } = await client.listJobs();
    expect(items).toHaveLength(54);
    expect(totalCount).toBe(54);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("respects maxPages and stops early", async () => {
    let from = 1;
    mockFetch.mockImplementation(async () => {
      const p = jobPage(from, 20, 200);
      from += 20;
      return p;
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listJobs(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(20);
  });

  it("surfaces totalCount null when envelope lacks the field", async () => {
    mockFetch.mockResolvedValue(jobPage(1, 3)); // no totalCount
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { totalCount } = await client.listJobs();
    expect(totalCount).toBeNull();
  });
});

describe("RestFieldpulseClient — listInvoices", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function invoicePage(from: number, n: number, totalCount: number | null = null) {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: from + i,
      job_id: 18000000 + i,
      customer_id: 17000000 + i,
      status: 3,
      total: "100.00",
      amount_paid: "100.00",
      amount_unpaid: "0.00",
      created_at: "2026-06-01 12:00:00",
    }));
    const envelope: Record<string, unknown> = { error: false, response: rows };
    if (totalCount !== null) envelope.total_count = totalCount;
    return { ok: true, status: 200, json: async () => envelope };
  }

  it("pages all invoices at FP's fixed 20/page and surfaces totalCount null", async () => {
    // Phase 0.5: /invoices total_count is null AND FP returns a fixed 20/page
    // (live-verified: passing 50 made page 1 look "short" and stopped the walk).
    mockFetch
      .mockResolvedValueOnce(invoicePage(1, 20)) // no total_count key
      .mockResolvedValueOnce(invoicePage(21, 20))
      .mockResolvedValueOnce(invoicePage(41, 7)); // short final page
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items, totalCount } = await client.listInvoices();
    expect(items).toHaveLength(47);
    expect(totalCount).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("respects maxPages override", async () => {
    let from = 1;
    mockFetch.mockImplementation(async () => {
      const p = invoicePage(from, 20);
      from += 20;
      return p;
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listInvoices(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(items).toHaveLength(60);
  });

  it("stops when the API ignores page (identical batches — no duplicates)", async () => {
    mockFetch.mockResolvedValue(invoicePage(1, 20));
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listInvoices();
    expect(items).toHaveLength(20);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── getCustomer ───────────────────────────────────────────────────────────────

describe("RestFieldpulseClient — getCustomer", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Minimal envelope shape FP returns for a single customer. */
  function customerEnvelope(id: number | string = 17431277) {
    return {
      error: false,
      response: {
        id,
        first_name: "Jane",
        last_name: "Smith",
        display_name: "Jane Smith",
        email: "jane@example.invalid",
        phone: "555-010-0001",
        phone_e164: "+15550100001",
        address_1: "1 Main St",
        city: "Johnson City",
        state: "TN",
        zip_code: "37601",
        deleted_at: null,
        merged_customer_id: null,
      },
    };
  }

  it("returns a FieldpulseCustomer on 200 with the real envelope shape", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => customerEnvelope(17431277),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("17431277");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("17431277");
    expect(result!.displayName).toBe("Jane Smith");
    expect(result!.email).toBe("jane@example.invalid");
    // Verify the URL contained the customer id.
    expect(String(mockFetch.mock.calls[0][0])).toContain("/customers/17431277");
  });

  it("returns null on 404 (customer not in FP list page)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "Not found" }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("99999999");
    expect(result).toBeNull();
  });

  it("returns null on network error (degrades gracefully)", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("17431277");
    expect(result).toBeNull();
  });
});

// ── listJobs real-shape fixture (Phase 0.5 sanitized fixture) ────────────────

import jobFixture from "./fixtures/fp-jobs-page1-sanitized.json";

describe("RestFieldpulseClient — listJobs real-shape fixture", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses the sanitized Phase-0.5 job fixture: all 4 status ints, schedule, assignments", async () => {
    // First page returns all 4 fixture jobs; second page empty → stop.
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => jobFixture,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ error: false, response: [], total_count: 54 }),
      });

    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items, totalCount } = await client.listJobs();

    expect(items).toHaveLength(4);
    expect(totalCount).toBe(54);

    // Verify one job per status int.
    const byStatus = Object.fromEntries(items.map((j) => [j.workStatus, j]));
    expect(byStatus["1"]).toBeDefined();
    expect(byStatus["2"]).toBeDefined();
    expect(byStatus["3"]).toBeDefined();
    expect(byStatus["4"]).toBeDefined();

    // Verify schedule fields map from start_time/end_time.
    const job1 = byStatus["1"];
    expect(job1.scheduleStart).toBe("2026-07-07 16:00:00");
    expect(job1.scheduleEnd).toBe("2026-07-07 18:00:00");

    // Verify customer id is coerced to string.
    expect(typeof job1.customerId).toBe("string");

    // Status 1 job has completed_at (useful for terminal-state correlation).
    expect(job1.createdAt).toBe("2026-07-07 13:36:22");
  });
});

// ── getJobRaw seam-guard ──────────────────────────────────────────────────────

describe("RestFieldpulseClient — getJobRaw", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns unwrapped raw payload preserving status_log, total_price, and map", async () => {
    const rawJob = {
      id: 42,
      status_log: { pending: 0, on_the_way: 5940, in_progress: 108756, completed: 0 },
      total_price: "245.00",
      map: { lat: 36.3, lng: -82.3 },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ error: false, response: rawJob }),
    });

    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getJobRaw("42") as Record<string, unknown>;

    expect(result.status_log).toEqual(rawJob.status_log);
    expect(result.total_price).toBe("245.00");
    expect(result.map).toEqual(rawJob.map);
  });
});

// ── toCustomer: customFields + lead_source folding ────────────────────────────

describe("RestFieldpulseClient — toCustomer customFields + lead_source folding", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function customerEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      error: false,
      response: {
        id: 12345,
        display_name: "Test Customer",
        ...overrides,
      },
    };
  }

  it("folds customfields + lead_source together: customfields first, then Lead Source", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        customerEnvelope({
          customfields: [{ name: "Referral", value: "Angi" }],
          lead_source: "Google",
        }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("12345");
    expect(result?.customFields).toEqual([
      { name: "Referral", value: "Angi" },
      { name: "Lead Source", value: "Google" },
    ]);
  });

  it("tolerates malformed customfields entries; coerces numeric values; falls back to field_instance_id labels", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        customerEnvelope({
          customfields: [
            "not-an-object",            // non-object entry → dropped
            { name: "Score", value: 99 }, // numeric value → coerced to "99"
            { label: "Source" },          // missing value key → dropped
            { name: "Good", value: "Yes" }, // valid entry
            // Live-verified real shape: NO name, only field_instance_id + value
            { field_instance_id: 164098, value: "Commercial" },
            { field_instance_id: 164099, value: "" }, // empty value → dropped
          ],
        }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("12345");
    expect(result?.customFields).toEqual([
      { name: "Score", value: "99" },
      { name: "Good", value: "Yes" },
      { name: "Custom field #164098", value: "Commercial" },
    ]);
  });

  it("returns null customFields when no customfields and no lead_source", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => customerEnvelope({ customfields: null }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("12345");
    expect(result?.customFields).toBeNull();
  });
});

// ── cappedByMaxPages flag ─────────────────────────────────────────────────────

describe("RestFieldpulseClient — cappedByMaxPages flag", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function fullPage(from: number, pageSize = 20) {
    // A complete page of `pageSize` rows — the condition that triggers the cap.
    const rows = Array.from({ length: pageSize }, (_, i) => ({
      id: from + i,
      customer_id: 9000000 + from + i,
      status: 1,
      start_time: "2026-07-07 16:00:00",
      end_time: "2026-07-07 18:00:00",
      created_at: "2026-07-07 13:36:22",
    }));
    return { ok: true, status: 200, json: async () => ({ error: false, response: rows }) };
  }

  function shortPage(from: number, pageSize = 20, count = 5) {
    const rows = Array.from({ length: count }, (_, i) => ({
      id: from + i,
      customer_id: 9000000 + from + i,
      status: 1,
      start_time: "2026-07-07 16:00:00",
      end_time: "2026-07-07 18:00:00",
      created_at: "2026-07-07 13:36:22",
    }));
    void pageSize;
    return { ok: true, status: 200, json: async () => ({ error: false, response: rows }) };
  }

  it("cappedByMaxPages=true when walk ends at maxPages with a full page", async () => {
    // maxPages=2, both pages are full → walk stopped by cap, not naturally.
    mockFetch
      .mockResolvedValueOnce(fullPage(1))
      .mockResolvedValueOnce(fullPage(21));
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { cappedByMaxPages } = await client.listJobs(2);
    expect(cappedByMaxPages).toBe(true);
  });

  it("cappedByMaxPages=false when walk ends naturally on a short page", async () => {
    // maxPages=10, but the data ends after 2 pages naturally.
    mockFetch
      .mockResolvedValueOnce(fullPage(1))
      .mockResolvedValueOnce(shortPage(21, 20, 5)); // short page → natural end
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { cappedByMaxPages } = await client.listJobs(10);
    expect(cappedByMaxPages).toBe(false);
  });

  it("cappedByMaxPages=false when walk ends naturally on empty page", async () => {
    mockFetch
      .mockResolvedValueOnce(fullPage(1))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { cappedByMaxPages } = await client.listJobs(10);
    expect(cappedByMaxPages).toBe(false);
  });
});

// ── listItems ─────────────────────────────────────────────────────────────────

describe("RestFieldpulseClient — listItems", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function itemPage(from: number, n: number, totalCount: number | null = null) {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: from + i,
      name: `Item ${from + i}`,
      default_unit_price: "99.00",
      default_taxable: true,
      is_active: true,
      type: "service",
    }));
    const envelope: Record<string, unknown> = { error: false, response: rows };
    if (totalCount !== null) envelope.total_count = totalCount;
    return { ok: true, status: 200, json: async () => envelope };
  }

  it("pages /items at 20/page, total_count null, maps FieldpulseItem correctly", async () => {
    mockFetch
      .mockResolvedValueOnce(itemPage(1, 20))
      .mockResolvedValueOnce(itemPage(21, 20))
      .mockResolvedValueOnce(itemPage(41, 7)); // short final page
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items, totalCount, cappedByMaxPages } = await client.listItems();
    expect(items).toHaveLength(47);
    expect(totalCount).toBeNull();
    expect(cappedByMaxPages).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Spot-check mapper output.
    expect(items[0].priceCents).toBe(9900);
    expect(items[0].taxable).toBe(true);
    expect(items[0].isActive).toBe(true);
    expect(items[0].type).toBe("service");
    expect(items[0].rawFpType).toBe("service");
  });

  it("skips nameless rows in toItem (name missing or blank)", async () => {
    const rows = [
      { id: 1, name: "Valid Item", default_unit_price: "10.00", is_active: true, type: "service" },
      { id: 2, name: "", default_unit_price: "10.00", is_active: true, type: "service" }, // blank
      { id: 3, name: "  ", default_unit_price: "10.00", is_active: true }, // whitespace
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ error: false, response: rows }),
    }).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ error: false, response: [] }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Valid Item");
  });

  it("maps material and equipment type strings correctly", async () => {
    const rows = [
      { id: 1, name: "Filter", default_unit_price: "5.00", is_active: true, type: "material" },
      { id: 2, name: "Compressor", default_unit_price: "500.00", is_active: true, type: "equipment" },
      { id: 3, name: "Unknown Type Item", default_unit_price: "0.00", is_active: true, type: "hvac_widget" },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ error: false, response: rows }),
    }).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ error: false, response: [] }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].type).toBe("material");
    expect(items[1].type).toBe("equipment");
    expect(items[2].type).toBe("service"); // unknown → fallback
    expect(items[2].rawFpType).toBe("hvac_widget");
  });

  it("parses dollar string price defensively (number or string)", async () => {
    const rows = [
      { id: 1, name: "String Price", default_unit_price: "149.99", is_active: true, type: "service" },
      { id: 2, name: "Number Price", default_unit_price: 149.99, is_active: true, type: "service" },
      { id: 3, name: "Null Price", default_unit_price: null, is_active: true, type: "service" },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ error: false, response: rows }),
    }).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ error: false, response: [] }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].priceCents).toBe(14999);
    expect(items[1].priceCents).toBe(14999);
    expect(items[2].priceCents).toBe(0); // null → 0
  });

  it("treats absent is_active as active=true (inclusive default)", async () => {
    const rows = [
      { id: 1, name: "No active field", default_unit_price: "10.00", type: "service" },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ error: false, response: rows }),
    }).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ error: false, response: [] }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].isActive).toBe(true);
  });

  it("respects maxPages override", async () => {
    let from = 1;
    mockFetch.mockImplementation(async () => {
      const p = itemPage(from, 20);
      from += 20;
      return p;
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items, cappedByMaxPages } = await client.listItems(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(items).toHaveLength(60);
    expect(cappedByMaxPages).toBe(true);
  });

  // ── P1 field-parity additions ─────────────────────────────────────────────

  it("toItem: maps costCents from default_unit_cost (dollar string → cents)", async () => {
    const rows = [
      { id: 1, name: "Diagnostic", default_unit_price: "99.00", default_unit_cost: "45.50", is_active: true, type: "service" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].costCents).toBe(4550);
  });

  it("toItem: maps costCents=null when default_unit_cost is null", async () => {
    const rows = [
      { id: 1, name: "Diagnostic", default_unit_price: "99.00", default_unit_cost: null, is_active: true, type: "service" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].costCents).toBeNull();
  });

  it("toItem: maps description from default_description (trimmed)", async () => {
    const rows = [
      { id: 1, name: "Filter Change", default_unit_price: "0.00", default_description: "  Replace 1-inch filter  ", is_active: true, type: "service" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].description).toBe("Replace 1-inch filter");
  });

  it("toItem: maps description=null when default_description is absent/blank", async () => {
    const rows = [
      { id: 1, name: "Filter Change", default_unit_price: "0.00", is_active: true, type: "service" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].description).toBeNull();
  });

  it("toItem: maps isLaborItem=true from is_labor_item=true", async () => {
    const rows = [
      { id: 1, name: "Labor", default_unit_price: "100.00", is_labor_item: true, is_active: true, type: "service" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].isLaborItem).toBe(true);
  });

  it("toItem: maps isLaborItem=true from is_labor_item=1 (integer coerce)", async () => {
    const rows = [
      { id: 1, name: "Labor 2", default_unit_price: "80.00", is_labor_item: 1, is_active: true, type: "service" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].isLaborItem).toBe(true);
  });

  it("toItem: maps isLaborItem=false when is_labor_item is absent", async () => {
    const rows = [
      { id: 1, name: "Part", default_unit_price: "5.00", is_active: true, type: "material" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].isLaborItem).toBe(false);
  });

  it("toItem: maps quantityAvailable from quantity_available (rounds)", async () => {
    const rows = [
      { id: 1, name: "Capacitor", default_unit_price: "25.00", quantity_available: 9.7, is_active: true, type: "material" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].quantityAvailable).toBe(10);
  });

  it("toItem: maps quantityAvailable=null when absent", async () => {
    const rows = [
      { id: 1, name: "Capacitor", default_unit_price: "25.00", is_active: true, type: "material" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].quantityAvailable).toBeNull();
  });

  it("toItem: maps vendorType from vendor_type (trimmed)", async () => {
    const rows = [
      { id: 1, name: "Compressor", default_unit_price: "450.00", vendor_type: "  carrier  ", is_active: true, type: "equipment" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].vendorType).toBe("carrier");
  });

  it("toItem: maps markupPct as rounded int percentage (NOT dollarsToCents)", async () => {
    const rows = [
      { id: 1, name: "Filter", default_unit_price: "10.00", automatic_markup_percentage: 15.6, is_active: true, type: "material" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    // 15.6% → Math.round(15.6) = 16 (not 1560 as dollarsToCents would give)
    expect(items[0].markupPct).toBe(16);
  });

  it("toItem: markupPct=0 from automatic_markup_percentage=0", async () => {
    const rows = [
      { id: 1, name: "Part", default_unit_price: "5.00", automatic_markup_percentage: 0, is_active: true, type: "material" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].markupPct).toBe(0);
  });

  it("toItem: markupPct=null when automatic_markup_percentage is absent", async () => {
    const rows = [
      { id: 1, name: "Part", default_unit_price: "5.00", is_active: true, type: "material" },
    ];
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: rows }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: false, response: [] }) });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items } = await client.listItems();
    expect(items[0].markupPct).toBeNull();
  });

  it("identical-batch stop AT page===maxPages with full page → cappedByMaxPages=false (repeated-batch break wins)", async () => {
    // The API ignores the `page` param and returns the same batch every call.
    // When the repeated-batch break fires at page === maxPages the cap flag
    // must remain false — we stopped because the API looped, not because we
    // hit the ceiling.
    const page1 = itemPage(1, 20); // full page of 20
    mockFetch
      .mockResolvedValueOnce(page1) // page 1 — accepted
      .mockResolvedValueOnce(page1); // page 2 (maxPages=2) — identical → break
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const { items, cappedByMaxPages } = await client.listItems(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(items).toHaveLength(20); // only the first batch kept (no dupes)
    expect(cappedByMaxPages).toBe(false);
  });
});

// ── toCustomer: P1 field-parity additions ────────────────────────────────────

describe("RestFieldpulseClient — toCustomer P1 field-parity", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function customerEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      error: false,
      response: {
        id: 10001001,
        display_name: "Test Customer",
        ...overrides,
      },
    };
  }

  it("maps accountType from account_type string", async () => {
    mockFetch.mockResolvedValue({
      ok: true, json: async () => customerEnvelope({ account_type: "commercial" }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("10001001");
    expect(result?.accountType).toBe("commercial");
  });

  it("maps accountType=null when account_type is absent", async () => {
    mockFetch.mockResolvedValue({
      ok: true, json: async () => customerEnvelope({}),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("10001001");
    expect(result?.accountType).toBeNull();
  });

  it("maps isTaxExempt=true from boolean", async () => {
    mockFetch.mockResolvedValue({
      ok: true, json: async () => customerEnvelope({ is_tax_exempt: true }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("10001001");
    expect(result?.isTaxExempt).toBe(true);
  });

  it("maps isTaxExempt=false from 0 (integer coerce)", async () => {
    mockFetch.mockResolvedValue({
      ok: true, json: async () => customerEnvelope({ is_tax_exempt: 0 }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("10001001");
    expect(result?.isTaxExempt).toBe(false);
  });

  it("maps isTaxExempt=true from 1 (integer coerce)", async () => {
    mockFetch.mockResolvedValue({
      ok: true, json: async () => customerEnvelope({ is_tax_exempt: 1 }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("10001001");
    expect(result?.isTaxExempt).toBe(true);
  });

  it("maps isTaxExempt=null when absent", async () => {
    mockFetch.mockResolvedValue({
      ok: true, json: async () => customerEnvelope({}),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("10001001");
    expect(result?.isTaxExempt).toBeNull();
  });

  it("maps billingAddress when has_different_billing_address=true and billing_address_1 is populated", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        customerEnvelope({
          has_different_billing_address: true,
          billing_address_1: "200 Billing Ave",
          billing_address_2: null,
          billing_city: "Billington",
          billing_state: "TN",
          billing_zip_code: "37001",
        }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("10001001");
    expect(result?.billingAddress).not.toBeNull();
    expect(result?.billingAddress?.street).toBe("200 Billing Ave");
    expect(result?.billingAddress?.city).toBe("Billington");
    expect(result?.billingAddress?.state).toBe("TN");
    expect(result?.billingAddress?.zip).toBe("37001");
  });

  it("maps billingAddress=null when has_different_billing_address is absent/false", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        customerEnvelope({
          has_different_billing_address: false,
          billing_address_1: "200 Billing Ave",
        }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("10001001");
    expect(result?.billingAddress).toBeNull();
  });

  it("maps billingAddress=null when has_different_billing_address=true but billing_address_1 is absent", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        customerEnvelope({
          has_different_billing_address: true,
          // no billing_address_1
        }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getCustomer("10001001");
    expect(result?.billingAddress).toBeNull();
  });
});

// ── toEstimate: P1 field-parity additions ────────────────────────────────────

describe("RestFieldpulseClient — toEstimate P1 field-parity", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const config = { baseUrl: "https://api.fieldpulse.com", apiKey: "k" };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function estEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      error: false,
      response: {
        id: 70000001,
        customer_id: 20000001,
        status: "2",
        subtotal: "250.00",
        total: "270.00",
        created_at: "2026-07-01 08:00:00",
        ...overrides,
      },
    };
  }

  it("maps title from the `name` field (FP list API uses `name`, not `title`)", async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => estEnvelope({ name: "HVAC Repair Quote" }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getEstimate("70000001");
    expect(result?.title).toBe("HVAC Repair Quote");
  });

  it("maps title from `title` as fallback when `name` is absent", async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => estEnvelope({ title: "Fallback Title" }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getEstimate("70000001");
    expect(result?.title).toBe("Fallback Title");
  });

  it("maps title=null when both name and title are absent", async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => estEnvelope({}),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getEstimate("70000001");
    expect(result?.title).toBeNull();
  });

  it("maps dueDate from due_date string", async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => estEnvelope({ due_date: "2026-08-01" }),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getEstimate("70000001");
    expect(result?.dueDate).toBe("2026-08-01");
  });

  it("maps dueDate=null when due_date is absent", async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => estEnvelope({}),
    });
    const client = new RestFieldpulseClient(config, mockFetch as never);
    const result = await client.getEstimate("70000001");
    expect(result?.dueDate).toBeNull();
  });
});
