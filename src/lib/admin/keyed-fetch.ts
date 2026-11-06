/**
 * Fetch guards for a params-keyed list hook (Task 7 parked). A fetch in flight
 * only blocks a second fetch for the SAME key, and an answer only lands while
 * its key is still current, so a `?bucket=` deep link restored after the
 * default bucket's first fetch started still loads the chosen bucket. Pure.
 */
export function fetchGate(p: { readonly inFlightKey: string | null; readonly key: string; readonly bust: boolean }): "fetch" | "skip" {
  return !p.bust && p.inFlightKey === p.key ? "skip" : "fetch";
}

export function responseApplies(requestKey: string, currentKey: string): boolean {
  return requestKey === currentKey;
}
