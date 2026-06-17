'use client';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ConversationDetailContent } from '@/components/admin/conversations/conversation-detail-content';

interface ConversationDetailSheetProps {
  readonly conversationId: string | null;
  readonly onClose: () => void;
  readonly onDeleted?: () => void;
}

/**
 * Mobile / fallback presentation of a conversation. The desktop inbox renders
 * the same {@link ConversationDetailContent} inline in its right pane; this
 * sheet just wraps that shared content in a slide-over so no behavior (load,
 * delete -> refetch) is duplicated.
 */
export function ConversationDetailSheet({
  conversationId,
  onClose,
  onDeleted,
}: ConversationDetailSheetProps) {
  const isOpen = conversationId !== null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full p-0 sm:w-[480px] sm:max-w-[480px] flex flex-col overflow-hidden"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Conversation details</SheetTitle>
        </SheetHeader>
        <ConversationDetailContent
          conversationId={conversationId}
          onClose={onClose}
          onDeleted={onDeleted}
        />
      </SheetContent>
    </Sheet>
  );
}
