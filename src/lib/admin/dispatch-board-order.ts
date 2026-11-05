/**
 * Dispatch board column order: technicians with requests that day first, then
 * the idle ones, each group keeping the server's order (alphabetical). With
 * eight technicians the day's only job used to sit in the 7th column, off
 * screen at 1440, and the board read as an empty day.
 */
export function busyColumnsFirst<T extends { readonly jobs: readonly unknown[] }>(
  columns: readonly T[],
): readonly T[] {
  return [
    ...columns.filter((c) => c.jobs.length > 0),
    ...columns.filter((c) => c.jobs.length === 0),
  ];
}
