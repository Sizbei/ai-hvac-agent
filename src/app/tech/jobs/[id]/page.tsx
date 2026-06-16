import { TechJobDetailClient } from '@/components/tech/tech-job-detail-client';

/**
 * Technician job detail — materials used, on-site note, and customer signature
 * capture. All mutations hit the assignee+tenant-guarded /api/tech/jobs/[id]/*
 * routes. Next.js 16: params is a Promise.
 */
export default async function TechJobDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TechJobDetailClient id={id} />;
}
