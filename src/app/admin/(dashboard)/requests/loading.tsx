import { TableSkeleton } from '@/components/admin/skeletons';

export default function RequestsLoading() {
  return (
    <div className="space-y-6 p-6">
      {/* header bar */}
      <div className="h-7 w-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      {/* filters + search */}
      <div className="flex gap-2">
        <div className="h-9 w-64 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-9 w-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-9 w-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
      {/* requests table — 7 columns matching RequestTable */}
      <TableSkeleton rows={5} cols={7} />
    </div>
  );
}
