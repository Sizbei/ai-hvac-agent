/**
 * The narrated walkthrough on /admin/setup: file paths, its length and the
 * copy the player shows. The files live in `public/tutorial/` and were
 * recorded against a fictional demo org (no real customer data).
 */

export const TUTORIAL_VIDEO = {
  src: "/tutorial/walkthrough.mp4",
  poster: "/tutorial/walkthrough-poster.jpg",
  captions: "/tutorial/walkthrough.en.vtt",
  /** Length of walkthrough.mp4, rounded to the second. */
  durationSeconds: 169,
  /** The recording's frame size, so the box never jumps when it loads. */
  width: 1920,
  height: 1080,
} as const;

/** What the video covers; also the text fallback when it cannot play. */
export const TUTORIAL_TOPICS: readonly string[] = [
  "Your dashboard",
  "Finding a request and its details",
  "Scheduling a technician",
  "Customers",
  "Estimates and invoices",
  "The setup checklist",
  "Where to get help or replay the tour",
];

/** `m:ss`, e.g. 192 → "3:12". */
export function clockLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Whole minutes for copy, e.g. 192 → "3-minute"; never below 1. */
export function minutesLabel(totalSeconds: number): string {
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  return `${minutes}-minute`;
}

/** Screen-reader length, e.g. 192 → "3 minutes 12 seconds". */
export function spokenDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (seconds > 0 || minutes === 0) parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}
