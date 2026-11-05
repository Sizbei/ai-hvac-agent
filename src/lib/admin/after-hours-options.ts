/** Option lists for the After-hours settings panel (hour and timezone pickers). */

export interface Option {
  readonly value: string;
  readonly label: string;
}

const US_TIMEZONES: readonly Option[] = [
  { value: "America/New_York", label: "Eastern time (New York)" },
  { value: "America/Chicago", label: "Central time (Chicago)" },
  { value: "America/Denver", label: "Mountain time (Denver)" },
  { value: "America/Phoenix", label: "Mountain time, no DST (Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific time (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska time (Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii time (Honolulu)" },
];

/** US zones, plus the stored zone when it isn't one of them (so it stays selectable). */
export function timezoneOptions(current: string): readonly Option[] {
  if (!current || US_TIMEZONES.some((o) => o.value === current)) return US_TIMEZONES;
  return [...US_TIMEZONES, { value: current, label: current.replace(/_/g, " ") }];
}

/** "12 am (midnight)", "1 am" … "12 pm (noon)" … "11 pm" for hours 0–23. */
export function hourLabel(hour: number): string {
  if (hour === 0) return "12 am (midnight)";
  if (hour === 12) return "12 pm (noon)";
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

export const HOUR_OPTIONS: readonly Option[] = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: hourLabel(h),
}));
