'use client';

import { useEffect, useState } from 'react';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';
import {
  fieldpulseDataFromDetail,
  fieldpulseDetailUrl,
  type FieldpulseDetailRecord,
} from '@/lib/admin/fieldpulse-detail-fetch';

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
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((body: unknown) => {
        if (active) setLoaded({ url, result: { kind: 'loaded', data: fieldpulseDataFromDetail(body, record) } });
      })
      .catch(() => {
        if (active) setLoaded({ url, result: { kind: 'failed' } });
      });
    return () => {
      active = false;
    };
  }, [url, record]);

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
