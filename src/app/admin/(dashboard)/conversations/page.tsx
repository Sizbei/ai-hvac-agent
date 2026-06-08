'use client';

import { useState, useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { useAdminConversations } from '@/hooks/use-admin-conversations';
import { ConversationTable } from '@/components/admin/conversation-table';
import { ConversationDetailSheet } from '@/components/admin/conversation-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL_STATUSES = 'all';
const ALL_CHANNELS = 'all';

const STATUS_OPTIONS: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'All', value: ALL_STATUSES },
  { label: 'Chatting', value: 'chatting' },
  { label: 'Extracting', value: 'extracting' },
  { label: 'Confirmed', value: 'confirmed' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Escalated', value: 'escalated' },
  { label: 'Abandoned', value: 'abandoned' },
];

const CHANNEL_OPTIONS: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'All channels', value: ALL_CHANNELS },
  { label: 'Web', value: 'web' },
  { label: 'Phone', value: 'phone' },
];

const SEARCH_DEBOUNCE_MS = 300;

export default function AdminConversationsPage() {
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUSES);
  const [channelFilter, setChannelFilter] = useState<string>(ALL_CHANNELS);
  const [searchInput, setSearchInput] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handler);
  }, [searchInput]);

  const { conversations, total, isLoading, error, refetch } = useAdminConversations({
    status: statusFilter === ALL_STATUSES ? undefined : statusFilter,
    channel: channelFilter === ALL_CHANNELS ? undefined : channelFilter,
    search: debouncedSearch || undefined,
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Conversations</h1>
        <span className="text-sm text-muted-foreground">{total} total</span>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          placeholder="Search conversations..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-9 w-full sm:max-w-xs"
        />
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value ?? ALL_STATUSES)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={channelFilter} onValueChange={(value) => setChannelFilter(value ?? ALL_CHANNELS)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Filter by channel" />
          </SelectTrigger>
          <SelectContent>
            {CHANNEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ConversationTable
        conversations={conversations}
        isLoading={isLoading}
        onRowClick={(conversation) => setSelectedConversationId(conversation.id)}
      />

      <ConversationDetailSheet
        conversationId={selectedConversationId}
        onClose={() => setSelectedConversationId(null)}
        onDeleted={() => {
          void refetch();
        }}
      />
    </div>
  );
}
