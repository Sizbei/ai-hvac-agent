'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Trash2, Send, ArrowUpRight, Check, RotateCw } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/admin/ui/error-state';
import { StatusBadge } from '@/components/admin/status-badge';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { ChannelChip, channelLabel } from '@/components/admin/conversations/channel-chip';
import {
  REPLY_MAX_LENGTH,
  canReplyByChannel,
  getReplyLengthError,
  replyErrorToCopy,
  modeIndicator,
} from '@/components/admin/conversations/conversation-reply-logic';
import {
  authorLabel,
  conversationTitle,
  shortConversationId,
  customerNameFromMetadata,
  extractedFields,
  messageAuthors,
  type MessageAuthor,
} from '@/lib/admin/conversation-display';
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
  /** Called after a triage change (mark handled / reopen) so the list refreshes. */
  readonly onChanged?: () => void;
  /** Delete is super_admin-only server-side; hidden for everyone else. */
  readonly canDelete?: boolean;
}

/** One consistent stamp for the transcript and Overview: "Aug 27, 6:38 PM". */
function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function InfoRow({
  label,
  value,
  href,
}: {
  readonly label: string;
  readonly value: React.ReactNode | null;
  readonly href?: string;
}) {
  return (
    <div className="flex gap-4 py-1">
      <span className="w-28 shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-sm font-medium">
        {value === null ? (
          <span className="text-muted-foreground italic">Not provided</span>
        ) : href ? (
          <a href={href} className="text-marker underline-offset-2 hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </span>
    </div>
  );
}

function TranscriptBubble({
  author,
  content,
  createdAt,
}: {
  readonly author: MessageAuthor;
  readonly content: string;
  readonly createdAt: string;
}) {
  if (author === 'system') {
    return (
      <div className="text-center py-1">
        <span className="text-xs italic text-muted-foreground">{content}</span>
      </div>
    );
  }

  const isUser = author === 'customer';
  const time = formatStamp(createdAt);

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
          <p className="whitespace-pre-wrap break-words">{content}</p>
        </div>
        <div
          className={`mt-1 px-1 text-[11px] text-muted-foreground ${
            isUser ? 'text-left' : 'text-right'
          }`}
        >
          {authorLabel(author)} · {time}
        </div>
      </div>
    </div>
  );
}

function ExtractedData({ metadata }: { readonly metadata: Record<string, unknown> }) {
  const rows = extractedFields(metadata);
  if (rows.length === 0) {
    return null;
  }

  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">Extracted data</h3>
      <div className="rounded-md border p-3 space-y-1">
        {rows.map((row) => (
          <InfoRow key={row.key} label={row.label} value={row.value} href={row.href} />
        ))}
      </div>
    </section>
  );
}

export function ConversationDetailContent({
  conversationId,
  onClose,
  onDeleted,
  onChanged,
  canDelete = false,
}: ConversationDetailContentProps) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [replyMessage, setReplyMessage] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const [isSavingHandled, setIsSavingHandled] = useState(false);
  const [handledError, setHandledError] = useState<string | null>(null);
  // Bumped by "Try again" to re-run the load effect.
  const [loadAttempt, setLoadAttempt] = useState(0);

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
    setReplyMessage('');
    setReplyError(null);
    setHandledError(null);

    let active = true;
    async function loadDetail(): Promise<void> {
      try {
        const res = await fetch(`/api/admin/conversations/${conversationId}`);
        if (!active) return;
        if (!res.ok) {
          if (active) {
            setDetailError(
              res.status === 404
                ? 'This conversation could not be found. It may have been deleted.'
                : "Couldn't load this conversation. Please try again.",
            );
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
        if (active) setDetailError("Couldn't reach the server. Check your connection and try again.");
      } finally {
        if (active) setIsLoadingDetail(false);
      }
    }

    loadDetail();
    return () => {
      active = false;
    };
  }, [conversationId, loadAttempt]);

  // Best-effort re-fetch after a successful reply send, so the new message and
  // the mode flip to "human" show up without a full loading-skeleton reset.
  const refetchDetailSilently = useCallback(async (): Promise<void> => {
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/admin/conversations/${conversationId}`);
      if (!res.ok) return;
      const body = (await res.json()) as { success: boolean; data: ConversationDetail };
      if (body.success) setDetail(body.data);
    } catch {
      // The reply already succeeded server-side; a refresh failure here just
      // means the transcript won't visibly update until the next reload.
    }
  }, [conversationId]);

  const handleSendReply = useCallback(async (): Promise<void> => {
    if (!conversationId) return;
    const lengthError = getReplyLengthError(replyMessage);
    if (lengthError) {
      setReplyError(lengthError);
      return;
    }

    setIsSendingReply(true);
    setReplyError(null);

    try {
      const res = await fetch(`/api/admin/conversations/${conversationId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: replyMessage.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const code = body?.error?.code ?? '';
        const message = body?.error?.message ?? '';
        setReplyError(replyErrorToCopy({ code, message }));
        return;
      }

      setReplyMessage('');
      await refetchDetailSilently();
    } catch {
      setReplyError('Could not connect to server.');
    } finally {
      setIsSendingReply(false);
    }
  }, [conversationId, replyMessage, refetchDetailSilently]);

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!conversationId) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/admin/conversations/${conversationId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        setDeleteError(
          res.status === 403
            ? 'Only an owner can delete conversations.'
            : "Couldn't delete this conversation. Please try again.",
        );
        return;
      }

      setIsConfirmOpen(false);
      onDeleted?.();
      onClose();
    } catch {
      setDeleteError("Couldn't reach the server. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  }, [conversationId, onDeleted, onClose]);

  // Clear (or restore) "Needs action". Only touches triage state — never sends.
  const handleSetHandled = useCallback(async (handled: boolean): Promise<void> => {
    if (!conversationId) return;
    setIsSavingHandled(true);
    setHandledError(null);
    try {
      const res = await fetch(`/api/admin/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handled }),
      });
      if (!res.ok) {
        setHandledError("Couldn't update this conversation. Please try again.");
        return;
      }
      const body = (await res.json()) as { success: boolean; data: { handledAt: string | null } };
      setDetail((prev) =>
        prev
          ? { ...prev, handledAt: body.data.handledAt, needsAction: !handled }
          : prev,
      );
      onChanged?.();
    } catch {
      setHandledError("Couldn't reach the server. Please try again.");
    } finally {
      setIsSavingHandled(false);
    }
  }, [conversationId, onChanged]);

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
      <ErrorState
        className="flex-1"
        title="Couldn't open this conversation"
        description={detailError}
        action={
          <Button variant="outline" size="sm" onClick={() => setLoadAttempt((n) => n + 1)}>
            <RotateCw className="size-3.5" />
            Try again
          </Button>
        }
      />
    );
  }

  if (!detail) {
    return null;
  }

  const customerName = customerNameFromMetadata(detail.metadata);
  const title = conversationTitle({
    customerName,
    requestCustomerName: detail.requestCustomerName,
    referenceNumber: detail.referenceNumber,
    id: detail.id,
    channel: detail.channel,
    preview: detail.messages.find((m) => m.role === 'user')?.content ?? null,
    startedAt: detail.createdAt,
  });
  const authors = messageAuthors(detail.messages, detail.staffReplyTimes);
  const requestHref = detail.serviceRequestId
    ? `/admin/requests?request=${detail.serviceRequestId}`
    : null;
  const channelName =
    detail.channel === 'phone'
      ? 'Phone call'
      : detail.channel === 'sms'
        ? 'Text message'
        : 'Web chat';

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-4 pr-12 sm:px-6 sm:py-5 lg:pr-6">
        <div className="flex items-start gap-3">
          <ChannelChip channel={detail.channel} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h2 className="font-heading text-lg font-bold tracking-tight break-words">
                {title}
              </h2>
              {detail.needsAction ? (
                <ContextBadge variant="warning" label="Needs action" />
              ) : (
                <StatusBadge status={detail.status} />
              )}
              {detail.channel === 'sms' && (
                <ContextBadge
                  variant={modeIndicator(detail.mode).variant}
                  label={modeIndicator(detail.mode).label}
                />
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {channelLabel(detail.channel)} · {formatStamp(detail.createdAt)} ·{' '}
              {/* The short id ⌘K and the inbox search find it by. */}
              <span className="font-mono tabular-nums">{shortConversationId(detail.id)}</span>
              {detail.referenceNumber && requestHref && (
                <>
                  {' · '}
                  <Link
                    href={requestHref}
                    className="font-mono font-medium text-marker underline-offset-2 hover:underline"
                  >
                    {detail.referenceNumber}
                  </Link>
                </>
              )}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {requestHref && (
                <Link href={requestHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  Open request
                  <ArrowUpRight className="size-3.5" />
                </Link>
              )}
              {detail.needsAction && (
                <Button
                  size="sm"
                  onClick={() => void handleSetHandled(true)}
                  disabled={isSavingHandled}
                >
                  <Check className="size-3.5" />
                  {isSavingHandled ? 'Saving…' : 'Mark handled'}
                </Button>
              )}
              {!detail.needsAction && detail.status === 'escalated' && detail.handledAt && (
                <>
                  <span className="text-xs text-muted-foreground">
                    Handled {formatStamp(detail.handledAt)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleSetHandled(false)}
                    disabled={isSavingHandled}
                  >
                    Reopen
                  </Button>
                </>
              )}
            </div>
            {handledError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {handledError}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
       <div className="max-w-2xl space-y-4">
        {/* AI summary callout */}
        {detail.summary && (
          <div className="rounded-md border border-primary-border bg-primary-soft p-4">
            <div className="mb-1.5 text-xs font-semibold text-marker-strong">
              AI summary
            </div>
            <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
              {detail.summary}
            </p>
          </div>
        )}

        {/* AI outcome + suggested next steps */}
        {(detail.outcome || (detail.nextSteps && detail.nextSteps.length > 0)) && (
          <div className="rounded-md border border-border bg-surface-sunken p-4 space-y-3">
            {detail.outcome && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground">Outcome</span>
                <StatusBadge status={detail.outcome} />
              </div>
            )}
            {detail.nextSteps && detail.nextSteps.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-semibold text-muted-foreground">
                  Suggested next steps
                </div>
                <ul className="list-disc space-y-1 pl-4 text-sm text-foreground/90">
                  {detail.nextSteps.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Extracted metadata — who and what, first */}
        {detail.metadata && <ExtractedData metadata={detail.metadata} />}

        {/* Overview */}
        <section>
          <h3 className="text-sm font-semibold mb-2">Overview</h3>
          <div className="rounded-md border p-3 space-y-1">
            <InfoRow label="Channel" value={channelName} />
            <InfoRow label="Messages" value={String(detail.messages.length)} />
            <InfoRow
              label="Linked request"
              value={detail.referenceNumber ?? 'None'}
              href={requestHref ?? undefined}
            />
            <InfoRow label="Started" value={formatStamp(detail.createdAt)} />
          </div>
        </section>

        {/* Running summary (long conversations) */}
        {detail.runningSummary && (
          <section>
            <h3 className="text-sm font-semibold mb-2">Conversation summary</h3>
            <div className="rounded-md border p-3">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {detail.runningSummary}
              </p>
            </div>
          </section>
        )}

        <Separator />

        {/* Transcript — flows with the body scroll (no nested scroll box). */}
        <section>
          <h3 className="text-sm font-semibold mb-2">Transcript</h3>
          <div className="rounded-md border p-3">
            {detail.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No messages recorded
              </p>
            ) : (
              detail.messages.map((msg, index) => (
                <TranscriptBubble
                  key={`${msg.createdAt}-${index}`}
                  author={authors[index]}
                  content={msg.content}
                  createdAt={msg.createdAt}
                />
              ))
            )}
          </div>
        </section>

        {/* Delete lives at the end of the body, not pinned under the thumb. */}
        {canDelete && (
          <section className="border-t border-border pt-4">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setDeleteError(null);
                setIsConfirmOpen(true);
              }}
            >
              <Trash2 className="size-4" />
              Delete conversation
            </Button>
          </section>
        )}
       </div>
      </div>

      {/* Reply composer — human takeover (Rconv-1) */}
      {/* Only SMS can be answered; phone and web chats get no composer at all,
          so the transcript keeps the screen. */}
      {canReplyByChannel(detail.channel) && (
      <div className="shrink-0 border-t border-border bg-card px-4 py-3 sm:px-6 sm:py-4">
        <h3 className="text-sm font-semibold mb-2">Reply</h3>
        {(
          <div className="space-y-2">
            <Textarea
              value={replyMessage}
              onChange={(event) => {
                setReplyMessage(event.target.value);
                if (replyError) setReplyError(null);
              }}
              placeholder="Type a reply to send as a text message…"
              rows={3}
              maxLength={REPLY_MAX_LENGTH}
              disabled={isSendingReply}
              aria-label="Reply message"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {replyMessage.trim().length.toLocaleString()} / {REPLY_MAX_LENGTH.toLocaleString()}
              </span>
              <Button
                size="sm"
                onClick={() => void handleSendReply()}
                disabled={isSendingReply || getReplyLengthError(replyMessage) !== null}
              >
                <Send className="size-3.5" />
                {isSendingReply ? 'Sending…' : 'Send reply'}
              </Button>
            </div>
            {replyError && <p className="text-sm text-destructive">{replyError}</p>}
            {detail.mode === 'human' && (
              <p className="text-xs text-muted-foreground">
                You&apos;ve taken over this conversation — the AI stays quiet until it&apos;s
                handed back.
              </p>
            )}
          </div>
        )}
      </div>
      )}

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
