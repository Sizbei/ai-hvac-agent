'use client';

import Link from 'next/link';
import { CreditCard } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { useBillingEntry } from '@/components/admin/billing-entry-context';
import { billingHandledCopy } from '@/lib/admin/billing-entry';

/**
 * Billing discovery card, driven by the same view as /admin/settings/billing
 * (`billingPageView` via the layout): the plan link for whoever gets the
 * billing panel, who handles billing in a platform-managed org, nothing for
 * anyone else. The billing endpoints keep their own gates.
 */
export function BillingLinkPanel() {
  const entry = useBillingEntry();
  if (entry.view === 'redirect') return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
        <CardDescription>
          {entry.view === 'handled'
            ? billingHandledCopy(entry)
            : 'See your plan, what it includes, and change it.'}
        </CardDescription>
      </CardHeader>
      {entry.view === 'panel' && (
        <CardContent>
          <Link href="/admin/settings/billing" className={buttonVariants({ variant: 'outline' })}>
            <CreditCard className="size-4" aria-hidden="true" /> Open billing
          </Link>
        </CardContent>
      )}
    </Card>
  );
}
