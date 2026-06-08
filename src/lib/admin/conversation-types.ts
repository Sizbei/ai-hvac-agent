/**
 * Admin conversation API request/response types.
 *
 * Conversations are stored in `customer_sessions` + `messages`. Many sessions
 * never become a service request, so these types model conversations directly
 * from sessions/messages, independent of whether a service request exists.
 *
 * All interfaces use readonly properties for immutability.
 */

export type ConversationChannel = "web" | "phone";

export interface ConversationSummary {
  readonly id: string; // session id
  readonly status: string; // session_status enum value
  readonly channel: ConversationChannel; // medium: web widget vs phone call
  readonly turnCount: number;
  readonly messageCount: number;
  readonly tokensUsed: number;
  readonly preview: string | null; // first user message, trimmed to ~120 chars
  readonly hasServiceRequest: boolean;
  readonly referenceNumber: string | null;
  readonly createdAt: string; // ISO
  readonly updatedAt: string; // ISO
  readonly lastMessageAt: string | null; // ISO of most recent message, or null
}

export interface ConversationMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly tokensUsed: number | null;
  readonly createdAt: string; // ISO
}

export interface ConversationDetail {
  readonly id: string;
  readonly status: string;
  readonly channel: ConversationChannel;
  readonly turnCount: number;
  readonly tokensUsed: number;
  readonly tokenBudget: number;
  // Rolling summary of turns that aged out of the model's window (long
  // conversations). null when the conversation never grew past the window.
  readonly runningSummary: string | null;
  // parsed from customerSessions.metadata JSON; null if absent/unparseable
  readonly metadata: Record<string, unknown> | null;
  readonly referenceNumber: string | null;
  readonly hasServiceRequest: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ConversationMessage[];
}

export interface ConversationFilters {
  readonly status?: string; // optional session_status filter
  readonly channel?: string; // optional session_channel filter ("web" | "phone")
  // optional: case-insensitive substring match against message content OR session id
  readonly search?: string;
  readonly page?: number;
  readonly limit?: number;
}
