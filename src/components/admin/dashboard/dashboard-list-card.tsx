'use client';

import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Inbox } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { IconChip, type IconChipIntent } from '@/components/admin/ui/icon-chip';
import { formatArrivalWindow } from '@/lib/admin/arrival-window';
import { DASHBOARD_LIST_LIMIT, type DashboardRequest } from '@/lib/admin/types';

type RowMeta = 'arrivalWindow' | 'followUp';

interface DashboardListCardProps {
  readonly title: string;
  readonly icon: LucideIcon;
  /** Intent drives the header IconChip tint (semantic tokens only). */
  readonly intent: IconChipIntent;
  readonly requests: readonly DashboardRequest[];
  readonly isLoading: boolean;
  readonly emptyLabel: string;
  /** Which secondary line to show under the customer name. */
  readonly meta: RowMeta;
  readonly onSelect: (id: string) => void;
}

function formatIssueType(issueType: string): string {
  return issueType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatHoldReason(reason: string | null): string | null {
  if (!reason) return null;
  return reason
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatFollowUp(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function MetaLine({
  request,
  meta,
}: {
  readonly request: DashboardRequest;
  readonly meta: RowMeta;
}) {
  if (meta === 'arrivalWindow') {
    const label = formatArrivalWindow(
      request.arrivalWindowStart,
      request.arrivalWindowEnd,
    );
    return (
      <span className="text-xs text-muted-foreground">{label ?? 'No window set'}</span>
    );
  }

  const followUp = formatFollowUp(request.followUpDate);
  const reason = formatHoldReason(request.holdReason);
  return (
    <span className="text-xs text-muted-foreground">
      {followUp ? `Follow up ${followUp}` : 'Follow up'}
      {reason ? ` · ${reason}` : ''}
    </span>
  );
}

export function DashboardListCard({
  title,
  icon: Icon,
  intent,
  requests,
  isLoading,
  emptyLabel,
  meta,
  onSelect,
}: DashboardListCardProps) {
  return (
    <Card className="flex flex-col p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <IconChip icon={Icon} intent={intent} size="sm" />
        <h2 className="font-heading text-sm font-semibold">{title}</h2>
        {!isLoading && (
          <span
            className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground"
            title={
              requests.length >= DASHBOARD_LIST_LIMIT
                ? `Showing the first ${DASHBOARD_LIST_LIMIT}`
                : undefined
            }
          >
            {requests.length}
            {requests.length >= DASHBOARD_LIST_LIMIT ? '+' : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={`skeleton-${i}`} className="h-12 w-full" />
          ))}
        </div>
      ) : requests.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="All clear"
          description={emptyLabel}
          className="py-8"
        />
      ) : (
        <ul className="space-y-1">
          {requests.map((request) => (
            <li key={request.id}>
              <button
                type="button"
                onClick={() => onSelect(request.id)}
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {request.customerName ?? 'Unknown'}
                    </span>
                    {request.isAfterHours && (
                      <ContextBadge
                        variant="after-hours"
                        label="After-hrs"
                        title="After hours"
                        className="shrink-0"
                      />
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {formatIssueType(request.issueType)} ·{' '}
                    <span className="font-mono">{request.referenceNumber}</span>
                  </div>
                  <MetaLine request={request} meta={meta} />
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="flex items-center gap-1">
                    {request.urgency === 'emergency' && (
                      <AlertTriangle
                        className="size-3.5 text-destructive"
                        aria-hidden="true"
                      />
                    )}
                    <UrgencyBadge urgency={request.urgency} />
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {request.assignedToName ?? 'Unassigned'}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
