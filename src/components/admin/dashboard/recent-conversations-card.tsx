'use client';

import Link from 'next/link';
import { ChevronRight, MessagesSquare } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { ChannelChip } from '@/components/admin/conversations/channel-chip';
import { StatusBadge } from '@/components/admin/status-badge';
import { useAdminConversations } from '@/hooks/use-admin-conversations';
import { formatRelativeTime } from '@/lib/admin/relative-time';

const RECENT_LIMIT = 5;

/**
 * Right-rail feed of the most recent conversations on the dashboard. Fetches its
 * own slice (newest first, capped) and links into the inbox. Read-only — clicking
 * navigates to /admin/conversations.
 */
export function RecentConversationsCard() {
  const { conversations, isLoading } = useAdminConversations({
    limit: RECENT_LIMIT,
    intervalMs: 30_000,
  });
  const recent = conversations.slice(0, RECENT_LIMIT);

  return (
    <Card className="flex flex-col p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-heading text-sm font-semibold tracking-tight">
          Recent conversations
        </h2>
        <Link
          href="/admin/conversations"
          className="inline-flex items-center gap-0.5 text-xs font-medium text-link hover:underline"
        >
          View all
          <ChevronRight className="size-3.5" />
        </Link>
      </div>

      {isLoading && recent.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={`skeleton-${i}`} className="flex gap-3">
              <Skeleton className="size-7 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : recent.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No conversations yet"
          description="New chats from web, phone, and SMS will show up here."
          className="py-10"
        />
      ) : (
        <ul className="-mx-2 space-y-0.5">
          {recent.map((c) => (
            <li key={c.id}>
              <Link
                href="/admin/conversations"
                className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/60"
              >
                <ChannelChip channel={c.channel} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {c.referenceNumber ?? c.id.slice(0, 8)}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {formatRelativeTime(c.lastMessageAt ?? c.updatedAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                    {c.preview ?? 'No messages yet'}
                  </p>
                  <div className="mt-1.5">
                    <StatusBadge status={c.status} />
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
