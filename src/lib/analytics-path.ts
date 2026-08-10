/**
 * Strip bearer tokens out of analytics URLs.
 *
 * `/portal/<token>`, `/estimates/<token>` and `/review/<token>` are
 * unauthenticated, token-addressed pages: the path segment IS the credential.
 * `@vercel/analytics` reports BOTH a templated `route` and the raw `path`
 * (from `usePathname()`), so without this the plaintext token is transmitted
 * to a third-party collector on every page view — including the pay links
 * that invoice reminders mint.
 *
 * Pure and dependency-free so it can be unit-tested directly; the client
 * wrapper in `src/components/masked-analytics.tsx` feeds it to `beforeSend`.
 */

/** Route prefixes whose next path segment is a secret, not an identifier. */
const TOKEN_ROUTE_PREFIXES = new Set(["portal", "estimates", "review"]);

const PLACEHOLDER = "[token]";

/**
 * Replace the token segment of a token-addressed URL with `[token]`.
 *
 * Any non-token-addressed URL is returned byte-identical. For a token URL the
 * query and hash are dropped as well: these pages have no legitimate params of
 * their own, so discarding them is cheaper than deciding which are safe.
 * Accepts a full URL or a bare path.
 */
export function maskTokenPath(url: string): string {
  if (!url) return url;

  const origin = originOf(url);
  const rest = url.slice(origin.length);
  const pathname = rest.split(/[?#]/)[0];

  const segments = pathname.split("/");
  // segments[0] is "" for a leading slash, so the route prefix is segments[1].
  if (!TOKEN_ROUTE_PREFIXES.has(segments[1]) || !segments[2]) return url;

  segments[2] = PLACEHOLDER;
  // Truncate anything below the token segment too — a nested path under a
  // token route would otherwise still carry it.
  return origin + segments.slice(0, 3).join("/");
}

/** The `scheme://host` prefix, or `""` for a bare path. */
function originOf(url: string): string {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return "";
  const pathStart = url.indexOf("/", schemeEnd + 3);
  return pathStart === -1 ? url : url.slice(0, pathStart);
}
