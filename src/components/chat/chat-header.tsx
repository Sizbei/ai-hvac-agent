'use client';

import { Phone, PhoneForwarded, RotateCcw, History, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/admin/brand-mark';
import type { SessionState } from '@/lib/types/chat';
import type { TalkToHumanAction } from '@/lib/chat/chat-end-state';

interface ChatHeaderProps {
  readonly companyName?: string | null;
  readonly status: SessionState;
  readonly onEscalate: () => void;
  /** What "Talk to a human" does in this state (see chatEndActions). */
  readonly talkToHuman?: TalkToHumanAction;
  /** `tel:` href used when talkToHuman is "call". */
  readonly callHref?: string | null;
  /** Used when talkToHuman is "show-panel": reveal the end-of-chat panel. */
  readonly onShowEndPanel?: () => void;
  /** Close the widget (only when rendered inside the site widget's iframe). */
  readonly onClose?: () => void;
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

// Chat is a touch surface: the 30px header controls keep their instrument size
// but get a 44px hit area via a transparent ::before overlay (no visual bloat).
const TOUCH_TARGET =
  "relative before:absolute before:inset-x-0 before:-inset-y-[7px] before:content-['']";

export function ChatHeader({
  companyName,
  status,
  onEscalate,
  talkToHuman = 'dialog',
  callHref = null,
  onShowEndPanel,
  onClose,
  onNewConversation,
  onShowHistory,
}: ChatHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-y-2 border-b border-border-strong bg-surface px-4 py-3">
      <div className="flex min-w-0 basis-full items-center gap-2.5 sm:basis-auto">
        {/* Brand the customer chat with the Spears logo lozenge. `compact` shows
            just the logo (the admin "Service Console" subtitle isn't customer
            copy), paired with a chat-appropriate wordmark below. */}
        <div className="relative">
          <BrandMark compact />
          {/* Semantic session-status dot, anchored to the brand lozenge. */}
          <span
            className={`absolute -right-0.5 -top-0.5 inline-block size-2.5 rounded-[2px] ring-2 ring-surface ${getStatusColor(status)}`}
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 leading-tight">
          <h1 className="truncate font-heading text-[15px] font-semibold tracking-tight">
            {companyName ?? 'Chat with us'}
          </h1>
          <p className="truncate text-[11px] text-muted-foreground">
            AI assistant · our team follows up on every request
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {onShowHistory && (
          <Button
            variant="ghost"
            onClick={onShowHistory}
            title="View conversation history"
            aria-label="View conversation history"
            className={TOUCH_TARGET}
          >
            <History className="size-3.5" data-icon="inline-start" />
          </Button>
        )}
        {onNewConversation && (
          <Button
            variant="ghost"
            onClick={onNewConversation}
            title="Start a new conversation"
            className={TOUCH_TARGET}
          >
            <RotateCcw className="size-3.5" data-icon="inline-start" />
            New
          </Button>
        )}
        {talkToHuman === 'call' && callHref ? (
          <Button
            variant="outline"
            render={<a href={callHref} />}
            className={TOUCH_TARGET}
          >
            <Phone className="size-3.5" data-icon="inline-start" />
            Call us
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={talkToHuman === 'show-panel' ? onShowEndPanel : onEscalate}
            disabled={talkToHuman === 'disabled' || talkToHuman === 'call'}
            className={TOUCH_TARGET}
          >
            <PhoneForwarded className="size-3.5" data-icon="inline-start" />
            Talk to a human
          </Button>
        )}
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close chat"
            title="Close chat"
            className={TOUCH_TARGET}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
    </header>
  );
}
