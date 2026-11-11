/**
 * Pure display + triage helpers for the admin conversations inbox.
 *
 * No I/O, no server-only imports: the inbox components and the queries share
 * these, and they are unit-tested in conversation-display.test.ts.
 */
import { humanizeSnake, issueTypeLabel, urgencyLabel } from "@/lib/admin/request-labels";

/**
 * "Needs action" = escalated, and nobody has marked it handled since the
 * customer last wrote. A customer message after the handled time reopens it.
 * Mirrors the SQL in conversation-queries.ts (needsActionSql).
 */
export function needsAction(input: {
  readonly status: string;
  readonly handledAt: string | null;
  readonly lastCustomerMessageAt: string | null;
}): boolean {
  if (input.status !== "escalated") return false;
  if (input.handledAt === null) return true;
  if (input.lastCustomerMessageAt === null) return false;
  return Date.parse(input.lastCustomerMessageAt) > Date.parse(input.handledAt);
}

/** The customer's name the intake captured, if any (metadata.customerName). */
export function customerNameFromMetadata(
  metadata: Record<string, unknown> | null,
): string | null {
  const raw = metadata?.customerName;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

const CHANNEL_TITLES: Record<string, string> = {
  web: "Web chat",
  phone: "Phone call",
  sms: "Text message",
};

/** "Web chat" / "Phone call" / "Text message". */
export function channelTitle(channel: string): string {
  return CHANNEL_TITLES[channel] ?? "Conversation";
}

const SNIPPET_MAX = 24;
const SNIPPET_MIN_WORD_CUT = 10;

/** The first few words of the customer's first message, cut at a word: "my AC is not…". */
export function previewSnippet(preview: string | null | undefined): string | null {
  const text = (preview ?? "").replace(/\s+/g, " ").trim().replace(/…$/, "");
  if (text.length === 0) return null;
  if (text.length <= SNIPPET_MAX) return text;
  const cut = text.slice(0, SNIPPET_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace >= SNIPPET_MIN_WORD_CUT ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s,.;:!?-]+$/, "")}…`;
}

function dayKey(date: Date, timeZone: string | undefined): string {
  return date.toLocaleDateString("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** "2:14 PM" today, "Nov 6, 2:14 PM" this year, else "Nov 6, 2025, 2:14 PM". */
export function conversationTimeLabel(
  iso: string,
  now: Date = new Date(),
  timeZone?: string,
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  if (dayKey(date, timeZone) === dayKey(now, timeZone)) return time;
  const sameYear =
    date.toLocaleDateString("en-US", { timeZone, year: "numeric" }) ===
    now.toLocaleDateString("en-US", { timeZone, year: "numeric" });
  const day = date.toLocaleDateString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
}

export interface ConversationTitleInput {
  readonly customerName: string | null;
  /** The linked request's customer, when the bot captured no name. */
  readonly requestCustomerName?: string | null;
  readonly referenceNumber: string | null;
  readonly id: string;
  readonly channel?: string;
  /** The customer's first message. */
  readonly preview?: string | null;
  /** When the conversation started (ISO); omitted → no time in the title. */
  readonly startedAt?: string;
}

/**
 * Row / header / ⌘K title, by what is known: the captured name, else the linked
 * request's customer, else "Web chat · “my AC is…” · 2:14 PM". The request
 * number and short id are fallbacks only when even the channel is unknown.
 */
export function conversationTitle(
  input: ConversationTitleInput,
  options: { readonly now?: Date; readonly timeZone?: string } = {},
): string {
  if (input.customerName) return input.customerName;
  if (input.requestCustomerName) return input.requestCustomerName;
  if (input.channel) {
    const snippet = previewSnippet(input.preview);
    const time = input.startedAt
      ? conversationTimeLabel(input.startedAt, options.now, options.timeZone)
      : null;
    return [channelTitle(input.channel), snippet ? `\u201c${snippet}\u201d` : null, time]
      .filter((part): part is string => part !== null)
      .join(" \u00b7 ");
  }
  return input.referenceNumber ?? shortConversationId(input.id);
}

/** The 8-character id the inbox shows and ⌘K matches ("7d111fea"). */
export function shortConversationId(id: string): string {
  return id.slice(0, 8);
}

/**
 * A search that is really a phone number ("5125550177", "(512) 555-0177")
 * → its digits, so it can match however the number was stored. Null when the
 * input has letters or fewer than 7 digits.
 */
export function phoneDigitsQuery(search: string): string | null {
  if (!/^[\d\s()+.\-]+$/.test(search)) return null;
  const digits = search.replace(/\D/g, "");
  // "+1 512 555 0177": stored numbers may lack the country code.
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return national.length >= 7 ? national : null;
}

// Sentinel a skipped optional intake step writes (triage.SKIP_SENTINEL); it must
// never be shown to an admin as if it were a real value.
const SKIP_SENTINEL = "__skipped__";

export interface ExtractedField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** tel: / mailto: link when the value is a phone number or email. */
  readonly href?: string;
}

type FieldFormat = "text" | "phone" | "email" | "issue" | "urgency" | "enum";

/**
 * The intake fields an office person cares about, in reading order. Anything
 * else in session metadata is the bot's working state (re-ask counters,
 * empathy flags, frustration score…) and is not shown.
 */
const EXTRACTED_FIELDS: readonly { key: string; label: string; format: FieldFormat }[] = [
  { key: "customerName", label: "Name", format: "text" },
  { key: "customerPhone", label: "Phone", format: "phone" },
  { key: "customerEmail", label: "Email", format: "email" },
  { key: "address", label: "Address", format: "text" },
  { key: "issueType", label: "Issue", format: "issue" },
  { key: "urgency", label: "Urgency", format: "urgency" },
  { key: "systemDownStatus", label: "System", format: "enum" },
  { key: "problemDuration", label: "How long", format: "text" },
  { key: "description", label: "Description", format: "text" },
];

const ENUM_SHAPE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

function formatField(format: FieldFormat, value: string): { value: string; href?: string } {
  switch (format) {
    case "phone": {
      const digits = value.replace(/[^\d+]/g, "");
      return digits.replace(/\D/g, "").length >= 7 ? { value, href: `tel:${digits}` } : { value };
    }
    case "email":
      return value.includes("@") ? { value, href: `mailto:${value}` } : { value };
    case "issue":
      return { value: issueTypeLabel(value) };
    case "urgency":
      return { value: urgencyLabel(value) };
    case "enum":
      return { value: ENUM_SHAPE.test(value) ? humanizeSnake(value) : value };
    case "text":
      // Free text, but the bot sometimes stores an enum here
      // (problemDuration: "a_few_days" / "partially_working").
      return { value: ENUM_SHAPE.test(value) && value.includes("_") ? humanizeSnake(value) : value };
  }
}

/** Office-readable rows for the "Extracted data" card. */
export function extractedFields(
  metadata: Record<string, unknown> | null,
): readonly ExtractedField[] {
  if (!metadata) return [];
  const rows: ExtractedField[] = [];
  for (const field of EXTRACTED_FIELDS) {
    const raw = metadata[field.key];
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const text = String(raw).trim();
    if (text.length === 0 || text === SKIP_SENTINEL) continue;
    rows.push({ key: field.key, label: field.label, ...formatField(field.format, text) });
  }
  return rows;
}

export type MessageAuthor = "customer" | "ai" | "staff" | "system";

/** How close (ms) a reply's audit row must follow its stored message. */
const STAFF_MATCH_WINDOW_MS = 60_000;

/**
 * Staff replies are stored as role "assistant" (same as the AI). Each one is
 * followed within milliseconds by a `conversation_reply_sent` audit row, so an
 * assistant message is a staff reply when such a row lands within a minute
 * after it. Each audit row claims at most one message (the latest one before it).
 */
export function messageAuthors(
  messages: readonly { readonly role: "user" | "assistant" | "system"; readonly createdAt: string }[],
  staffReplyAuditTimes: readonly string[],
): MessageAuthor[] {
  const authors: MessageAuthor[] = messages.map((m) =>
    m.role === "user" ? "customer" : m.role === "system" ? "system" : "ai",
  );
  for (const auditIso of staffReplyAuditTimes) {
    const auditAt = Date.parse(auditIso);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (authors[i] !== "ai") continue;
      const at = Date.parse(messages[i].createdAt);
      if (at <= auditAt && auditAt - at <= STAFF_MATCH_WINDOW_MS) {
        authors[i] = "staff";
        break;
      }
    }
  }
  return authors;
}

/** Bubble caption for a message author. */
export function authorLabel(author: MessageAuthor): string {
  switch (author) {
    case "customer":
      return "Customer";
    case "staff":
      return "Office";
    case "ai":
      return "AI assistant";
    case "system":
      return "System";
  }
}

/** The inbox with its "Needs action" filter on (conversation-inbox.tsx URL state `action=1`). */
export const NEEDS_ACTION_INBOX_HREF = "/admin/conversations?action=1";
