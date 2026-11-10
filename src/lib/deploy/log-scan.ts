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
const TOKEN_LIKE = /^[A-Za-z0-9_-]{17,}$/;
const TOKEN_PARENTS = new Set(["invite", "portal"]);

export function normalizeRoute(rawPath: string): string {
  const path = rawPath.split(/[?#]/)[0];
  const segs = path.split("/");
  const out = segs.map((seg, i) => {
    if (!seg) return seg;
    if (UUID.test(seg) || NUMERIC.test(seg)) return "[id]";
    if (TOKEN_LIKE.test(seg) || TOKEN_PARENTS.has(segs[i - 1] ?? "")) return "[token]";
    return seg;
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

function fromText(line: string): { status: number | null; path: string | null } {
  const status = line.match(/(?:^|\s)([1-5]\d\d)(?:\s|$)/);
  const path = line.match(/(?:^|\s)(\/[^\s]*)/);
  return { status: status ? Number(status[1]) : null, path: path ? path[1] : null };
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
