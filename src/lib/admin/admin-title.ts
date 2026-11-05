/**
 * Browser-tab title for an admin page: "Requests · Ridgeline Mechanical".
 * Falls back to the product name when the org name isn't known. Pure.
 */
export const ADMIN_TITLE_FALLBACK = "Service console";

export function adminPageTitle(page: string, orgName?: string | null): string {
  const brand = orgName?.trim() || ADMIN_TITLE_FALLBACK;
  const label = page.trim();
  return label ? `${label} · ${brand}` : brand;
}
