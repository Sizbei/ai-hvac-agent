/**
 * Request statuses the field-sale writes accept (M3c spec §5–§6). No imports:
 * shared by the SQL builders, the route preambles, the tech GETs and client
 * components.
 */
export const SELL_STATUSES = ["arrived", "in_progress", "on_hold"] as const;
export const BILL_STATUSES = ["arrived", "in_progress", "on_hold", "completed"] as const;
export const CLOSED_STATUSES = ["completed", "cancelled"] as const;

export type StatusGate = "ok" | "not_on_site" | "job_closed";

/** ok when allowed; a closed status that is not allowed → job_closed; anything else → not_on_site. */
export function statusGate(status: string, allowed: readonly string[]): StatusGate {
  if (allowed.includes(status)) return "ok";
  return (CLOSED_STATUSES as readonly string[]).includes(status) ? "job_closed" : "not_on_site";
}
