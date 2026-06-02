/**
 * Origin allowlist matching for the embeddable widget. An org lists the origins
 * allowed to embed its widget; the public endpoints check the request Origin
 * against that list and reflect CORS only for a match.
 *
 * Supported entry forms (case-insensitive on host):
 *   - "https://acme.com"      exact origin (scheme + host [+ port])
 *   - "acme.com"              bare host → matches http/https on that host
 *   - "*.acme.com"            wildcard subdomain (one or more labels), NOT the
 *                             apex unless also listed
 */

/** Normalize an origin/host string for comparison: trim, lowercase, drop a
 * trailing slash. Returns null for empty input. */
function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/\/+$/, "");
  return v.length > 0 ? v : null;
}

/** Extract the host (no scheme, no port) from an origin or bare host. */
function hostOf(originOrHost: string): string {
  // Strip scheme.
  const noScheme = originOrHost.replace(/^[a-z]+:\/\//, "");
  // Strip port and any path.
  return noScheme.split("/")[0].split(":")[0];
}

/**
 * Does `origin` (a request Origin header value) match `entry` (an allowlist
 * entry)? Both are cleaned first.
 */
export function originMatchesEntry(origin: string, entry: string): boolean {
  const o = clean(origin);
  const e = clean(entry);
  if (!o || !e) return false;

  // Exact origin match (scheme included).
  if (o === e) return true;

  const oHost = hostOf(o);

  // Wildcard subdomain: "*.acme.com" matches "foo.acme.com", "a.b.acme.com",
  // but not "acme.com" itself.
  if (e.startsWith("*.")) {
    const base = e.slice(2);
    return oHost !== base && oHost.endsWith(`.${base}`);
  }

  // Bare host entry ("acme.com") matches the same host on any scheme/port.
  const eHost = hostOf(e);
  // Only treat as a bare-host entry when the entry had no scheme.
  if (!/^[a-z]+:\/\//.test(e)) {
    return oHost === eHost;
  }

  return false;
}

/** Is `origin` allowed by ANY entry in the list? An EMPTY list means the org
 * hasn't configured an allowlist yet — callers decide whether that's open
 * (publishable-key-only) or closed. */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): boolean {
  const o = clean(origin);
  if (!o) return false;
  return allowedOrigins.some((entry) => originMatchesEntry(o, entry));
}
