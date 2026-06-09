'use client';

import { useCallback, useEffect, useState } from 'react';
import { Calendar, Check, Loader2, Plug, Unplug } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

/** Shape of GET /api/admin/integrations/google. */
interface GoogleStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly calendarId: string | null;
}

/**
 * Connect Google Calendar settings panel.
 *
 * Reads connection status from /api/admin/integrations/google. "Connect" sends
 * the admin through the OAuth flow (a full navigation to the connect route, which
 * 302s to Google). "Disconnect" DELETEs the connection. When the integration
 * isn't configured (no OAuth credentials on the server) the Connect button is
 * disabled with an explanation, so the panel degrades cleanly.
 */
export function GoogleCalendarPanel() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/admin/integrations/google');
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError('Could not load Google Calendar status.');
        return;
      }
      setError(null);
      setStatus(body.data as GoogleStatus);
    } catch {
      setError('Could not load Google Calendar status.');
    }
  }, []);

  useEffect(() => {
    // One-shot fetch of connection status on mount. setState happens only after
    // the awaited fetch resolves (inside `load`), not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch-on-mount; state set post-await
    load().catch(() => undefined);
  }, [load]);

  function handleConnect(): void {
    // Full navigation: the connect route redirects to Google's consent screen.
    window.location.href = '/api/admin/integrations/google/connect';
  }

  async function handleDisconnect(): Promise<void> {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/admin/integrations/google', {
        method: 'DELETE',
      });
      if (res.ok) {
        await load();
      } else {
        setError('Could not disconnect Google Calendar.');
      }
    } catch {
      setError('Could not disconnect Google Calendar.');
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="size-5" />
          Google Calendar
        </CardTitle>
        <CardDescription>
          Connect your business Google Calendar to automatically sync scheduled
          service requests as calendar events. Rescheduling updates the event;
          cancelling removes it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {!status ? (
          <Skeleton className="h-10 w-full" />
        ) : status.connected ? (
          <div className="flex items-center gap-2">
            <Badge variant="default" className="gap-1">
              <Check className="size-3" />
              Connected
            </Badge>
            <span className="text-sm text-muted-foreground">
              Syncing to{' '}
              <span className="font-medium">
                {status.calendarId ?? 'primary'}
              </span>{' '}
              calendar.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Not connected</Badge>
            {!status.configured && (
              <span className="text-sm text-muted-foreground">
                Google Calendar isn&apos;t configured on the server yet.
              </span>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter>
        {status?.connected ? (
          <Button
            variant="outline"
            onClick={handleDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Unplug className="size-4" />
            )}
            Disconnect
          </Button>
        ) : (
          <Button
            onClick={handleConnect}
            disabled={!status || !status.configured}
          >
            <Plug className="size-4" />
            Connect Google Calendar
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
