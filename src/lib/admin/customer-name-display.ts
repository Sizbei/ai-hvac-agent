/**
 * Display-layer name for a customer. The FieldPulse import stores a placeholder
 * ("FieldPulse customer (deleted #id)", title-cased by name sanitising) for
 * customers deleted at the source; the office sees plain words instead. Stored
 * data is untouched.
 */
const DELETED_FP_PLACEHOLDER = /^field\s?pulse customer \(deleted #[^)]*\)$/i;

export function displayCustomerName(name: string | null): string | null {
  if (name !== null && DELETED_FP_PLACEHOLDER.test(name.trim())) {
    return "Deleted FieldPulse customer";
  }
  return name;
}
