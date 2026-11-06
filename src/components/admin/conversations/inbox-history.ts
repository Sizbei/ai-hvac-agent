/**
 * Phone Back closes an open conversation: opening one below `lg` pushes a
 * history entry with `?c=<id>`, and popstate reads the open id back from the
 * URL. Pure URL helpers (unit-tested; no DOM).
 */
import { isUuid } from '@/lib/validation/uuid';

/** The same page and filters, with `c` set to this conversation. */
export function urlWithConversation(pathname: string, search: string, id: string): string {
  const params = new URLSearchParams(search);
  params.set('c', id);
  return `${pathname}?${params.toString()}`;
}

/** The conversation a URL's query string opens, or null (absent / not a uuid). */
export function conversationFromSearch(search: string): string | null {
  const c = new URLSearchParams(search).get('c');
  return c && isUuid(c) ? c : null;
}
