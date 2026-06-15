/**
 * ADDRESS VALIDATION: two-way address resolution for Fieldpulse integration.
 *
 * Stage 8: Enhances Photon autocomplete with Fieldpulse geocoding fallback.
 * When Photon fails or returns low-quality results, we can fall back to
 * Fieldpulse's address validation API to ensure we have valid addresses
 * for job dispatch.
 *
 * The pattern: try Photon first (free, fast), fall back to Fieldpulse if:
 * - Photon returns no results
 * - Photon returns results without ZIP codes
 * - We need to validate an address against Fieldpulse's service area
 *
 * DEGRADE-SAFE: if Fieldpulse is down or has no address API, we use Photon
 * results as-is. The customer can always type the address manually.
 */
import { fetchAddressSuggestions } from "@/lib/address/photon";
import { getFieldpulseClient } from "./client";
import type { FieldpulseAddress } from "./types";

/**
 * Minimum address quality scores.
 */
const MIN_ZIP_LENGTH = 5;
const MIN_STREET_LENGTH = 3;
const DEFAULT_QUALITY_THRESHOLD = 0.6;

/**
 * Quality score for an address suggestion (0-1).
 * Higher is better: has street, city, state, ZIP, coordinates.
 */
function scoreAddressQuality(suggestion: {
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postcode: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
}): number {
  let score = 0;
  if (suggestion.street && suggestion.street.length >= MIN_STREET_LENGTH) score += 0.3;
  if (suggestion.city) score += 0.2;
  if (suggestion.state) score += 0.1;
  if (suggestion.postcode && suggestion.postcode.length >= MIN_ZIP_LENGTH) score += 0.2;
  if (typeof suggestion.lat === "number" && typeof suggestion.lon === "number") score += 0.2;
  return score;
}

/**
 * Filter suggestions to high-quality only (score >= threshold).
 */
function filterByQuality<T extends {
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postcode: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
}>(
  suggestions: readonly T[],
  minScore = DEFAULT_QUALITY_THRESHOLD,
): T[] {
  return suggestions.filter((s) => scoreAddressQuality(s) >= minScore);
}

/**
 * Validate address against Fieldpulse's geocoding API (if available).
 *
 * This attempts to use Fieldpulse's address validation endpoint to:
 * - Normalize address components (street, city, state, ZIP)
 * - Provide latitude/longitude coordinates
 * - Verify the address is in their service area
 *
 * If the endpoint doesn't exist or returns an error, returns null so
 * callers can fall back to Photon results or manual entry.
 */
async function validateWithFieldpulse(
  organizationId: string,
  address: {
    readonly street: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postcode: string | null;
  },
): Promise<{
  readonly valid: boolean;
  readonly normalizedAddress?: FieldpulseAddress | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
} | null> {
  const client = await getFieldpulseClient(organizationId);
  if (!client) {
    return null; // No Fieldpulse connection - cannot validate
  }

  try {
    const result = await client.geocodeAddress({
      street: address.street ?? undefined,
      city: address.city ?? undefined,
      state: address.state ?? undefined,
      zip: address.postcode ?? undefined,
    });

    return result;
  } catch {
    // Fieldpulse geocoding failed - degrade to null
    return null;
  }
}

/**
 * Fetch address suggestions with two-way validation.
 *
 * 1. Try Photon autocomplete (free, fast)
 * 2. Filter by quality score
 * 3. If high-quality results exist, return them
 * 4. Otherwise, fall back to Fieldpulse validation (if connected)
 *
 * Never blocks or fails: returns empty array on any error so the customer
 * can always type the address manually.
 */
export async function fetchValidatedAddressSuggestions(
  query: string,
  organizationId: string,
  opts?: {
    readonly signal?: AbortSignal;
    readonly near?: { readonly lat: number; readonly lon: number };
    readonly qualityThreshold?: number;
  },
): Promise<readonly {
  readonly label: string;
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postcode: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
}[]> {
  try {
    // First, try Photon
    const photonResults = await fetchAddressSuggestions(query, opts);

    // Filter by quality
    const minScore = opts?.qualityThreshold ?? DEFAULT_QUALITY_THRESHOLD;
    const highQuality = filterByQuality(photonResults, minScore);

    if (highQuality.length > 0) {
      // We have good results from Photon - return them
      return highQuality;
    }

    // Photon had no/poor results - try Fieldpulse validation
    // Parse the query to extract potential address components
    const parts = query.split(',').map(p => p.trim());
    const street = parts[0] || null;
    const city = parts[1] || null;
    const state = parts[2] || null;
    const postcode = parts[3] || null;

    const fieldpulseResult = await validateWithFieldpulse(organizationId, {
      street,
      city,
      state,
      postcode,
    });

    if (fieldpulseResult?.valid) {
      // Fieldpulse validated the address - return a single result
      const normalized = fieldpulseResult.normalizedAddress;
      const label = normalizeAddressForFieldpulse({
        street: normalized?.street ?? street,
        city: normalized?.city ?? city,
        state: normalized?.state ?? state,
        postcode: normalized?.zip ?? postcode,
      });

      return [{
        label,
        street: normalized?.street ?? street,
        city: normalized?.city ?? city,
        state: normalized?.state ?? state,
        postcode: normalized?.zip ?? postcode,
        lat: fieldpulseResult.latitude ?? null,
        lon: fieldpulseResult.longitude ?? null,
      } as const];
    }

    // Either Fieldpulse rejected it or we have no results at all
    return [];
  } catch {
    // Any error - degrade to empty array
    return [];
  }
}

/**
 * Normalize an address for Fieldpulse (combine components into single line).
 * Fieldpulse may accept structured addresses; this is a fallback.
 */
export function normalizeAddressForFieldpulse(address: {
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postcode: string | null;
}): string {
  const parts = [
    address.street,
    address.city,
    address.state,
    address.postcode,
  ]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p && p.length > 0));

  return parts.join(", ");
}

/**
 * Validate a complete address before syncing to Fieldpulse.
 *
 * This ensures we have a quality address before creating/updating customers.
 * Returns the validated/normalized address or null if validation fails.
 */
export async function validateAddressForSync(
  organizationId: string,
  address: {
    readonly street?: string | null;
    readonly city?: string | null;
    readonly state?: string | null;
    readonly zip?: string | null;
  },
): Promise<FieldpulseAddress | null> {
  if (!address.street && !address.city) {
    return null; // No address to validate
  }

  // Build query from components
  const query = normalizeAddressForFieldpulse({
    street: address.street ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postcode: address.zip ?? null,
  });

  try {
    const suggestions = await fetchValidatedAddressSuggestions(
      query,
      organizationId,
    );

    if (suggestions.length === 0) {
      // No validated suggestions - return original (graceful degradation)
      return {
        street: address.street ?? null,
        city: address.city ?? null,
        state: address.state ?? null,
        zip: address.zip ?? null,
      };
    }

    // Return the best suggestion
    const best = suggestions[0];
    return {
      street: best.street ?? address.street ?? null,
      city: best.city ?? address.city ?? null,
      state: best.state ?? address.state ?? null,
      zip: best.postcode ?? address.zip ?? null,
    };
  } catch {
    // Validation failed - degrade to original
    return {
      street: address.street ?? null,
      city: address.city ?? null,
      state: address.state ?? null,
      zip: address.zip ?? null,
    };
  }
}

/**
 * Check if an address has sufficient quality for syncing to Fieldpulse.
 *
 * This is a lightweight check that doesn't make network requests.
 * Use it to filter out obviously incomplete addresses before syncing.
 */
export function hasMinimumAddressQuality(address: {
  readonly street?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zip?: string | null;
}): boolean {
  const hasStreet = address.street && address.street.trim().length >= MIN_STREET_LENGTH;
  const hasCity = address.city && address.city.trim().length > 0;
  const hasState = address.state && address.state.trim().length >= 2;
  const hasZip = address.zip && address.zip.trim().length >= 5;

  // At minimum, we need a street and one other component
  // Return false (not null) for invalid addresses
  return Boolean(hasStreet && (hasCity || hasState || hasZip));
}
