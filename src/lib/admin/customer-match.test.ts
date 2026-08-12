import { describe, it, expect } from "vitest";
import { Column } from "drizzle-orm";
import {
  pickCustomerMatch,
  customerMatchCandidatePredicate,
  CUSTOMER_MATCH_CANDIDATE_LIMIT,
  type CustomerMatchCandidate,
} from "./customer-match";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-01-01T00:00:00Z");
const later = (days: number) => new Date(T0.getTime() + days * DAY);

function candidate(
  over: Partial<CustomerMatchCandidate> & { id: string },
): CustomerMatchCandidate {
  return {
    matchedOn: "email",
    anonymizedAt: null,
    archivedAt: null,
    doNotService: false,
    createdAt: T0,
    lastActivityAt: null,
    ...over,
  };
}

describe("pickCustomerMatch — pick order", () => {
  it("returns null for no candidates (and nothing else does)", () => {
    expect(pickCustomerMatch([])).toBeNull();
  });

  it("returns the full shape for any surviving candidate", () => {
    expect(pickCustomerMatch([candidate({ id: "a" })])).toEqual({
      id: "a",
      ambiguous: false,
      doNotService: false,
    });
  });

  it("rule 1: never returns an erased row, even as the only match", () => {
    expect(
      pickCustomerMatch([candidate({ id: "erased", anonymizedAt: T0 })]),
    ).toBeNull();
  });

  it("rule 1: an erased row does not make a single live row ambiguous", () => {
    const picked = pickCustomerMatch([
      candidate({ id: "erased", anonymizedAt: T0 }),
      candidate({ id: "live" }),
    ]);
    expect(picked).toEqual({ id: "live", ambiguous: false, doNotService: false });
  });

  it("rule 2: a do-not-service row wins", () => {
    const picked = pickCustomerMatch([
      candidate({ id: "live" }),
      candidate({ id: "blocked", doNotService: true }),
    ]);
    expect(picked?.id).toBe("blocked");
  });

  it("rule 2 beats every other axis: blocked, archived, oldest, phone-matched still wins", () => {
    const picked = pickCustomerMatch([
      candidate({
        id: "strongest-on-paper",
        matchedOn: "email",
        lastActivityAt: later(30),
        createdAt: later(10),
      }),
      candidate({
        id: "blocked",
        matchedOn: "phone",
        archivedAt: later(1),
        doNotService: true,
        createdAt: new Date("2020-01-01T00:00:00Z"),
        lastActivityAt: null,
      }),
    ]);
    expect(picked?.id).toBe("blocked");
    expect(picked?.doNotService).toBe(true);
  });

  it("rule 3: an email match beats a phone match", () => {
    const picked = pickCustomerMatch([
      candidate({ id: "by-phone", matchedOn: "phone", lastActivityAt: later(30) }),
      candidate({ id: "by-email", matchedOn: "email" }),
    ]);
    expect(picked?.id).toBe("by-email");
  });

  it("rule 4: a live row beats an archived one", () => {
    const picked = pickCustomerMatch([
      candidate({ id: "archived", archivedAt: later(1), lastActivityAt: later(30) }),
      candidate({ id: "live" }),
    ]);
    expect(picked?.id).toBe("live");
  });

  it("rule 5: the most recently active row wins, and no activity ranks last", () => {
    const picked = pickCustomerMatch([
      candidate({ id: "dormant", lastActivityAt: null, createdAt: later(20) }),
      candidate({ id: "old-activity", lastActivityAt: later(1) }),
      candidate({ id: "recent", lastActivityAt: later(9) }),
    ]);
    expect(picked?.id).toBe("recent");
  });

  it("rule 6: the newest identity wins when no activity separates them", () => {
    const picked = pickCustomerMatch([
      candidate({ id: "older", createdAt: later(1) }),
      candidate({ id: "newer", createdAt: later(5) }),
    ]);
    expect(picked?.id).toBe("newer");
  });

  it("rule 7: two candidates identical on every axis resolve the same way twice", () => {
    const candidates = [candidate({ id: "b2" }), candidate({ id: "a1" })];
    const first = pickCustomerMatch(candidates);
    const second = pickCustomerMatch([...candidates].reverse());
    expect(first?.id).toBe("a1");
    expect(second?.id).toBe("a1");
  });

  it("does not mutate the caller's array", () => {
    const candidates = [candidate({ id: "b2" }), candidate({ id: "a1" })];
    pickCustomerMatch(candidates);
    expect(candidates.map((c) => c.id)).toEqual(["b2", "a1"]);
  });
});

describe("pickCustomerMatch — ambiguity", () => {
  it("is ambiguous for two live candidates", () => {
    expect(
      pickCustomerMatch([candidate({ id: "a" }), candidate({ id: "b" })])
        ?.ambiguous,
    ).toBe(true);
  });

  it("is not ambiguous for one live candidate plus archived and erased ones", () => {
    const picked = pickCustomerMatch([
      candidate({ id: "live" }),
      candidate({ id: "archived", archivedAt: later(1) }),
      candidate({ id: "also-archived", archivedAt: later(2) }),
      candidate({ id: "erased", anonymizedAt: T0 }),
    ]);
    expect(picked).toEqual({ id: "live", ambiguous: false, doNotService: false });
  });

  it("carries the winning candidate's do-not-service flag, not the cluster's", () => {
    const picked = pickCustomerMatch([
      candidate({ id: "a" }),
      candidate({ id: "b" }),
    ]);
    expect(picked?.doNotService).toBe(false);
  });

  it("still returns the do-not-service row's id when the pick is ambiguous", () => {
    // Returning null here would let a blocked business book by sharing a
    // contact with an unblocked one — the exact bypass rule 2 prevents.
    const picked = pickCustomerMatch([
      candidate({ id: "live" }),
      candidate({ id: "blocked", doNotService: true }),
    ]);
    expect(picked).toEqual({
      id: "blocked",
      ambiguous: true,
      doNotService: true,
    });
  });
});

describe("candidate query constants", () => {
  it("caps the candidate read", () => {
    expect(CUSTOMER_MATCH_CANDIDATE_LIMIT).toBe(50);
  });

  it("puts rule 1 in the candidate query's WHERE", () => {
    // Guard against the filter drifting out of the SQL and living only in the
    // helper: the LIMIT is safe only while erased rows never enter the set.
    const rendered = customerMatchCandidatePredicate().queryChunks
      .map((chunk) =>
        chunk instanceof Column
          ? chunk.name
          : ((chunk as { value?: string[] }).value ?? []).join(""),
      )
      .join("");
    expect(rendered).toBe("anonymized_at IS NULL");
  });
});
