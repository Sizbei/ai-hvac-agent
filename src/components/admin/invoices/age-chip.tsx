'use client';
const DAY_MS = 24 * 60 * 60 * 1000;
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}
export function ageBucket(days: number): 'green' | 'amber' | 'red' {
  if (days >= 60) return 'red';
  if (days >= 30) return 'amber';
  return 'green';
}
const CLS: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-700', amber: 'bg-amber-100 text-amber-700',
  red: 'bg-rose-100 text-rose-700',
};
export function AgeChip({ createdAt, state }: { createdAt: string; state: string }) {
  if (state === 'paid') {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700"><span className="size-1.5 rounded-full bg-emerald-600" />Paid</span>;
  }
  const days = daysBetween(new Date(createdAt), new Date());
  const b = ageBucket(days);
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${CLS[b]}`}><span className="size-1.5 rounded-full bg-current opacity-70" />{days} days</span>;
}
