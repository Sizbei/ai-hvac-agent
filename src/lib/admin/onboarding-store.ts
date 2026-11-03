/**
 * Client store for the setup guide (spec §4 "Client store"). One module-level
 * cache shared by the sidebar digit, the home card and the setup page, so a
 * cold load costs one request. Plain module (no server imports): the payload
 * type comes from the pure `onboarding-steps` module as a type only.
 *
 * Contract:
 * - fetches are sequence-tagged; a response older than the newest issued is dropped;
 * - `refreshOnboarding()` is a no-op while a fetch is in flight (it joins it)
 *   or while the data is younger than 1 s, unless forced or stale;
 * - a forced refresh during a fetch chains ONE follow-up fetch after it;
 * - `invalidateOnboarding()` forces a refresh when someone is subscribed, else
 *   marks the snapshot stale so the next refresh is forced;
 * - a 429/error keeps the last good data and sets `error`;
 * - the snapshot is a frozen module object replaced only on change.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { OnboardingPayload } from "./onboarding-steps";
import { adminFetch, AdminAuthRedirectError } from "./admin-fetch";

export interface OnboardingSnapshot {
  readonly data: OnboardingPayload | null;
  readonly error: boolean;
  readonly loadedAt: number | null;
  readonly stale: boolean;
}

export const EMPTY_SNAPSHOT: OnboardingSnapshot = Object.freeze({
  data: null,
  error: false,
  loadedAt: null,
  stale: false,
});

const ENDPOINT = "/api/admin/onboarding";
const MIN_AGE_MS = 1_000;
const VISIBLE_REFRESH_AGE_MS = 10_000;

let snapshot: OnboardingSnapshot = EMPTY_SNAPSHOT;
let newestSeq = 0;
let generation = 0;
let invalidations = 0;
let inFlight: Promise<void> | null = null;
let chained: Promise<void> | null = null;
const listeners = new Set<() => void>();
let visibilityRefs = 0;

/** Pure gate for starting a fetch. In flight → never (a forced call chains instead). */
export function shouldRefresh(
  now: number,
  loadedAt: number | null,
  inFlightNow: boolean,
  force: boolean,
  stale: boolean,
): boolean {
  if (inFlightNow) return false;
  if (force || stale || loadedAt === null) return true;
  return now - loadedAt >= MIN_AGE_MS;
}

export function getOnboardingSnapshot(): OnboardingSnapshot {
  return snapshot;
}

export function subscribeOnboarding(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function update(patch: Partial<OnboardingSnapshot>): void {
  const next = { ...snapshot, ...patch };
  if (
    next.data === snapshot.data &&
    next.error === snapshot.error &&
    next.loadedAt === snapshot.loadedAt &&
    next.stale === snapshot.stale
  ) {
    return;
  }
  snapshot = Object.freeze(next);
  for (const cb of [...listeners]) cb();
}

/** Untrusted boundary: accept only something shaped like the payload. */
function asPayload(body: unknown): OnboardingPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { success?: unknown; data?: unknown }).data;
  if ((body as { success?: unknown }).success !== true) return null;
  if (typeof data !== "object" || data === null) return null;
  const p = data as Partial<OnboardingPayload>;
  if (!Array.isArray(p.steps)) return null;
  if (typeof p.progress?.requiredDone !== "number") return null;
  if (typeof p.progress?.requiredTotal !== "number") return null;
  return data as OnboardingPayload;
}

async function load(seq: number, invAtStart: number): Promise<void> {
  try {
    const res = await adminFetch(ENDPOINT, { cache: "no-store" });
    const payload = res.ok ? asPayload(await res.json()) : null;
    if (seq !== newestSeq) return;
    if (!payload) {
      update({ error: true });
      return;
    }
    update({
      data: payload,
      error: false,
      loadedAt: Date.now(),
      stale: snapshot.stale && invalidations !== invAtStart,
    });
  } catch (err) {
    if (err instanceof AdminAuthRedirectError || seq !== newestSeq) return;
    update({ error: true });
  }
}

function startFetch(): Promise<void> {
  newestSeq += 1;
  const p: Promise<void> = load(newestSeq, invalidations).finally(() => {
    if (inFlight === p) inFlight = null;
  });
  inFlight = p;
  return p;
}

export function refreshOnboarding(opts: { force?: boolean } = {}): Promise<void> {
  const force = opts.force === true;
  if (inFlight) {
    if (!force) return inFlight;
    if (!chained) {
      const gen = generation;
      chained = inFlight.then(() => {
        chained = null;
        return gen === generation ? startFetch() : undefined;
      });
    }
    return chained;
  }
  if (!shouldRefresh(Date.now(), snapshot.loadedAt, false, force, snapshot.stale)) {
    return Promise.resolve();
  }
  return startFetch();
}

export function invalidateOnboarding(): void {
  invalidations += 1;
  if (listeners.size > 0) {
    void refreshOnboarding({ force: true });
    return;
  }
  update({ stale: true });
}

function onVisibilityChange(): void {
  if (document.visibilityState !== "visible") return;
  const { loadedAt } = snapshot;
  if (loadedAt === null || Date.now() - loadedAt > VISIBLE_REFRESH_AGE_MS) {
    void refreshOnboarding();
  }
}

const getServerSnapshot = (): OnboardingSnapshot => EMPTY_SNAPSHOT;

export function useOnboarding(): OnboardingSnapshot {
  const snap = useSyncExternalStore(subscribeOnboarding, getOnboardingSnapshot, getServerSnapshot);
  useEffect(() => {
    if (typeof document === "undefined") return;
    visibilityRefs += 1;
    if (visibilityRefs === 1) document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      visibilityRefs -= 1;
      if (visibilityRefs === 0) document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  return snap;
}

/** Test-only: drop all state; any in-flight response is ignored. */
export function __resetOnboardingStoreForTests(): void {
  generation += 1;
  newestSeq += 1;
  invalidations = 0;
  inFlight = null;
  chained = null;
  snapshot = EMPTY_SNAPSHOT;
  listeners.clear();
}
