/**
 * Switch-aware review copy (P8 M9). When an org's `reviewRequests` switch is
 * off, no review texts go out, so /admin/reviews and the Review request
 * template card must not promise them. The switch reaches the client as
 * `data.reviewTextsOn` on the reviews and templates GET envelopes; the reviews
 * GET adds `data.historyContact` (who can turn them on) when the switch is off.
 * The UI calls them "review texts" everywhere.
 */
import { HISTORY_CONTACT_FALLBACK } from "./admin-guide-state";

export const REVIEW_TEXTS_OFF = "Review texts are off for this account.";

const REVIEWS_SENT_AUTOMATICALLY =
  "Review texts are sent automatically when a request is completed.";

const REVIEWS_SUBTITLE_ON =
  "Review texts sent after completed requests, average rating and response rate.";

const REVIEW_TRIGGER = "review_request";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `data.reviewTextsOn` from a success envelope; true unless it is exactly false. */
export function reviewTextsOnFrom(json: unknown): boolean {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return true;
  return json.data.reviewTextsOn !== false;
}

/** `data.historyContact` from a success envelope, else null. */
export function historyContactFrom(json: unknown): string | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  return typeof json.data.historyContact === "string" ? json.data.historyContact : null;
}

/** The reviews page subtitle: what the page shows, or that texts are off and who can turn them on. */
export function reviewsSubtitle(reviewTextsOn: boolean, historyContact: string | null): string {
  if (reviewTextsOn) return REVIEWS_SUBTITLE_ON;
  return `${REVIEW_TEXTS_OFF} Ask ${historyContact ?? HISTORY_CONTACT_FALLBACK} to turn them on.`;
}

/** The reviews page empty-state description. */
export function reviewsEmptyDescription(reviewTextsOn: boolean): string {
  return reviewTextsOn ? REVIEWS_SENT_AUTOMATICALLY : REVIEW_TEXTS_OFF;
}

/** The template card badge: a review-request template is never "Active" while the switch is off. */
export function templateStatus(
  template: { readonly triggerType: string; readonly isActive: boolean },
  reviewTextsOn: boolean,
): { readonly label: "Active" | "Inactive" | "Off for this account"; readonly active: boolean } {
  if (template.triggerType === REVIEW_TRIGGER && !reviewTextsOn) {
    return { label: "Off for this account", active: false };
  }
  return template.isActive ? { label: "Active", active: true } : { label: "Inactive", active: false };
}
