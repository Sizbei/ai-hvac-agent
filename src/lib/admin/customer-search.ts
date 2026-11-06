/**
 * Pure helpers for the customers-list search.
 *
 * Contact columns are encrypted, so the list search decrypts and filters in
 * Node. Two problems that used to make it fail an office manager on the phone:
 *
 * 1. Phone numbers are stored formatted ("(423) 555-0187"), and a plain
 *    substring match missed "423-555-0187" or "4235550187". Phone-shaped
 *    queries are now compared on digits only, on both sides.
 * 2. Every keystroke re-downloaded the whole org's ciphertext (~800 KB at
 *    2.6k customers, 2–5 s from a slow link). The scan is now cached per
 *    instance and revalidated with a one-row fingerprint query, so a repeat
 *    search only pays a round trip. See {@link CustomerScanCache}.
 */

export interface SearchableCustomer {
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
}

/** Characters a person types when reading out a phone number. */
const PHONE_SHAPED = /^[\d\s().+-]+$/;
/** Fewer digits than this is too loose to match on digits alone. */
const MIN_PHONE_DIGITS = 3;

/** Digits a phone-shaped query should match, or null for a non-phone query. */
export function phoneQueryDigits(query: string): string | null {
  const trimmed = query.trim();
  if (!PHONE_SHAPED.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= MIN_PHONE_DIGITS ? digits : null;
}

function phoneMatchesDigits(phone: string | null, digits: string): boolean {
  if (!phone) return false;
  const stored = phone.replace(/\D/g, "");
  if (stored.includes(digits)) return true;
  // "1 423 555 0187" typed against a number stored without the country code.
  return digits.length === 11 && digits.startsWith("1") && stored.includes(digits.slice(1));
}

/** Does this customer match the search box text? Case-insensitive. */
export function customerMatchesSearch(customer: SearchableCustomer, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (
    customer.name?.toLowerCase().includes(q) ||
    customer.email?.toLowerCase().includes(q) ||
    customer.phone?.toLowerCase().includes(q) ||
    customer.address?.toLowerCase().includes(q)
  ) {
    return true;
  }
  const digits = phoneQueryDigits(q);
  return digits !== null && phoneMatchesDigits(customer.phone, digits);
}

/** How long a cached scan may be reused at all, even with a matching fingerprint. */
export const SCAN_CACHE_TTL_MS = 5 * 60 * 1000;
/** Most scans kept per instance (one per org + filter combination). */
export const SCAN_CACHE_MAX_ENTRIES = 24;

/**
 * Cache key for one org's scan with a given filter combination. JSON keeps two
 * keys from colliding, and every key for an org starts with
 * {@link customerScanKeyOrgPrefix}.
 */
export function customerScanKey(organizationId: string, ...filters: readonly unknown[]): string {
  return JSON.stringify([organizationId, ...filters]);
}

/** The prefix shared by every {@link customerScanKey} of one org. */
export function customerScanKeyOrgPrefix(organizationId: string): string {
  return `[${JSON.stringify(organizationId)},`;
}

interface CacheEntry<T> {
  readonly fingerprint: string;
  readonly storedAt: number;
  readonly rows: readonly T[];
}

/**
 * Small per-instance cache of the search scan (ciphertext rows, never
 * plaintext). An entry is served only when the caller's fresh fingerprint of
 * the same filtered set matches the one stored with it, so any insert, delete,
 * archive or contact edit invalidates it on the next search.
 *
 * Expired entries are swept on every get and set, and an org's entries are
 * dropped outright when one of its customers is erased or deleted, so an
 * erased person's ciphertext does not linger in instance memory.
 */
export class CustomerScanCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number = SCAN_CACHE_TTL_MS,
    private readonly maxEntries: number = SCAN_CACHE_MAX_ENTRIES,
  ) {}

  get(key: string, fingerprint: string, now: number = Date.now()): readonly T[] | null {
    this.sweepExpired(now);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint) {
      this.entries.delete(key);
      return null;
    }
    // Refresh recency: Map iteration order is insertion order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.rows;
  }

  set(key: string, fingerprint: string, rows: readonly T[], now: number = Date.now()): void {
    this.sweepExpired(now);
    this.entries.delete(key);
    this.entries.set(key, { fingerprint, storedAt: now, rows });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drops every entry whose key starts with `prefix`. */
  deleteByPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.storedAt > this.ttlMs) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
