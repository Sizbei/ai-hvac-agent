'use client';

import { Fragment, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatCentsExact } from '@/lib/admin/money-format';
import { computeMargin } from '@/lib/admin/margin';
import type { PricebookItem } from '@/hooks/use-pricebook';
import { SyncPill } from '@/components/admin/sync-pill';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';

interface PricebookTableProps {
  readonly items: readonly PricebookItem[];
  readonly isLoading: boolean;
  readonly onEdit: (item: PricebookItem) => void;
  readonly onDeactivate: (item: PricebookItem) => void;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="secondary" className="capitalize">
      {type}
    </Badge>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-40" /></TableCell>
          <TableCell><Skeleton className="h-5 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-12" /></TableCell>
          <TableCell><Skeleton className="h-7 w-32" /></TableCell>
          <TableCell />
        </TableRow>
      ))}
    </>
  );
}

export function PricebookTable({
  items,
  isLoading,
  onEdit,
  onDeactivate,
}: PricebookTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!isLoading && items.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        No pricebook items yet.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>SKU</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Member</TableHead>
          <TableHead className="text-right">Margin</TableHead>
          <TableHead className="text-right">Actions</TableHead>
          <TableHead className="w-8" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <SkeletonRows />
        ) : (
          items.map((item) => {
            const isExpanded = expandedId === item.id;
            const marginData = computeMargin(item.priceCents, item.costCents);

            return (
              // The key must sit on the array element (the fragment), not the
              // inner rows — an unkeyed fragment in a .map triggers React's
              // list-key warning.
              <Fragment key={item.id}>
                <TableRow
                  // border-b-0 while expanded: the row + its panel read as one
                  // unit (the panel row's own border-b separates from the next).
                  className={`cursor-pointer ${item.active ? '' : 'opacity-60'} ${isExpanded ? 'border-b-0' : ''}`}
                  onClick={() => setExpandedId((prev) => (prev === item.id ? null : item.id))}
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-1.5">
                      {item.name}
                      {!item.active && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (inactive)
                        </span>
                      )}
                      {item.fieldpulseItemId && (
                        <SyncPill source="fieldpulse" size="sm" />
                      )}
                    </div>
                    {item.description && (
                      <div className="text-xs text-muted-foreground truncate max-w-xs">
                        {item.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <TypeBadge type={item.type} />
                      {item.isLaborItem && (
                        <Badge variant="outline" className="text-xs">
                          Labor
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.sku ?? ''}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentsExact(item.priceCents)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {item.memberPriceCents != null
                      ? formatCentsExact(item.memberPriceCents)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {item.priceCents > 0
                      ? `${(marginData.marginPct * 100).toFixed(1)}%`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <div
                      className="flex justify-end gap-2"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); onEdit(item); }}
                      >
                        Edit
                      </Button>
                      {item.active && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); onDeactivate(item); }}
                        >
                          Deactivate
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={(e) => { e.stopPropagation(); setExpandedId((prev) => (prev === item.id ? null : item.id)); }}
                      className="flex items-center justify-center text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                    >
                      {isExpanded
                        ? <ChevronDown className="size-4" />
                        : <ChevronRight className="size-4" />
                      }
                    </button>
                  </TableCell>
                </TableRow>
                {isExpanded && (
                  <TableRow key={`${item.id}-expand`}>
                    <TableCell colSpan={8} className="bg-muted/30 px-6 py-4 animate-in fade-in-0 slide-in-from-top-1 duration-100">
                      <div className="flex flex-wrap gap-6">
                        {/* Key facts */}
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                          {item.description && (
                            <>
                              <dt className="text-muted-foreground">Description</dt>
                              <dd className="max-w-xs">{item.description}</dd>
                            </>
                          )}
                          <dt className="text-muted-foreground">Cost</dt>
                          <dd className="tabular-nums">{formatCentsExact(item.costCents)}</dd>
                          <dt className="text-muted-foreground">Price</dt>
                          <dd className="font-medium tabular-nums">{formatCentsExact(item.priceCents)}</dd>
                          <dt className="text-muted-foreground">Margin</dt>
                          <dd className="tabular-nums">
                            {item.priceCents > 0 ? `${(marginData.marginPct * 100).toFixed(1)}%` : '—'}
                          </dd>
                          {item.memberPriceCents != null && (
                            <>
                              <dt className="text-muted-foreground">Member price</dt>
                              <dd className="tabular-nums">{formatCentsExact(item.memberPriceCents)}</dd>
                            </>
                          )}
                          {item.hours != null && (
                            <>
                              <dt className="text-muted-foreground">Hours</dt>
                              <dd className="tabular-nums">{item.hours}</dd>
                            </>
                          )}
                          <dt className="text-muted-foreground">Labor item</dt>
                          <dd>{item.isLaborItem ? 'Yes' : 'No'}</dd>
                        </dl>

                        {/* FieldPulse details */}
                        {item.fieldpulseData && (
                          <div className="flex-1 min-w-48">
                            <FieldpulseDetails data={item.fieldpulseData} />
                          </div>
                        )}
                      </div>

                      {/* Primary action */}
                      <div className="mt-4">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); onEdit(item); }}
                        >
                          Edit item
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
