/** "1 question" / "3 questions". The one plural helper for M3d copy (spec §7). */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
