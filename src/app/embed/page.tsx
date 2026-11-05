'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, X } from 'lucide-react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatExperience } from '@/components/chat/chat-experience';
import { WIDGET_CLOSE_MESSAGE } from '@/lib/widget/widget-messages';

/**
 * The embeddable chat panel (rendered inside the widget iframe). Same chat
 * experience as /chat, but on submission it shows an inline confirmation
 * instead of navigating (the iframe can't drive the host page).
 *
 * The publishable widget key arrives as ?key=pk_live_… and is forwarded to
 * /api/session by the chat-session hook.
 *
 * Wrapped in Suspense to prevent prerender errors from useChat's internal
 * Math.random() calls during build.
 */
export default function EmbedPage() {
  return (
    <Suspense fallback={<EmbedLoading />}>
      <EmbedContent />
    </Suspense>
  );
}

/**
 * Inside the site widget (the loader adds ?widget=1) the panel can't be closed
 * from here directly: on a phone it covers the whole screen and keyboard focus
 * lives in this iframe, so the host page never sees Esc. Ask the loader to
 * close it instead — from the header's X and from Esc.
 */
function useWidgetClose(): (() => void) | undefined {
  const inWidget = useSearchParams().get('widget') === '1';
  const close = useCallback(() => {
    // The host page's origin is unknown here (any allowlisted site); the
    // message carries no data, and the loader checks it came from our iframe.
    window.parent?.postMessage(WIDGET_CLOSE_MESSAGE, '*');
  }, []);
  useEffect(() => {
    if (!inWidget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // An open dialog (confirm, escalate, history) takes Esc first.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inWidget, close]);
  return inWidget ? close : undefined;
}

function EmbedContent() {
  const onClose = useWidgetClose();
  const [submitted, setSubmitted] = useState<{
    referenceNumber: string;
    arrivalWindowLabel: string | null;
  } | null>(null);

  if (submitted) {
    return (
      <div className="relative flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close chat"
            className="absolute top-3 right-3 size-11"
          >
            <X className="size-4" />
          </Button>
        )}
        <CheckCircle2 className="size-12 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">
            {submitted.arrivalWindowLabel ? "You're booked" : 'Request submitted'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {/* Only name a window we actually reserved; otherwise soft copy. */}
            {submitted.arrivalWindowLabel
              ? `We've got you down for ${submitted.arrivalWindowLabel}. Your reference number is `
              : 'Our team will reach out shortly. Your reference number is '}
            <span className="font-mono font-medium text-foreground">
              {submitted.referenceNumber}
            </span>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <ChatExperience variant="embed" onSubmitted={setSubmitted} onClose={onClose} />
  );
}

function EmbedLoading() {
  return (
    <div className="flex h-dvh items-center justify-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}
