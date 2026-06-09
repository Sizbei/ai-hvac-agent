'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Plug, Unplug, Wrench } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/** Non-secret account metadata cached after a successful connect. */
interface HousecallAccountInfo {
  readonly companyName: string | null;
  readonly accountId: string | null;
}

/** Shape of GET /api/admin/integrations/housecall/status. */
interface HousecallStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly accountInfo: HousecallAccountInfo | null;
}

/**
 * Connect Housecall Pro settings panel.
 *
 * Reads status from /status. Connecting takes an API key in a password field
 * and POSTs it to /connect (which validates it against HCP before storing it
 * encrypted). Disconnecting POSTs to /disconnect. The key is write-only here —
 * it is never read back from the server. The panel degrades cleanly when the
 * integration is unconfigured.
 */
export function HousecallProPanel() {
  const [status, setStatus] = useState<HousecallStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/admin/integrations/housecall/status');
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError('Could not load Housecall Pro status.');
        return;
      }
      setError(null);
      setStatus(body.data as HousecallStatus);
    } catch {
      setError('Could not load Housecall Pro status.');
    }
  }, []);

  useEffect(() => {
    // One-shot fetch of connection status on mount. setState happens only after
    // the awaited fetch resolves (inside `load`), not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch-on-mount; state set post-await
    load().catch(() => undefined);
  }, [load]);

  async function handleConnect(): Promise<void> {
    if (!apiKey.trim()) {
      setError('Enter your Housecall Pro API key.');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/integrations/housecall/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        setApiKey(''); // clear the secret from component state on success
        await load();
      } else {
        setError(
          body?.error ??
            'Could not connect Housecall Pro. Check the API key.',
        );
      }
    } catch {
      setError('Could not connect Housecall Pro.');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect(): Promise<void> {
    setDisconnecting(true);
    try {
      const res = await fetch(
        '/api/admin/integrations/housecall/disconnect',
        { method: 'POST' },
      );
      if (res.ok) {
        await load();
      } else {
        setError('Could not disconnect Housecall Pro.');
      }
    } catch {
      setError('Could not disconnect Housecall Pro.');
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="size-5" />
          Housecall Pro
        </CardTitle>
        <CardDescription>
          Connect your Housecall Pro account (MAX plan) to sync customers and
          push scheduled jobs. Paste an API key from your HCP account settings;
          it is validated, then stored encrypted.
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
              Linked to{' '}
              <span className="font-medium">
                {status.accountInfo?.companyName ?? 'your Housecall Pro account'}
              </span>
              .
            </span>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">Not connected</Badge>
            </div>
            <div className="space-y-2">
              <Label htmlFor="hcp-api-key">Housecall Pro API key</Label>
              <Input
                id="hcp-api-key"
                type="password"
                autoComplete="off"
                placeholder="Paste your HCP API key"
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
            Connect Housecall Pro
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
