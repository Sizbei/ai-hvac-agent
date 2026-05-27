'use client';

import { Badge } from '@/components/ui/badge';

interface UrgencyBadgeProps {
  readonly urgency: string;
}

const URGENCY_STYLES: Record<string, string> = {
  emergency: 'bg-red-100 text-red-700 border-red-200',
  high: 'bg-orange-100 text-orange-700 border-orange-200',
  medium: 'bg-blue-100 text-blue-700 border-blue-200',
  low: 'bg-gray-100 text-gray-600 border-gray-200',
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function UrgencyBadge({ urgency }: UrgencyBadgeProps) {
  const colorClass = URGENCY_STYLES[urgency] ?? URGENCY_STYLES.low;

  return (
    <Badge variant="outline" className={colorClass}>
      {capitalize(urgency)}
    </Badge>
  );
}
