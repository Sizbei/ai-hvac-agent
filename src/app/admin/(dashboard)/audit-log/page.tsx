'use client';

import { useState } from 'react';
import { AlertCircle, ScrollText } from 'lucide-react';
import { useAdminAuditLog } from '@/hooks/use-admin-audit-log';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL_ACTIONS = 'all';
const PAGE_LIMIT = 50;

// Pretty-print a snake_case action/entity ("customer_updated" → "Customer Updated").
function humanize(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Render the JSON `details` payload (field names / ids only, never PII) as a
// compact readable string. Falls back to the raw string if it isn't JSON.
function formatDetails(details: string | null): string | null {
  if (!details) return null;
  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    const parts = Object.entries(parsed).map(([k, v]) => {
      const val = Array.isArray(v) ? v.join(', ') : String(v);
      return `${humanize(k)}: ${val || '—'}`;
    });
    return parts.join(' · ');
  } catch {
    // Every write site stores valid JSON of field NAMES only. If a row somehow
    // holds free text, don't echo it verbatim — it could contain a value a
    // future bad write leaked. Show a neutral placeholder instead.
    return '(details unavailable)';
  }
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminAuditLogPage() {
  const [actionFilter, setActionFilter] = useState<string>(ALL_ACTIONS);
  const [page, setPage] = useState(1);

  const { entries, total, actions, isLoading, error } = useAdminAuditLog({
    action: actionFilter === ALL_ACTIONS ? undefined : actionFilter,
    page,
    limit: PAGE_LIMIT,
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="size-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Audit Log</h1>
        </div>
        <span className="text-sm text-muted-foreground">{total} entries</span>
      </div>

      <p className="text-sm text-muted-foreground">
        A record of every admin action and safety-critical event for your
        organization. Details show which fields changed — never the values
        themselves.
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={actionFilter}
          onValueChange={(value) => {
            setActionFilter(value ?? ALL_ACTIONS);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Filter by action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ACTIONS}>All actions</SelectItem>
            {actions.map((a) => (
              <SelectItem key={a} value={a}>
                {humanize(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border">
        <div className="grid grid-cols-[180px_1fr_140px] gap-4 border-b bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground">
          <span>When</span>
          <span>Action</span>
          <span>Actor</span>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            No audit entries{actionFilter !== ALL_ACTIONS ? ' for this action' : ''} yet.
          </p>
        ) : (
          <div className="divide-y">
            {entries.map((e) => {
              const details = formatDetails(e.details);
              return (
                <div
                  key={e.id}
                  className="grid grid-cols-[180px_1fr_140px] gap-4 px-4 py-3 text-sm"
                >
                  <span className="text-muted-foreground">
                    {formatTimestamp(e.createdAt)}
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {humanize(e.action)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {humanize(e.entity)}
                      </span>
                    </div>
                    {details && (
                      <p className="truncate text-xs text-muted-foreground">
                        {details}
                      </p>
                    )}
                    {e.ipAddress && (
                      <p className="text-xs text-muted-foreground/70">
                        IP: {e.ipAddress}
                      </p>
                    )}
                  </div>
                  <span className="truncate text-muted-foreground">
                    {e.actorName ?? (
                      <span className="italic">System</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
