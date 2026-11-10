import { notFound } from 'next/navigation';
import { getAdminSession } from '@/lib/auth/session';
import { getFeatures } from '@/lib/tenancy/features';
import { DispatchMapPageClient } from './page-client';
import type { MapProvider } from './page-client';

/**
 * Server component: reads env vars to determine which map provider is active,
 * then passes `mapProvider` to the client shell.
 *
 * mapProvider = "apple"    — all three Apple MapKit env vars are present
 * mapProvider = "maplibre" — fallback (default; any var absent)
 *
 * Task 3's DispatchMapProvider consumes the `mapProvider` prop to decide
 * which map component to render.
 */
function resolveMapProvider(): MapProvider {
  const configured =
    Boolean(process.env.APPLE_TEAM_ID) &&
    Boolean(process.env.APPLE_MAPKIT_KEY_ID) &&
    Boolean(process.env.APPLE_MAPKIT_PRIVATE_KEY);
  return configured ? 'apple' : 'maplibre';
}

export default async function DispatchMapPage() {
  // Map is a per-org switch (off by default). A failed read throws to the
  // error boundary rather than showing the map.
  const session = await getAdminSession();
  if (!session || !(await getFeatures(session.organizationId)).map) notFound();
  const mapProvider = resolveMapProvider();
  return <DispatchMapPageClient mapProvider={mapProvider} />;
}
