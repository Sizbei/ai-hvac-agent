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

/**
 * Route prefixes whose NEXT path segment is a secret, not an identifier.
 * Each entry is the segment path leading up to the token. Keep this in sync
 * with the `[token]` page routes under `src/app/` — a missing entry silently
 * ships that credential to the analytics collector.
 */
const TOKEN_ROUTE_PREFIXES: readonly (readonly string[])[] = [
  ["portal"],
  ["estimates"],
  ["review"],
  ["admin", "invite"],
];

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

  // segments[0] is "" for a leading slash, so the route starts at segments[1].
  const segments = pathname.split("/");
  const prefix = TOKEN_ROUTE_PREFIXES.find((p) =>
    p.every((seg, i) => segments[i + 1] === seg),
  );
  if (!prefix) return url;

  const tokenIndex = prefix.length + 1;
  if (!segments[tokenIndex]) return url;

  segments[tokenIndex] = PLACEHOLDER;
  // Truncate anything below the token segment too — a nested path under a
  // token route would otherwise still carry it.
  return origin + segments.slice(0, tokenIndex + 1).join("/");
}

/** The `scheme://host` prefix, or `""` for a bare path. */
function originOf(url: string): string {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return "";
  const pathStart = url.indexOf("/", schemeEnd + 3);
  return pathStart === -1 ? url : url.slice(0, pathStart);
}
