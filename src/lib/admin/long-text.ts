/**
 * Display helpers for long free text (request descriptions, mostly imported
 * FieldPulse job notes that run to thousands of characters). Pure; safe in
 * client components and plain vitest.
 */

/**
 * FieldPulse joins a job's fields with " | " ("PM ESTIMATE | Upon arrival…").
 * Show each part as its own paragraph, drop blank-line runs and trailing
 * spaces, so a wall of text reads as notes.
 */
export function readableDescription(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\|[ \t]+/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Characters shown before "Show more" on a long description. */
export const DESCRIPTION_PREVIEW_CHARS = 600;

export interface TextPreview {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * The first `max` characters, cut at the last whitespace so no word is split,
 * with "…" appended. Text within the limit comes back whole.
 */
export function previewText(text: string, max: number = DESCRIPTION_PREVIEW_CHARS): TextPreview {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  const head = chars.slice(0, max).join("");
  const cut = head.search(/\s\S*$/u);
  const body = (cut > max * 0.6 ? head.slice(0, cut) : head).trimEnd();
  return { text: `${body}…`, truncated: true };
}
