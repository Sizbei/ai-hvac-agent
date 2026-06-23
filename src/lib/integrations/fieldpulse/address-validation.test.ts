import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchValidatedAddressSuggestions,
  normalizeAddressForFieldpulse,
  validateAddressForSync,
  hasMinimumAddressQuality,
} from "./address-validation";

// Mock the dependencies
vi.mock("@/lib/address/photon", () => ({
  fetchAddressSuggestions: vi.fn(),
}));

vi.mock("./client", () => ({
  getFieldpulseClient: vi.fn(),
}));

import { fetchAddressSuggestions } from "@/lib/address/photon";
import { getFieldpulseClient } from "./client";

describe("address-validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchValidatedAddressSuggestions", () => {
    it("returns high-quality Photon results without calling Fieldpulse", async () => {
      const mockSuggestions = [
        {
          label: "123 Main St, Johnson City, TN 37601",
          street: "123 Main St",
          city: "Johnson City",
          state: "TN",
          postcode: "37601",
          lat: 36.334,
          lon: -82.3819,
        },
      ];

      vi.mocked(fetchAddressSuggestions).mockResolvedValue(mockSuggestions);

      const result = await fetchValidatedAddressSuggestions("123 Main St", "org-123");

      expect(result).toEqual(mockSuggestions);
      expect(fetchAddressSuggestions).toHaveBeenCalledTimes(1);
      expect(getFieldpulseClient).not.toHaveBeenCalled();
    });

    it("falls back to Fieldpulse when Photon returns low-quality results", async () => {
      // Low-quality result (no ZIP code)
      const lowQualitySuggestions = [
        {
          label: "Main St",
          street: "Main St",
          city: null,
          state: null,
          postcode: null,
          lat: null,
          lon: null,
        },
      ];

      const mockClient = {
        geocodeAddress: vi.fn().mockResolvedValue({
          valid: true,
          normalizedAddress: {
            street: "123 Main St",
            city: "Johnson City",
            state: "TN",
            zip: "37601",
          },
          latitude: 36.334,
          longitude: -82.3819,
        }),
      };

      vi.mocked(fetchAddressSuggestions).mockResolvedValue(lowQualitySuggestions);
      vi.mocked(getFieldpulseClient).mockResolvedValue(mockClient as never);

      const result = await fetchValidatedAddressSuggestions("Main St", "org-123");

      expect(result).toHaveLength(1);
      expect(result[0].street).toBe("123 Main St");
      expect(result[0].city).toBe("Johnson City");
      expect(mockClient.geocodeAddress).toHaveBeenCalled();
    });

    it("returns empty array when Fieldpulse validation fails", async () => {
      const lowQualitySuggestions = [
        {
          label: "Invalid",
          street: "Invalid",
          city: null,
          state: null,
          postcode: null,
          lat: null,
          lon: null,
        },
      ];

      const mockClient = {
        geocodeAddress: vi.fn().mockResolvedValue({
          valid: false,
          error: "Address not found",
        }),
      };

      vi.mocked(fetchAddressSuggestions).mockResolvedValue(lowQualitySuggestions);
      vi.mocked(getFieldpulseClient).mockResolvedValue(mockClient as never);

      const result = await fetchValidatedAddressSuggestions("Invalid", "org-123");

      expect(result).toEqual([]);
    });

    it("returns empty array when no Fieldpulse client exists", async () => {
      const lowQualitySuggestions = [
        {
          label: "Main St",
          street: "Main St",
          city: null,
          state: null,
          postcode: null,
          lat: null,
          lon: null,
        },
      ];

      vi.mocked(fetchAddressSuggestions).mockResolvedValue(lowQualitySuggestions);
      vi.mocked(getFieldpulseClient).mockResolvedValue(null);

      const result = await fetchValidatedAddressSuggestions("Main St", "org-123");

      expect(result).toEqual([]);
    });

    it("handles custom quality threshold", async () => {
      const suggestions = [
        {
          label: "123 Main St",
          street: "123 Main St",
          city: "Johnson City",
          state: "TN",
          postcode: "376", // Too short for default threshold
          lat: 36.334,
          lon: -82.3819,
        },
      ];

      vi.mocked(fetchAddressSuggestions).mockResolvedValue(suggestions);

      // With lower threshold, should pass
      const result = await fetchValidatedAddressSuggestions("123 Main St", "org-123", {
        qualityThreshold: 0.5,
      });

      expect(result).toEqual(suggestions);
    });
  });

  describe("normalizeAddressForFieldpulse", () => {
    it("combines address components into single line", () => {
      const result = normalizeAddressForFieldpulse({
        street: "123 Main St",
        city: "Johnson City",
        state: "TN",
        postcode: "37601",
      });

      expect(result).toBe("123 Main St, Johnson City, TN, 37601");
    });

    it("skips null/empty components", () => {
      const result = normalizeAddressForFieldpulse({
        street: "123 Main St",
        city: null,
        state: "TN",
        postcode: "",
      });

      expect(result).toBe("123 Main St, TN");
    });

    it("handles all null components", () => {
      const result = normalizeAddressForFieldpulse({
        street: null,
        city: null,
        state: null,
        postcode: null,
      });

      expect(result).toBe("");
    });

    it("trims whitespace from components", () => {
      const result = normalizeAddressForFieldpulse({
        street: "  123 Main St  ",
        city: "  Johnson City  ",
        state: "  TN  ",
        postcode: "  37601  ",
      });

      expect(result).toBe("123 Main St, Johnson City, TN, 37601");
    });
  });

  describe("validateAddressForSync", () => {
    it("returns validated address from Photon", async () => {
      const validatedAddress = {
        street: "123 Main St",
        city: "Johnson City",
        state: "TN",
        zip: "37601",
      };

      const mockSuggestions = [
        {
          label: "123 Main St, Johnson City, TN 37601",
          street: "123 Main St",
          city: "Johnson City",
          state: "TN",
          postcode: "37601",
          lat: 36.334,
          lon: -82.3819,
        },
      ];

      vi.mocked(fetchAddressSuggestions).mockResolvedValue(mockSuggestions);

      const result = await validateAddressForSync("org-123", {
        street: "123 Main St",
        city: "Johnson City",
        state: "TN",
        zip: "37601",
      });

      expect(result).toEqual(validatedAddress);
    });

    it("returns original address when no suggestions found", async () => {
      vi.mocked(fetchAddressSuggestions).mockResolvedValue([]);

      const result = await validateAddressForSync("org-123", {
        street: "123 Main St",
        city: "Johnson City",
      });

      expect(result).toEqual({
        street: "123 Main St",
        city: "Johnson City",
        state: null,
        zip: null,
      });
    });

    it("returns null when no street or city provided", async () => {
      const result = await validateAddressForSync("org-123", {
        city: null,
        street: null,
      });

      expect(result).toBeNull();
    });

    it("handles validation errors gracefully", async () => {
      vi.mocked(fetchAddressSuggestions).mockRejectedValue(new Error("Network error"));

      const result = await validateAddressForSync("org-123", {
        street: "123 Main St",
        city: "Johnson City",
      });

      expect(result).toEqual({
        street: "123 Main St",
        city: "Johnson City",
        state: null,
        zip: null,
      });
    });
  });

  describe("hasMinimumAddressQuality", () => {
    it("returns true for complete address", () => {
      const result = hasMinimumAddressQuality({
        street: "123 Main St",
        city: "Johnson City",
        state: "TN",
        zip: "37601",
      });

      expect(result).toBe(true);
    });

    it("returns true for street + city only", () => {
      const result = hasMinimumAddressQuality({
        street: "123 Main St",
        city: "Johnson City",
        state: null,
        zip: null,
      });

      expect(result).toBe(true);
    });

    it("returns true for street + state only", () => {
      const result = hasMinimumAddressQuality({
        street: "123 Main St",
        city: null,
        state: "TN",
        zip: null,
      });

      expect(result).toBe(true);
    });

    it("returns true for street + ZIP only", () => {
      const result = hasMinimumAddressQuality({
        street: "123 Main St",
        city: null,
        state: null,
        zip: "37601",
      });

      expect(result).toBe(true);
    });

    it("returns false for street only (too short)", () => {
      const result = hasMinimumAddressQuality({
        street: "12",
        city: null,
        state: null,
        zip: null,
      });

      expect(result).toBe(false);
    });

    it("returns false for empty street with other components", () => {
      const result = hasMinimumAddressQuality({
        street: null,
        city: "Johnson City",
        state: "TN",
        zip: "37601",
      });

      expect(result).toBe(false);
    });

    it("returns false for whitespace-only street", () => {
      const result = hasMinimumAddressQuality({
        street: "   ",
        city: "Johnson City",
        state: "TN",
        zip: "37601",
      });

      expect(result).toBe(false);
    });

    it("returns false for ZIP that's too short", () => {
      const result = hasMinimumAddressQuality({
        street: "123 Main St",
        city: null,
        state: null,
        zip: "123",
      });

      expect(result).toBe(false);
    });

    it("returns false for state that's too short", () => {
      const result = hasMinimumAddressQuality({
        street: "123 Main St",
        city: null,
        state: "T",
        zip: null,
      });

      expect(result).toBe(false);
    });
  });
});
