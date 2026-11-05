'use client';

import { forwardRef } from 'react';
import { Phone, TriangleAlert, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatEndPanel as ChatEndPanelModel } from '@/lib/chat/chat-end-state';

interface ChatEndPanelProps {
  readonly panel: ChatEndPanelModel;
  readonly phone: string | null;
  readonly callHref: string | null;
}

/**
 * Persistent panel shown once a chat is escalated (emergency or a manual
 * hand-off). It stays above the input — never scrolls away with the
 * transcript — so the customer always sees how to reach a person.
 */
export const ChatEndPanel = forwardRef<HTMLDivElement, ChatEndPanelProps>(
  function ChatEndPanel({ panel, phone, callHref }, ref) {
    const emergency = panel.kind === 'emergency';
    const Icon = emergency ? TriangleAlert : UserRound;
    return (
      <div
        ref={ref}
        tabIndex={-1}
        role={emergency ? 'alert' : 'status'}
        className={cn(
          'mx-3 mb-2 rounded-lg border p-3 outline-none focus-visible:outline-2 focus-visible:outline-ring',
          emergency
            ? 'border-danger-border bg-danger-light'
            : 'border-border-strong bg-surface-raised',
        )}
      >
        <div className="flex items-start gap-2.5">
          <Icon
            className={cn(
              'mt-0.5 size-4 shrink-0',
              emergency ? 'text-danger-strong' : 'text-muted-foreground',
            )}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                'text-[15px] font-semibold',
                emergency ? 'text-danger-strong' : 'text-foreground',
              )}
            >
              {panel.title}
            </p>
            <p className="mt-0.5 text-[13px] text-foreground">{panel.body}</p>
            {panel.guidance && (
              <p className="mt-1 text-[13px] font-medium text-foreground">
                {panel.guidance}
              </p>
            )}
          </div>
        </div>
        {callHref && phone && (
          <Button
            variant={emergency ? 'default' : 'outline'}
            render={<a href={callHref} />}
            className="mt-3 h-11 w-full text-[15px]"
          >
            <Phone className="size-4" data-icon="inline-start" />
            Call {phone}
          </Button>
        )}
      </div>
    );
  },
);
