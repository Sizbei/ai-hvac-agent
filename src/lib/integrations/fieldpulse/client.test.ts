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
