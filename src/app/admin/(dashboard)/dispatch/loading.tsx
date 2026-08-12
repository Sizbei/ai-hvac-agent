import { CardSkeleton } from '@/components/admin/skeletons';
import { Skeleton } from '@/components/ui/skeleton';

export default function DispatchLoading() {
  return (
    <div className="space-y-6 p-6">
      {/* header + date nav bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton aria-hidden="true" className="h-7 w-40" />
        <div className="flex gap-2">
          <Skeleton aria-hidden="true" className="size-8" />
          <Skeleton aria-hidden="true" className="h-8 w-32" />
          <Skeleton aria-hidden="true" className="size-8" />
        </div>
      </div>
      {/* 4 dispatch columns, each with a header bar + 3 job-card skeletons */}
      <div className="flex gap-4 overflow-x-auto pb-2">
        {Array.from({ length: 4 }, (_, col) => (
          <div key={col} className="flex w-72 shrink-0 flex-col gap-3">
            {/* column header — sunken band on a hairline panel, no resting shadow */}
            <div className="flex h-10 items-center rounded-lg border border-border-strong bg-surface-sunken px-3 shadow-[var(--keyline-top)]">
              <Skeleton aria-hidden="true" className="h-4 w-28 bg-ink-300" />
            </div>
            {/* job card stubs */}
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        ))}
      </div>
    </div>
  );
}
