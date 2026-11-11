/**
 * Display formatting for contact details (phone numbers, postal addresses).
 * Imported FieldPulse rows carry "+1 (423) 555-0187", "4235550187",
 * "900 Larkspur St, Maple Hollow, TN, 37601" and "254 Quarry Rd, Fernbrook, TN,
 * Fernbrook, TN 37690"; these helpers show them the way a person would write
 * them. Display only: stored values, tel: links and search are untouched.
 * Pure — safe for client components and plain vitest.
 */
import { ERASED_ADDRESS_LABEL, ERASED_PLACEHOLDER } from './report-format';

const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

const STATE_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'district of columbia', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota',
  'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
]);

const ZIP = /^\d{5}(?:-\d{4})?$/;

/**
 * A US number as "(423) 555-0187" (a leading country code 1 is dropped and an
 * extension is kept as " ext. 12"). Anything that isn't a 10-digit US number —
 * short legacy numbers, other countries — comes back trimmed and unchanged.
 */
export function formatPhoneDisplay(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  if (text.startsWith('+') && !/^\+\s*1\b|^\+1/.test(text)) return text;
  const ext = /(?:\s*(?:ext\.?|extension|x)\s*(\d{1,6}))$/i.exec(text);
  const main = ext ? text.slice(0, ext.index) : text;
  let digits = main.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return text;
  const formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return ext ? `${formatted} ext. ${ext[1]}` : formatted;
}

/** "TN", "Tn.", "TN 37601", "Tennessee 37601" → normalized; null when the
 * segment isn't a state (with or without a ZIP). */
function normalizeStateSegment(segment: string): string | null {
  const m = /^(.*?)(?:\s+(\d{5}(?:-\d{4})?))?$/.exec(segment);
  if (!m) return null;
  const head = (m[1] ?? '').replace(/\.$/, '').trim();
  const zip = m[2];
  const code = head.toUpperCase();
  if (head.length === 2 && STATE_CODES.has(code)) return zip ? `${code} ${zip}` : code;
  if (STATE_NAMES.has(head.toLowerCase())) return zip ? `${head} ${zip}` : head;
  return null;
}

function isStateOrZip(segment: string): boolean {
  return ZIP.test(segment) || normalizeStateSegment(segment) !== null;
}

/** Address segments after tidying (see `formatAddressDisplay`). */
function tidySegments(raw: string): string[] {
  const parts = raw
    .split(/[,\n]/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // The state may only sit in the last two segments ("…, TN" or "…, TN, 37601");
  // normalizing elsewhere would turn a street called "Co" into "CO".
  const normalized = parts.map((p, i) =>
    i >= parts.length - 3 ? (normalizeStateSegment(p) ?? p) : p,
  );

  // "TN, 37601" → "TN 37601".
  const merged: string[] = [];
  for (const p of normalized) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && ZIP.test(p) && normalizeStateSegment(prev) !== null && !/\d/.test(prev)) {
      merged[merged.length - 1] = `${prev} ${p}`;
    } else {
      merged.push(p);
    }
  }

  // Drop a segment repeated later on ("Fernbrook, TN, Fernbrook, TN 37690").
  const lower = merged.map((p) => p.toLowerCase());
  return merged.filter((p, i) => {
    const later = lower.slice(i + 1);
    if (later.includes(lower[i]!)) return false;
    // A bare state code followed later by "TN 37690". Codes only: "New York"
    // is both a city and a state, and the city must stay.
    if (p.length === 2 && STATE_CODES.has(p)) {
      return !later.some((l) => l.startsWith(`${lower[i]} `));
    }
    return true;
  });
}

/**
 * An address as one tidy line: empty segments dropped ("Birchvale, , Birchvale"),
 * a repeated city/state pair collapsed, "TN, 37601" joined to "TN 37601" and a
 * state code upper-cased ("Tn." → "TN"). Null when there is nothing to show.
 */
export function formatAddressDisplay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.trim() === ERASED_PLACEHOLDER) return ERASED_ADDRESS_LABEL;
  const segments = tidySegments(raw);
  return segments.length > 0 ? segments.join(', ') : null;
}

/**
 * The city of a "street, city, ST zip" address, or null when the address
 * doesn't end in a state or ZIP ("Larkin Health Care, 1633 Fernhill Dr")
 * or the segment before it is a street, not a city.
 */
export function addressCity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const segments = tidySegments(raw);
  if (segments.length < 2) return null;
  if (!isStateOrZip(segments[segments.length - 1]!)) return null;
  const city = segments[segments.length - 2]!;
  if (/\d/.test(city) || /^p\.?\s?o\.?\s+box/i.test(city)) return null;
  return city;
}
