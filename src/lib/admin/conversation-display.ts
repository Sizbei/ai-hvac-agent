/**
 * Pure display + triage helpers for the admin conversations inbox.
 *
 * No I/O, no server-only imports: the inbox components and the queries share
 * these, and they are unit-tested in conversation-display.test.ts.
 */
import { humanizeCode, issueTypeLabel, urgencyLabel } from "@/lib/admin/request-labels";

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

/** Row / header title: the customer's name, else the request number, else a short id. */
export function conversationTitle(input: {
  readonly customerName: string | null;
  readonly referenceNumber: string | null;
  readonly id: string;
}): string {
  return input.customerName ?? input.referenceNumber ?? input.id.slice(0, 8);
}

/**
 * A search that is really a phone number ("5125550177", "(512) 555-0177")
 * → its digits, so it can match however the number was stored. Null when the
 * input has letters or fewer than 7 digits.
 */
export function phoneDigitsQuery(search: string): string | null {
  if (!/^[\d\s()+.\-]+$/.test(search)) return null;
  const digits = search.replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
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
      return { value: ENUM_SHAPE.test(value) ? humanizeCode(value) : value };
    case "text":
      // Free text, but the bot sometimes stores an enum here
      // (problemDuration: "a_few_days" / "partially_working").
      return { value: ENUM_SHAPE.test(value) && value.includes("_") ? humanizeCode(value) : value };
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
