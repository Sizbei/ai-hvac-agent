'use client';

import { formatAuditDetails, humanizeAuditKey } from '@/lib/admin/audit-format';
import { useState } from 'react';
import { ScrollText, X } from 'lucide-react';
import { useAdminAuditLog } from '@/hooks/use-admin-audit-log';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { DataTableShell, type DataTableColumn } from '@/components/admin/ui/data-table-shell';
import { Pager } from '@/components/admin/ui/pager';
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { EmptyState } from '@/components/admin/ui/empty-state';
import type { AuditLogEntry } from '@/lib/admin/audit-types';
import { useAdminPageTitle } from '@/components/admin/org-name-context';

const ALL_ACTIONS = 'all';
const ALL_ENTITIES = 'all';
const PAGE_LIMIT = 50;

// Enumerated entity values from logAudit call sites across the codebase.
const KNOWN_ENTITIES = [
  'accounting_export',
  'custom_faqs',
  'customer',
  'customer_equipment',
  'customer_membership',
  'customer_sessions',
  'customers',
  'estimate',
  'financing_application',
  'follow_ups',
  'invoice',
  'invoices',
  'membership_plan',
  'message',
  'organization',
  'organization_settings',
  'payment',
  'service_request',
  'service_requests',
  'staff_invite',
  'user',
] as const;

// Pretty-print a snake_case action/entity ("customer_updated" → "Customer updated").
// Sentence case: only the first word is capitalised.
const humanize = humanizeAuditKey;

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Actor({ entry }: { readonly entry: AuditLogEntry }) {
  return <>{entry.actorName ?? <span className="italic">System</span>}</>;
}

// Phone (<640px): When and Actor fold into the Action cell, which wraps, so no
// line runs off to the right. From sm up it is the three-column table; the
// Action cell wraps there too, so long details never push Actor off-screen.
const AUDIT_COLUMNS: ReadonlyArray<DataTableColumn<AuditLogEntry>> = [
  {
    key: 'when',
    header: 'When',
    cell: (e) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatTimestamp(e.createdAt)}
      </span>
    ),
    className: 'hidden w-[180px] sm:table-cell',
  },
  {
    key: 'action',
    header: 'Action',
    cell: (e) => {
      const details = formatAuditDetails(e.details);
      return (
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-muted-foreground sm:hidden">
            {formatTimestamp(e.createdAt)} · <Actor entry={e} />
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {humanize(e.action)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {humanize(e.entity)}
            </span>
          </div>
          {details && (
            <p className="break-words text-xs text-muted-foreground">{details}</p>
          )}
          {e.ipAddress && (
            <p className="break-all text-xs text-muted-foreground/70">IP: {e.ipAddress}</p>
          )}
        </div>
      );
    },
    className: 'whitespace-normal sm:min-w-[20rem]',
  },
  {
    key: 'actor',
    header: 'Actor',
    cell: (e) => (
      <span className="truncate text-muted-foreground">
        <Actor entry={e} />
      </span>
    ),
    className: 'hidden w-[140px] sm:table-cell',
  },
];

export default function AdminAuditLogPage() {
  useAdminPageTitle('Audit log');
  const [actionFilter, setActionFilter] = useState<string>(ALL_ACTIONS);
  const [entityFilter, setEntityFilter] = useState<string>(ALL_ENTITIES);
  const [page, setPage] = useState(1);

  const hasFilters = actionFilter !== ALL_ACTIONS || entityFilter !== ALL_ENTITIES;

  const { entries, total, actions, isLoading, error, refetch } = useAdminAuditLog({
    action: actionFilter === ALL_ACTIONS ? undefined : actionFilter,
    entity: entityFilter === ALL_ENTITIES ? undefined : entityFilter,
    page,
    limit: PAGE_LIMIT,
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  function clearFilters() {
    setActionFilter(ALL_ACTIONS);
    setEntityFilter(ALL_ENTITIES);
    setPage(1);
  }

  return (
    <PageShell>
      <PageHeader
        title="Audit log"
        subtitle="A record of every admin action and safety-critical event for your organization. Details show which fields changed — never the values themselves."
        actions={error ? undefined : <span className="text-sm text-muted-foreground">{total} entries</span>}
      />

      {error ? (
        // A failed load is never "no activity": human copy + Try again only.
        <LoadErrorState
          title="Couldn't load the audit log."
          onRetry={refetch}
          className="rounded-lg border border-dashed"
        />
      ) : (
        <DataTableShell
          columns={AUDIT_COLUMNS}
          rows={entries}
          getRowKey={(e) => e.id}
          isLoading={isLoading}
          toolbar={
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

              <Select
                value={entityFilter}
                onValueChange={(value) => {
                  setEntityFilter(value ?? ALL_ENTITIES);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Filter by entity" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_ENTITIES}>All entities</SelectItem>
                  {KNOWN_ENTITIES.map((e) => (
                    <SelectItem key={e} value={e}>
                      {humanize(e)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {hasFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="text-muted-foreground"
                >
                  <X className="mr-1 size-3" aria-hidden="true" />
                  Clear filters
                </Button>
              )}
            </div>
          }
          emptyState={
            <EmptyState
              icon={ScrollText}
              title="No audit entries"
              description={hasFilters ? 'No entries match these filters.' : 'No audit activity recorded yet.'}
            />
          }
          footer={
            <Pager
              page={page}
              totalPages={totalPages}
              total={total}
              perPage={PAGE_LIMIT}
              onPageChange={setPage}
              showFirstLast
            />
          }
        />
      )}
    </PageShell>
  );
}
