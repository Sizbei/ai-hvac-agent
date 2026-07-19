'use client';

import { useState, useCallback, useEffect } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatSession } from '@/hooks/use-chat-session';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { ChatInput } from '@/components/chat/chat-input';
import { QuickReplies } from '@/components/chat/quick-replies';
import {
  SuggestedReplies,
  type Suggestion,
} from '@/components/chat/suggested-replies';
import {
  chipsForExtraction,
  nextStepIdForExtraction,
} from '@/lib/ai/triage-from-extraction';
import { AddressAutocomplete } from '@/components/chat/address-autocomplete';
import { ExtractionPills } from '@/components/chat/extraction-pills';
import { ExtractionCard } from '@/components/chat/extraction-card';
import { EscalationDialog } from '@/components/chat/escalation-dialog';
import { ConfirmationDialog } from '@/components/chat/confirmation-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { HistorySidebar } from '@/components/chat/history-sidebar';
import { ConnectionStatus } from '@/components/streaming/streaming-states';

const ISSUE_SUGGESTIONS: readonly Suggestion[] = [
  { label: 'AC not cooling', message: 'My air conditioner is running but not cooling — it just blows warm air.' },
  { label: 'No heat', message: "My furnace is running but the house isn't getting warm." },
  { label: 'Thermostat issue', message: 'My thermostat display is blank / not responding.' },
];

interface ChatExperienceProps {
  /** "page" centers a max-width panel (hosted /chat); "embed" fills the iframe. */
  readonly variant?: 'page' | 'embed';
  /** Called after a request is successfully submitted, with the reference number
   * and — when a concrete arrival window was actually reserved — its human label
   * (null on a soft booking, so callers keep soft "we'll confirm" copy). The page
   * navigates to the success route; the embed shows an inline success. */
  readonly onSubmitted?: (result: {
    referenceNumber: string;
    arrivalWindowLabel: string | null;
  }) => void;
}

export function ChatExperience({
  variant = 'page',
  onSubmitted,
}: ChatExperienceProps) {
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
    startNewConversation,
  } = useChatSession();

  const [showEscalation, setShowEscalation] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  // Holds inline edits from ExtractionCard so they carry into ConfirmationDialog.
  const [cardEditedExtraction, setCardEditedExtraction] = useState<import('@/lib/ai/extraction-schema').ExtractionResult | null>(null);
  const [isEscalating, setIsEscalating] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [, setViewingPastSessionId] = useState<string | null>(null);

  // Network status for the offline affordance (ConnectionStatus renders a banner
  // only while offline). Initialized true to avoid an SSR/client mismatch, then
  // synced to the real value + kept current via the online/offline events.
  const [isOnline, setIsOnline] = useState(true);
  useEffect(() => {
    const sync = () => setIsOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  const containerClass = cn(
    'flex flex-col',
    variant === 'embed'
      ? 'h-dvh'
      : 'h-dvh md:mx-auto md:max-w-lg md:shadow-lg',
  );

  const isTerminal =
    status === 'escalated' || status === 'abandoned' || status === 'submitted';
  const inputDisabled = isStreaming || isTerminal || isLoading;

  const hasUserMessages = messages.some((m) => m.role === 'user');
  // The greeting is a real persisted message (seeded by useChatSession from
  // POST /api/session), so the transcript renders as-is — no display-only
  // welcome that would vanish on the customer's first reply.
  const lastMessageIsAssistant = messages.at(-1)?.role === 'assistant';

  // Tappable mid-intake chips (#3): derive the next triage step's quick replies
  // from the polled extraction and offer them as one-tap suggestions. The chip's
  // captured value is sent as the message; the server captures it deterministically
  // (0-token). Falls back to the issue picker when no issue is known yet, and to []
  // for free-text steps (address/phone/name) where the customer should type.
  const triageChips: readonly Suggestion[] = extraction?.issueType
    ? chipsForExtraction(extraction).map((c) => ({
        label: c.label,
        message: c.value,
      }))
    : ISSUE_SUGGESTIONS;

  // Show the address autocomplete only while the address (or city/ZIP follow-up)
  // step is the pending question — derived from the SAME triage engine the
  // server sequences with, so client and server always agree. Picking a result
  // sends the full address as the customer's next message; the server captures
  // it deterministically. If Photon is unreachable the widget falls back to a
  // plain typed input, and the server's "what city and ZIP?" step handles partials.
  const pendingStepId = nextStepIdForExtraction(extraction);
  const showAddressAutocomplete =
    pendingStepId === 'address' || pendingStepId === 'address_parts';

  // Start a new conversation. Guard with a confirm only when there's real
  // in-progress work to lose (the customer has sent messages and the session
  // isn't already finished) — a fresh or terminal session restarts instantly.
  const handleNewConversation = useCallback(() => {
    const hasProgress = messages.some((m) => m.role === 'user') && !isTerminal;
    if (
      hasProgress &&
      typeof window !== 'undefined' &&
      !window.confirm('Start a new conversation? This clears the current chat.')
    ) {
      return;
    }
    void startNewConversation();
  }, [messages, isTerminal, startNewConversation]);

  const handleEscalate = useCallback(async () => {
    setIsEscalating(true);
    try {
      await escalate();
      setShowEscalation(false);
    } finally {
      setIsEscalating(false);
    }
  }, [escalate]);

  const handleConfirm = useCallback(async (edited: import('@/lib/ai/extraction-schema').ExtractionResult) => {
    setIsConfirming(true);
    setConfirmError(null);
    try {
      const { referenceNumber, arrivalWindowLabel } = await confirm(edited);
      setShowConfirmation(false);
      onSubmitted?.({ referenceNumber, arrivalWindowLabel });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Confirmation failed';
      setConfirmError(message);
    } finally {
      setIsConfirming(false);
    }
  }, [confirm, onSubmitted]);

  if (isLoading) {
    return (
      <div className={containerClass}>
        <div className="flex items-center justify-between border-b bg-background/80 px-4 py-3">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-8 w-32" />
        </div>
        <div className="flex-1 space-y-4 p-4">
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
    <>
      <HistorySidebar
        open={showHistory}
        onOpenChange={setShowHistory}
        onSelectSession={(sessionId) => {
          setViewingPastSessionId(sessionId);
          setShowHistory(false);
        }}
        customerId={null} // customerId is populated after extraction confirmation
      />

      <div className={containerClass}>
      <ChatHeader
        status={status}
        onEscalate={() => setShowEscalation(true)}
        onNewConversation={handleNewConversation}
        onShowHistory={() => setShowHistory(true)}
      />

      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        showFeedback
      />

      {status === 'extracting' && extraction && (
        <div className="px-4 pb-2">
          <ExtractionCard
            extraction={extraction}
            onConfirm={(edited) => {
              setCardEditedExtraction(edited);
              setShowConfirmation(true);
            }}
          />
        </div>
      )}

      {(error || confirmError) && (
        <div className="px-3 pb-2">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{confirmError ?? error}</AlertDescription>
          </Alert>
        </div>
      )}

      <ExtractionPills fields={extractionFields} />

      {hasUserMessages &&
        !isStreaming &&
        !isTerminal &&
        status !== 'extracting' &&
        lastMessageIsAssistant && (
          <SuggestedReplies
            suggestions={triageChips}
            onSelect={sendMessage}
            onEscalate={() => setShowEscalation(true)}
            disabled={inputDisabled}
          />
        )}

      {!hasUserMessages && !isStreaming && !isTerminal && (
        <div className="border-t bg-muted/30 px-3 py-3">
          <QuickReplies onSelect={sendMessage} disabled={inputDisabled} />
        </div>
      )}

      {showAddressAutocomplete &&
        hasUserMessages &&
        !isStreaming &&
        !isTerminal &&
        status !== 'extracting' && (
          <AddressAutocomplete
            onSelect={(addr) => sendMessage(addr)}
            disabled={inputDisabled}
            placeholder="Start typing your service address…"
          />
        )}

      {/* When the session has ended (submitted / escalated / abandoned) the
          input is locked — offer a clear way to start over instead of a dead box. */}
      {isTerminal && (
        <div className="border-t bg-muted/30 px-3 py-3">
          <Button
            variant="outline"
            className="w-full"
            onClick={handleNewConversation}
          >
            <RotateCcw className="size-4" data-icon="inline-start" />
            Start a new conversation
          </Button>
        </div>
      )}

      {/* Offline affordance — renders a banner only while the network is down. */}
      <ConnectionStatus isOnline={isOnline} />

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
          extraction={cardEditedExtraction ?? extraction}
          onConfirm={handleConfirm}
          isLoading={isConfirming}
        />
      )}
    </div>
    </>
  );
}
