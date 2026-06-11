'use client';

import { PhoneForwarded, RotateCcw, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SessionState } from '@/lib/types/chat';

interface ChatHeaderProps {
  readonly status: SessionState;
  readonly onEscalate: () => void;
  readonly onShowHistory?: () => void;
  /** Start a fresh conversation (clears the transcript + session). Optional so
   * legacy consumers without a session hook can omit the control. */
  readonly onNewConversation?: () => void;
}

function getStatusColor(status: SessionState): string {
  switch (status) {
    case 'chatting':
    case 'extracting':
      return 'bg-green-500';
    case 'confirmed':
      return 'bg-orange-500';
    case 'submitted':
      return 'bg-blue-500';
    case 'escalated':
    case 'abandoned':
      return 'bg-gray-400';
  }
}

function isEscalationDisabled(status: SessionState): boolean {
  return status === 'escalated' || status === 'abandoned' || status === 'submitted';
}

export function ChatHeader({
  status,
  onEscalate,
  onNewConversation,
  onShowHistory,
}: ChatHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/80 backdrop-blur px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block size-2.5 rounded-full ${getStatusColor(status)}`}
          aria-label={`Status: ${status}`}
        />
        <div className="leading-tight">
          <h1 className="text-base font-semibold">HVAC Assistant</h1>
          <p className="text-[11px] text-muted-foreground">
            AI assistant · our team follows up on every request
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {onShowHistory && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onShowHistory}
            title="View conversation history"
          >
            <History className="size-3.5" data-icon="inline-start" />
          </Button>
        )}
        {onNewConversation && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onNewConversation}
            title="Start a new conversation"
          >
            <RotateCcw className="size-3.5" data-icon="inline-start" />
            New
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onEscalate}
          disabled={isEscalationDisabled(status)}
        >
          <PhoneForwarded className="size-3.5" data-icon="inline-start" />
          Talk to a Human
        </Button>
      </div>
    </header>
  );
}
