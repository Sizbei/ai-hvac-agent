'use client';

import { Suspense, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CheckCircle2 } from 'lucide-react';
import { ChatExperience } from '@/components/chat/chat-experience';

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

function EmbedContent() {
  const [submittedRef, setSubmittedRef] = useState<string | null>(null);

  if (submittedRef) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <CheckCircle2 className="size-12 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">Request submitted</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Our team will reach out shortly. Your reference number is{' '}
            <span className="font-mono font-medium text-foreground">
              {submittedRef}
            </span>
            .
          </p>
        </div>
      </div>
    );
  }

  return <ChatExperience variant="embed" onSubmitted={setSubmittedRef} />;
}

function EmbedLoading() {
  return (
    <div className="flex h-dvh items-center justify-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}
