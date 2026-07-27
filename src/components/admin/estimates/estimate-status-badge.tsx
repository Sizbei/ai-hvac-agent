import { Badge } from '@/components/ui/badge';
import { ESTIMATE_STATUS_BADGE, ESTIMATE_STATUS_DEFAULT } from '@/lib/admin/status-colors';

const LABELS: Record<string, string> = {
  open: 'Open',
  sold: 'Sold',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

export function EstimateStatusBadge({ status }: { readonly status: string }) {
  const className = ESTIMATE_STATUS_BADGE[status] ?? ESTIMATE_STATUS_DEFAULT;
  return (
    <Badge variant="outline" className={className}>
      {LABELS[status] ?? status}
    </Badge>
  );
}
