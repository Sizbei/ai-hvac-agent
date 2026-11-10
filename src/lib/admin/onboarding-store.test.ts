import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  EMPTY_SNAPSHOT,
  getOnboardingSnapshot,
  invalidateOnboarding,
  refreshOnboarding,
  shouldRefresh,
  subscribeOnboarding,
  __resetOnboardingStoreForTests,
} from "./onboarding-store";
import type { OnboardingPayload } from "./onboarding-steps";

function payload(requiredDone: number): OnboardingPayload {
  return {
    steps: [],
    progress: { requiredDone, requiredTotal: 4, optionalDone: 0, optionalTotal: 4 },
    upNext: null,
    dismissedAt: null,
    completedSeenAt: null,
    demo: false,
    guide: null,
  };
}

interface Pending {
  resolve: (res: Response) => void;
}

/** Stubbed fetch whose responses are released by the test, in any order. */
function stubFetch() {
  const pending: Pending[] = [];
  const fn = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        pending.push({ resolve });
      }),
  );
  vi.stubGlobal("fetch", fn);
  return { fn, pending };
}

const ok = (p: OnboardingPayload) =>
  new Response(JSON.stringify({ success: true, data: p }), { status: 200 });
const status = (code: number) =>
  new Response(JSON.stringify({ success: false, error: "x" }), { status: code });

/** Let queued promise callbacks (fetch → json → state) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetOnboardingStoreForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shouldRefresh", () => {
  it("refreshes when nothing has loaded", () => {
    expect(shouldRefresh(1000, null, false, false, false)).toBe(true);
  });
  it("never starts a second fetch while one is in flight (force chains instead)", () => {
    expect(shouldRefresh(1000, null, true, false, false)).toBe(false);
    expect(shouldRefresh(1000, null, true, true, true)).toBe(false);
  });
  it("skips data younger than 1 s unless forced or stale", () => {
    expect(shouldRefresh(1500, 1000, false, false, false)).toBe(false);
    expect(shouldRefresh(1500, 1000, false, true, false)).toBe(true);
    expect(shouldRefresh(1500, 1000, false, false, true)).toBe(true);
  });
  it("refreshes data 1 s or older", () => {
    expect(shouldRefresh(2000, 1000, false, false, false)).toBe(true);
  });
});

describe("onboarding store", () => {
  it("starts from the frozen empty snapshot", () => {
    expect(Object.isFrozen(EMPTY_SNAPSHOT)).toBe(true);
    expect(getOnboardingSnapshot()).toBe(EMPTY_SNAPSHOT);
    expect(EMPTY_SNAPSHOT).toEqual({ data: null, error: false, loadedAt: null, stale: false });
  });

  it("shares one fetch between two concurrent refreshes", async () => {
    const { fn, pending } = stubFetch();
    const a = refreshOnboarding();
    const b = refreshOnboarding();
    expect(fn).toHaveBeenCalledTimes(1);
    pending[0].resolve(ok(payload(2)));
    await Promise.all([a, b]);
    expect(getOnboardingSnapshot().data?.progress.requiredDone).toBe(2);
    expect(getOnboardingSnapshot().error).toBe(false);
  });

  it("does not refetch data younger than 1 s", async () => {
    const { fn, pending } = stubFetch();
    const a = refreshOnboarding();
    pending[0].resolve(ok(payload(1)));
    await a;
    await refreshOnboarding();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("chains a forced refresh after the in-flight one, and its result wins", async () => {
    const { fn, pending } = stubFetch();
    const first = refreshOnboarding();
    const forced = refreshOnboarding({ force: true });
    expect(fn).toHaveBeenCalledTimes(1);
    pending[0].resolve(ok(payload(1)));
    await first;
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
    pending[1].resolve(ok(payload(3)));
    await forced;
    expect(getOnboardingSnapshot().data?.progress.requiredDone).toBe(3);
  });

  it("coalesces several forced refreshes during one fetch into one follow-up", async () => {
    const { fn, pending } = stubFetch();
    void refreshOnboarding();
    void refreshOnboarding({ force: true });
    const last = refreshOnboarding({ force: true });
    pending[0].resolve(ok(payload(1)));
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
    pending[1].resolve(ok(payload(2)));
    await last;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("drops a response older than the newest issued fetch", async () => {
    const { pending } = stubFetch();
    const stale = refreshOnboarding();
    // A reset mid-flight issues a newer generation; the old response must not land.
    __resetOnboardingStoreForTests();
    const fresh = refreshOnboarding();
    pending[1].resolve(ok(payload(4)));
    await fresh;
    pending[0].resolve(ok(payload(0)));
    await stale;
    expect(getOnboardingSnapshot().data?.progress.requiredDone).toBe(4);
  });

  it.each([429, 500])("keeps the last good payload and sets error on %i", async (code) => {
    const { pending } = stubFetch();
    const a = refreshOnboarding();
    pending[0].resolve(ok(payload(2)));
    await a;
    const good = getOnboardingSnapshot().data;
    const b = refreshOnboarding({ force: true });
    pending[1].resolve(status(code));
    await b;
    expect(getOnboardingSnapshot().data).toBe(good);
    expect(getOnboardingSnapshot().error).toBe(true);
  });

  it("treats a body that is not a payload (old envelope) as an error", async () => {
    const { pending } = stubFetch();
    const a = refreshOnboarding();
    pending[0].resolve(
      new Response(JSON.stringify({ success: true, data: { onboarding: {} } }), { status: 200 }),
    );
    await a;
    expect(getOnboardingSnapshot().data).toBeNull();
    expect(getOnboardingSnapshot().error).toBe(true);
  });

  it("reads a payload without guide (a server from before 0060) as guide: null", async () => {
    const { pending } = stubFetch();
    const a = refreshOnboarding();
    const { guide: _g, ...old } = payload(1);
    pending[0].resolve(new Response(JSON.stringify({ success: true, data: old }), { status: 200 }));
    await a;
    expect(getOnboardingSnapshot().data?.guide).toBeNull();
    expect(getOnboardingSnapshot().data?.progress.requiredDone).toBe(1);
  });

  it("keeps the guide object as sent", async () => {
    const { pending } = stubFetch();
    const a = refreshOnboarding();
    const guide = {
      welcomeDue: true, lastLesson: "schedule", tourStartedAt: "2026-11-10T12:00:00.000Z", tourCompletedAt: null,
      readOnly: false, payLinks: false, hasFieldPulse: true, historyHidden: true, historyContact: "Ray",
    } as const;
    pending[0].resolve(ok({ ...payload(0), guide }));
    await a;
    expect(getOnboardingSnapshot().data?.guide).toEqual(guide);
  });

  it("keeps a network rejection from escaping and sets error", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    await expect(refreshOnboarding()).resolves.toBeUndefined();
    expect(getOnboardingSnapshot().error).toBe(true);
  });

  it("clears error once a later fetch succeeds", async () => {
    const { pending } = stubFetch();
    const a = refreshOnboarding();
    pending[0].resolve(status(500));
    await a;
    const b = refreshOnboarding();
    pending[1].resolve(ok(payload(1)));
    await b;
    expect(getOnboardingSnapshot().error).toBe(false);
  });

  it("returns the same snapshot object until something changes", async () => {
    const { pending } = stubFetch();
    const a = refreshOnboarding();
    pending[0].resolve(ok(payload(1)));
    await a;
    const s1 = getOnboardingSnapshot();
    expect(getOnboardingSnapshot()).toBe(s1);
    expect(Object.isFrozen(s1)).toBe(true);
  });

  it("notifies subscribers once per change and not after unsubscribe", async () => {
    const { pending } = stubFetch();
    const cb = vi.fn();
    const unsubscribe = subscribeOnboarding(cb);
    const a = refreshOnboarding();
    pending[0].resolve(ok(payload(1)));
    await a;
    expect(cb).toHaveBeenCalledTimes(1);
    // A second identical error twice: only the first flips state.
    const b = refreshOnboarding({ force: true });
    pending[1].resolve(status(500));
    await b;
    const c = refreshOnboarding({ force: true });
    pending[2].resolve(status(500));
    await c;
    expect(cb).toHaveBeenCalledTimes(2);
    unsubscribe();
    const d = refreshOnboarding({ force: true });
    pending[3].resolve(ok(payload(2)));
    await d;
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("invalidate with subscribers forces a refetch", async () => {
    const { fn, pending } = stubFetch();
    const unsubscribe = subscribeOnboarding(() => {});
    const a = refreshOnboarding();
    pending[0].resolve(ok(payload(1)));
    await a;
    invalidateOnboarding();
    expect(fn).toHaveBeenCalledTimes(2);
    pending[1].resolve(ok(payload(2)));
    await flush();
    expect(getOnboardingSnapshot().data?.progress.requiredDone).toBe(2);
    unsubscribe();
  });

  it("invalidate without subscribers marks stale and the next refresh is forced", async () => {
    const { fn, pending } = stubFetch();
    const a = refreshOnboarding();
    pending[0].resolve(ok(payload(1)));
    await a;
    invalidateOnboarding();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getOnboardingSnapshot().stale).toBe(true);
    const b = refreshOnboarding(); // within 1 s, but stale forces it
    expect(fn).toHaveBeenCalledTimes(2);
    pending[1].resolve(ok(payload(2)));
    await b;
    expect(getOnboardingSnapshot().stale).toBe(false);
  });
});
