/**
 * Office-facing labels for service-request issue types, and the top-N grouping
 * the insights chart uses. Pure; safe on client and server.
 */
import { ISSUE_TYPE_LABELS } from "./create-request";

const KNOWN = ISSUE_TYPE_LABELS as Readonly<Record<string, string>>;

export function isKnownIssueType(raw: string): boolean {
  return Object.hasOwn(KNOWN, raw);
}

/** Sentence case for a raw enum value: "water_leak" → "Water leak". */
export function humanizeCode(raw: string): string {
  const text = raw.replace(/_/g, " ").trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/** The label for an issue type; unknown values are humanized, never shown raw. */
export function issueTypeLabel(raw: string): string {
  return isKnownIssueType(raw) ? KNOWN[raw]! : humanizeCode(raw);
}

export interface IssueTypeBar {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export const ISSUE_CHART_TOP_N = 8;

/**
 * Known issue types, largest first, capped at `topN`; everything else (smaller
 * known types, and imported free-text job titles that are not issue types at
 * all) is summed into one "Other" bar. `importedTitles` counts the requests
 * whose issue type was free text, for the caption.
 */
export function groupIssueTypes(
  rows: readonly { readonly key: string; readonly count: number }[],
  topN: number = ISSUE_CHART_TOP_N,
): { bars: IssueTypeBar[]; importedTitles: number } {
  let other = 0;
  let importedTitles = 0;
  const known: IssueTypeBar[] = [];
  for (const r of rows) {
    if (r.key === "other") other += r.count;
    else if (isKnownIssueType(r.key)) known.push({ key: r.key, label: issueTypeLabel(r.key), count: r.count });
    else {
      other += r.count;
      importedTitles += r.count;
    }
  }
  const sorted = [...known].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, topN);
  other += sorted.slice(topN).reduce((sum, r) => sum + r.count, 0);
  const bars = other > 0 ? [...top, { key: "other", label: "Other", count: other }] : top;
  return { bars, importedTitles };
}
