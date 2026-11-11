/** Empty-state copy for the dispatch day board. */
export const UNASSIGNED_EMPTY_COPY = "Nothing unassigned";
export const EMPTY_LANE_COPY = "No requests";

/** Link text to the calendar's unscheduled rail, or null when there is nothing to link to. */
export function unscheduledLinkLabel(count: number): string | null {
  return count > 0 ? `${count} unscheduled → Calendar` : null;
}

/** Accessible name for that link: the arrow is decoration, not words. */
export function unscheduledLinkAriaLabel(count: number): string {
  return `${count} unscheduled ${count === 1 ? "request" : "requests"}. Open the calendar`;
}
