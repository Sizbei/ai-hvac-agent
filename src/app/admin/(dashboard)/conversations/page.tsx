import type { Metadata } from 'next';
import { ConversationInbox } from '@/components/admin/conversations/conversation-inbox';

export const metadata: Metadata = { title: 'Conversations · Spears Admin' };

// No PageShell — intentional full-bleed master-detail; no PageShell by design.
export default function AdminConversationsPage() {
  return (
    <div className="h-full">
      <h1 className="sr-only">Conversations</h1>
      <ConversationInbox />
    </div>
  );
}
