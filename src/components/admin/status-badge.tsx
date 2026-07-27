'use client';

import { Badge } from '@/components/ui/badge';
import {
  REQUEST_STATUS_BADGE,
  REQUEST_STATUS_DEFAULT,
  SESSION_STATUS_BADGE,
  SESSION_STATUS_DEFAULT,
} from '@/lib/admin/status-colors';

interface StatusBadgeProps {
  readonly status: string;
}

/**
 * All status values from `request_status` and `session_status`/`session_outcome`
 * enums are covered. Unknown values fall back to the pending/chatting default.
 * Colors come exclusively from semantic design tokens — no raw palette classes.
 */
function resolveColorClass(status: string): string {
  return (
    REQUEST_STATUS_BADGE[status] ??
    SESSION_STATUS_BADGE[status] ??
    REQUEST_STATUS_DEFAULT ??
    SESSION_STATUS_DEFAULT
  );
}

function formatStatus(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const colorClass = resolveColorClass(status);

  return (
    <Badge variant="outline" className={colorClass}>
      {formatStatus(status)}
    </Badge>
  );
}
