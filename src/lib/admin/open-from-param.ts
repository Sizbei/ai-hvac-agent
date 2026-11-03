/**
 * Pure parsing for setup-guide deep links (spec §4 "Deep links that open the
 * thing"). Only whitelisted `new` values open anything; `from=setup` must match
 * exactly; every other value is ignored and never rendered.
 */

const STRIPPED_KEYS: readonly string[] = ["new", "from"];

export interface OpenParams {
  readonly open?: string;
  readonly fromSetup: boolean;
}

export function parseOpenParams(
  search: string,
  allowed: readonly string[],
  key = "new",
): OpenParams {
  const params = new URLSearchParams(search);
  const value = params.get(key);
  const fromSetup = params.get("from") === "setup";
  return value !== null && allowed.includes(value) ? { open: value, fromSetup } : { fromSetup };
}

function rawKey(segment: string): string {
  const name = segment.split("=", 1)[0];
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/**
 * Removes every `new` and `from` occurrence; other segments keep their order
 * and raw encoding. Returns "" or a string starting with "?".
 */
export function stripParams(search: string): string {
  const body = search.startsWith("?") ? search.slice(1) : search;
  const kept = body
    .split("&")
    .filter((segment) => segment !== "" && !STRIPPED_KEYS.includes(rawKey(segment)));
  return kept.length > 0 ? `?${kept.join("&")}` : "";
}
