import { CardSkeleton } from '@/components/admin/skeletons';

export default function CustomersLoading() {
  return (
    <div className="space-y-6 p-6">
      {/* header bar */}
      <div className="flex items-center justify-between">
        <div className="h-7 w-36 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-8 w-24 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
      {/* filter/search bar */}
      <div className="flex gap-2">
        <div className="h-9 w-64 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-9 w-36 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
      {/* customer cards — 3-column grid matching CustomerPeopleCards (sm:grid-cols-2 lg:grid-cols-3) */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
