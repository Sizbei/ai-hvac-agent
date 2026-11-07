import { describe, it, expect } from "vitest";
import { nextSaveState, nextWakeAt, remainingMs, saveDue, SAVE_IDLE, settleStep, submitStep, TIMED_OUT, withDeadline, type SaveEvent, type SaveState } from "./form-save-machine";

const run = (events: SaveEvent[], s: SaveState = SAVE_IDLE) => events.reduce(nextSaveState, s);

describe("nextSaveState / saveDue (spec §7.3)", () => {
  it("debounce: a save starts 1.5 s after the last change", () => {
    const s = run([{ type: "edit", now: 0 }, { type: "edit", now: 1000 }]);
    expect(saveDue(s, 2000, true)).toBeNull();
    expect(saveDue(s, 2500, true)).toBe("send_new");
    expect(nextWakeAt(s, true)).toBe(2500);
  });
  it("one write in flight; then at most one PUT per 3 s", () => {
    let s = run([{ type: "edit", now: 0 }, { type: "sent", now: 1500 }, { type: "edit", now: 1600 }]);
    expect(saveDue(s, 3200, true)).toBeNull();
    s = nextSaveState(s, { type: "landed" });
    expect(saveDue(s, 3200, true)).toBeNull();
    expect(saveDue(s, 4500, true)).toBe("send_new");
  });
  it("blur / hidden / pagehide bypass the floor but keep one in flight", () => {
    let s = run([{ type: "sent", now: 0 }, { type: "landed" }, { type: "edit", now: 100 }, { type: "flush" }]);
    expect(saveDue(s, 200, true)).toBe("send_new");
    s = run([{ type: "sent", now: 0 }, { type: "edit", now: 100 }, { type: "flush" }]);
    expect(saveDue(s, 200, true)).toBeNull();
  });
  it("an unknown result is re-sent first, after 3 s, doubling to 30 s; a new edit doesn't reset the wait", () => {
    let s = run([{ type: "sent", now: 0 }, { type: "unknown", now: 100, retryAfterMs: null }]);
    expect(s.waitUntil).toBe(3100);
    s = nextSaveState(s, { type: "edit", now: 200 });
    expect(saveDue(s, 3000, true)).toBeNull();
    expect(saveDue(s, 3100, true)).toBe("send_retry");
    const waits: number[] = [];
    s = SAVE_IDLE;
    for (let i = 0; i < 6; i++) {
      s = run([{ type: "sent", now: 0 }, { type: "unknown", now: 0, retryAfterMs: null }], s);
      waits.push(s.waitUntil);
    }
    expect(waits).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
    expect(run([{ type: "sent", now: 0 }, { type: "unknown", now: 0, retryAfterMs: 7000 }]).waitUntil).toBe(7000);
    expect(nextSaveState(s, { type: "landed" })).toMatchObject({ backoffMs: 0, retryPending: false });
  });
  it("401 stops; a values-size 400 stops until the next edit; another 400 waits for Try again", () => {
    expect(saveDue(run([{ type: "stop", reason: "signed_out" }, { type: "edit", now: 0 }]), 5000, true)).toBeNull();
    const big = run([{ type: "stop", reason: "too_large" }, { type: "edit", now: 0 }]);
    expect(big.stop).toBeNull();
    expect(saveDue(big, 5000, true)).toBe("send_new");
    const bad = run([{ type: "stop", reason: "bad_request" }, { type: "edit", now: 0 }]);
    expect(saveDue(bad, 5000, true)).toBeNull();
    expect(saveDue(nextSaveState(bad, { type: "try_again" }), 5000, true)).toBe("send_retry");
  });
  it("a submit sent or unknown locks the page and pauses autosave", () => {
    const s = run([{ type: "edit", now: 0 }, { type: "lock" }]);
    expect(saveDue(s, 9000, true)).toBeNull();
    expect(nextWakeAt(s, true)).toBeNull();
    expect(saveDue(nextSaveState(s, { type: "unlock" }), 9000, true)).toBe("send_new");
  });
  it("submit waits for the write in flight, then re-sends a pending unknown draft, then submits", () => {
    expect(submitStep(run([{ type: "sent", now: 0 }]), true, true)).toBe("await_flight");
    const unknown = run([{ type: "sent", now: 0 }, { type: "unknown", now: 10, retryAfterMs: null }, { type: "lock" }]);
    // Locked by the submit and still inside the back-off: the draft goes first anyway.
    expect(submitStep(unknown, true, false)).toBe("resend_pending");
    expect(submitStep(nextSaveState(unknown, { type: "landed" }), false, false)).toBe("send_submit");
  });
  it("a draft queued behind a successful submit is cleared, never retried", () => {
    const s = run([{ type: "sent", now: 0 }, { type: "unknown", now: 10, retryAfterMs: null }, { type: "edit", now: 20 }, { type: "submitted" }]);
    expect(s.retryPending).toBe(false);
    expect(saveDue(s, 60_000, true)).toBeNull();
    expect(nextWakeAt(s, true)).toBeNull();
    expect(saveDue(nextSaveState(s, { type: "edit", now: 70_000 }), 80_000, true)).toBeNull();
  });
  it("submitted is final: resume and try_again leave it alone", () => {
    const s = run([{ type: "submitted" }]);
    expect(nextSaveState(s, { type: "resume" }).stop).toBe("submitted");
    expect(nextSaveState(s, { type: "try_again" }).stop).toBe("submitted");
    expect(saveDue(nextSaveState(s, { type: "resume" }), 9000, true)).toBeNull();
  });
  it("nothing dirty, nothing sent", () => {
    expect(saveDue(run([{ type: "edit", now: 0 }]), 5000, false)).toBeNull();
  });
});

describe("settleStep (in-app leave, ruling R1a)", () => {
  const o = { pending: false, dirty: false, flight: false, rereading: false };
  it("nothing left → done; edits → send now, an unknown body first", () => {
    expect(settleStep(SAVE_IDLE, o)).toBe("done");
    expect(settleStep(SAVE_IDLE, { ...o, dirty: true })).toBe("send_new");
    expect(settleStep(SAVE_IDLE, { ...o, dirty: true, pending: true })).toBe("send_retry");
    const backingOff = run([{ type: "sent", now: 0 }, { type: "unknown", now: 10, retryAfterMs: null }]);
    expect(settleStep(backingOff, { ...o, pending: true })).toBe("send_retry");
  });
  it("a write in flight or a re-read → wait (a STALE merge re-saves before leaving)", () => {
    expect(settleStep(run([{ type: "sent", now: 0 }]), { ...o, dirty: true })).toBe("wait");
    expect(settleStep(SAVE_IDLE, { ...o, flight: true })).toBe("wait");
    expect(settleStep(SAVE_IDLE, { ...o, dirty: true, rereading: true })).toBe("wait");
  });
  it("a stop that needs the technician → fail (stay); blocked, submitted or a locked submit → done", () => {
    for (const reason of ["signed_out", "too_large", "bad_request"] as const) {
      expect(settleStep(run([{ type: "stop", reason }]), { ...o, dirty: true })).toBe("fail");
    }
    expect(settleStep(run([{ type: "stop", reason: "blocked" }]), { ...o, dirty: true })).toBe("done");
    expect(settleStep(run([{ type: "submitted" }]), { ...o, dirty: true })).toBe("done");
    expect(settleStep(run([{ type: "lock" }]), { ...o, dirty: true, flight: true })).toBe("done");
  });
});

describe("withDeadline (an in-app leave never hangs)", () => {
  it("remainingMs never goes negative", () => {
    expect(remainingMs(1000, 400)).toBe(600);
    expect(remainingMs(1000, 1500)).toBe(0);
  });
  it("a never-settling promise yields TIMED_OUT at the deadline; a settled one its value", async () => {
    const never = new Promise<boolean>(() => {});
    expect(await withDeadline(never, Date.now() + 20)).toBe(TIMED_OUT);
    expect(await withDeadline(never, Date.now() - 5)).toBe(TIMED_OUT);
    expect(await withDeadline(Promise.resolve(true), Date.now() + 1000)).toBe(true);
    expect(await withDeadline(Promise.resolve(false), Date.now() + 1000)).toBe(false);
  });
});
