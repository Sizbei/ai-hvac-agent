import { TechJobsListClient } from '@/components/tech/tech-jobs-list-client';

/**
 * Technician "my jobs" list — the active jobs assigned to the calling tech.
 * Data comes from GET /api/tech/jobs (assignee + tenant scoped).
 */
export default function TechJobsPage() {
  return <TechJobsListClient />;
}
