import { Skeleton } from '@/components/ui/skeleton';

export function ChatLoadingSkeleton() {
  return (
    <div className="flex flex-col h-dvh max-w-lg mx-auto">
      {/* Header skeleton */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-2.5 rounded-full" />
          <Skeleton className="h-5 w-32" />
        </div>
        <Skeleton className="h-7 w-36 rounded-lg" />
      </div>

      {/* Message area skeleton */}
      <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4">
        {/* Assistant message */}
        <div className="flex justify-start">
          <Skeleton className="h-12 w-3/4 rounded-2xl rounded-bl-md" />
        </div>

        {/* Assistant message (longer) */}
        <div className="flex justify-start">
          <Skeleton className="h-16 w-4/5 rounded-2xl rounded-bl-md" />
        </div>

        {/* User message */}
        <div className="flex justify-end">
          <Skeleton className="h-10 w-1/2 rounded-2xl rounded-br-md" />
        </div>

        {/* Assistant message */}
        <div className="flex justify-start">
          <Skeleton className="h-14 w-2/3 rounded-2xl rounded-bl-md" />
        </div>
      </div>

      {/* Input skeleton */}
      <div className="flex items-center gap-2 border-t px-4 py-3">
        <Skeleton className="h-10 flex-1 rounded-md" />
        <Skeleton className="size-10 rounded-lg" />
      </div>
    </div>
  );
}
