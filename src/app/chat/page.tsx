'use client';

import { useRouter } from 'next/navigation';
import { ChatExperience } from '@/components/chat/chat-experience';

export default function ChatPage() {
  const router = useRouter();
  return (
    <ChatExperience
      variant="page"
      onSubmitted={({ referenceNumber, arrivalWindowLabel }) => {
        const params = new URLSearchParams({ ref: referenceNumber });
        // Only carries a window when one was actually reserved — the success
        // page keeps its soft copy otherwise.
        if (arrivalWindowLabel) params.set('window', arrivalWindowLabel);
        router.push(`/chat/success?${params.toString()}`);
      }}
    />
  );
}
