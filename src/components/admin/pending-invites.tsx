'use client';

import { useState } from 'react';
import { Mail, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { InviteListItem } from '@/hooks/use-admin-invites';
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { listViewState } from '@/lib/admin/list-view-state';
import { staffErrorMessage } from '@/lib/admin/staff-errors';

interface PendingInvitesProps {
  readonly invites: readonly InviteListItem[];
  readonly isLoading: boolean;
  /** The list fetch failed: show the error with Try again, never "No pending invites". */
  readonly loadFailed: boolean;
  readonly onRetry: () => Promise<void>;
  /** Called after a successful revoke so the parent refetches. */
  readonly onRevoked: () => void;
}

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function PendingInvites({
  invites,
  isLoading,
  loadFailed,
  onRetry,
  onRevoked,
}: PendingInvitesProps) {
  // Track which invite id is mid-revoke to disable its button.
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRevoke(id: string): Promise<void> {
    setRevokingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/invites/${id}/revoke`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(staffErrorMessage(body, "Couldn't revoke the invite. Please try again."));
        return;
      }
      onRevoked();
    } catch {
      setError("Couldn't revoke the invite. Please try again.");
    } finally {
      setRevokingId(null);
    }
  }

  const view = listViewState({ loading: isLoading, failed: loadFailed, count: invites.length });

  if (view === 'error') {
    return (
      <LoadErrorState
        title="Couldn't load pending invites."
        onRetry={onRetry}
        className="rounded-lg border border-dashed"
      />
    );
  }

  if (view === 'empty') {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        No pending invites. Use Invite to send someone a sign-up link.
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pending invites</CardTitle>
        <CardDescription>
          Outstanding invitations that haven&apos;t been accepted yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          invites.map((invite) => (
            <div
              key={invite.id}
              className="flex items-center justify-between rounded-md border p-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{invite.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Expires {formatExpiry(invite.expiresAt)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="secondary" className="capitalize">
                  {invite.role}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRevoke(invite.id)}
                  disabled={revokingId === invite.id}
                  aria-label={`Revoke invite for ${invite.email}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
