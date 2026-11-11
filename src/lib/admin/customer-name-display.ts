/**
 * Display-layer name for a customer. Two stored placeholders never reach the
 * office verbatim; stored data is untouched:
 * - the FieldPulse import's "FieldPulse customer (deleted #id)" (title-cased
 *   by name sanitising) for customers deleted at the source: no real name
 *   survives, so it reads "No name on file" like any nameless customer;
 * - erasure's "[deleted]" sentinel (ERASED_PLACEHOLDER) for a customer whose
 *   data was erased on request.
 */
import { ERASED_PLACEHOLDER } from "@/lib/admin/report-format";

/** The one label for a customer with no name; never "Unknown" or "Unnamed". */
export const NO_CUSTOMER_NAME = "No name on file";

const DELETED_FP_PLACEHOLDER = /^field\s?pulse customer \(deleted #[^)]*\)$/i;

/** What the office reads for a customer whose personal data was erased. */
export const ERASED_CUSTOMER_LABEL = "Erased customer";

/** True for the import's stand-in name of a customer deleted in FieldPulse. */
export function isDeletedFieldpulsePlaceholder(name: string | null | undefined): boolean {
  return typeof name === "string" && DELETED_FP_PLACEHOLDER.test(name.trim());
}

export function displayCustomerName(name: string | null): string | null {
  if (name === null) return name;
  const trimmed = name.trim();
  if (trimmed === ERASED_PLACEHOLDER) return ERASED_CUSTOMER_LABEL;
  if (DELETED_FP_PLACEHOLDER.test(trimmed)) return NO_CUSTOMER_NAME;
  return name;
}

/**
 * THE read-surface label for a customer name: blank reads "No name on file",
 * and both stored placeholders map as in `displayCustomerName`. Every surface
 * that shows a possibly-missing name calls this.
 */
export function customerNameLabel(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) return NO_CUSTOMER_NAME;
  return displayCustomerName(trimmed) ?? NO_CUSTOMER_NAME;
}
