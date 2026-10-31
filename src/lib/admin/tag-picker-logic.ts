/** Toggle `id` in `current`: remove it when present, otherwise append it once. Never drops other ids. */
export function nextTagIds(current: readonly string[], id: string): readonly string[] {
  return current.includes(id)
    ? current.filter((i) => i !== id)
    : [...new Set([...current, id])];
}

/** A response is stale when a newer request has been issued since it was sent. */
export function isStaleResponse(seq: number, latest: number): boolean {
  return seq !== latest;
}
