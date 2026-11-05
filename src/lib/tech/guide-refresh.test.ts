import { describe, it, expect, vi } from "vitest";
import { GUIDE_REFRESH_EVENT, dispatchGuideRefresh, subscribeGuideRefresh } from "./guide-refresh";

describe("guide refresh event", () => {
  it("names the event", () => expect(GUIDE_REFRESH_EVENT).toBe("tech:guide:refresh"));
  it("delivers once per dispatch and stops after unsubscribe", () => {
    const target = new EventTarget();
    const cb = vi.fn();
    const off = subscribeGuideRefresh(cb, target);
    dispatchGuideRefresh(target);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    dispatchGuideRefresh(target);
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it("is a no-op without a target", () => {
    expect(() => dispatchGuideRefresh(undefined)).not.toThrow();
    expect(typeof subscribeGuideRefresh(() => {}, undefined)).toBe("function");
  });
});
