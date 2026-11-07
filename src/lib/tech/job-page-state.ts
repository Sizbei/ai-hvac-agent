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

/** A failed upload (server text is never shown); the card offers Try again and Discard (M3d spec §7.7). */
export const PHOTO_UPLOAD_FAILED = "Couldn't upload that photo.";
export const FILE_UPLOAD_FAILED = "Couldn't upload that file.";
export const UPLOAD_CUSTOMER_REMOVED = "This job's customer was removed.";

/** Image rows render as thumbnails; anything else (PDFs) as a file tile. */
export const isImageMime = (mime: string): boolean => mime.startsWith("image/");
