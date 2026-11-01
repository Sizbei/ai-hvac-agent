import { TechJobDetailClient } from '@/components/tech/tech-job-detail-client';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Technician job detail — materials used, on-site note, and customer signature
 * capture. All mutations hit the assignee+tenant-guarded /api/tech/jobs/[id]/*
 * routes. `?visit=<appointment id>` picks one of the technician's visits on the
 * job. Next.js 16: params and searchParams are Promises.
 */
export default async function TechJobDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ visit?: string | string[] }>;
}) {
  const { id } = await params;
  const { visit } = await searchParams;
  const appointmentId = typeof visit === 'string' && UUID_REGEX.test(visit) ? visit : undefined;
  return <TechJobDetailClient id={id} appointmentId={appointmentId} />;
}
