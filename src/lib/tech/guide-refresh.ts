/** One window event tells the guide card and page to refetch (spec §2). */
export const GUIDE_REFRESH_EVENT = "tech:guide:refresh";

function defaultTarget(): EventTarget | undefined {
  return typeof window === "undefined" ? undefined : window;
}

export function dispatchGuideRefresh(target: EventTarget | undefined = defaultTarget()): void {
  target?.dispatchEvent(new Event(GUIDE_REFRESH_EVENT));
}

export function subscribeGuideRefresh(cb: () => void, target: EventTarget | undefined = defaultTarget()): () => void {
  if (!target) return () => {};
  target.addEventListener(GUIDE_REFRESH_EVENT, cb);
  return () => target.removeEventListener(GUIDE_REFRESH_EVENT, cb);
}
