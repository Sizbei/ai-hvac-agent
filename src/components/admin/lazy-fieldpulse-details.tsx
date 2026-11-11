'use client';

import { useEffect, useState } from 'react';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';
import {
  createFieldpulseDetailLoader,
  fieldpulseDetailUrl,
  type FieldpulseDetailRecord,
} from '@/lib/admin/fieldpulse-detail-fetch';

/** One load per record for the page's lifetime (re-expanding a row is instant). */
const loadDetail = createFieldpulseDetailLoader((url) => adminFetch(url));

type LoadResult =
  | { readonly kind: 'failed' }
  | { readonly kind: 'loaded'; readonly data: Record<string, unknown> | null };

/**
 * FieldPulse details for an expanded list row. List pages don't carry the
 * FieldPulse blob (speed S3), so this reads it from the record's detail
 * endpoint when the row is opened (mount = expand).
 */
export function LazyFieldpulseDetails({
  record,
  id,
}: {
  readonly record: FieldpulseDetailRecord;
  readonly id: string;
}) {
  const url = fieldpulseDetailUrl(record, id);
  // Keyed by url: a result for another record reads as still loading.
  const [loaded, setLoaded] = useState<{ readonly url: string; readonly result: LoadResult } | null>(null);

  useEffect(() => {
    let active = true;
    loadDetail(record, id)
      .then((data) => {
        if (active) setLoaded({ url, result: { kind: 'loaded', data } });
      })
      .catch((err: unknown) => {
        // A 401 is already on its way to sign in: keep "Loading…".
        if (active && !(err instanceof AdminAuthRedirectError)) setLoaded({ url, result: { kind: 'failed' } });
      });
    return () => {
      active = false;
    };
  }, [url, record, id]);

  const result = loaded?.url === url ? loaded.result : null;
  if (!result) {
    return <p className="text-xs text-muted-foreground">Loading FieldPulse details…</p>;
  }
  if (result.kind === 'failed') {
    return (
      <p className="text-xs text-muted-foreground">
        Couldn’t load FieldPulse details. Open the {record} to see them.
      </p>
    );
  }
  return <FieldpulseDetails data={result.data} />;
}
