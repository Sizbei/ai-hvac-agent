'use client';

import Link from 'next/link';
import { ChevronRight, MessagesSquare } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { SectionCard } from '@/components/admin/ui/section-card';
import { ChannelChip } from '@/components/admin/conversations/channel-chip';
import { StatusBadge } from '@/components/admin/status-badge';
import { useAdminConversations } from '@/hooks/use-admin-conversations';
import { formatRelativeTime } from '@/lib/admin/relative-time';
import { conversationTitle, recentConversations } from '@/lib/admin/dashboard-display';

const RECENT_LIMIT = 5;
/** Fetch extra rows so empty widget sessions can be dropped and 5 still remain. */
const FETCH_LIMIT = 20;

/**
 * Right-rail feed of the most recent conversations on the dashboard. Fetches its
 * own slice (newest first, capped) and links into the inbox. Read-only — clicking
 * navigates to /admin/conversations.
 */
export function RecentConversationsCard() {
  const { conversations, isLoading } = useAdminConversations({
    limit: FETCH_LIMIT,
    intervalMs: 30_000,
  });
  const recent = recentConversations(conversations, RECENT_LIMIT);

  return (
    <SectionCard
      title="Recent conversations"
      className="flex flex-col"
      contentClassName="p-3"
      action={
        <Link
          href="/admin/conversations"
          className="inline-flex items-center gap-0.5 text-xs font-medium text-link hover:underline"
        >
          View all
          <ChevronRight className="size-3.5" />
        </Link>
      }
    >
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
        <ul className="space-y-0.5">
          {recent.map((c) => (
            <li key={c.id}>
              <Link
                href="/admin/conversations"
                className="flex items-start gap-3 rounded-[3px] px-2 py-2.5 transition-colors hover:bg-row-hover"
              >
                <ChannelChip channel={c.channel} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">
                      {conversationTitle(c)}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {formatRelativeTime(c.lastMessageAt ?? c.updatedAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                    {c.preview ?? 'No customer message'}
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
    </SectionCard>
  );
}
