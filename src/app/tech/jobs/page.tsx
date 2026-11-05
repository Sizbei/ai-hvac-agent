import { getTechSession } from '@/lib/auth/tech-session';
import { readGuideHidden } from '@/lib/tech/guide-queries';
import { TechJobsListClient } from '@/components/tech/tech-jobs-list-client';

export const dynamic = 'force-dynamic';

/**
 * Technician "my jobs" list. The guide card's hidden flag is read server-side
 * (spec §2) so a hidden guide never flashes a skeleton above the list.
 */
export default async function TechJobsPage() {
  const session = await getTechSession();
  if (!session) return null; // the layout redirects
  const guideHidden = await readGuideHidden(session.organizationId, session.userId);
  return <TechJobsListClient guideHidden={guideHidden} />;
}
