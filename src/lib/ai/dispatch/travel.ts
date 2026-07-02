/**
 * Drive-time estimation for dispatch scoring. Provider-agnostic: a single
 * `durationMatrix` returns road drive-time (minutes) from each tech anchor to the
 * job, via the configured routing provider. It is a best-effort OVERLAY — it
 * NEVER throws and returns `null` for any origin it can't price, so the scorer
 * falls back to haversine (straight-line) for that tech. Dispatch therefore never
 * depends on an external routing service (same principle as the clamped LLM
 * duration estimate).
 *
 * Enabled via `ROUTING_PROVIDER` (default `none` → all null → today's haversine
 * behavior, byte-identical). Only the free OSM-native OpenRouteService adapter is
 * implemented; `mapbox`/`google` are recognized names that fall through to null
 * until their adapters are added (the interface is provider-agnostic).
 */
export interface LatLng {
  readonly lat: number;
  readonly lon: number;
}

type RoutingProvider = "none" | "ors" | "mapbox" | "google";

const TIMEOUT_MS = 1500;
const ORS_MATRIX_URL =
  "https://api.openrouteservice.org/v2/matrix/driving-car";

function resolveProvider(): { readonly provider: RoutingProvider; readonly key: string | null } {
  const provider = (process.env.ROUTING_PROVIDER ?? "none").toLowerCase();
  switch (provider) {
    case "ors":
      return { provider: "ors", key: process.env.ORS_API_KEY || null };
    case "mapbox":
      return { provider: "mapbox", key: process.env.MAPBOX_TOKEN || null };
    case "google":
      return { provider: "google", key: process.env.GOOGLE_MAPS_KEY || null };
    default:
      return { provider: "none", key: null };
  }
}

/** Whether a routing provider is configured (for callers that want to skip the
 * matrix call entirely when it would be a no-op). */
export function routingEnabled(): boolean {
  const { provider, key } = resolveProvider();
  return provider !== "none" && !!key;
}

/**
 * Drive-time in minutes from each origin to `dest`, one entry per origin (order
 * preserved). `null` where the provider is unset, the call failed/timed out, or
 * the provider omitted a value for that origin. Never throws.
 */
export async function durationMatrix(
  origins: readonly LatLng[],
  dest: LatLng,
): Promise<(number | null)[]> {
  if (origins.length === 0) return [];
  const { provider, key } = resolveProvider();
  if (provider === "none" || !key) return origins.map(() => null);
  try {
    switch (provider) {
      case "ors":
        return await orsDurationMatrix(origins, dest, key);
      // mapbox / google: interface reserved, adapter not yet built.
      default:
        return origins.map(() => null);
    }
  } catch {
    return origins.map(() => null);
  }
}

/** OpenRouteService matrix: one request, N origins → 1 destination, durations in
 * seconds. ORS takes coordinates as [lon, lat]. */
async function orsDurationMatrix(
  origins: readonly LatLng[],
  dest: LatLng,
  key: string,
): Promise<(number | null)[]> {
  const locations = [
    ...origins.map((o) => [o.lon, o.lat]),
    [dest.lon, dest.lat],
  ];
  const destIndex = origins.length;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ORS_MATRIX_URL, {
      method: "POST",
      headers: {
        Authorization: key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        locations,
        sources: origins.map((_, i) => i),
        destinations: [destIndex],
        metrics: ["duration"],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return origins.map(() => null);
    const data = (await res.json()) as { durations?: (number | null)[][] };
    const durations = data?.durations;
    if (!Array.isArray(durations)) return origins.map(() => null);
    // durations is sources × destinations (we asked for exactly 1 destination).
    return origins.map((_, i) => {
      const seconds = durations[i]?.[0];
      return typeof seconds === "number" && Number.isFinite(seconds)
        ? seconds / 60
        : null;
    });
  } finally {
    clearTimeout(timer);
  }
}
