import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAddressSuggestions, haversineKm } from "./photon";

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
        lat: null,
        lon: null,
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

  it("returns [] when fetch rejects even with `near` provided", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down"),
    );

    await expect(
      fetchAddressSuggestions("123 Main", {
        near: { lat: JOHNSON_CITY.lat, lon: JOHNSON_CITY.lon },
      }),
    ).resolves.toEqual([]);
  });
});

// Johnson City, TN — the Spears base used as the proximity origin in tests.
const JOHNSON_CITY = { lat: 36.334, lon: -82.3819 };

// A US feature near Johnson City (Jonesborough, TN, ~12km away).
const NEAR_FEATURE = {
  properties: {
    housenumber: "1",
    street: "Near St",
    city: "Jonesborough",
    state: "Tennessee",
    postcode: "37659",
    countrycode: "US",
  },
  geometry: { coordinates: [-82.4735, 36.2945] },
};

// A US feature far from Johnson City (Nashville, TN, ~400km away).
const FAR_FEATURE = {
  properties: {
    housenumber: "2",
    street: "Far St",
    city: "Nashville",
    state: "Tennessee",
    postcode: "37203",
    countrycode: "US",
  },
  geometry: { coordinates: [-86.7816, 36.1627] },
};

// A US feature with no geometry at all.
const NO_GEOMETRY_FEATURE = {
  properties: {
    housenumber: "3",
    street: "Nowhere Ave",
    city: "Kingsport",
    state: "Tennessee",
    postcode: "37660",
    countrycode: "US",
  },
};

describe("fetchAddressSuggestions with `near` proximity bias", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("appends lat/lon/zoom to the Photon URL when `near` is set", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ features: [NEAR_FEATURE] }),
    );

    await fetchAddressSuggestions("near st", {
      near: { lat: JOHNSON_CITY.lat, lon: JOHNSON_CITY.lon },
    });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(calledUrl).toContain(`lat=${JOHNSON_CITY.lat}`);
    expect(calledUrl).toContain(`lon=${JOHNSON_CITY.lon}`);
    expect(calledUrl).toContain("zoom=12");
  });

  it("captures geometry coordinates onto lat/lon (GeoJSON is [lon, lat])", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ features: [NEAR_FEATURE] }),
    );

    const result = await fetchAddressSuggestions("near st");

    expect(result[0].lon).toBe(-82.4735);
    expect(result[0].lat).toBe(36.2945);
  });

  it("sorts a closer suggestion ahead of a farther one when `near` is set", async () => {
    // Far returned first to prove the sort actually reorders.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ features: [FAR_FEATURE, NEAR_FEATURE] }),
    );

    const result = await fetchAddressSuggestions("street", {
      near: { lat: JOHNSON_CITY.lat, lon: JOHNSON_CITY.lon },
    });

    expect(result.map((r) => r.city)).toEqual(["Jonesborough", "Nashville"]);
  });

  it("sorts suggestions missing geometry after ones that have it", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({
        features: [NO_GEOMETRY_FEATURE, FAR_FEATURE, NEAR_FEATURE],
      }),
    );

    const result = await fetchAddressSuggestions("street", {
      near: { lat: JOHNSON_CITY.lat, lon: JOHNSON_CITY.lon },
    });

    // Near, then Far (both have coords), then the no-geometry one last.
    expect(result.map((r) => r.city)).toEqual([
      "Jonesborough",
      "Nashville",
      "Kingsport",
    ]);
  });

  it("does not drop out-of-radius results", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ features: [NEAR_FEATURE, FAR_FEATURE] }),
    );

    const result = await fetchAddressSuggestions("street", {
      near: { lat: JOHNSON_CITY.lat, lon: JOHNSON_CITY.lon },
    });

    expect(result).toHaveLength(2);
  });
});

describe("haversineKm", () => {
  it("returns ~0 for identical points", () => {
    expect(haversineKm(36.334, -82.3819, 36.334, -82.3819)).toBeCloseTo(0, 5);
  });

  it("returns a plausible distance for a known city pair", () => {
    // Johnson City, TN -> Nashville, TN is roughly 400 km.
    const km = haversineKm(36.334, -82.3819, 36.1627, -86.7816);
    expect(km).toBeGreaterThan(380);
    expect(km).toBeLessThan(420);
  });
});
