'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { usePlatformUi } from '@/components/admin/platform-ui-context';

/**
 * Self-hiding discovery card for the platform console. Probes the platform-gated
 * endpoint; a non-platform admin gets 403/401 and we render nothing — the server
 * is the authority for visibility (same pattern as AiModelPanel). While a
 * "View as" preview is on the probe still passes (the API keeps the real
 * session), so the layout's platform-UI flag hides it too (spec P7).
 */
export function PlatformLinkPanel() {
  const platformUi = usePlatformUi();
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/platform/organizations');
        if (!cancelled && res.ok) setAuthorized(true);
      } catch {
        // leave hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!platformUi || !authorized) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform</CardTitle>
        <CardDescription>
          Provision and manage tenant organizations across the platform.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" render={<Link href="/admin/platform" />}>
          <Building2 className="size-4" /> Open platform console
        </Button>
      </CardContent>
    </Card>
  );
}
