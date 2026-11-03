'use client';

import { useEffect, useRef, useState } from 'react';
import { parseOpenParams, stripParams } from '@/lib/admin/open-from-param';

/**
 * Setup-guide deep links (spec §4). Reads `window.location.search` once after
 * mount — declare it BEFORE `useUrlFilterSync` so it reads the URL before that
 * hook's write effect replaces it. On a positive parse it calls `open(value)`
 * for a whitelisted `key` value, records `from=setup`, and strips `new` and
 * `from` with `history.replaceState`. State is only ever set on a positive
 * parse and a ref guards the run, so a StrictMode double effect is harmless.
 */
export function useOpenFromParam(
  key: string,
  allowed: readonly string[],
  open: (value: string) => void,
): { fromSetup: boolean } {
  const [fromSetup, setFromSetup] = useState(false);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const { pathname, search, hash } = window.location;
    const parsed = parseOpenParams(search, allowed, key);
    if (parsed.open === undefined && !parsed.fromSetup) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the URL after mount
    if (parsed.fromSetup) setFromSetup(true);
    if (parsed.open !== undefined) open(parsed.open);
    window.history.replaceState(null, '', pathname + stripParams(search) + hash);
    // Mount-only: the URL is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { fromSetup };
}

const NOTHING_TO_OPEN: readonly string[] = [];
const noop = (): void => {};

/** `from=setup` only (Settings): records it and strips it from the URL. */
export function useFromSetup(): boolean {
  return useOpenFromParam('new', NOTHING_TO_OPEN, noop).fromSetup;
}
