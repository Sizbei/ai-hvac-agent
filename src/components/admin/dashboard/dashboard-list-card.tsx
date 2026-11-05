'use client';

import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Inbox } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { SectionCard } from '@/components/admin/ui/section-card';
import { type IconChipIntent } from '@/components/admin/ui/icon-chip';
import { formatArrivalWindow } from '@/lib/admin/arrival-window';
import { DASHBOARD_LIST_LIMIT, type DashboardRequest } from '@/lib/admin/types';
import { humanizeCode, issueTypeLabel } from '@/lib/admin/issue-type-label';
import { customerDisplayName } from '@/lib/admin/dashboard-display';

type RowMeta = 'arrivalWindow' | 'followUp';

interface DashboardListCardProps {
  readonly title: string;
  readonly icon: LucideIcon;
  /**
   * Retained for API compatibility. The panel header no longer tints: the
   * redesign spec bans tinted icon squares in panel headers.
   */
  readonly intent?: IconChipIntent;
  readonly requests: readonly DashboardRequest[];
  readonly isLoading: boolean;
  readonly emptyLabel: string;
  /** Which secondary line to show under the customer name. */
  readonly meta: RowMeta;
  readonly onSelect: (id: string) => void;
}

function formatHoldReason(reason: string | null): string | null {
  return reason ? humanizeCode(reason) : null;
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
  requests,
  isLoading,
  emptyLabel,
  meta,
  onSelect,
}: DashboardListCardProps) {
  return (
    <SectionCard
      title={title}
      icon={Icon}
      className="flex flex-col"
      contentClassName="p-2"
      action={
        !isLoading && (
          // Bare tabular-mono count — no pill.
          <span
            className="font-mono text-[13px] leading-none tabular-nums text-muted-foreground"
            title={
              requests.length >= DASHBOARD_LIST_LIMIT
                ? `Showing the first ${DASHBOARD_LIST_LIMIT}`
                : undefined
            }
          >
            {requests.length}
            {requests.length >= DASHBOARD_LIST_LIMIT ? '+' : ''}
          </span>
        )
      }
    >
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
                className="flex w-full items-start gap-3 rounded-[3px] px-2 py-2 text-left transition-colors hover:bg-row-hover"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {customerDisplayName(request.customerName)}
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
                    {issueTypeLabel(request.issueType)} ·{' '}
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
    </SectionCard>
  );
}
