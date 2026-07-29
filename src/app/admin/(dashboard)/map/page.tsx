'use client';

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';

// MapLibre needs `window`, so never render it on the server.
const DispatchMap = dynamic(
  () => import('@/components/admin/dispatch/dispatch-map').then((m) => m.DispatchMap),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex h-full min-h-[400px] animate-pulse items-center justify-center rounded-xl border bg-muted text-sm text-muted-foreground"
        aria-label="Loading map"
        role="status"
      >
        <span aria-hidden="true">Loading map…</span>
      </div>
    ),
  },
);

export default function DispatchMapPage() {
  useEffect(() => { document.title = 'Map · Spears Admin'; }, []);
  return (
    <PageShell fullHeight className="p-6 sm:p-7 gap-4">
      <PageHeader
        title="Map"
        subtitle="Live technician locations and active requests across your service area. Technician location is shared only when the technician opts in."
      />
      <div className="min-h-0 flex-1">
        <DispatchMap />
      </div>
    </PageShell>
  );
}
