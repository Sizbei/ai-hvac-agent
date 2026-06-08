'use client';

import { Badge } from '@/components/ui/badge';

interface StatusBadgeProps {
  readonly status: string;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  assigned: 'bg-blue-100 text-blue-700 border-blue-200',
  scheduled: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  in_progress: 'bg-purple-100 text-purple-700 border-purple-200',
  on_hold: 'bg-orange-100 text-orange-700 border-orange-200',
  completed: 'bg-green-100 text-green-700 border-green-200',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
};

function formatStatus(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const colorClass = STATUS_STYLES[status] ?? STATUS_STYLES.pending;

  return (
    <Badge variant="outline" className={colorClass}>
      {formatStatus(status)}
    </Badge>
  );
}
