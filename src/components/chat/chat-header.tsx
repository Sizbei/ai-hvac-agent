'use client';

import { PhoneForwarded, RotateCcw, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/admin/brand-mark';
import type { SessionState } from '@/lib/types/chat';

interface ChatHeaderProps {
  readonly status: SessionState;
  readonly onEscalate: () => void;
  readonly onShowHistory?: () => void;
  /** Start a fresh conversation (clears the transcript + session). Optional so
   * legacy consumers without a session hook can omit the control. */
  readonly onNewConversation?: () => void;
}

// Map the session state to a SEMANTIC status color, reusing the existing theme
// intent tokens rather than inventing new ones:
//  - active intake → success (live, healthy)
//  - confirming    → warning (awaiting the customer's confirm)
//  - submitted     → primary (done, brand accent)
//  - escalated / abandoned / done → muted (no longer an active AI thread)
function getStatusColor(status: SessionState): string {
  switch (status) {
    case 'chatting':
    case 'extracting':
      return 'bg-success';
    case 'confirmed':
      return 'bg-warning';
    case 'submitted':
      return 'bg-primary';
    case 'escalated':
    case 'abandoned':
      return 'bg-muted-foreground/40';
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
      <div className="flex items-center gap-2.5">
        {/* Brand the customer chat with the Spears logo lozenge. `compact` shows
            just the logo (the admin "Service Console" subtitle isn't customer
            copy), paired with a chat-appropriate wordmark below. */}
        <div className="relative">
          <BrandMark compact />
          {/* Semantic session-status dot, anchored to the brand lozenge. */}
          <span
            className={`absolute -right-0.5 -top-0.5 inline-block size-2.5 rounded-full ring-2 ring-background ${getStatusColor(status)}`}
            aria-label={`Status: ${status}`}
          />
        </div>
        <div className="leading-tight">
          <h1 className="font-heading text-base font-bold tracking-tight">
            Spears Services
          </h1>
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
