/**
 * Which body a fetched list should render. A failed load must never fall
 * through to the empty state ("No templates yet") — that reads as "you have
 * none" and invites duplicates. Rows already on screen stay on screen when a
 * later refetch fails; the caller shows the error beside them.
 */
export type ListViewState = "loading" | "error" | "empty" | "ready";

export function listViewState(input: {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly count: number;
}): ListViewState {
  if (input.count > 0) return "ready";
  if (input.loading) return "loading";
  if (input.failed) return "error";
  return "empty";
}
