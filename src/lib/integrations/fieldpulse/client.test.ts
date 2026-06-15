import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestFieldpulseClient } from "./client";
import type { FieldpulseConfig } from "./config";
import type { GeocodeInput } from "./types";

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

      const client = new RestFieldpulseClient(config, mockFetch as any);
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

      const client = new RestFieldpulseClient(config, mockFetch as any);
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

      const client = new RestFieldpulseClient(config, mockFetch as any);
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

      const client = new RestFieldpulseClient(config, mockFetch as any);
      const result = await client.geocodeAddress({
        street: "123 Main St",
      });

      expect(result).toBeNull();
    });

    it("returns error when no address components provided", async () => {
      const client = new RestFieldpulseClient(config, mockFetch as any);
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

      const client = new RestFieldpulseClient(config, mockFetch as any);
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

      const client = new RestFieldpulseClient(config, mockFetch as any);
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

      const client = new RestFieldpulseClient(config, mockFetch as any);
      const result = await client.geocodeAddress({
        street: "123 Main St",
      });

      expect(result?.normalizedAddress?.streetLine2).toBe("Apt 4B");
    });
  });
});
