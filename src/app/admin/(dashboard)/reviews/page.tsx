'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Star, MessageSquareQuote, Send } from 'lucide-react';
import { useReviews, type ReviewRow } from '@/hooks/use-reviews';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { StatCard, StatStrip } from '@/components/admin/ui/stat-card';
import { SectionCard } from '@/components/admin/ui/section-card';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { Pager } from '@/components/admin/ui/pager';

const PER_PAGE = 50;

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const REVIEW_STATUS_CLASS: Record<ReviewRow['status'], string> = {
  pending: 'bg-muted text-muted-foreground border-border',
  sent: 'bg-info-light text-info border-info/30',
  responded: 'bg-success-light text-success border-success/30',
};

const REVIEW_STATUS_LABEL: Record<ReviewRow['status'], string> = {
  pending: 'Pending',
  sent: 'Sent',
  responded: 'Responded',
};

function ReviewStatusBadge({ status }: { readonly status: ReviewRow['status'] }) {
  return (
    <Badge variant="outline" className={REVIEW_STATUS_CLASS[status]}>
      {REVIEW_STATUS_LABEL[status]}
    </Badge>
  );
}

function Stars({ rating }: { readonly rating: number | null }) {
  if (rating === null) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} of 5`}>
      {[1, 2, 3, 4, 5].map((v) => (
        <Star
          key={v}
          className={
            v <= rating
              ? 'size-4 fill-warning text-warning'
              : 'size-4 text-muted-foreground/30'
          }
        />
      ))}
    </span>
  );
}

export default function ReviewsPage() {
  useEffect(() => { document.title = 'Reviews · Spears Admin'; }, []);
  const [page, setPage] = useState(1);
  const { reviews, total, stats, isLoading, error } = useReviews({ page });

  const responseRate =
    stats && stats.count > 0
      ? Math.round((stats.responded / stats.count) * 100)
      : 0;

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  return (
    <PageShell>
      <PageHeader
        title="Reviews"
        subtitle="Post-job review requests, average rating, and response rate."
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Stat cards */}
      <StatStrip>
        <StatCard
          icon={Star}
          intent="warning"
          label="Average rating"
          value={stats?.avgRating != null ? `${stats.avgRating.toFixed(1)} / 5` : '—'}
          loading={isLoading}
        />
        <StatCard
          icon={Send}
          intent="info"
          label="Requests sent"
          value={String(stats?.count ?? 0)}
          loading={isLoading}
        />
        <StatCard
          icon={MessageSquareQuote}
          intent="success"
          label="Response rate"
          value={`${responseRate}%`}
          sublabel={`${stats?.responded ?? 0} responded`}
          loading={isLoading}
        />
      </StatStrip>

      {/* Review list */}
      <SectionCard title="All reviews">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Rating</th>
                <th scope="col" className="px-4 py-3 font-medium">Public link clicked</th>
                <th scope="col" className="px-4 py-3 font-medium">Sent</th>
                <th scope="col" className="px-4 py-3 font-medium">Responded</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3" colSpan={5}>
                      <Skeleton className="h-5 w-full" />
                    </td>
                  </tr>
                ))
              ) : reviews.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon={Star}
                      title="No reviews yet"
                      description="Review requests are sent automatically when a job is completed."
                    />
                  </td>
                </tr>
              ) : (
                reviews.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3">
                      <ReviewStatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3">
                      <Stars rating={r.rating} />
                    </td>
                    <td className="px-4 py-3">{r.publicClicked ? 'Yes' : 'No'}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(r.sentAt)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(r.respondedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {total > 0 && (
        <Pager
          page={safePage}
          totalPages={totalPages}
          total={total}
          perPage={PER_PAGE}
          onPageChange={setPage}
          showFirstLast
        />
      )}
    </PageShell>
  );
}
