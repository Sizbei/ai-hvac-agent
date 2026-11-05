import type { Metadata } from 'next';
import { ConversationInbox } from '@/components/admin/conversations/conversation-inbox';
import { getAdminSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/authz';

export const metadata: Metadata = { title: 'Conversations · Spears Admin' };

// No PageShell — intentional full-bleed master-detail; no PageShell by design.
export default async function AdminConversationsPage() {
  // The layout already gates on a session; this only decides whether to show
  // Delete (the DELETE route is super_admin-only).
  const session = await getAdminSession();
  const canDelete = session !== null && isSuperAdmin(session);
  return (
    <div className="h-full">
      <h1 className="sr-only">Conversations</h1>
      <ConversationInbox canDelete={canDelete} />
    </div>
  );
}
