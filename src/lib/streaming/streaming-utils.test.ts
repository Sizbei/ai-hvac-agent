import { describe, it, expect, vi } from "vitest";
import {
  StreamController,
  mergeMessages,
  createOptimisticMessage,
  retryWithBackoff,
} from "./streaming-utils";

// ---------------------------------------------------------------------------
// StreamController — the incremental-streaming consistency guard. As the user
// sends a new message, the previous in-flight stream is aborted and its id goes
// stale, so a late chunk from the OLD stream can never render over the new one.
// ---------------------------------------------------------------------------
describe("StreamController", () => {
  it("issues incrementing request ids and only the latest isCurrent", () => {
    const c = new StreamController();
    const a = c.startNew();
    const b = c.startNew();
    expect(b).toBeGreaterThan(a);
    expect(c.isCurrent(a)).toBe(false); // stale stream
    expect(c.isCurrent(b)).toBe(true); // live stream
  });

  it("aborts the previous request when a new one starts", () => {
    const c = new StreamController();
    c.startNew();
    const firstSignal = c.signal;
    expect(firstSignal?.aborted).toBe(false);
    c.startNew(); // starting a new request aborts the prior
    expect(firstSignal?.aborted).toBe(true);
  });

  it("exposes a live signal, and none after an explicit abort", () => {
    const c = new StreamController();
    c.startNew();
    expect(c.signal).toBeInstanceOf(AbortSignal);
    c.abort();
    expect(c.signal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergeMessages — optimistic user message shows immediately, then the server
// confirmed copy REPLACES it (same id) without duplicating; an assistant message
// streamed in chunks renders incrementally (later, longer-content version of the
// same id supersedes the earlier one).
// ---------------------------------------------------------------------------
describe("mergeMessages (incremental render)", () => {
  it("keeps an optimistic message that has no confirmed counterpart", () => {
    const optimistic = createOptimisticMessage("hello");
    const merged = mergeMessages([], [optimistic]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ content: "hello", pending: true });
  });

  it("replaces an optimistic message with the confirmed one (no duplicate)", () => {
    const msg = { id: "m1", content: "hi", pending: true };
    const confirmed = { id: "m1", content: "hi", pending: false };
    const merged = mergeMessages([confirmed], [msg]);
    expect(merged).toHaveLength(1); // not 2 — same id deduped
    expect(merged[0].pending).toBe(false); // confirmed wins
  });

  it("renders a streamed assistant reply incrementally (longer chunk supersedes)", () => {
    // Simulate two render passes of the SAME assistant message id as chunks arrive.
    const partial = { id: "a1", role: "assistant", content: "The AC" };
    const full = { id: "a1", role: "assistant", content: "The AC may be low on refrigerant." };
    const pass1 = mergeMessages([partial], []);
    expect(pass1[0].content).toBe("The AC");
    const pass2 = mergeMessages([full], []);
    expect(pass2).toHaveLength(1);
    expect(pass2[0].content).toBe("The AC may be low on refrigerant.");
  });
});

// ---------------------------------------------------------------------------
// retryWithBackoff — transient failures retry, but a 4xx and an abort do NOT.
// ---------------------------------------------------------------------------
describe("retryWithBackoff", () => {
  const fast = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };

  it("returns on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retryWithBackoff(fn, fast)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient (5xx-ish) failure then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue("ok");
    await expect(retryWithBackoff(fn, fast)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 4xx client error", async () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, fast)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1); // immediate, no retry
  });

  it("does NOT retry an aborted request", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, fast)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
