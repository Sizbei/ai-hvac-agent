import { CardSkeleton } from '@/components/admin/skeletons';

export default function DispatchLoading() {
  return (
    <div className="space-y-6 p-6">
      {/* header + date nav bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="h-7 w-40 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="flex gap-2">
          <div className="h-9 w-9 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
          <div className="h-9 w-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
          <div className="h-9 w-9 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        </div>
      </div>
      {/* 4 dispatch columns, each with a header bar + 3 job-card skeletons */}
      <div className="flex gap-4 overflow-x-auto pb-2">
        {Array.from({ length: 4 }, (_, col) => (
          <div key={col} className="flex w-72 shrink-0 flex-col gap-3">
            {/* column header */}
            <div className="rounded-lg border bg-card p-3 shadow-sm">
              <div className="h-4 w-28 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
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
