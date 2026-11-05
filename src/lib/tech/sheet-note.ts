/**
 * The inline line a tech invoice sheet shows after a write (pure). `pending`
 * (the server still holds the tap) and `skipped` read as status, not as an
 * error; done/dropped need no line.
 */
import type { WriteStatus } from "./invoice-view-diff";

export interface SheetNote {
  readonly text: string;
  readonly error: boolean;
}

export function noteFor(r: { status: WriteStatus; message: string | null }, fallback: string): SheetNote | null {
  if (r.status === "done" || r.status === "dropped") return null;
  if (r.status === "pending" || r.status === "skipped") return r.message ? { text: r.message, error: false } : null;
  return { text: r.message ?? fallback, error: true };
}
