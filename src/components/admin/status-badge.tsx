'use client';

import { Badge } from '@/components/ui/badge';
import {
  REQUEST_STATUS_BADGE,
  REQUEST_STATUS_DEFAULT,
  SESSION_STATUS_BADGE,
  SESSION_STATUS_DEFAULT,
} from '@/lib/admin/status-colors';
// Sentence case ("On hold"), matching the list's status tabs.
import { requestStatusLabel } from '@/lib/admin/request-status';

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

export function StatusBadge({ status }: StatusBadgeProps) {
  const colorClass = resolveColorClass(status);

  return (
    <Badge variant="outline" className={colorClass}>
      {requestStatusLabel(status)}
    </Badge>
  );
}
