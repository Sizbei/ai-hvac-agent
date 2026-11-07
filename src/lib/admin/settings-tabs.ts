/** Tab ids on /admin/settings, in display order. `?tab=` must be one of these. */
export const SETTINGS_TABS = [
  'branding',
  'services',
  'job-types',
  'forms',
  'tags',
  'business',
  'faqs',
  'embed',
  'limits',
  'after-hours',
  'dispatch',
  'integrations',
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tab named by `?tab=`, or Branding for a missing or unknown value. */
export function resolveSettingsTab(param: string | null): SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(param ?? '')
    ? (param as SettingsTab)
    : 'branding';
}

/** The page's query string with `tab` set, keeping every other param (e.g. from=setup). */
export function settingsTabSearch(currentSearch: string, tab: SettingsTab): string {
  const params = new URLSearchParams(currentSearch);
  params.set('tab', tab);
  return `?${params.toString()}`;
}
