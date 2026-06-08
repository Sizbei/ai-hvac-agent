'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Phone, MessageSquare } from 'lucide-react';
import { StatusBadge } from '@/components/admin/status-badge';
import type {
  ConversationSummary,
  ConversationChannel,
} from '@/lib/admin/conversation-types';

function ChannelBadge({ channel }: { readonly channel: ConversationChannel }) {
  const isPhone = channel === 'phone';
  const Icon = isPhone ? Phone : MessageSquare;
  return (
    <Badge variant="outline" className="gap-1 font-normal">
      <Icon className="size-3" />
      {isPhone ? 'Phone' : 'Web'}
    </Badge>
  );
}

interface ConversationTableProps {
  readonly conversations: readonly ConversationSummary[];
  readonly isLoading: boolean;
  readonly onRowClick: (conversation: ConversationSummary) => void;
}

function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

const SKELETON_ROWS = 5;
const COLUMN_COUNT = 7;

export function ConversationTable({
  conversations,
  isLoading,
  onRowClick,
}: ConversationTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Channel</TableHead>
          <TableHead>Preview</TableHead>
          <TableHead>Messages</TableHead>
          <TableHead>Turns</TableHead>
          <TableHead>Linked Request</TableHead>
          <TableHead>Last Activity</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading
          ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <TableRow key={`skeleton-${i}`}>
                {Array.from({ length: COLUMN_COUNT }, (__, j) => (
                  <TableCell key={`skeleton-cell-${i}-${j}`}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          : conversations.length === 0
            ? (
                <TableRow>
                  <TableCell colSpan={COLUMN_COUNT} className="text-center py-8 text-muted-foreground">
                    No conversations yet
                  </TableCell>
                </TableRow>
              )
            : conversations.map((conversation) => (
                <TableRow
                  key={conversation.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => onRowClick(conversation)}
                >
                  <TableCell>
                    <StatusBadge status={conversation.status} />
                  </TableCell>
                  <TableCell>
                    <ChannelBadge channel={conversation.channel} />
                  </TableCell>
                  <TableCell className="max-w-[280px] truncate text-muted-foreground">
                    {conversation.preview ?? '—'}
                  </TableCell>
                  <TableCell>{conversation.messageCount}</TableCell>
                  <TableCell>{conversation.turnCount}</TableCell>
                  <TableCell>
                    {conversation.hasServiceRequest && conversation.referenceNumber ? (
                      <span className="font-mono text-xs">
                        {conversation.referenceNumber}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(conversation.lastMessageAt ?? conversation.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
      </TableBody>
    </Table>
  );
}
