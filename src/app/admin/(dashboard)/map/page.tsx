'use client';

import { useEffect } from 'react';
import dynamic from 'next/dynamic';

// MapLibre needs `window`, so never render it on the server.
const DispatchMap = dynamic(
  () => import('@/components/admin/dispatch/dispatch-map').then((m) => m.DispatchMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center rounded-xl border bg-card text-sm text-muted-foreground">
        Loading map…
      </div>
    ),
  },
);

export default function DispatchMapPage() {
  useEffect(() => { document.title = 'Map · Spears Admin'; }, []);
  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Map</h1>
        <p className="text-sm text-muted-foreground">
          Live technician locations and active jobs across your service area.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <DispatchMap />
      </div>
    </div>
  );
}
