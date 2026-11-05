'use client';

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { Search, Inbox, MessagesSquare, RotateCw } from 'lucide-react';
import { useAdminConversations } from '@/hooks/use-admin-conversations';
import { useUrlFilterSync } from '@/hooks/use-url-filter-sync';
import { ConversationDetailContent } from '@/components/admin/conversations/conversation-detail-content';
import { ConversationDetailSheet } from '@/components/admin/conversation-detail-sheet';
import { ChannelChip } from '@/components/admin/conversations/channel-chip';
import { StatusBadge } from '@/components/admin/status-badge';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { ErrorState } from '@/components/admin/ui/error-state';
import { TabGroup } from '@/components/admin/ui/tab-group';
import { Pager } from '@/components/admin/ui/pager';
import { Button } from '@/components/ui/button';
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
import { conversationTitle } from '@/lib/admin/conversation-display';
import { isUuid } from '@/lib/validation/uuid';
import type { ConversationSummary } from '@/lib/admin/conversation-types';

const ALL_STATUSES = 'all';
const ALL_CHANNELS = 'all';
const SEARCH_DEBOUNCE_MS = 300;
const PER_PAGE = 50;
/** Tailwind `lg` — at and above it the detail renders inline, not in a sheet. */
const DESKTOP_QUERY = '(min-width: 1024px)';

function subscribeDesktop(onChange: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/**
 * Desktop (lg+) shows the detail inline; below lg it opens in a sheet. Only
 * ONE of them mounts, so a click loads the detail once and the sheet (which
 * portals to <body>, out of reach of `lg:hidden`) never opens on desktop.
 */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

// Office-meaningful statuses only; "extracting"/"confirmed" are brief internal
// pipeline states.
const STATUS_OPTIONS: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'All statuses', value: ALL_STATUSES },
  { label: 'Chatting', value: 'chatting' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Escalated', value: 'escalated' },
  { label: 'Abandoned', value: 'abandoned' },
];
const STATUS_VALUES: readonly string[] = STATUS_OPTIONS.map((o) => o.value);

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
  const title = conversationTitle(conversation);
  // Second line: the request number when the title is the customer's name.
  const subtitle =
    conversation.customerName && conversation.referenceNumber
      ? conversation.referenceNumber
      : null;
  return (
    <button
      ref={onRef}
      type="button"
      tabIndex={tabIndex}
      onClick={onSelect}
      aria-label={`Open conversation ${title}`}
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
          <span
            className={cn(
              'truncate text-[13px] font-medium',
              !conversation.customerName && 'font-mono tabular-nums',
            )}
          >
            {title}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatRelativeTime(conversation.lastMessageAt ?? conversation.createdAt)}
          </span>
        </div>
        {subtitle && (
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">{subtitle}</p>
        )}
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {conversation.preview ?? 'No customer messages yet'}
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          {/* "Needs action" already says "escalated"; show one or the other. */}
          {conversation.needsAction ? (
            <ContextBadge variant="warning" label="Needs action" className="shrink-0" />
          ) : (
            <StatusBadge status={conversation.status} />
          )}
        </div>
      </div>
    </button>
  );
}

interface ConversationInboxProps {
  /** Permanent delete is super_admin-only server-side; hide it for others. */
  readonly canDelete: boolean;
}

export function ConversationInbox({ canDelete }: ConversationInboxProps) {
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUSES);
  const [channelFilter, setChannelFilter] = useState<string>(ALL_CHANNELS);
  const [needsActionOnly, setNeedsActionOnly] = useState<boolean>(false);
  const [includeEmpty, setIncludeEmpty] = useState<boolean>(false);
  const [searchInput, setSearchInput] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isDesktop = useIsDesktop();
  // Keyboard navigation: focusedIndex tracks the arrow-key cursor in the list.
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Filters + the open conversation live in the URL (shareable, survive reload).
  const urlState = {
    status: statusFilter === ALL_STATUSES ? '' : statusFilter,
    channel: channelFilter === ALL_CHANNELS ? '' : channelFilter,
    action: needsActionOnly ? '1' : '',
    empty: includeEmpty ? '1' : '',
    q: searchInput,
    c: selectedId ?? '',
  };
  const restoreFromUrl = useCallback((p: Record<string, string>) => {
    if (p.status && STATUS_VALUES.includes(p.status)) setStatusFilter(p.status);
    if (p.channel && CHANNEL_TABS.some((t) => t.id === p.channel)) setChannelFilter(p.channel);
    if (p.action === '1') setNeedsActionOnly(true);
    if (p.empty === '1') setIncludeEmpty(true);
    if (p.q) {
      setSearchInput(p.q);
      setDebouncedSearch(p.q);
    }
    if (p.c && isUuid(p.c)) setSelectedId(p.c);
  }, []);
  useUrlFilterSync(urlState, restoreFromUrl);

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
  }, [statusFilter, channelFilter, debouncedSearch, needsActionOnly, includeEmpty]);

  const { conversations, total, needsActionCount, isLoading, error, refetch } =
    useAdminConversations({
      status: statusFilter === ALL_STATUSES ? undefined : statusFilter,
      channel: channelFilter === ALL_CHANNELS ? undefined : channelFilter,
      search: debouncedSearch || undefined,
      needsAction: needsActionOnly,
      includeEmpty,
      page,
      limit: PER_PAGE,
    });

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  const channelNoun = channelFilter === ALL_CHANNELS ? '' : CHANNEL_NOUN[channelFilter] ?? '';
  const isFiltered =
    statusFilter !== ALL_STATUSES ||
    channelFilter !== ALL_CHANNELS ||
    needsActionOnly ||
    debouncedSearch.length > 0;
  const isFirstLoad = isLoading && conversations.length === 0;

  // Reset focusedIndex when the list changes so stale arrow positions don't persist.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedIndex(-1);
  }, [conversations]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const handleDeleted = useCallback(() => {
    setSelectedId(null);
    void refetch();
  }, [refetch]);

  const handleChanged = useCallback(() => {
    void refetch();
  }, [refetch]);

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
      <div className="flex min-h-0 flex-1">
        {/* LEFT: list pane */}
        <div className="flex w-full shrink-0 flex-col border-r border-border-strong bg-surface lg:w-[380px]">
          {/* Filters */}
          <div className="shrink-0 border-b border-border-strong bg-surface-sunken px-4 pt-4">
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search name, phone, request or message…"
                aria-label="Search conversations"
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
            <div className="flex items-center justify-between gap-3 pb-3">
              <Button
                type="button"
                size="sm"
                variant={needsActionOnly ? 'default' : 'outline'}
                aria-pressed={needsActionOnly}
                onClick={() => setNeedsActionOnly((v) => !v)}
              >
                Needs action
                <span className="font-mono tabular-nums">{needsActionCount}</span>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={includeEmpty}
                onClick={() => setIncludeEmpty((v) => !v)}
                className="text-muted-foreground"
              >
                {includeEmpty ? 'Hide empty chats' : 'Show empty chats'}
              </Button>
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
            {error && conversations.length === 0 ? (
              <ErrorState
                title="Couldn't load conversations"
                description="Check your connection and try again."
                action={
                  <Button variant="outline" size="sm" onClick={() => void refetch()}>
                    <RotateCw className="size-3.5" />
                    Try again
                  </Button>
                }
              />
            ) : isFirstLoad ? (
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
                  needsActionOnly && !debouncedSearch
                    ? 'Nothing needs action'
                    : isFiltered
                      ? `No ${channelNoun ? `${channelNoun} ` : ''}conversations match`
                      : 'No conversations yet'
                }
                description={
                  needsActionOnly && !debouncedSearch
                    ? 'Escalated conversations show up here until someone marks them handled.'
                    : isFiltered
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
              total={isFirstLoad || (error && conversations.length === 0) ? undefined : total}
              perPage={PER_PAGE}
              onPageChange={setPage}
              showFirstLast
            />
          </div>
        </div>

        {/* RIGHT: detail pane (desktop only) */}
        <div className="hidden min-w-0 flex-1 flex-col bg-background lg:flex">
          {isDesktop && selectedId ? (
            <ConversationDetailContent
              key={selectedId}
              conversationId={selectedId}
              canDelete={canDelete}
              onClose={() => setSelectedId(null)}
              onDeleted={handleDeleted}
              onChanged={handleChanged}
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
      <ConversationDetailSheet
        conversationId={isDesktop ? null : selectedId}
        canDelete={canDelete}
        onClose={() => setSelectedId(null)}
        onDeleted={handleDeleted}
        onChanged={handleChanged}
      />
    </div>
  );
}
