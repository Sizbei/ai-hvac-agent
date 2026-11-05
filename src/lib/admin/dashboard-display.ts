/**
 * Pure display helpers for the dashboard lists (no I/O).
 */
import type { ConversationSummary } from "./conversation-types";
import { ERASED_PLACEHOLDER } from "./report-format";

/** A request's customer as the office should read it. */
export function customerDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) return "No name on file";
  if (trimmed === ERASED_PLACEHOLDER) return "Erased customer";
  return trimmed;
}

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
