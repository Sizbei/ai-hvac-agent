/**
 * Pure summary of `vercel logs --json` output for the post-deploy watch.
 * Returns counts only. Route keys are normalized patterns (ids and tokens
 * replaced), so nothing from a log line's content is ever returned.
 */

export type LogSummary = {
  total: number;
  status5xx: number;
  byRoute: Record<string, number>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const SAFE_SEGMENT = /^[a-z][a-z0-9-]{0,30}$/;
const DIGIT_RUN = /\d{4,}/;
const TOKEN_PARENTS = new Set(["invite", "portal"]);

export function normalizeRoute(rawPath: string): string {
  const path = rawPath.split(/[?#]/)[0];
  const segs = path.split("/");
  const out = segs.map((seg, i) => {
    if (!seg) return seg;
    if (UUID.test(seg) || NUMERIC.test(seg)) return "[id]";
    if (TOKEN_PARENTS.has(segs[i - 1] ?? "")) return "[token]";
    // Allowlist: anything not plainly a route word is hidden.
    return SAFE_SEGMENT.test(seg) && !DIGIT_RUN.test(seg) ? seg : "[x]";
  });
  return out.join("/") || "/";
}

function fromJson(line: string): { status: number | null; path: string | null } | null {
  if (!line.startsWith("{")) return null;
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    const status = [o.responseStatusCode, o.statusCode, o.status].find((v) => typeof v === "number");
    const path = [o.requestPath, o.path, o.proxy && (o.proxy as Record<string, unknown>).path].find(
      (v) => typeof v === "string" && v.startsWith("/"),
    );
    return { status: (status as number | undefined) ?? null, path: (path as string | undefined) ?? null };
  } catch {
    return null;
  }
}

/**
 * A status only where a log puts one: right after the request path
 * ("GET /x 503") or as `status=` / `statusCode:`. A bare number in the 500s
 * (a duration, a size, a count) is not a status.
 */
function fromText(line: string): { status: number | null; path: string | null } {
  const afterPath = line.match(/(?:^|\s)(\/\S*)\s+([1-5]\d\d)(?=\s|$)/);
  if (afterPath) return { status: Number(afterPath[2]), path: afterPath[1] };
  const keyed = line.match(/\bstatus(?:Code)?\s*[=:]\s*([1-5]\d\d)\b/i);
  if (!keyed) return { status: null, path: null };
  const path = line.match(/(?:^|\s)(\/[^\s]*)/);
  return { status: Number(keyed[1]), path: path ? path[1] : null };
}

export function summarizeLogLines(lines: string[]): LogSummary {
  let total = 0;
  let status5xx = 0;
  const byRoute: Record<string, number> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    total += 1;
    const parsed = fromJson(line) ?? fromText(line);
    if (parsed.status === null || parsed.status < 500 || parsed.status > 599) continue;
    status5xx += 1;
    const key = parsed.path ? normalizeRoute(parsed.path) : "(unknown)";
    byRoute[key] = (byRoute[key] ?? 0) + 1;
  }
  return { total, status5xx, byRoute };
}
