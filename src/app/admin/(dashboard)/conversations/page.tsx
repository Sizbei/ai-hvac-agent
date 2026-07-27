import type { Metadata } from 'next';
import { ConversationInbox } from '@/components/admin/conversations/conversation-inbox';

export const metadata: Metadata = { title: 'Conversations · Spears Admin' };

export default function AdminConversationsPage() {
  return (
    <div className="h-full">
      <h1 className="sr-only">Conversations</h1>
      <ConversationInbox />
    </div>
  );
}
