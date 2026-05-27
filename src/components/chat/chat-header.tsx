'use client';

import { PhoneForwarded } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SessionState } from '@/lib/types/chat';

interface ChatHeaderProps {
  readonly status: SessionState;
  readonly onEscalate: () => void;
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

export function ChatHeader({ status, onEscalate }: ChatHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/80 backdrop-blur px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block size-2.5 rounded-full ${getStatusColor(status)}`}
          aria-label={`Status: ${status}`}
        />
        <h1 className="text-base font-semibold">HVAC Assistant</h1>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onEscalate}
        disabled={isEscalationDisabled(status)}
      >
        <PhoneForwarded className="size-3.5" data-icon="inline-start" />
        Talk to a Human
      </Button>
    </header>
  );
}
