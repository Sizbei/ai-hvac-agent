/**
 * Pure state and copy for the technician job page's failure paths.
 * No React, no fetch — safe for client code and plain vitest.
 */

export type JobLoadOutcome = "ok" | "not_found" | "error";

/** The summary GET's result: 404 (not this tech's job) and 400 (bad id) both mean not found. */
export function jobLoadOutcome(status: number | null, success: boolean): JobLoadOutcome {
  if (status !== null && status >= 200 && status < 300 && success) return "ok";
  if (status === 404 || status === 400) return "not_found";
  return "error";
}

export const JOB_NOT_FOUND = "This job isn't yours, or it no longer exists.";
export const JOB_NOT_FOUND_BACK = "Back to my jobs";

/** Any failed photo upload (server text is never shown). */
export const PHOTO_UPLOAD_FAILED = "Couldn't upload that photo. Try again.";
