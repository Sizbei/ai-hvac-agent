'use client';

import { useState, useCallback } from 'react';
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

const WELCOME_MESSAGE = {
  id: 'welcome',
  role: 'assistant' as const,
  content:
    "Hi, I'm here to help get your heating or cooling sorted and a technician on the way. Tell me what's going on, and I'll take care of the rest. (You can tap “Talk to a Human” anytime.)",
};

const ISSUE_SUGGESTIONS: readonly Suggestion[] = [
  { label: 'AC not cooling', message: 'My air conditioner is running but not cooling — it just blows warm air.' },
  { label: 'No heat', message: "My furnace is running but the house isn't getting warm." },
  { label: 'Thermostat issue', message: 'My thermostat display is blank / not responding.' },
];

interface ChatExperienceProps {
  /** "page" centers a max-width panel (hosted /chat); "embed" fills the iframe. */
  readonly variant?: 'page' | 'embed';
  /** Called with the reference number after a request is successfully submitted.
   * The page navigates to the success route; the embed shows an inline success. */
  readonly onSubmitted?: (referenceNumber: string) => void;
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
  const [isEscalating, setIsEscalating] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

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
  const displayMessages = hasUserMessages
    ? messages
    : [WELCOME_MESSAGE, ...messages];
  const lastMessageIsAssistant = displayMessages.at(-1)?.role === 'assistant';

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

  const handleConfirm = useCallback(async () => {
    if (!extraction) return;
    setIsConfirming(true);
    setConfirmError(null);
    try {
      const { referenceNumber } = await confirm(extraction);
      setShowConfirmation(false);
      onSubmitted?.(referenceNumber);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Confirmation failed';
      setConfirmError(message);
    } finally {
      setIsConfirming(false);
    }
  }, [extraction, confirm, onSubmitted]);

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
    <div className={containerClass}>
      <ChatHeader
        status={status}
        onEscalate={() => setShowEscalation(true)}
        onNewConversation={handleNewConversation}
      />

      <MessageList
        messages={displayMessages}
        isStreaming={isStreaming}
        showFeedback
      />

      {status === 'extracting' && extraction && (
        <div className="px-4 pb-2">
          <ExtractionCard
            extraction={extraction}
            onConfirm={() => setShowConfirmation(true)}
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
            onSelect={sendMessage}
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
