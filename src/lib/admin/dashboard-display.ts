/**
 * Pure display helpers for the dashboard lists (no I/O).
 */
import type { ConversationSummary } from "./conversation-types";
import { ERASED_PLACEHOLDER } from "./report-format";
import { customerNameLabel } from "./customer-name-display";

/** A request's customer as the office should read it (the shared label). */
export const customerDisplayName = customerNameLabel;

/**
 * The dashboard's recent conversations: real ones only. A chat widget that was
 * opened but never written in has no messages and would push real
 * conversations off the card.
 */
export function recentConversations(
  rows: readonly ConversationSummary[],
  limit: number,
): ConversationSummary[] {
  return rows.filter((c) => c.messageCount > 0 || c.hasServiceRequest).slice(0, limit);
}

/** Title for a conversation row: the customer, else the reference, else the channel (never a hash). */
export function conversationTitle(c: Pick<ConversationSummary, "customerName" | "referenceNumber" | "channel">): string {
  const name = c.customerName?.trim();
  if (name && name !== ERASED_PLACEHOLDER) return name;
  if (c.referenceNumber) return c.referenceNumber;
  return c.channel === "phone" ? "Phone call" : c.channel === "sms" ? "Text conversation" : "Web chat";
}

export type DashboardSectionState = "loading" | "error" | "ready";

/**
 * What a dashboard section may show. A failed load with nothing loaded yet is
 * an ERROR, never the empty state: "All clear · no unassigned urgent requests"
 * over a failed fetch tells a dispatcher there is nothing urgent. Once data has
 * loaded, a failed poll keeps showing it (the page banner says it's stale).
 */
export function dashboardSectionState(input: {
  readonly isLoading: boolean;
  readonly hasData: boolean;
  readonly failed: boolean;
}): DashboardSectionState {
  if (input.hasData) return "ready";
  if (input.isLoading) return "loading";
  return input.failed ? "error" : "ready";
}

/** "1 conversation needs action" / "7 conversations need action". */
export function needsActionLabel(count: number): string {
  return count === 1 ? "1 conversation needs action" : `${count} conversations need action`;
}

/**
 * Today's date as the business sees it ("Friday, November 6"), so the header
 * matches "Today's schedule", which uses the business day — not the viewer's
 * clock (a viewer in Tokyo saw tomorrow's date over today's jobs).
 */
export function businessDateLabel(now: Date, timeZone: string): string {
  return now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  });
}
