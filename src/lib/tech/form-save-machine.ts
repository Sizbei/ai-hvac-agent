/**
 * Autosave timing (M3d spec §7.3), pure. A save starts 1.5 s after the last
 * change, on blur of a text field, and on hidden / pagehide (those bypass the
 * 3 s floor but keep one write in flight and any back-off). One write in
 * flight; an unknown result is re-sent with its own body and saveId before any
 * newer write; retries wait Retry-After or 3 s, doubling to 30 s, and a new
 * edit doesn't reset the wait.
 */
export const DEBOUNCE_MS = 1500;
export const FLOOR_MS = 3000;
export const FIRST_RETRY_MS = 3000;
export const MAX_RETRY_MS = 30_000;

export type StopReason = "signed_out" | "too_large" | "bad_request" | "blocked";

export interface SaveState {
  readonly inFlight: boolean;
  /** An unknown write waits to be re-sent (the caller keeps its body and saveId). */
  readonly retryPending: boolean;
  readonly dueAt: number | null;
  readonly immediate: boolean;
  readonly lastSentAt: number | null;
  readonly backoffMs: number;
  readonly waitUntil: number;
  readonly stop: StopReason | null;
  /** A submit is `sent` or `unknown`: the page is locked and autosave paused. */
  readonly locked: boolean;
}

export const SAVE_IDLE: SaveState = {
  inFlight: false, retryPending: false, dueAt: null, immediate: false, lastSentAt: null,
  backoffMs: 0, waitUntil: 0, stop: null, locked: false,
};

export type SaveEvent =
  | { readonly type: "edit"; readonly now: number }
  | { readonly type: "flush" }
  | { readonly type: "sent"; readonly now: number }
  | { readonly type: "landed" }
  | { readonly type: "unknown"; readonly now: number; readonly retryAfterMs: number | null }
  | { readonly type: "stop"; readonly reason: StopReason }
  | { readonly type: "try_again" }
  | { readonly type: "resume" }
  | { readonly type: "lock" }
  | { readonly type: "unlock" }
  /** The form was submitted (by this page or anyone): nothing more is saved. */
  | { readonly type: "submitted" };

export function nextSaveState(s: SaveState, e: SaveEvent): SaveState {
  switch (e.type) {
    case "edit":
      // A too-large stop lifts on the next edit; a bad-request stop waits for Try again.
      return { ...s, dueAt: e.now + DEBOUNCE_MS, stop: s.stop === "too_large" ? null : s.stop };
    case "flush":
      return { ...s, immediate: true };
    case "sent":
      return { ...s, inFlight: true, retryPending: false, lastSentAt: e.now, dueAt: null, immediate: false };
    case "landed":
      return { ...s, inFlight: false, retryPending: false, backoffMs: 0, waitUntil: 0 };
    case "unknown": {
      const backoffMs = s.backoffMs === 0 ? FIRST_RETRY_MS : Math.min(s.backoffMs * 2, MAX_RETRY_MS);
      return { ...s, inFlight: false, retryPending: true, backoffMs, waitUntil: e.now + (e.retryAfterMs ?? backoffMs) };
    }
    case "stop":
      return { ...s, inFlight: false, retryPending: false, stop: e.reason, dueAt: null, immediate: false };
    case "try_again":
      // `Couldn't save your answers.` + Try again: the same body and saveId go again now.
      return s.stop === "bad_request" ? { ...s, stop: null, retryPending: true, waitUntil: 0 } : s;
    case "resume":
      return { ...s, stop: null };
    case "lock":
      return { ...s, locked: true };
    case "unlock":
      return { ...s, locked: false };
    case "submitted":
      return { ...s, inFlight: false, retryPending: false, dueAt: null, immediate: false, stop: "blocked" };
  }
}

export type SubmitStep = "await_flight" | "resend_pending" | "send_submit";

/**
 * What a confirmed Submit does next (spec §4.2 / §7.3: an unknown result is
 * retried with its own body and saveId before any newer write — the submit
 * included): wait for the write in flight, then re-send a pending draft, then
 * submit.
 */
export function submitStep(s: SaveState, hasPendingDraft: boolean, flightOpen: boolean): SubmitStep {
  if (s.inFlight || flightOpen) return "await_flight";
  if (hasPendingDraft || s.retryPending) return "resend_pending";
  return "send_submit";
}

export type SaveAction = "send_retry" | "send_new" | null;

/** What to send now, if anything. `dirty` = there are changes to send. */
export function saveDue(s: SaveState, now: number, dirty: boolean): SaveAction {
  if (s.locked || s.stop !== null || s.inFlight) return null;
  if (s.retryPending) return now >= s.waitUntil ? "send_retry" : null;
  if (!dirty || now < s.waitUntil) return null;
  if (s.immediate) return "send_new";
  if (s.dueAt !== null && now >= s.dueAt && (s.lastSentAt === null || now - s.lastSentAt >= FLOOR_MS)) return "send_new";
  return null;
}

/** When to look again (a timer), or null when nothing is scheduled. */
export function nextWakeAt(s: SaveState, dirty: boolean): number | null {
  if (s.locked || s.stop !== null || s.inFlight) return null;
  if (s.retryPending) return s.waitUntil;
  if (!dirty) return null;
  if (s.immediate) return s.waitUntil;
  if (s.dueAt === null) return null;
  return Math.max(s.dueAt, s.lastSentAt === null ? 0 : s.lastSentAt + FLOOR_MS, s.waitUntil);
}

/** keepalive only for bodies of 60 KB or less (the browser's keepalive budget). */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;
