'use client';

import { useEffect } from 'react';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { DispatchMapProvider } from '@/components/admin/dispatch/dispatch-map-provider';

export type MapProvider = 'apple' | 'maplibre';

interface DispatchMapPageClientProps {
  mapProvider: MapProvider;
}

export function DispatchMapPageClient({ mapProvider }: DispatchMapPageClientProps) {
  useEffect(() => { document.title = 'Map · Spears Admin'; }, []);
  return (
    <PageShell fullHeight className="p-6 sm:p-7 gap-4">
      <PageHeader
        title="Map"
        subtitle="Live technician locations and active requests across your service area. Technician location is shared only when the technician opts in."
      />
      <div className="min-h-0 flex-1">
        {/* Provider picks Apple MapKit when configured, else the MapLibre map,
            and owns both dynamic imports (only the active branch's chunk loads). */}
        <DispatchMapProvider mapProvider={mapProvider} />
      </div>
    </PageShell>
  );
}
