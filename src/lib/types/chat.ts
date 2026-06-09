import type { SessionState } from '@/lib/ai/state-machine';
import type { ExtractionResult } from '@/lib/ai/extraction-schema';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt?: Date;
}

export type { SessionState, ExtractionResult };

// Fields tracked for extraction progress pills — the required intake set the
// customer sees as a checklist (issue/urgency/address/name/phone/email).
export interface ExtractionField {
  readonly key: keyof Pick<
    ExtractionResult,
    | 'issueType'
    | 'urgency'
    | 'address'
    | 'customerName'
    | 'customerPhone'
    | 'customerEmail'
  >;
  readonly label: string;
  readonly collected: boolean;
}

// Session status derived from SessionState for UI display
export type SessionStatus = 'active' | 'confirming' | 'complete' | 'terminal';

// Props interfaces for chat components
export interface ChatContainerProps {
  readonly messages: readonly ChatMessage[];
  readonly status: SessionState;
  readonly isStreaming: boolean;
  readonly extraction: ExtractionResult | null;
  readonly onSendMessage: (message: string) => void;
  readonly onEscalate: () => void;
  readonly onConfirm: () => void;
  readonly inputDisabled?: boolean;
}
