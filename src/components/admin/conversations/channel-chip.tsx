'use client';

import { Phone, MessageSquareText, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ConversationChannel } from '@/lib/admin/conversation-types';

/**
 * Monochrome channel chip + label, ported from the approved redesign mock.
 * Channels are intentionally neutral (muted icon, no per-channel color) so cyan
 * stays reserved for actions/active state.
 */

const CHANNEL_META: Record<
  ConversationChannel,
  { readonly Icon: typeof Phone; readonly label: string }
> = {
  phone: { Icon: Phone, label: 'Phone' },
  sms: { Icon: MessageSquareText, label: 'SMS' },
  web: { Icon: Globe, label: 'Web' },
};

export function ChannelChip({
  channel,
  size = 'md',
}: {
  readonly channel: ConversationChannel;
  readonly size?: 'sm' | 'md';
}) {
  const { Icon } = CHANNEL_META[channel] ?? CHANNEL_META.web;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground',
        size === 'sm' ? 'size-7' : 'size-9',
      )}
    >
      <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} />
    </span>
  );
}

export function channelLabel(channel: ConversationChannel): string {
  return (CHANNEL_META[channel] ?? CHANNEL_META.web).label;
}
