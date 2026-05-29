'use client';

import { useState, useEffect, useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/admin/status-badge';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import type { ConversationDetail } from '@/lib/admin/conversation-types';

interface ConversationDetailSheetProps {
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
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-blue-100 text-blue-900'
            : 'bg-gray-100 text-gray-900'
        }`}
      >
        <p className="whitespace-pre-wrap">{content}</p>
        <p className={`mt-1 text-xs ${isUser ? 'text-blue-500' : 'text-gray-400'}`}>
          {time}
        </p>
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

function ExtractedData({ metadata }: { readonly metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(
    ([, value]) => value !== null && value !== undefined,
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

export function ConversationDetailSheet({
  conversationId,
  onClose,
  onDeleted,
}: ConversationDetailSheetProps) {
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

    async function loadDetail(): Promise<void> {
      try {
        const res = await fetch(`/api/admin/conversations/${conversationId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({
            error: { message: 'Failed to load conversation details' },
          }));
          setDetailError(body?.error?.message ?? 'Failed to load conversation details');
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: ConversationDetail;
        };
        if (body.success) {
          setDetail(body.data);
        }
      } catch {
        setDetailError('Could not connect to server.');
      } finally {
        setIsLoadingDetail(false);
      }
    }

    loadDetail();
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

  const isOpen = conversationId !== null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:w-[480px] sm:max-w-[480px] flex flex-col overflow-hidden">
        {isLoadingDetail ? (
          <div className="space-y-4 p-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : detailError ? (
          <div className="p-4">
            <p className="text-sm text-destructive">{detailError}</p>
          </div>
        ) : detail ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="font-mono text-sm">{detail.id.slice(0, 8)}</span>
              </SheetTitle>
              <SheetDescription className="flex items-center gap-2">
                <StatusBadge status={detail.status} />
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto space-y-4 px-4">
              {/* Meta */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Overview</h3>
                <div className="rounded-md border p-3 space-y-1">
                  <InfoRow label="Turns" value={String(detail.turnCount)} />
                  <InfoRow label="Messages" value={String(detail.messages.length)} />
                  <InfoRow
                    label="Tokens Used"
                    value={`${detail.tokensUsed.toLocaleString()} / ${detail.tokenBudget.toLocaleString()}`}
                  />
                  <InfoRow
                    label="Linked Request"
                    value={detail.referenceNumber ?? 'None'}
                  />
                  <InfoRow
                    label="Created"
                    value={new Date(detail.createdAt).toLocaleString()}
                  />
                </div>
              </section>

              {/* Extracted metadata */}
              {detail.metadata && <ExtractedData metadata={detail.metadata} />}

              <Separator />

              {/* Transcript */}
              <section>
                <h3 className="text-sm font-semibold mb-2">Conversation Transcript</h3>
                <ScrollArea className="max-h-[360px] rounded-md border p-3">
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

            <SheetFooter>
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
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>

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
    </Sheet>
  );
}
