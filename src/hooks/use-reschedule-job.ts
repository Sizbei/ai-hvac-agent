'use client';

import { useCallback, useState } from 'react';
import type { ArrivalWindow } from '@/lib/admin/arrival-window';

interface RescheduleArgs {
  readonly requestId: string;
  /** Business-tz day (YYYY-MM-DD) the job was dropped on. */
  readonly date: string;
  readonly arrivalWindow: ArrivalWindow;
  /** New technician on a drag-to-ASSIGN (drop into another lane). Omit for a
   * pure reschedule — the server keeps the current assignee. */
  readonly technicianId?: string;
  /** Commit despite a conflict the server flagged (dispatcher confirmed). */
  readonly override?: boolean;
}

/** The lightweight conflict shape the 409 carries (mirrors the server's
 * ScheduleConflictDetail) — PII-free: refs/ids/flags only. */
export interface RescheduleConflictDetail {
  readonly conflicts: ReadonlyArray<{
    readonly id: string;
    readonly referenceNumber: string;
    readonly arrivalWindowStart: string;
    readonly arrivalWindowEnd: string;
  }>;
  readonly outsideAvailability: boolean;
}

type RescheduleResult =
  | { readonly status: 'ok'; readonly overridden: boolean }
  | {
      readonly status: 'conflict';
      readonly detail: RescheduleConflictDetail;
      readonly message: string;
    }
  | { readonly status: 'error'; readonly message: string };

interface UseRescheduleJobResult {
  readonly reschedule: (args: RescheduleArgs) => Promise<RescheduleResult>;
  readonly unschedule: (
    requestId: string,
  ) => Promise<{ status: 'ok' } | { status: 'error'; message: string }>;
  readonly isRescheduling: boolean;
}

/** Narrow an unknown JSON body to the conflict detail, defensively. */
function parseConflictDetail(value: unknown): RescheduleConflictDetail {
  const detail =
    typeof value === 'object' && value !== null
      ? (value as { conflicts?: unknown; outsideAvailability?: unknown })
      : {};
  const conflicts = Array.isArray(detail.conflicts)
    ? detail.conflicts.flatMap((c) => {
        if (typeof c !== 'object' || c === null) return [];
        const job = c as Record<string, unknown>;
        return [
          {
            id: String(job.id ?? ''),
            referenceNumber: String(job.referenceNumber ?? ''),
            arrivalWindowStart: String(job.arrivalWindowStart ?? ''),
            arrivalWindowEnd: String(job.arrivalWindowEnd ?? ''),
          },
        ];
      })
    : [];
  return {
    conflicts,
    outsideAvailability: detail.outsideAvailability === true,
  };
}

/**
 * Posts a drag-to-reschedule / drag-to-assign to
 * /api/admin/requests/[id]/reschedule. The OPTIMISTIC update + rollback lives in
 * the calendar component (it owns the board state); this hook performs the
 * network call and classifies the outcome: ok (possibly an override),
 * conflict (a 409 the server BLOCKED — the caller shows a warning and may retry
 * with override:true), or error. The server is the gate; the client only
 * surfaces what it returns.
 */
export function useRescheduleJob(): UseRescheduleJobResult {
  const [isRescheduling, setIsRescheduling] = useState(false);

  const reschedule = useCallback(
    async ({
      requestId,
      date,
      arrivalWindow,
      technicianId,
      override,
    }: RescheduleArgs): Promise<RescheduleResult> => {
      setIsRescheduling(true);
      try {
        const res = await fetch(
          `/api/admin/requests/${encodeURIComponent(requestId)}/reschedule`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              date,
              arrivalWindow,
              ...(technicianId ? { technicianId } : {}),
              ...(override ? { override: true } : {}),
            }),
          },
        );

        if (res.ok) {
          return { status: 'ok', overridden: override === true };
        }

        const body = await res.json().catch(() => null);
        const message =
          body?.error?.message ?? 'Failed to reschedule. Please try again.';

        // 409 with our conflict code → a blockable conflict the caller can override.
        if (res.status === 409 && body?.error?.code === 'SCHEDULE_CONFLICT') {
          return {
            status: 'conflict',
            detail: parseConflictDetail(body?.error?.details),
            message,
          };
        }

        return { status: 'error', message };
      } catch {
        return {
          status: 'error',
          message: 'Could not connect to server. Please try again.',
        };
      } finally {
        setIsRescheduling(false);
      }
    },
    [],
  );

  const unschedule = useCallback(
    async (
      requestId: string,
    ): Promise<{ status: 'ok' } | { status: 'error'; message: string }> => {
      setIsRescheduling(true);
      try {
        const res = await fetch(
          `/api/admin/requests/${encodeURIComponent(requestId)}/unschedule`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        );
        if (res.ok) return { status: 'ok' };
        const body = await res.json().catch(() => null);
        return {
          status: 'error',
          message:
            body?.error?.message ?? 'Failed to unschedule. Please try again.',
        };
      } catch {
        return {
          status: 'error',
          message: 'Could not connect to server. Please try again.',
        };
      } finally {
        setIsRescheduling(false);
      }
    },
    [],
  );

  return { reschedule, unschedule, isRescheduling };
}
