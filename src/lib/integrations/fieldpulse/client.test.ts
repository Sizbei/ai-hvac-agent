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
