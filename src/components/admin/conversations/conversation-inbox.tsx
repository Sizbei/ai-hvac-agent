'use client';

import { useState, useEffect } from 'react';
import { AlertCircle, Search, Inbox, MessagesSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { pageLabel } from '@/lib/admin/invoice-list-helpers';
import { useAdminConversations } from '@/hooks/use-admin-conversations';
import { ConversationDetailContent } from '@/components/admin/conversations/conversation-detail-content';
import { ConversationDetailSheet } from '@/components/admin/conversation-detail-sheet';
import { ChannelChip } from '@/components/admin/conversations/channel-chip';
import { StatusBadge } from '@/components/admin/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/admin/relative-time';
import type { ConversationSummary } from '@/lib/admin/conversation-types';

const ALL_STATUSES = 'all';
const ALL_CHANNELS = 'all';
const SEARCH_DEBOUNCE_MS = 300;
const PER_PAGE = 50;

const STATUS_OPTIONS: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'All statuses', value: ALL_STATUSES },
  { label: 'Chatting', value: 'chatting' },
  { label: 'Extracting', value: 'extracting' },
  { label: 'Confirmed', value: 'confirmed' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Escalated', value: 'escalated' },
  { label: 'Abandoned', value: 'abandoned' },
];

const CHANNEL_TABS: readonly { readonly key: string; readonly label: string }[] = [
  { key: ALL_CHANNELS, label: 'All' },
  { key: 'phone', label: 'Phone' },
  { key: 'sms', label: 'SMS' },
  { key: 'web', label: 'Web' },
];

const CHANNEL_NOUN: Record<string, string> = {
  phone: 'phone',
  sms: 'SMS',
  web: 'web',
};

/** Statuses that warrant a "needs action" marker on the row. */
function needsAction(status: string): boolean {
  return status === 'escalated';
}

function ConversationRow({
  conversation,
  isSelected,
  onSelect,
}: {
  readonly conversation: ConversationSummary;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open conversation ${conversation.referenceNumber ?? conversation.id.slice(0, 8)}`}
      aria-current={isSelected}
      className={cn(
        'relative flex w-full items-start gap-3 border-b border-border/60 px-4 py-3.5 text-left transition-colors',
        isSelected ? 'bg-primary/[0.06]' : 'hover:bg-muted/50',
      )}
    >
      {isSelected && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      <ChannelChip channel={conversation.channel} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">
            {conversation.referenceNumber ?? conversation.id.slice(0, 8)}
          </span>
          {needsAction(conversation.status) && (
            <span
              title="Needs action"
              className="size-1.5 shrink-0 rounded-full bg-primary"
            />
          )}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatRelativeTime(conversation.lastMessageAt ?? conversation.updatedAt)}
          </span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {conversation.preview ?? 'No messages yet'}
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <StatusBadge status={conversation.status} />
        </div>
      </div>
    </button>
  );
}

export function ConversationInbox() {
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUSES);
  const [channelFilter, setChannelFilter] = useState<string>(ALL_CHANNELS);
  const [searchInput, setSearchInput] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Drives the mobile (<lg) slide-over; desktop renders the pane inline.
  const [mobileOpenId, setMobileOpenId] = useState<string | null>(null);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handler);
  }, [searchInput]);

  // Reset to page 1 whenever filters/search/channel change.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setPage(1);
  }, [statusFilter, channelFilter, debouncedSearch]);

  const { conversations, total, isLoading, error, refetch } = useAdminConversations({
    status: statusFilter === ALL_STATUSES ? undefined : statusFilter,
    channel: channelFilter === ALL_CHANNELS ? undefined : channelFilter,
    search: debouncedSearch || undefined,
    page,
    limit: PER_PAGE,
  });

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  const selected =
    conversations.find((c) => c.id === selectedId) ?? null;
  const channelNoun = channelFilter === ALL_CHANNELS ? '' : CHANNEL_NOUN[channelFilter] ?? '';
  const isFiltered =
    statusFilter !== ALL_STATUSES ||
    channelFilter !== ALL_CHANNELS ||
    debouncedSearch.length > 0;

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setMobileOpenId(id);
  };

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="p-4">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* LEFT: list pane */}
        <div className="flex w-full shrink-0 flex-col border-r border-border bg-card lg:w-[380px]">
          {/* Filters */}
          <div className="shrink-0 border-b border-border px-4 pt-4">
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search conversations..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="h-9 w-full pl-9"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex gap-5">
                {CHANNEL_TABS.map((tab) => {
                  const isActive = channelFilter === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setChannelFilter(tab.key)}
                      className={cn(
                        'relative pb-2.5 text-sm font-medium transition-colors',
                        isActive
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {tab.label}
                      {isActive && (
                        <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
              <Select
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value ?? ALL_STATUSES)}
              >
                <SelectTrigger aria-label="Filter by status" className="mb-1.5 h-8 w-[150px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Rows */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading && conversations.length === 0 ? (
              <div className="space-y-px">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={`skeleton-${i}`} className="flex gap-3 border-b border-border/60 px-4 py-3.5">
                    <Skeleton className="size-7 shrink-0 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-1/2" />
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-4 w-20 rounded-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : conversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
                <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Inbox className="size-5" />
                </span>
                <p className="text-sm font-semibold text-foreground">
                  {isFiltered
                    ? `No ${channelNoun} conversations match`
                    : 'No conversations yet'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {isFiltered
                    ? 'Try a different channel, status, or search.'
                    : 'New conversations from chat, phone, and SMS will appear here.'}
                </p>
              </div>
            ) : (
              conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  isSelected={conversation.id === selectedId}
                  onSelect={() => handleSelect(conversation.id)}
                />
              ))
            )}
          </div>

          <div className="shrink-0 border-t border-border px-4 py-2 flex items-center justify-between gap-2">
            <span className="tabular-nums text-xs text-muted-foreground">
              {pageLabel(safePage, total, PER_PAGE)}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setPage(1)}
                disabled={safePage <= 1}
              >
                First
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
              >
                ← Prev
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
              >
                Next →
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setPage(totalPages)}
                disabled={safePage >= totalPages}
              >
                Last
              </Button>
            </div>
          </div>
        </div>

        {/* RIGHT: detail pane (desktop only) */}
        <div className="hidden min-w-0 flex-1 flex-col bg-background lg:flex">
          {selected ? (
            <ConversationDetailContent
              key={selected.id}
              conversationId={selected.id}
              onClose={() => setSelectedId(null)}
              onDeleted={() => {
                setSelectedId(null);
                void refetch();
              }}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <MessagesSquare className="size-6" />
              </span>
              <p className="text-sm font-semibold text-foreground">
                Select a conversation
              </p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Pick a conversation from the list to read its transcript and AI summary.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Mobile (<lg): tapping a row opens the slide-over sheet */}
      <div className="lg:hidden">
        <ConversationDetailSheet
          conversationId={mobileOpenId}
          onClose={() => setMobileOpenId(null)}
          onDeleted={() => {
            setMobileOpenId(null);
            setSelectedId(null);
            void refetch();
          }}
        />
      </div>
    </div>
  );
}
