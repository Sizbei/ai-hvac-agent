/**
 * Pure seat-limit rules shared by invites, direct staff creation and the
 * Staff page notice. A seat is an active user; the limit is the plan's
 * maxStaff (src/lib/billing/plans.ts).
 */
export interface SeatUsage {
  readonly used: number;
  readonly limit: number;
}

/** True when one more active user would exceed the plan. */
export function seatsFull(usage: SeatUsage): boolean {
  return usage.used >= usage.limit;
}

/** "You've used 3 of 5 seats." */
export function seatUsageCopy(usage: SeatUsage): string {
  const noun = usage.limit === 1 ? 'seat' : 'seats';
  return `You've used ${usage.used} of ${usage.limit} ${noun}.`;
}

/** Shown before the form when the plan is full. */
export const SEAT_LIMIT_COPY =
  "Your plan has no free seats, so you can't add or invite anyone right now. Deactivate someone or upgrade the plan to add more.";
