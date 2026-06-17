'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CreditCard } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Self-hiding discovery card for billing. Probes the super_admin/platform-gated
 * billing endpoint; a non-eligible admin gets 403/401 and we render nothing —
 * the server is the authority for visibility (same pattern as PlatformLinkPanel).
 */
export function BillingLinkPanel() {
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/platform/billing');
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
        <CardTitle>Billing</CardTitle>
        <CardDescription>
          Manage your platform subscription, plan, and entitlements.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" render={<Link href="/admin/settings/billing" />}>
          <CreditCard className="size-4" /> Open billing
        </Button>
      </CardContent>
    </Card>
  );
}
