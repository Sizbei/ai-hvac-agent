'use client';

import { Button } from '@/components/ui/button';

const NOTE = 'rounded-md border border-border bg-surface-raised px-3 py-2.5 text-[15px] text-muted-foreground';

/**
 * The materials prompt and the h-12 "Create invoice" button: shown when the job
 * has no invoice yet, and under a paid or refunded invoice shown read-only.
 * Off site (create not allowed), a note says to arrive first.
 */
export function CreateInvoicePrompt({
  prompt,
  canCreate,
  onSite,
  disabled,
  creating,
  onCreate,
}: {
  readonly prompt: string;
  readonly canCreate: boolean;
  readonly onSite: boolean;
  readonly disabled: boolean;
  readonly creating: boolean;
  readonly onCreate: () => void;
}) {
  return (
    <>
      <p className="text-[15px]">{prompt}</p>
      {canCreate ? (
        <Button className="h-12 w-full rounded-xl text-[16px]" disabled={disabled} onClick={onCreate}>
          {creating ? 'Creating…' : 'Create invoice'}
        </Button>
      ) : (
        !onSite && <p className={NOTE}>Arrive at the job before invoicing.</p>
      )}
    </>
  );
}
