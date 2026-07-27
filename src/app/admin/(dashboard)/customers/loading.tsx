import { Skeleton } from '@/components/ui/skeleton';

export default function CustomersLoading() {
  return (
    <div className="mx-auto max-w-[1280px] space-y-7 p-6 sm:p-7">
      {/* Header bar — mirrors PageHeader with subtitle + actions slot */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>
      {/* Filter / search bar */}
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-9 w-64 rounded-md" />
        <Skeleton className="h-9 w-40 rounded-md" />
        <Skeleton className="h-9 w-36 rounded-md" />
        <Skeleton className="h-9 w-44 rounded-md" />
      </div>
      {/* Customer cards — 3-column grid matching CustomerPeopleCards (sm:grid-cols-2 lg:grid-cols-3) */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-xl" />
        ))}
      </div>
      {/* Pager */}
      <div className="flex items-center justify-between px-1 py-3">
        <Skeleton className="h-9 w-20 rounded-md" />
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-9 w-20 rounded-md" />
      </div>
    </div>
  );
}
