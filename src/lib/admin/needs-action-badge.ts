/**
 * Nav badge for conversations that need action (escalated and not handled
 * since the customer last wrote — the inbox's "Needs action" filter). Same
 * visible/label/srLabel shape and cap as the unscheduled-jobs badge.
 */
import { UNSCHEDULED_BADGE_CAP, type UnscheduledBadge } from "./unscheduled-badge";

export function needsActionBadge(count: number): UnscheduledBadge {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (safe === 0) return { visible: false, label: "", srLabel: "" };
  const label = safe > UNSCHEDULED_BADGE_CAP ? `${UNSCHEDULED_BADGE_CAP}+` : String(safe);
  const noun = safe === 1 ? "conversation needs action" : "conversations need action";
  return { visible: true, label, srLabel: `${safe} ${noun}` };
}
