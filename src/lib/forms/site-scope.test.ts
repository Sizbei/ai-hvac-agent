import { describe, it, expect } from "vitest";
import { membershipEvaluable, siteMatches, siteScopeOf, type SiteCandidate, type SiteSelf } from "./site-scope";

const L1 = "loc-1";
const L2 = "loc-2";
const A = "12 elm st, johnson city, tn";
const B = "40 oak ave, johnson city, tn";
const self = (over: Partial<SiteSelf> = {}): SiteSelf => ({ hasCustomer: true, customerErased: false, locationId: null, address: null, ...over });
const c = (id: string, locationId: string | null, address: string | null): SiteCandidate => ({ id, locationId, address });

describe("siteScopeOf / siteMatches (spec §7.6)", () => {
  const candidates = [c("same-loc", L1, B), c("other-loc", L2, A), c("no-loc-same-addr", null, A), c("no-loc-other", null, B), c("bare", null, null)];

  it("location: same location, plus location-less requests at the same address", () => {
    const s = self({ locationId: L1, address: A });
    expect(siteScopeOf(s)).toBe("location");
    expect(siteMatches(s, candidates)).toEqual(["same-loc", "no-loc-same-addr"]);
  });

  it("location with no address of its own: only the same location", () => {
    expect(siteMatches(self({ locationId: L1 }), candidates)).toEqual(["same-loc"]);
  });

  it("address: an equal normalised address, whatever the candidate's location", () => {
    const s = self({ address: A });
    expect(siteScopeOf(s)).toBe("address");
    expect(siteMatches(s, candidates)).toEqual(["other-loc", "no-loc-same-addr"]);
  });

  it("none: no location and no address, no customer, or an erased customer; no fallback", () => {
    expect(siteScopeOf(self())).toBe("none");
    expect(siteMatches(self(), candidates)).toEqual([]);
    expect(siteScopeOf(self({ hasCustomer: false, address: A }))).toBe("none");
    expect(siteMatches(self({ customerErased: true, locationId: L1, address: A }), candidates)).toEqual([]);
  });

  it("an address-less, location-less candidate never matches", () => {
    expect(siteMatches(self({ address: A }), [c("bare", null, null)])).toEqual([]);
  });
});

describe("membershipEvaluable", () => {
  it("one address everywhere and at most one location", () => {
    expect(membershipEvaluable(A, 1, [A, A])).toBe(true);
    expect(membershipEvaluable(A, 0, [A])).toBe(true);
  });
  it("withheld for a second location, an address-less sibling or a different address", () => {
    expect(membershipEvaluable(A, 2, [A])).toBe(false);
    expect(membershipEvaluable(A, 1, [A, null])).toBe(false);
    expect(membershipEvaluable(A, 1, [A, B])).toBe(false);
    expect(membershipEvaluable(null, 0, [null])).toBe(false);
  });
});
