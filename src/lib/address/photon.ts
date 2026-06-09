/**
 * Keyless address autocomplete via the Photon geocoder (Komoot).
 *
 * Photon is a free, no-API-key, no-env-var GeoJSON geocoding service backed by
 * OpenStreetMap data. We use it purely to help the chat customer enter a clean,
 * ZIP-bearing service address. Every failure mode degrades to an empty array so
 * the customer can always fall back to typing the address by hand — the chat's
 * existing "what city and ZIP?" follow-up handles partial input.
 */

const PHOTON_ENDPOINT = "https://photon.komoot.io/api/";
const MIN_QUERY_LENGTH = 3;
const RESULT_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 5000;

export interface AddressSuggestion {
  readonly label: string;
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postcode: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
}

interface PhotonProperties {
  readonly name?: string;
  readonly housenumber?: string;
  readonly street?: string;
  readonly city?: string;
  readonly town?: string;
  readonly village?: string;
  readonly state?: string;
  readonly postcode?: string;
  readonly countrycode?: string;
}

interface PhotonGeometry {
  readonly coordinates?: readonly [number, number];
}

interface PhotonFeature {
  readonly properties?: PhotonProperties;
  readonly geometry?: PhotonGeometry;
}

interface PhotonResponse {
  readonly features?: readonly PhotonFeature[];
}

interface FetchOptions {
  readonly signal?: AbortSignal;
  readonly near?: { readonly lat: number; readonly lon: number };
}

/**
 * Fetch up to 5 US-style address suggestions for a free-text query.
 *
 * Never throws: any network error, non-OK response, malformed payload, or empty
 * result set yields `[]`. Queries shorter than 3 trimmed characters short-circuit
 * to `[]` without hitting the network.
 */
export async function fetchAddressSuggestions(
  query: string,
  opts?: FetchOptions,
): Promise<AddressSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return [];
  }

  let url = `${PHOTON_ENDPOINT}?q=${encodeURIComponent(trimmed)}&limit=${RESULT_LIMIT}&lang=en`;
  if (opts?.near) {
    // Photon biases results toward a focus point via lat/lon + zoom.
    url += `&lat=${opts.near.lat}&lon=${opts.near.lon}&zoom=12`;
  }

  // Use a caller-provided signal when present; otherwise enforce our own timeout.
  const controller = opts?.signal ? null : new AbortController();
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
    : null;
  const signal = opts?.signal ?? controller?.signal;

  try {
    const response = await fetch(url, signal ? { signal } : {});
    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as PhotonResponse;
    const features = data.features;
    if (!Array.isArray(features) || features.length === 0) {
      return [];
    }

    const mapped = features
      .map(toMappedSuggestion)
      .filter((s): s is MappedSuggestion => s !== null);

    const chosen = preferUsResults(mapped);

    return opts?.near ? sortByDistance(chosen, opts.near) : chosen;
  } catch {
    // Swallow everything (network, abort, JSON parse) — graceful degradation.
    return [];
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

interface MappedSuggestion {
  readonly suggestion: AddressSuggestion;
  readonly isUs: boolean;
}

function toMappedSuggestion(feature: PhotonFeature): MappedSuggestion | null {
  const props = feature.properties;
  if (!props) {
    return null;
  }

  const street = props.street ?? props.name ?? null;
  const city = props.city ?? props.town ?? props.village ?? null;
  const state = props.state ?? null;
  const postcode = props.postcode ?? null;

  const label = buildLabel({
    housenumber: props.housenumber ?? null,
    street,
    city,
    state,
    postcode,
  });

  if (label.length === 0) {
    return null;
  }

  // Photon GeoJSON geometry is [lon, lat]; read both, defaulting to null.
  const coords = feature.geometry?.coordinates;
  const lon = typeof coords?.[0] === "number" ? coords[0] : null;
  const lat = typeof coords?.[1] === "number" ? coords[1] : null;

  return {
    suggestion: { label, street, city, state, postcode, lat, lon },
    isUs: props.countrycode === "US",
  };
}

interface LabelParts {
  readonly housenumber: string | null;
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postcode: string | null;
}

/**
 * Build a US-style label: "<housenumber> <street>, <city>, <state> <postcode>",
 * skipping any missing parts so we never emit stray commas or whitespace.
 */
function buildLabel(parts: LabelParts): string {
  const line1 = [parts.housenumber, parts.street]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(" ")
    .trim();

  const cityState = [parts.city, parts.state]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(", ")
    .trim();

  const tail = [cityState, parts.postcode?.trim() ?? ""]
    .filter((p) => p.length > 0)
    .join(" ")
    .trim();

  return [line1, tail]
    .filter((p) => p.length > 0)
    .join(", ")
    .trim();
}

/**
 * Prefer US results but never hard-require them: if any US feature exists, keep
 * only the US-mapped suggestions; otherwise return everything we parsed.
 */
function preferUsResults(mapped: readonly MappedSuggestion[]): AddressSuggestion[] {
  const usSuggestions = mapped
    .filter((m) => m.isUs)
    .map((m) => m.suggestion);

  return usSuggestions.length > 0
    ? usSuggestions
    : mapped.map((m) => m.suggestion);
}

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance in kilometers between two lat/lon points.
 * Pure: depends only on its arguments.
 */
export function haversineKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Stable-sort suggestions by haversine distance from `near` ascending.
 * Suggestions with null coordinates sort last while preserving their
 * relative order. Never drops any suggestion.
 */
function sortByDistance(
  suggestions: readonly AddressSuggestion[],
  near: { readonly lat: number; readonly lon: number },
): AddressSuggestion[] {
  const indexed = suggestions.map((suggestion, index) => {
    const hasCoords =
      typeof suggestion.lat === "number" && typeof suggestion.lon === "number";
    const distance = hasCoords
      ? haversineKm(near.lat, near.lon, suggestion.lat!, suggestion.lon!)
      : Number.POSITIVE_INFINITY;
    return { suggestion, index, distance };
  });

  indexed.sort((a, b) => {
    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    // Tie (including both null/Infinity): preserve original order.
    return a.index - b.index;
  });

  return indexed.map((item) => item.suggestion);
}
