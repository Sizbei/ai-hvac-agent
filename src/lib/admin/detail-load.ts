/**
 * Why a detail page (invoice, estimate) has nothing to show. A 404 (or a
 * malformed id, 400) means the record really isn't there; anything else — a
 * 5xx, a dropped connection (status null) — is a failed load the office can
 * retry. Only the first may say "may have been removed".
 */
export type DetailLoadFailure = "not_found" | "failed";

export function detailLoadFailure(status: number | null): DetailLoadFailure {
  return status === 404 || status === 400 ? "not_found" : "failed";
}

/** Drawer copy for a request that failed to load; only `failed` offers a retry. */
export const REQUEST_DETAIL_COPY: Record<DetailLoadFailure, string> = {
  not_found: "This request no longer exists or isn’t in your organization.",
  failed: "Couldn’t load this request.",
};
