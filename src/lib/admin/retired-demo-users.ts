import { isRetiredDemoEmail } from "@/lib/auth/retired-demo";
import type { Visibility } from "./visibility";

/**
 * The retired demo logins (`@demo-hvac.com`) still exist as rows, but an org
 * viewer never sees them in staff lists, technician pickers, suggestions or
 * scorecards. The platform owner (not previewing) still does. Pure.
 */
export function withoutRetiredDemoUsers<T extends { readonly email: string | null }>(
  rows: readonly T[],
  vis: Visibility,
): T[] {
  return vis.showHidden ? [...rows] : rows.filter((row) => !isRetiredDemoEmail(row.email));
}
