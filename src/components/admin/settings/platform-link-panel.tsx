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

/**
 * Self-hiding discovery card for the platform console. Probes the platform-gated
 * endpoint; a non-platform admin gets 403/401 and we render nothing — the server
 * is the authority for visibility (same pattern as AiModelPanel).
 */
export function PlatformLinkPanel() {
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

  if (!authorized) return null;

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
