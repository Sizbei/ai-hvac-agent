import type { BusinessInfo } from './org-config-types';

/** The text fields the Business info panel edits. */
export const BUSINESS_INFO_TEXT_FIELDS = [
  'serviceArea',
  'businessHours',
  'phone',
  'email',
  'licensedInsured',
  'paymentMethods',
  'website',
] as const;

type TextField = (typeof BUSINESS_INFO_TEXT_FIELDS)[number];

export type BusinessInfoDraft = Readonly<Record<TextField, string>> & {
  readonly financingAvailable: boolean;
};

/**
 * Build the businessInfo object to PATCH. The settings PATCH replaces the
 * whole object, so start from what is stored: keys the panel doesn't edit
 * survive the save. Edited text fields are trimmed; an emptied field is
 * removed rather than stored as "".
 */
export function mergeBusinessInfo(
  stored: BusinessInfo,
  draft: BusinessInfoDraft,
): BusinessInfo {
  const next: Record<string, unknown> = {
    ...stored,
    financingAvailable: draft.financingAvailable,
  };
  for (const key of BUSINESS_INFO_TEXT_FIELDS) {
    const value = draft[key].trim();
    if (value) next[key] = value;
    else delete next[key];
  }
  return next as BusinessInfo;
}
