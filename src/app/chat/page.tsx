'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import { useChatSession } from '@/hooks/use-chat-session';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { ChatInput } from '@/components/chat/chat-input';
import { QuickReplies } from '@/components/chat/quick-replies';
import { ExtractionPills } from '@/components/chat/extraction-pills';
import { ExtractionCard } from '@/components/chat/extraction-card';
import { EscalationDialog } from '@/components/chat/escalation-dialog';
import { ConfirmationDialog } from '@/components/chat/confirmation-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

const WELCOME_MESSAGE = {
  id: 'welcome',
  role: 'assistant' as const,
  content:
    "Hi! I'm your HVAC assistant. Tell me what's going on with your heating or cooling system, or pick a common issue below to get started.",
};

export default function ChatPage() {
  const router = useRouter();
  const {
    messages,
    status,
    isStreaming,
    extraction,
    extractionFields,
    error,
    isLoading,
    sendMessage,
    escalate,
    confirm,
  } = useChatSession();

  const [showEscalation, setShowEscalation] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [isEscalating, setIsEscalating] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const isTerminal =
    status === 'escalated' || status === 'abandoned' || status === 'submitted';
  const inputDisabled = isStreaming || isTerminal || isLoading;

  const hasUserMessages = messages.some((m) => m.role === 'user');
  const displayMessages = hasUserMessages
    ? messages
    : [WELCOME_MESSAGE, ...messages];

  const handleEscalate = useCallback(async () => {
    setIsEscalating(true);
    try {
      await escalate();
      setShowEscalation(false);
    } finally {
      setIsEscalating(false);
    }
  }, [escalate]);

  const handleConfirm = useCallback(async () => {
    if (!extraction) return;
    setIsConfirming(true);
    setConfirmError(null);
    try {
      const { referenceNumber } = await confirm(extraction);
      setShowConfirmation(false);
      router.push(`/chat/success?ref=${encodeURIComponent(referenceNumber)}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Confirmation failed';
      setConfirmError(message);
    } finally {
      setIsConfirming(false);
    }
  }, [extraction, confirm, router]);

  if (isLoading) {
    return (
      <div className="flex flex-col h-dvh md:mx-auto md:max-w-lg md:shadow-lg">
        <div className="flex items-center justify-between border-b bg-background/80 px-4 py-3">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-8 w-32" />
        </div>
        <div className="flex-1 p-4 space-y-4">
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-10 w-1/2 ml-auto" />
          <Skeleton className="h-10 w-3/4" />
        </div>
        <div className="border-t p-3">
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-dvh md:mx-auto md:max-w-lg md:shadow-lg">
      <ChatHeader
        status={status}
        onEscalate={() => setShowEscalation(true)}
      />

      <MessageList messages={displayMessages} isStreaming={isStreaming} />

      {/* Extraction card appears inline when extraction is complete but not yet confirmed */}
      {status === 'extracting' && extraction && (
        <div className="px-4 pb-2">
          <ExtractionCard
            extraction={extraction}
            onConfirm={() => setShowConfirmation(true)}
          />
        </div>
      )}

      {/* Error banner */}
      {(error || confirmError) && (
        <div className="px-3 pb-2">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{confirmError ?? error}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* Extraction progress pills */}
      <ExtractionPills fields={extractionFields} />

      {/* Quick replies shown before user sends first message */}
      {!hasUserMessages && !isStreaming && !isTerminal && (
        <div className="border-t bg-muted/30 px-3 py-3">
          <QuickReplies onSelect={sendMessage} disabled={inputDisabled} />
        </div>
      )}

      <ChatInput
        onSendMessage={sendMessage}
        disabled={inputDisabled}
        placeholder={
          isStreaming
            ? 'Waiting for response...'
            : isTerminal
              ? 'Chat has ended'
              : hasUserMessages
                ? 'Type your reply...'
                : 'Describe your HVAC issue...'
        }
      />

      <EscalationDialog
        open={showEscalation}
        onOpenChange={setShowEscalation}
        onConfirm={handleEscalate}
        isLoading={isEscalating}
      />

      {extraction && (
        <ConfirmationDialog
          open={showConfirmation}
          onOpenChange={setShowConfirmation}
          extraction={extraction}
          onConfirm={handleConfirm}
          isLoading={isConfirming}
        />
      )}
    </div>
  );
}
