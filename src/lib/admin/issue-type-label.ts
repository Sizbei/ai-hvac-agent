/**
 * Office-facing labels for service-request issue types, and the top-N grouping
 * the insights chart uses. Pure; safe on client and server.
 */
import { ISSUE_TYPE_LABELS } from "./create-request";
import { codeOrTextLabel, issueTypeLabel as sharedIssueTypeLabel } from "./request-labels";

const KNOWN = ISSUE_TYPE_LABELS as Readonly<Record<string, string>>;

export function isKnownIssueType(raw: string): boolean {
  return Object.hasOwn(KNOWN, raw);
}

/** "water_leak" → "Water leak"; free text as typed (the shared rule in
 * request-labels). */
export function humanizeCode(raw: string): string {
  return codeOrTextLabel(raw);
}

/** The label for an issue type: known codes use the office wording, other
 * codes are humanized, and an imported free-text job title shows as typed. */
export function issueTypeLabel(raw: string | null | undefined): string {
  return sharedIssueTypeLabel(raw);
}

export interface IssueTypeBar {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export const ISSUE_CHART_TOP_N = 8;

/**
 * Known issue types, largest first, capped at `topN`; smaller known types and
 * "other" are summed into one "Other" bar. Imported free-text job titles are
 * not issue types at all and get NO bar: folded into Other they made one
 * 209-request bar that dwarfed every real one (7, 6, 5…). `importedTitles`
 * counts them for the caption.
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
    else importedTitles += r.count;
  }
  const sorted = [...known].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, topN);
  other += sorted.slice(topN).reduce((sum, r) => sum + r.count, 0);
  const bars = other > 0 ? [...top, { key: "other", label: "Other", count: other }] : top;
  return { bars, importedTitles };
}
