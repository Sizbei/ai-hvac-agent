'use client';

import { useRouter } from 'next/navigation';
import { ChatExperience } from '@/components/chat/chat-experience';

export default function ChatPage() {
  const router = useRouter();
  return (
    <ChatExperience
      variant="page"
      onSubmitted={(ref) =>
        router.push(`/chat/success?ref=${encodeURIComponent(ref)}`)
      }
    />
  );
}
