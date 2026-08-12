'use client';

import { useState, useEffect } from 'react';
import { Clock, MessageSquare, ChevronRight, X, CheckCircle2, AlertCircle, XCircle } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface PastSession {
  id: string;
  status: string;
  createdAt: string;
  preview: string;
  messageCount: number;
}

interface HistorySidebarProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly customerId: string | null;
}

const statusIcons = {
  submitted: <CheckCircle2 className="size-4 text-success" />,
  completed: <CheckCircle2 className="size-4 text-success" />,
  escalated: <AlertCircle className="size-4 text-warning-strong" />,
  abandoned: <XCircle className="size-4 text-muted-foreground" />,
} as const;

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 36000000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function HistorySidebar({
  open,
  onOpenChange,
  onSelectSession,
  customerId,
}: HistorySidebarProps) {
  const [sessions, setSessions] = useState<PastSession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = async () => {
    if (!customerId) {
      setSessions([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/chat/history');
      if (!res.ok) {
        throw new Error('Failed to fetch history');
      }
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load history');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      fetchHistory();
    }
  }, [open, customerId]);

  // Poll for updates every 30s to catch customer linking mid-chat
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(fetchHistory, 30000);
    return () => clearInterval(interval);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className={cn(
          'w-full border-r border-border-strong bg-surface sm:max-w-sm',
          // Safe area for notched phones
          'safe-area-all'
        )}
      >
        <SheetHeader className="border-b border-border-strong px-4 py-3">
          <SheetTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <MessageSquare className="size-5" />
              Past Conversations
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => onOpenChange(false)}
            >
              <X className="size-4" />
            </Button>
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-2 py-4">
          {!customerId ? (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              <p>Sign in to see your conversation history</p>
            </div>
          ) : isLoading ? (
            <div className="space-y-3 px-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="px-2 py-8 text-center text-sm text-destructive">
              <p>{error}</p>
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              <p>No past conversations yet</p>
            </div>
          ) : (
            <ul className="space-y-1" role="list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onSelectSession(session.id)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-md px-3 py-3 text-left',
                      'transition-colors duration-[var(--dur-hover)] hover:bg-accent active:bg-accent/70',
                      'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
                      // 44px minimum touch target
                      'min-h-[44px]'
                    )}
                  >
                    <div className="mt-0.5 shrink-0">
                      {statusIcons[session.status as keyof typeof statusIcons] ?? (
                        <Clock className="size-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {session.preview}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                        {formatRelativeTime(session.createdAt)} · {session.messageCount} messages
                      </p>
                    </div>
                    <ChevronRight className="size-4 shrink-0 self-center text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border px-4 py-3">
          <p className="text-[11px] text-muted-foreground">
            History is available for your account
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
