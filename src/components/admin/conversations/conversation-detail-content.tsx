'use client';

import { useState, useEffect, useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/admin/status-badge';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { ChannelChip, channelLabel } from '@/components/admin/conversations/channel-chip';
import type { ConversationDetail } from '@/lib/admin/conversation-types';

/**
 * Shared inner content for a single conversation: loads the detail, renders the
 * overview/transcript, and owns the delete action (with confirm + refetch).
 *
 * Rendered by BOTH the mobile detail Sheet and the desktop inbox right-pane, so
 * behavior (load, delete -> onDeleted refetch + onClose) stays in one place.
 */
interface ConversationDetailContentProps {
  readonly conversationId: string | null;
  readonly onClose: () => void;
  readonly onDeleted?: () => void;
}

function InfoRow({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">
        {value ?? <span className="text-muted-foreground italic">Not provided</span>}
      </span>
    </div>
  );
}

function TranscriptBubble({
  role,
  content,
  createdAt,
}: {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly createdAt: string;
}) {
  if (role === 'system') {
    return (
      <div className="text-center py-1">
        <span className="text-xs italic text-muted-foreground">{content}</span>
      </div>
    );
  }

  const isUser = role === 'user';
  const time = new Date(createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`flex ${isUser ? 'justify-start' : 'justify-end'} mb-3`}>
      <div className={`max-w-[80%] ${isUser ? 'items-start' : 'items-end'}`}>
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? 'rounded-tl-sm bg-card text-foreground ring-1 ring-foreground/10'
              : 'rounded-tr-sm bg-muted text-foreground'
          }`}
        >
          <p className="whitespace-pre-wrap">{content}</p>
        </div>
        <div
          className={`mt-1 px-1 text-[11px] text-muted-foreground ${
            isUser ? 'text-left' : 'text-right'
          }`}
        >
          {isUser ? 'Customer' : 'AI assistant'} · {time}
        </div>
      </div>
    </div>
  );
}

function formatMetadataKey(key: string): string {
  const withSpaces = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return withSpaces
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return String(value);
}

// Sentinel a skipped optional intake step writes (triage.SKIP_SENTINEL). It
// lives in the in-flight session metadata so the step isn't re-asked, but must
// never be shown to an admin as if it were a real value.
const SKIP_SENTINEL = '__skipped__';

function ExtractedData({ metadata }: { readonly metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(
    ([, value]) => value !== null && value !== undefined && value !== SKIP_SENTINEL,
  );

  if (entries.length === 0) {
    return null;
  }

  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">Extracted Data</h3>
      <div className="rounded-md border p-3 space-y-1">
        {entries.map(([key, value]) => (
          <InfoRow
            key={key}
            label={formatMetadataKey(key)}
            value={formatMetadataValue(value)}
          />
        ))}
      </div>
    </section>
  );
}

export function ConversationDetailContent({
  conversationId,
  onClose,
  onDeleted,
}: ConversationDetailContentProps) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    setIsLoadingDetail(true);
    setDetailError(null);
    setIsConfirmOpen(false);
    setDeleteError(null);

    let active = true;
    async function loadDetail(): Promise<void> {
      try {
        const res = await fetch(`/api/admin/conversations/${conversationId}`);
        if (!active) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({
            error: { message: 'Failed to load conversation details' },
          }));
          if (active) {
            setDetailError(body?.error?.message ?? 'Failed to load conversation details');
          }
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: ConversationDetail;
        };
        if (active && body.success) {
          setDetail(body.data);
        }
      } catch {
        if (active) setDetailError('Could not connect to server.');
      } finally {
        if (active) setIsLoadingDetail(false);
      }
    }

    loadDetail();
    return () => {
      active = false;
    };
  }, [conversationId]);

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!conversationId) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/admin/conversations/${conversationId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to delete conversation' },
        }));
        setDeleteError(body?.error?.message ?? 'Failed to delete conversation');
        return;
      }

      setIsConfirmOpen(false);
      onDeleted?.();
      onClose();
    } catch {
      setDeleteError('Could not connect to server.');
    } finally {
      setIsDeleting(false);
    }
  }, [conversationId, onDeleted, onClose]);

  if (isLoadingDetail) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (detailError) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">{detailError}</p>
      </div>
    );
  }

  if (!detail) {
    return null;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-card px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <ChannelChip channel={detail.channel} />
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="font-heading text-lg font-bold tracking-tight">
                  <span className="font-mono text-sm">{detail.id.slice(0, 8)}</span>
                </h2>
                <StatusBadge status={detail.status} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {channelLabel(detail.channel)} · {detail.turnCount} turns ·{' '}
                {detail.referenceNumber ? (
                  <span className="font-medium text-primary">{detail.referenceNumber}</span>
                ) : (
                  'No linked request'
                )}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto space-y-4 px-6 py-5">
        {/* AI summary callout */}
        {detail.summary && (
          <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-4">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
              AI summary
            </div>
            <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
              {detail.summary}
            </p>
          </div>
        )}

        {/* Overview */}
        <section>
          <h3 className="text-sm font-semibold mb-2">Overview</h3>
          <div className="rounded-md border p-3 space-y-1">
            <InfoRow
              label="Channel"
              value={
                detail.channel === 'phone'
                  ? 'Phone call'
                  : detail.channel === 'sms'
                    ? 'Text message'
                    : 'Web chat'
              }
            />
            <InfoRow label="Turns" value={String(detail.turnCount)} />
            <InfoRow label="Messages" value={String(detail.messages.length)} />
            <InfoRow
              label="Tokens Used"
              value={`${detail.tokensUsed.toLocaleString()} / ${detail.tokenBudget.toLocaleString()}`}
            />
            <InfoRow label="Linked Request" value={detail.referenceNumber ?? 'None'} />
            <InfoRow label="Created" value={new Date(detail.createdAt).toLocaleString()} />
          </div>
        </section>

        {/* Extracted metadata */}
        {detail.metadata && <ExtractedData metadata={detail.metadata} />}

        {/* Running summary (long conversations) */}
        {detail.runningSummary && (
          <section>
            <h3 className="text-sm font-semibold mb-2">Conversation Summary</h3>
            <div className="rounded-md border p-3">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {detail.runningSummary}
              </p>
            </div>
          </section>
        )}

        <Separator />

        {/* Transcript */}
        <section>
          <h3 className="text-sm font-semibold mb-2">Conversation Transcript</h3>
          <ScrollArea className="max-h-[420px] rounded-md border p-3">
            {detail.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No messages recorded
              </p>
            ) : (
              detail.messages.map((msg, index) => (
                <TranscriptBubble
                  key={`${msg.createdAt}-${index}`}
                  role={msg.role}
                  content={msg.content}
                  createdAt={msg.createdAt}
                />
              ))
            )}
          </ScrollArea>
        </section>
      </div>

      {/* Footer actions */}
      <div className="shrink-0 border-t border-border bg-card px-6 py-4">
        <Button
          variant="destructive"
          onClick={() => {
            setDeleteError(null);
            setIsConfirmOpen(true);
          }}
        >
          <Trash2 className="size-4" />
          Delete conversation
        </Button>
      </div>

      <ConfirmDialog
        open={isConfirmOpen}
        onOpenChange={setIsConfirmOpen}
        title="Delete conversation?"
        description="This permanently deletes the conversation and its transcript. This action cannot be undone."
        confirmLabel="Delete"
        isConfirming={isDeleting}
        error={deleteError}
        onConfirm={handleDelete}
      />
    </div>
  );
}
