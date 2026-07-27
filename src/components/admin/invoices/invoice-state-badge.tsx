import { Badge } from '@/components/ui/badge';
import { INVOICE_STATE_BADGE, INVOICE_STATE_DEFAULT } from '@/lib/admin/status-colors';

const LABELS: Record<string, string> = {
  draft: 'Draft',
  open: 'Open',
  paid: 'Paid',
  void: 'Void',
  refunded: 'Refunded',
};

export function InvoiceStateBadge({ state }: { readonly state: string }) {
  const className = INVOICE_STATE_BADGE[state] ?? INVOICE_STATE_DEFAULT;
  return (
    <Badge variant="outline" className={className}>
      {LABELS[state] ?? state}
    </Badge>
  );
}
