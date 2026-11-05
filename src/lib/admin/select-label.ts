/**
 * Trigger text for a base-ui `<Select>`. `<SelectValue />` renders the raw
 * value (a UUID, "__manual__", "name") unless it is given a formatter, so every
 * money picker routes through this: the matching option's label, or the
 * fallback (placeholder) when nothing matches. Never returns the raw value.
 */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export function selectLabel(
  options: ReadonlyArray<SelectOption>,
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== 'string' || value === '') return fallback;
  return options.find((o) => o.value === value)?.label ?? fallback;
}
