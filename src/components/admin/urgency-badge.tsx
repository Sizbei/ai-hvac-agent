'use client';

import { Badge } from '@/components/ui/badge';
import { URGENCY_BADGE, URGENCY_DEFAULT } from '@/lib/admin/status-colors';

interface UrgencyBadgeProps {
  readonly urgency: string;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function UrgencyBadge({ urgency }: UrgencyBadgeProps) {
  const colorClass = URGENCY_BADGE[urgency] ?? URGENCY_DEFAULT;

  return (
    <Badge variant="outline" className={colorClass}>
      {capitalize(urgency)}
    </Badge>
  );
}
