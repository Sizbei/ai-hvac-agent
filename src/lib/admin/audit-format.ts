/**
 * Sentence-case label for an audit action/entity key: "invoice.reminder_sent"
 * → "Invoice reminder sent". Splits on underscores, dots and spaces.
 */
export function humanizeAuditKey(value: string): string {
  const words = value.split(/[._\s]+/).filter(Boolean);
  if (words.length === 0) return value;
  return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}
