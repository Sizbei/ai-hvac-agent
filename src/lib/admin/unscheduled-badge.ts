/**
 * Unscheduled-jobs notification badge logic.
 *
 * The admin nav surfaces a count of jobs that still need to be PLACED on the
 * calendar (no technician and/or no arrival window) — mirroring how the overview
 * dashboard badges attention items. The display rules live here as a pure
 * function so they unit-test in the node env without rendering React: a zero
 * count hides the badge, and counts above a cap render as "N+" so a flood of
 * unplaced jobs doesn't blow out the nav width.
 */
import { DASHBOARD_LIST_LIMIT } from "./types";

/** Above this many unscheduled jobs, the badge shows "N+" instead of an exact
 * count. Reuses the dashboard list cap so the "+" affordance is consistent with
 * the rest of the admin surface. */
export const UNSCHEDULED_BADGE_CAP = DASHBOARD_LIST_LIMIT;

export interface UnscheduledBadge {
  /** Whether the badge should render at all (false when there is nothing to place). */
  readonly visible: boolean;
  /** The text to render inside the badge, e.g. "3" or "50+". Empty when hidden. */
  readonly label: string;
  /** Accessible label, e.g. "3 unscheduled jobs". Empty when hidden. */
  readonly srLabel: string;
}

/**
 * Resolve the badge state for a given unscheduled-job count. Negative or
 * non-finite inputs are treated as zero (defensive: the count comes from an API
 * payload, an untrusted boundary).
 */
export function unscheduledBadge(count: number): UnscheduledBadge {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (safe === 0) {
    return { visible: false, label: "", srLabel: "" };
  }
  const capped = safe > UNSCHEDULED_BADGE_CAP;
  const label = capped ? `${UNSCHEDULED_BADGE_CAP}+` : String(safe);
  const noun = safe === 1 ? "unscheduled job" : "unscheduled jobs";
  return { visible: true, label, srLabel: `${safe} ${noun}` };
}
