import { describe, it, expect } from "vitest";
import {
  CUSTOMER_HASH, LAYER_CLOSED, LAYER_OPEN, approveFirst, focusTrapTarget, layerStale, layerStep, pageLocked, saleFailNote,
  sellAdvanced, techNoteVisible,
} from "./customer-view-state";

describe("customer layer history (spec §7.2, plan ruling 13)", () => {
  it("Show to customer pushes one #customer entry; a second show does nothing", () => {
    expect(layerStep(LAYER_CLOSED, { type: "show" })).toEqual({ state: LAYER_OPEN, effect: "push" });
    expect(layerStep(LAYER_OPEN, { type: "show" })).toEqual({ state: LAYER_OPEN, effect: "none" });
  });
  it("Back (popstate without the hash) closes the layer onto the estimate page, nothing more", () => {
    expect(layerStep(LAYER_OPEN, { type: "popstate", hash: "" })).toEqual({ state: LAYER_CLOSED, effect: "none" });
    expect(layerStep(LAYER_CLOSED, { type: "popstate", hash: "" })).toEqual({ state: LAYER_CLOSED, effect: "none" });
  });
  it("Forward onto a stale #customer entry never reopens it", () => {
    expect(layerStep(LAYER_CLOSED, { type: "popstate", hash: CUSTOMER_HASH })).toEqual({ state: LAYER_CLOSED, effect: "strip" });
  });
  it("layerStep re-pushes #customer on a sellable reload so close is one back", () => {
    const reopened = layerStep(LAYER_CLOSED, { type: "mount", hash: CUSTOMER_HASH, sellable: true });
    expect(reopened).toEqual({ state: LAYER_OPEN, effect: "strip_push" });
    expect(layerStep(reopened.state, { type: "close" })).toEqual({ state: LAYER_CLOSED, effect: "back" });
    // React StrictMode mounts twice: the second mount must not push another entry.
    expect(layerStep(reopened.state, { type: "mount", hash: CUSTOMER_HASH, sellable: true })).toEqual({ state: LAYER_OPEN, effect: "none" });
  });
  it("a mount without the hash leaves the layer closed", () => {
    expect(layerStep(LAYER_CLOSED, { type: "mount", hash: "", sellable: true })).toEqual({ state: LAYER_CLOSED, effect: "none" });
  });
  it("layerStep strips the hash on a reload of an estimate that can no longer be sold", () => {
    expect(layerStep(LAYER_CLOSED, { type: "mount", hash: CUSTOMER_HASH, sellable: false })).toEqual({ state: LAYER_CLOSED, effect: "strip" });
  });
  it("every close of an open layer is a single back; closing a closed layer does nothing", () => {
    expect(layerStep(LAYER_OPEN, { type: "close" })).toEqual({ state: LAYER_CLOSED, effect: "back" });
    expect(layerStep(LAYER_CLOSED, { type: "close" })).toEqual({ state: LAYER_CLOSED, effect: "none" });
  });
});

describe("approve never reports a blind success (fix round 1)", () => {
  it("a send that went nowhere, or re-sent an older stored sell, is checked by refetch", () => {
    expect(approveFirst({ sent: false })).toBe("check");
    expect(approveFirst({ sent: true, outcome: "success_refetch", resentOld: true })).toBe("check");
    expect(approveFirst({ sent: true, outcome: "spent_new_key", resentOld: true })).toBe("check");
  });
  it("a fresh send follows saleResult", () => {
    expect(approveFirst({ sent: true, outcome: "success_refetch", resentOld: false })).toBe("success");
    expect(approveFirst({ sent: true, outcome: "already_saved_refetch", resentOld: false })).toBe("success");
    expect(approveFirst({ sent: true, outcome: "retry_same_key_after_refetch", resentOld: false })).toBe("check");
    expect(approveFirst({ sent: true, outcome: "wait_then_refetch", resentOld: false })).toBe("check");
    expect(approveFirst({ sent: true, outcome: "show_message_refetch", resentOld: false })).toBe("failed");
  });
  it("a stored sell is settled once the estimate is no longer open", () => {
    expect(sellAdvanced(null)).toBe(false);
    expect(sellAdvanced({ status: "open" })).toBe(false);
    expect(sellAdvanced({ status: "sold" })).toBe(true);
    expect(sellAdvanced({ status: "declined" })).toBe(true);
    expect(sellAdvanced({ status: "expired" })).toBe(true);
  });
});

describe("the technician sees why a sale failed (fix round 1)", () => {
  it("nothing sent: a sell is still in flight", () => {
    expect(saleFailNote({ sent: false })).toBe("Your last change may not have saved. Try again.");
  });
  it("the server's reason, or the write copy for the outcome", () => {
    expect(saleFailNote({ sent: true, outcome: "show_message_refetch", envelope: { error: { message: "This estimate has expired." } } }))
      .toBe("This estimate has expired.");
    expect(saleFailNote({ sent: true, outcome: "retry_same_key_after_refetch", envelope: null })).toBe("Your last change may not have saved. Try again.");
    expect(saleFailNote({ sent: true, outcome: "spent_new_key", envelope: null })).toBe("Couldn't save that. Try again.");
  });
  it("a re-sent older sell that landed: the page's sold state is the reason, no error note", () => {
    expect(saleFailNote({ sent: true, outcome: "success_refetch", envelope: null })).toBeNull();
    expect(saleFailNote({ sent: true, outcome: "already_saved_refetch", envelope: null })).toBeNull();
  });
});

describe("an open layer closes when its estimate stops being sellable (fix round 1)", () => {
  it("closes only an open layer with no sale started", () => {
    expect(layerStale({ open: true, saleStarted: false, sellable: false })).toBe(true);
    expect(layerStale({ open: true, saleStarted: false, sellable: true })).toBe(false);
    // After Approve the layer keeps its result screen until the technician takes the phone back.
    expect(layerStale({ open: true, saleStarted: true, sellable: false })).toBe(false);
    expect(layerStale({ open: false, saleStarted: false, sellable: false })).toBe(false);
  });
});

describe("estimate page locks while a sale is in flight (final review B P1-1)", () => {
  const base = { recovering: false, unresolved: 0, sellPhase: "idle", busy: null } as const;
  it("a sell still in flight locks the page, even after Back closed the layer", () => {
    expect(pageLocked({ ...base, sellPhase: "sent" })).toBe(true);
    expect(pageLocked({ ...base, sellPhase: "unknown" })).toBe(true);
  });
  it("idle and armed sells leave it unlocked; recovery, stored intents and busy lock it", () => {
    expect(pageLocked(base)).toBe(false);
    expect(pageLocked({ ...base, sellPhase: "armed" })).toBe(false);
    expect(pageLocked({ ...base, recovering: true })).toBe(true);
    expect(pageLocked({ ...base, unresolved: 1 })).toBe(true);
    expect(pageLocked({ ...base, busy: "bill" })).toBe(true);
  });
});

describe("customer layer focus trap (final review B P2-6)", () => {
  it("Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last", () => {
    expect(focusTrapTarget({ index: 2, count: 3, shift: false })).toBe(0);
    expect(focusTrapTarget({ index: 0, count: 3, shift: true })).toBe(2);
  });
  it("focus outside the layer (or on its heading) comes back in", () => {
    expect(focusTrapTarget({ index: -1, count: 3, shift: false })).toBe(0);
    expect(focusTrapTarget({ index: -1, count: 3, shift: true })).toBe(2);
  });
  it("inside the layer, the browser's own Tab order runs", () => {
    expect(focusTrapTarget({ index: 1, count: 3, shift: false })).toBeNull();
    expect(focusTrapTarget({ index: 1, count: 3, shift: true })).toBeNull();
  });
  it("nothing focusable: nothing to move to", () => {
    expect(focusTrapTarget({ index: -1, count: 0, shift: false })).toBeNull();
  });
});

describe("the technician's failure note waits for the layer to close (Task 9 parked)", () => {
  it("hidden while the customer holds the phone, shown once it is handed back", () => {
    expect(techNoteVisible({ note: "This estimate expired. Build a new one.", layerOpen: true, banner: false })).toBe(false);
    expect(techNoteVisible({ note: "This estimate expired. Build a new one.", layerOpen: false, banner: false })).toBe(true);
  });
  it("the may-not-have-saved banner already says it; no note, no line", () => {
    expect(techNoteVisible({ note: "x", layerOpen: false, banner: true })).toBe(false);
    expect(techNoteVisible({ note: null, layerOpen: false, banner: false })).toBe(false);
  });
});
