import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAddressSuggestions } from "./photon";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

const SAMPLE_PAYLOAD = {
  features: [
    {
      properties: {
        housenumber: "123",
        street: "Main Street",
        city: "Johnson City",
        state: "Tennessee",
        postcode: "37601",
        countrycode: "US",
      },
    },
  ],
};

describe("fetchAddressSuggestions", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses suggestions from a sample Photon GeoJSON payload", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(SAMPLE_PAYLOAD),
    );

    const result = await fetchAddressSuggestions("123 Main");

    expect(result).toEqual([
      {
        label: "123 Main Street, Johnson City, Tennessee 37601",
        street: "Main Street",
        city: "Johnson City",
        state: "Tennessee",
        postcode: "37601",
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("calls Photon with the encoded query, limit, and lang params", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(SAMPLE_PAYLOAD),
    );

    await fetchAddressSuggestions("123 Main St & 1st");

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("https://photon.komoot.io/api/");
    expect(calledUrl).toContain("q=123%20Main%20St%20%26%201st");
    expect(calledUrl).toContain("limit=5");
    expect(calledUrl).toContain("lang=en");
  });

  it("builds the label skipping missing parts", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({
        features: [
          // No housenumber, no postcode -> "Main Street, Johnson City, Tennessee"
          {
            properties: {
              street: "Main Street",
              city: "Johnson City",
              state: "Tennessee",
              countrycode: "US",
            },
          },
          // City only (falls back from town), no street/state/zip -> "Bristol"
          {
            properties: {
              town: "Bristol",
              countrycode: "US",
            },
          },
          // housenumber + street + postcode, no city/state -> "55 Oak Ave 37615"
          {
            properties: {
              housenumber: "55",
              street: "Oak Ave",
              postcode: "37615",
              countrycode: "US",
            },
          },
        ],
      }),
    );

    const result = await fetchAddressSuggestions("anything");

    expect(result.map((r) => r.label)).toEqual([
      "Main Street, Johnson City, Tennessee",
      "Bristol",
      "55 Oak Ave, 37615",
    ]);
  });

  it("prefers US results when a mix is returned", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({
        features: [
          {
            properties: {
              street: "Rue de la Paix",
              city: "Paris",
              countrycode: "FR",
            },
          },
          {
            properties: {
              housenumber: "1",
              street: "State St",
              city: "Bristol",
              state: "Tennessee",
              postcode: "37620",
              countrycode: "US",
            },
          },
        ],
      }),
    );

    const result = await fetchAddressSuggestions("state st");

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("1 State St, Bristol, Tennessee 37620");
  });

  it("falls back to non-US results when no US result exists", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({
        features: [
          {
            properties: {
              street: "Rue de la Paix",
              city: "Paris",
              countrycode: "FR",
            },
          },
        ],
      }),
    );

    const result = await fetchAddressSuggestions("rue de la paix");

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Rue de la Paix, Paris");
  });

  it("returns [] when fetch rejects", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down"),
    );

    await expect(fetchAddressSuggestions("123 Main")).resolves.toEqual([]);
  });

  it("returns [] on a non-OK response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({}, false),
    );

    await expect(fetchAddressSuggestions("123 Main")).resolves.toEqual([]);
  });

  it("returns [] when features is empty", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ features: [] }),
    );

    await expect(fetchAddressSuggestions("123 Main")).resolves.toEqual([]);
  });

  it("returns [] when features is missing", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({}));

    await expect(fetchAddressSuggestions("123 Main")).resolves.toEqual([]);
  });

  it("returns [] for queries shorter than 3 chars without calling fetch", async () => {
    await expect(fetchAddressSuggestions("12")).resolves.toEqual([]);
    await expect(fetchAddressSuggestions("  a  ")).resolves.toEqual([]);
    await expect(fetchAddressSuggestions("")).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
