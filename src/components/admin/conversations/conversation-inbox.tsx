'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertCircle, Search, Inbox, MessagesSquare } from 'lucide-react';
import { useAdminConversations } from '@/hooks/use-admin-conversations';
import { ConversationDetailContent } from '@/components/admin/conversations/conversation-detail-content';
import { ConversationDetailSheet } from '@/components/admin/conversation-detail-sheet';
import { ChannelChip } from '@/components/admin/conversations/channel-chip';
import { StatusBadge } from '@/components/admin/status-badge';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { TabGroup } from '@/components/admin/ui/tab-group';
import { Pager } from '@/components/admin/ui/pager';
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

const CHANNEL_TABS: readonly { readonly id: string; readonly label: string }[] = [
  { id: ALL_CHANNELS, label: 'All' },
  { id: 'phone', label: 'Phone' },
  { id: 'sms', label: 'SMS' },
  { id: 'web', label: 'Web' },
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
  isFocused,
  tabIndex,
  onRef,
  onSelect,
}: {
  readonly conversation: ConversationSummary;
  readonly isSelected: boolean;
  readonly isFocused: boolean;
  readonly tabIndex: number;
  readonly onRef: (el: HTMLButtonElement | null) => void;
  readonly onSelect: () => void;
}) {
  return (
    <button
      ref={onRef}
      type="button"
      tabIndex={tabIndex}
      onClick={onSelect}
      aria-label={`Open conversation ${conversation.referenceNumber ?? conversation.id.slice(0, 8)}`}
      aria-current={isSelected}
      className={cn(
        'relative flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors',
        isSelected
          ? 'bg-primary-soft'
          : isFocused
            ? 'bg-row-hover'
            : 'hover:bg-row-hover',
      )}
    >
      {isSelected && <span className="absolute inset-y-0 left-0 w-0.5 bg-marker" />}
      <ChannelChip channel={conversation.channel} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[13px] font-medium tabular-nums">
            {conversation.referenceNumber ?? conversation.id.slice(0, 8)}
          </span>
          {needsAction(conversation.status) && (
            <ContextBadge
              variant="warning"
              label="Needs action"
              className="shrink-0"
            />
          )}
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
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
  // Keyboard navigation: focusedIndex tracks the arrow-key cursor in the list.
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

  // Reset focusedIndex when the list changes so stale arrow positions don't persist.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedIndex(-1);
  }, [conversations]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileOpenId(id);
  }, []);

  // Arrow key / Enter navigation on the list pane (keyboard-first requirement).
  const handleListKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (conversations.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(focusedIndex + 1, conversations.length - 1);
      setFocusedIndex(next);
      rowRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(focusedIndex - 1, 0);
      setFocusedIndex(prev);
      rowRefs.current[prev]?.focus();
    } else if (e.key === 'Enter' && focusedIndex >= 0) {
      const conv = conversations[focusedIndex];
      if (conv) handleSelect(conv.id);
    }
  }, [conversations, focusedIndex, handleSelect]);

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
        <div className="flex w-full shrink-0 flex-col border-r border-border-strong bg-surface lg:w-[380px]">
          {/* Filters */}
          <div className="shrink-0 border-b border-border-strong bg-surface-sunken px-4 pt-4">
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
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 overflow-x-auto">
                <TabGroup
                  aria-label="Filter by channel"
                  tabs={CHANNEL_TABS}
                  activeTab={channelFilter}
                  onTabChange={setChannelFilter}
                  panelIdPrefix="conversations-panel"
                  className="border-b-0"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value ?? ALL_STATUSES)}
              >
                <SelectTrigger aria-label="Filter by status" className="mb-1.5 h-8 w-[130px] shrink-0">
                  <SelectValue placeholder="All statuses" />
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
          <div
            role="tabpanel"
            id={`conversations-panel-${channelFilter}`}
            aria-labelledby={`tab-${channelFilter}`}
            onKeyDown={handleListKeyDown}
            className={cn(
              'min-h-0 flex-1 overflow-y-auto transition-opacity duration-150',
              isLoading && conversations.length > 0 && 'opacity-50 pointer-events-none',
            )}
          >
            {isLoading && conversations.length === 0 ? (
              <div className="space-y-px">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={`skeleton-${i}`} className="flex gap-3 border-b border-border px-4 py-3">
                    <Skeleton className="size-7 shrink-0 rounded-[3px]" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-1/2" />
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-4 w-20 rounded-[3px]" />
                    </div>
                  </div>
                ))}
              </div>
            ) : conversations.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title={
                  isFiltered
                    ? `No ${channelNoun} conversations match`
                    : 'No conversations yet'
                }
                description={
                  isFiltered
                    ? 'Try a different channel, status, or search.'
                    : 'New conversations from chat, phone, and SMS will appear here.'
                }
              />
            ) : (
              conversations.map((conversation, idx) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  isSelected={conversation.id === selectedId}
                  isFocused={idx === focusedIndex}
                  tabIndex={focusedIndex < 0 ? (idx === 0 ? 0 : -1) : idx === focusedIndex ? 0 : -1}
                  onRef={(el) => { rowRefs.current[idx] = el; }}
                  onSelect={() => handleSelect(conversation.id)}
                />
              ))
            )}
          </div>

          <div className="shrink-0 border-t border-border-strong bg-surface-sunken px-2">
            <Pager
              page={safePage}
              totalPages={totalPages}
              total={total}
              perPage={PER_PAGE}
              onPageChange={setPage}
              showFirstLast
            />
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
            <EmptyState
              className="flex-1"
              icon={MessagesSquare}
              title="Select a conversation"
              description="Pick a conversation from the list to read its transcript and AI summary."
            />
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
