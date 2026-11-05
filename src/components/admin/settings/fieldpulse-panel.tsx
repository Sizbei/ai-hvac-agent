'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Plug, Unplug, Zap } from 'lucide-react';
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
import {
  fsmConnectErrorMessage,
  fsmConnectionView,
} from '@/lib/admin/fsm-connection-view';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/** Non-secret account metadata cached after a successful connect. */
interface FieldpulseAccountInfo {
  readonly companyName: string | null;
  readonly accountId: string | null;
}

/** Shape of GET /api/admin/integrations/fieldpulse/status. */
interface FieldpulseStatus {
  readonly configured: boolean;
  /** Connected, but the last availability sync failed (absent on older responses). */
  readonly syncFailed?: boolean;
  readonly connected: boolean;
  readonly accountInfo: FieldpulseAccountInfo | null;
}

/**
 * Connect Fieldpulse settings panel.
 *
 * Reads status from /status. Connecting takes an API key in a password field
 * and POSTs it to /connect (which validates it against Fieldpulse before
 * storing it encrypted). Disconnecting POSTs to /disconnect. The key is
 * write-only here — it is never read back from the server.
 */
export function FieldpulsePanel() {
  const [status, setStatus] = useState<FieldpulseStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/admin/integrations/fieldpulse/status');
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError("Couldn't load the FieldPulse status. Please try again.");
        return;
      }
      setError(null);
      setStatus(body.data as FieldpulseStatus);
    } catch {
      setError("Couldn't load the FieldPulse status. Please try again.");
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  async function handleConnect(): Promise<void> {
    if (!apiKey.trim()) {
      setError('Enter your FieldPulse API key.');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/integrations/fieldpulse/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        setApiKey(''); // clear the secret from component state on success
        await load();
      } else {
        setError(fsmConnectErrorMessage('FieldPulse', body));
      }
    } catch {
      setError("Couldn't connect FieldPulse. Please try again.");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect(): Promise<void> {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/admin/integrations/fieldpulse/disconnect', {
        method: 'POST',
      });
      if (res.ok) {
        await load();
      } else {
        setError("Couldn't disconnect FieldPulse. Please try again.");
      }
    } catch {
      setError("Couldn't disconnect FieldPulse. Please try again.");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="size-5" />
          FieldPulse
        </CardTitle>
        <CardDescription>
          Connect your FieldPulse account to sync customers, jobs, and
          technician schedules. Paste an API key from your FieldPulse account
          settings; it is checked, then stored encrypted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {!status ? (
          <Skeleton className="h-10 w-full" />
        ) : status.connected ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="default" className="gap-1">
              <Check className="size-3" />
              Connected
            </Badge>
            <span className="text-sm text-muted-foreground">
              Linked to{' '}
              <span className="font-medium">
                {status.accountInfo?.companyName ?? 'your FieldPulse account'}
              </span>
              .
            </span>
            {status.syncFailed && (
              <p className="w-full text-sm text-warning-strong">
                The last availability sync failed. Check that the API key is
                still valid, then reconnect.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {fsmConnectionView(status) === 'server_key' ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="default" className="gap-1">
                  <Check className="size-3" />
                  Connected
                </Badge>
                <span className="text-sm text-muted-foreground">
                  Using the account key set up on the server. To use a
                  different account, paste its API key below.
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Badge variant="secondary">Not connected</Badge>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="fieldpulse-api-key">FieldPulse API key</Label>
              <Input
                id="fieldpulse-api-key"
                type="password"
                autoComplete="off"
                placeholder="Paste your FieldPulse API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={connecting}
              />
            </div>
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
            disabled={!status || connecting || !apiKey.trim()}
          >
            {connecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plug className="size-4" />
            )}
            Connect FieldPulse
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
